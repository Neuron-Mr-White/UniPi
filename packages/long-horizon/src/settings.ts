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
import { decisionModelSection, DEFAULT_DECISION_OVERRIDE, getSettings, registerSettings, resolveDecisionModel, setSettings } from "@pi-unipi/core";
import type { LhMode } from "./modes.js";

export interface JudgeSettings {
  /** Master switch. Off → default_mode is exposed, no judge calls. */
  enabled: boolean;
  /**
   * Where the judgment call goes: "typesafe" (native systemone,
   * api.typesafe.ai), "openrouter" (decisions endpoint for jev, chat for
   * others), or "custom" (openrouter-shape transport against a required
   * baseUrl). Stored "auto" (pre-custom schema) migrates to "openrouter".
   */
  provider: "typesafe" | "openrouter" | "custom";
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
  /**
   * User-only goal progress estimate (a one-off model call, never in context):
   * "loop" = after every goal turn and on /unipi:goal status; "status" = only
   * on status; "off" = never.
   */
  goalProgress: "loop" | "status" | "off";
  /** Model for the estimate (empty = verifier model, else session model). */
  progressModel: string;
}

export const DEFAULT_SETTINGS: LongHorizonSettings = {
  judge: {
    enabled: false,
    // "auto" (the pre-custom default) resolved to the openrouter shape.
    provider: "openrouter",
    // openrouter/custom ride the decisions endpoint → the hosted jev id.
    model: "typesafe/jev-1.13",
    baseUrl: "",
    threshold: 0.8,
    timeoutMs: 0,
    apiKey: "",
  },
  defaultMode: "none",
  verifierModel: "",
  goalProgress: "loop",
  progressModel: "",
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

/** Default model per provider: native typesafe speaks bare ids, gateways don't. */
function defaultModelFor(provider: JudgeSettings["provider"]): string {
  return provider === "typesafe" ? "jev-latest" : "typesafe/jev-1.13";
}

/** Deep-merge stored values over defaults so new keys appear automatically. */
function mergeSettings(stored: unknown): LongHorizonSettings {
  if (!isRecord(stored)) return structuredClone(DEFAULT_SETTINGS);
  const judge = isRecord(stored.judge) ? stored.judge : {};
  const provider =
    judge.provider === "typesafe" || judge.provider === "openrouter" || judge.provider === "custom"
      ? judge.provider
      : judge.provider === "auto"
        ? "openrouter" // stored "auto" → its effective transport
        : "typesafe";
  return {
    judge: {
      enabled: typeof judge.enabled === "boolean" ? judge.enabled : DEFAULT_SETTINGS.judge.enabled,
      provider,
      model:
        typeof judge.model === "string" && judge.model
          ? judge.model
          : defaultModelFor(provider),
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
    goalProgress: stored.goalProgress === "status" || stored.goalProgress === "off" ? stored.goalProgress : "loop",
    progressModel: typeof stored.progressModel === "string" ? stored.progressModel : "",
  };
}

let cache: LongHorizonSettings | null = null;

// Register with the unified settings hub (core engine). Reads/writes go
// through the engine's global scope; the A_KEY_MODULES migration imports the
// legacy ~/.pi/agent/settings.json unipi.longHorizon block once, automatically.
registerSettings({
  namespace: "long-horizon",
  label: "Long-Horizon",
  defaults: { ...DEFAULT_SETTINGS, decisionModel: DEFAULT_DECISION_OVERRIDE } as unknown as Record<string, unknown>,
  projectOverrides: true,
  schema: [
    {
      title: "Judge",
      description: "Prompt → mode routing with the Decision Model (shared settings: /unipi:settings → Decision Model)",
      fields: [
        { key: "judge.enabled", type: "boolean", label: "Judge enabled", description: "Route new prompts automatically; off = always defaultMode" },
        { key: "judge.threshold", type: "number", label: "Confidence threshold", description: "Below this the judge abstains (0-1)", min: 0.01, max: 1 },
      ],
    },
    decisionModelSection({ title: "Judge — Decision model" }),
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
        { key: "verifierModel", type: "model", label: "Verifier model", description: "Goal completion verification", emptyLabel: "inherit (session model)", capability: "text", emptyOption: "inherit (session model)" },
      ],
    },
    {
      title: "Progress",
      description: "Progress bars shown only to you — never sent to the model",
      fields: [
        {
          key: "goalProgress",
          type: "enum",
          label: "Goal progress estimate",
          options: [
            { value: "loop", label: "every loop + /goal status" },
            { value: "status", label: "only on /goal status" },
            { value: "off", label: "off" },
          ],
          description: "A one-off side call estimates % done and summarizes the work so far",
        },
        { key: "progressModel", type: "model", label: "Estimate model", description: "Cheaper is fine; runs once per goal turn", emptyLabel: "inherit (verifier → session model)", capability: "text", emptyOption: "inherit (verifier → session model)" },
      ],
    },
  ],
});

export function loadSettings(force = false): LongHorizonSettings {
  if (cache && !force) return cache;
  const raw = getSettings("long-horizon", process.cwd());
  // The engine stores validated shapes; re-validate defensively anyway.
  cache = withDecisionModel(mergeSettings(raw), process.cwd());
  return cache;
}

/**
 * The judge's transport (provider/model/baseUrl/key/timeout) is the Decision
 * Model — shared, or this module's custom override. `enabled` and
 * `threshold` stay long-horizon's own.
 */
function withDecisionModel(settings: LongHorizonSettings, cwd: string): LongHorizonSettings {
  try {
    const dm = resolveDecisionModel(cwd, "long-horizon");
    return {
      ...settings,
      judge: { ...settings.judge, provider: dm.provider, model: dm.model, baseUrl: dm.baseUrl, apiKey: dm.apiKey, timeoutMs: dm.timeoutMs ?? 0 },
    };
  } catch {
    return settings;
  }
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
