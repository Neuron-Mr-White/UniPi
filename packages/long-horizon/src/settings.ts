/**
 * @pi-unipi/long-horizon — Settings
 *
 * Follows the shared-file convention (ask-user pattern): one settings file at
 * ~/.pi/agent/settings.json, namespaced under `unipi.longHorizon`. This is the
 * surface the future /unipi:settings hub (v3 utility task) will absorb —
 * adding keys here means the hub gets them for free.
 *
 * Design: docs/long-horizon-design.md §9.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getSettings, registerSettings, setSettings } from "@pi-unipi/core";
import type { LhMode } from "./modes.js";

export interface JudgeSettings {
  /** Master switch. Off → default_mode is exposed, no judge calls. */
  enabled: boolean;
  /** Where the judgment call goes. */
  provider: "typesafe" | "openrouter";
  /** Model id (typesafe: jev-latest; openrouter: any routing-capable model). */
  model: string;
  /** Base URL override; empty = provider default. */
  baseUrl: string;
  /** Confidence floor; below it the judge abstains (owner/default wins). */
  threshold: number;
  /**
   * Abort budget for one judge call. 0 = provider default (typesafe's native
   * jev is sub-second → 1s; an openrouter chat-model judge needs ~6s). Only
   * paid on genuinely new prompts with no active owner, so a few seconds is
   * acceptable and never recurs mid-task.
   */
  timeoutMs: number;
  /**
   * API key stored in the settings file (set via /unipi:settings) — wins over
   * the environment, so tmux/ssh-c/systemd launches work without shell env.
   * Empty = use env / provider fallback.
   */
  apiKey: string;
}

export interface LongHorizonSettings {
  judge: JudgeSettings;
  /** Mode exposed when the judge is off/unconfigured/fails-open. */
  defaultMode: LhMode;
  /** Model used for goal-completion verification (empty = session model). */
  verifierModel: string;
}

export const DEFAULT_SETTINGS: LongHorizonSettings = {
  judge: {
    enabled: false,
    provider: "typesafe",
    model: "jev-latest",
    baseUrl: "",
    threshold: 0.6,
    timeoutMs: 0,
    apiKey: "",
  },
  defaultMode: "goal",
  verifierModel: "",
};

const settingsPath = (): string => join(homedir(), ".pi", "agent", "settings.json");
const NAMESPACE_KEY = "unipi";
const MODULE_KEY = "longHorizon";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSettingsFile(): Record<string, unknown> {
  const path = settingsPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeSettingsFile(data: Record<string, unknown>): void {
  const path = settingsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

/** Deep-merge stored values over defaults so new keys appear automatically. */
function mergeSettings(stored: unknown): LongHorizonSettings {
  if (!isRecord(stored)) return structuredClone(DEFAULT_SETTINGS);
  const judge = isRecord(stored.judge) ? stored.judge : {};
  return {
    judge: {
      enabled: typeof judge.enabled === "boolean" ? judge.enabled : DEFAULT_SETTINGS.judge.enabled,
      provider: judge.provider === "openrouter" ? "openrouter" : "typesafe",
      model: typeof judge.model === "string" && judge.model ? judge.model : DEFAULT_SETTINGS.judge.model,
      baseUrl: typeof judge.baseUrl === "string" ? judge.baseUrl : "",
      threshold:
        typeof judge.threshold === "number" && judge.threshold > 0 && judge.threshold <= 1
          ? judge.threshold
          : DEFAULT_SETTINGS.judge.threshold,
      timeoutMs:
        typeof judge.timeoutMs === "number" && judge.timeoutMs >= 0
          ? judge.timeoutMs
          : DEFAULT_SETTINGS.judge.timeoutMs,
      apiKey: typeof judge.apiKey === "string" ? judge.apiKey : "",
    },
    defaultMode: ["goal", "ralph", "swarm", "graph", "none"].includes(stored.defaultMode as string)
      ? (stored.defaultMode as LhMode)
      : DEFAULT_SETTINGS.defaultMode,
    verifierModel: typeof stored.verifierModel === "string" ? stored.verifierModel : "",
  };
}

let cache: LongHorizonSettings | null = null;

// Register with the unified settings hub (core engine). Reads/writes go
// through the engine's global scope; the A_KEY_MODULES migration imports the
// legacy ~/.pi/agent/settings.json unipi.longHorizon block once, automatically.
registerSettings({
  namespace: "long-horizon",
  label: "Long-Horizon",
  defaults: DEFAULT_SETTINGS as unknown as Record<string, unknown>,
  projectOverrides: true,
  schema: [
    {
      title: "Judge",
      description: "Prompt → mode routing (TypeSafe jev via OpenRouter, or any chat model)",
      fields: [
        { key: "judge.enabled", type: "boolean", label: "Judge enabled", description: "Route new prompts automatically; off = always defaultMode" },
        {
          key: "judge.provider",
          type: "enum",
          label: "Provider",
          options: [
            { value: "typesafe", label: "typesafe (native systemone)" },
            { value: "openrouter", label: "openrouter (jev or chat)" },
          ],
          description: "jev models auto-use the decisions endpoint",
        },
        { key: "judge.model", type: "model", label: "Model", description: "jev models auto-use the decisions endpoint" },
        { key: "judge.baseUrl", type: "string", label: "Base URL", description: "oino proxy = https://router.oino.dev/v1", emptyLabel: "provider default" },
        { key: "judge.threshold", type: "number", label: "Confidence threshold", description: "Below this the judge abstains (0-1)", min: 0.01, max: 1 },
        { key: "judge.timeoutMs", type: "number", label: "Timeout ms", min: 0, zeroLabel: "auto (1s native / 6s chat)" },
        { key: "judge.apiKey", type: "secret", label: "API key", description: "Stored key wins over env (works in tmux/ssh-c/systemd)", emptyLabel: "env / bridge fallback" },
      ],
    },
    {
      title: "Modes",
      fields: [
        {
          key: "defaultMode",
          type: "enum",
          label: "Default mode",
          options: ["goal", "ralph", "swarm", "graph", "none"],
          description: "Used when judge is off/abstains",
        },
        { key: "verifierModel", type: "model", label: "Verifier model", description: "Goal completion verification", emptyLabel: "inherit (session model)" },
      ],
    },
  ],
});

export function loadSettings(force = false): LongHorizonSettings {
  if (cache && !force) return cache;
  const raw = getSettings("long-horizon", process.cwd());
  // The engine stores validated shapes; re-validate defensively anyway.
  cache = mergeSettings(raw);
  return cache;
}

export function saveSettings(update: Partial<LongHorizonSettings>): LongHorizonSettings {
  const current = mergeSettings(getSettings("long-horizon", process.cwd()));
  const next = mergeSettings({ ...current, ...update, judge: { ...current.judge, ...(update.judge ?? {}) } });
  setSettings("long-horizon", next as unknown as Record<string, unknown>, "global", process.cwd());
  cache = next;
  return next;
}

/** Test hook: drop the cache so tests can swap the settings file. */
export function resetSettingsCache(): void {
  cache = null;
}
