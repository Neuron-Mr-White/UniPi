/**
 * Config manager — load and save compactor settings
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { getSettingsScoped, registerSettings, setSettings, decisionModelSection, DEFAULT_DECISION_OVERRIDE } from "@pi-unipi/core";
import type { CompactorConfig } from "../types.js";
import { DEFAULT_COMPACTOR_CONFIG } from "./schema.js";

const METHOD_OPTIONS = [
  { value: "vcc", label: "lossless (no model)" },
  { value: "jev", label: "lossless + jev pruning" },
  { value: "llm", label: "model summary" },
] as const;

// Registered with the unified settings hub. Canonical paths:
// global ~/.unipi/config/compactor/config.json,
// project .unipi/config/compactor/config.json.
registerSettings({
  namespace: "compactor",
  label: "Compactor",
  defaults: { ...DEFAULT_COMPACTOR_CONFIG, decisionModel: DEFAULT_DECISION_OVERRIDE } as unknown as Record<string, unknown>,
  schema: [
    {
      title: "Compaction",
      description: "How the context is shrunk when it fills up",
      fields: [
        {
          key: "method",
          type: "enum",
          label: "Method",
          description: "Lossless: instant structured summary, full history stays searchable. + jev pruning: jev (the Decision model) drops items no longer in force — done requests, reversed decisions, fixed errors (~1s, fractions of a cent). Model summary: Pi's model-written summary (costs a model call).",
          options: METHOD_OPTIONS,
        },
        {
          key: "piCompact",
          type: "enum",
          label: "Pi's /compact",
          description: "What Pi's built-in /compact command does",
          options: [{ value: "follow", label: "same as Method" }, ...METHOD_OPTIONS],
        },
        {
          key: "trigger",
          type: "enum",
          label: "When",
          description: "Pi's limit: compact when the context nears the model's window (Pi's compaction settings). Percentage: compact at a set % of the window.",
          options: [
            { value: "pi", label: "Pi's context limit" },
            { value: "percent", label: "at a percentage" },
          ],
        },
        { key: "thresholdPercent", type: "number", label: "Percentage", min: 30, max: 95, description: "Used when When = at a percentage" },
        { key: "notify", type: "boolean", label: "Notifications", description: "Show a notice when compaction runs or fails" },
      ],
    },
    {
      title: "Advanced compaction",
      description: "Tuned defaults — rarely worth changing",
      advanced: true,
      fields: [
        { key: "smartKeepTail", type: "boolean", label: "Smart keep tail", description: "Keep more recent turns when the kept tail would be tiny (≤5k tokens, up to 25k)" },
        { key: "summaryBudgetTokens", type: "number", label: "Summary budget", min: 0, max: 20000, zeroLabel: "auto", description: "Lossless summary size in tokens (auto scales 1.5k–4k with session size)" },
        { key: "sections.activeWork", type: "boolean", label: "Section: active work", description: "Goal, ralph and kanboard state from those modules" },
        { key: "sections.requests", type: "boolean", label: "Section: your requests" },
        { key: "sections.state", type: "boolean", label: "Section: latest state", description: "The agent's most recent progress reports" },
        { key: "sections.decisions", type: "boolean", label: "Section: decisions & constraints" },
        { key: "sections.files", type: "boolean", label: "Section: files" },
        { key: "sections.commits", type: "boolean", label: "Section: commits" },
        { key: "sections.errors", type: "boolean", label: "Section: open errors" },
        { key: "sections.lessons", type: "boolean", label: "Section: lessons", description: "Lessons the agent wrote down: memory notes, # comments, diagnoses" },
        { key: "sections.transcript", type: "boolean", label: "Section: recent transcript" },
        { key: "cooldownMs", type: "number", label: "Percentage cooldown ms", min: 0, zeroLabel: "none", description: "Minimum delay between percentage-triggered compactions" },
        { key: "repeatMinGrowthTokens", type: "number", label: "Percentage repeat growth", min: 0, zeroLabel: "off", description: "New tokens needed to compact again while still above the percentage" },
        { key: "llmInstructions", type: "string", label: "Model summary instructions", emptyLabel: "none", description: "Extra instructions passed to model-written summaries" },
        { key: "debug", type: "boolean", label: "Debug output", description: "Write compaction diagnostics to /tmp/compactor-debug.json" },
      ],
    },
    decisionModelSection({ title: "jev pruning — Decision model" }),
  ],
});

export const COMPACTOR_CONFIG_PATH = join(homedir(), ".unipi", "config", "compactor", "config.json");

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Translate a pre-rework config (overrideDefaultCompaction / autoCompaction.*)
 * into the current keys. Only fills keys the scope does not already set.
 */
export function translateLegacyConfig(raw: Raw): Raw {
  const out: Raw = {};
  for (const key of Object.keys(DEFAULT_COMPACTOR_CONFIG)) {
    if (key in raw) out[key] = raw[key];
  }
  if (!("method" in raw) && raw.overrideDefaultCompaction === false) out.method = "llm";
  const auto = raw.autoCompaction;
  if (isRecord(auto)) {
    if (!("trigger" in raw) && auto.enabled === true) out.trigger = "percent";
    const carry: Array<[keyof CompactorConfig, string]> = [
      ["thresholdPercent", "thresholdPercent"],
      ["cooldownMs", "cooldownMs"],
      ["repeatMinGrowthTokens", "repeatMinGrowthTokens"],
      ["notify", "notify"],
    ];
    for (const [to, from] of carry) {
      if (!(to in raw) && auto[from] !== undefined) out[to] = auto[from];
    }
  }
  return out;
}

function deepMerge<T extends Raw>(base: T, override: Raw): T {
  const result: Raw = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    result[key] = isRecord(value) && isRecord(result[key]) ? deepMerge(result[key] as Raw, value) : value;
  }
  return result as T;
}

/** Load the effective config: defaults ← global ← project (legacy keys translated per scope). */
export function loadConfig(cwd: string = process.cwd()): CompactorConfig {
  let config: Raw = structuredClone(DEFAULT_COMPACTOR_CONFIG) as unknown as Raw;
  for (const scope of ["global", "project"] as const) {
    let raw: Raw | undefined;
    try {
      raw = getSettingsScoped("compactor", scope, cwd);
    } catch {
      raw = undefined;
    }
    if (raw) config = deepMerge(config, translateLegacyConfig(raw));
  }
  return config as unknown as CompactorConfig;
}

/**
 * Write translated legacy keys into each scope's file once, so the settings
 * hub shows the effective values. Additive only: old keys stay, untouched.
 */
export function migrateLegacyConfigFiles(cwd: string = process.cwd()): void {
  for (const scope of ["global", "project"] as const) {
    try {
      const raw = getSettingsScoped("compactor", scope, cwd);
      if (!raw || (!("overrideDefaultCompaction" in raw) && !("autoCompaction" in raw))) continue;
      const translated = translateLegacyConfig(raw);
      const patch: Raw = {};
      for (const key of ["method", "trigger", "thresholdPercent", "cooldownMs", "repeatMinGrowthTokens", "notify"]) {
        if (!(key in raw) && key in translated) patch[key] = translated[key];
      }
      if (Object.keys(patch).length > 0) setSettings("compactor", patch, scope, cwd);
    } catch {
      // Unreadable scope: loadConfig still translates on read.
    }
  }
}

/** Save a config patch (global by default). */
export function saveConfig(
  patch: Partial<CompactorConfig>,
  opts?: { perProject?: boolean; cwd?: string },
): { success: boolean; error?: string } {
  try {
    setSettings(
      "compactor",
      patch as unknown as Raw,
      opts?.perProject ? "project" : "global",
      opts?.cwd ?? process.cwd(),
    );
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
