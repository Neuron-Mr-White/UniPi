/**
 * Config manager — load and save compactor settings
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { getSettingsScoped, registerSettings, setSettings } from "@pi-unipi/core";
import type { CompactorConfig } from "../types.js";
import { DEFAULT_COMPACTOR_CONFIG, SUMMARY_SECTION_IDS } from "./schema.js";

const METHOD_OPTIONS = [
  { value: "vcc", label: "lossless", description: "instant structured summary; history stays searchable" },
  { value: "llm", label: "model summary", description: "pi's model writes the summary — costs one model call" },
] as const;

/** The `summarySections` multiselect: labels + explanations per section id. */
const SUMMARY_SECTION_OPTIONS = [
  { value: "activeWork", label: "Active work", description: "goal, ralph and kanboard state" },
  { value: "requests", label: "Your requests", description: "the user requests this session answered" },
  { value: "state", label: "Latest state", description: "the agent's most recent progress reports" },
  { value: "decisions", label: "Decisions", description: "decisions and constraints reached so far" },
  { value: "files", label: "Files", description: "files touched and what was done to them" },
  { value: "commits", label: "Commits", description: "commit history of this session" },
  { value: "errors", label: "Open errors", description: "unresolved errors worth remembering" },
  { value: "lessons", label: "Lessons", description: "memory notes and diagnoses written down" },
  { value: "transcript", label: "Recent transcript", description: "the last turns kept verbatim" },
] as const;

// Registered with the unified settings hub. Canonical paths:
// global ~/.unipi/config/compactor/config.json,
// project .unipi/config/compactor/config.json.
registerSettings({
  namespace: "compactor",
  label: "Compactor",
  defaults: { ...DEFAULT_COMPACTOR_CONFIG } as unknown as Record<string, unknown>,
  schema: [
    {
      title: "Compaction",
      description: "How the context is shrunk when it fills up",
      fields: [
        {
          key: "method",
          type: "enum",
          label: "Method",
          description: "How the context is summarized. Takes effect on the next compaction.",
          options: METHOD_OPTIONS,
        },
        {
          key: "piCompact",
          type: "enum",
          label: "Pi's /compact",
          description: "What pi's built-in /compact command does: follow Method, or force one.",
          options: [{ value: "follow", label: "same as Method", description: "reuse whatever Method is set to" }, ...METHOD_OPTIONS],
        },
        {
          key: "trigger",
          type: "enum",
          label: "When",
          description: "What trips a compaction while you work.",
          options: [
            { value: "pi", label: "pi's context limit", description: "compact when pi itself nears the model's window" },
            { value: "percent", label: "at a percentage", description: "compact when usage crosses the threshold below" },
          ],
        },
        { key: "thresholdPercent", type: "number", label: "Trigger threshold", unit: "%", min: 30, max: 95, description: "Context share that trips a compaction when When = at a percentage." },
        { key: "notify", type: "boolean", label: "Notifications", description: "Notice when a compaction runs or fails." },
      ],
    },
    {
      title: "Advanced compaction",
      description: "Tuned defaults — rarely worth changing",
      advanced: true,
      fields: [
        { key: "smartKeepTail", type: "boolean", label: "Smart keep tail", description: "Keep more recent turns when the kept tail would be tiny (≤5k tokens, up to 25k)." },
        { key: "summaryBudgetTokens", type: "number", label: "Summary budget", unit: "tokens", min: 0, max: 20000, zeroLabel: "auto", description: "Lossless summary size in tokens (auto scales 1.5k–4k with session size)." },
        {
          key: "summarySections",
          type: "multiselect",
          label: "Summary sections",
          description: "What the summary keeps — deselect to drop it from every new summary.",
          options: SUMMARY_SECTION_OPTIONS,
          emptyLabel: "none",
        },
        { key: "llmInstructions", type: "string", label: "Summary instructions", emptyLabel: "none", description: "Extra instructions passed to model-written summaries." },
      ],
    },
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
  // The jev method was removed: a saved method:"jev" behaves as "vcc".
  if (out.method === "jev") out.method = "vcc";
  if (out.piCompact === "jev") out.piCompact = "vcc";
  if (!("method" in raw) && raw.overrideDefaultCompaction === false) out.method = "llm";
  const auto = raw.autoCompaction;
  if (isRecord(auto)) {
    if (!("trigger" in raw) && auto.enabled === true) out.trigger = "percent";
    const carry: Array<[keyof CompactorConfig, string]> = [
      ["thresholdPercent", "thresholdPercent"],
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
  if (config.method === "jev") config.method = "vcc";
  if (config.piCompact === "jev") config.piCompact = "vcc";
  // The defaults-merged object always carries summarySections, so the stored
  // layers decide: new array wins, else legacy sections booleans, else default.
  const selection = storedSummarySelection(cwd);
  if (selection !== undefined) config.summarySections = selection;
  normalizeSummarySections(config);
  return config as unknown as CompactorConfig;
}

/**
 * The stored section selection: first layer (project wins) with the new
 * array, else the first with a legacy sections object (membership = every id
 * not explicitly false). undefined = nothing stored — the default applies.
 */
function storedSummarySelection(cwd: string): string[] | undefined {
  for (const scope of ["project", "global"] as const) {
    let layer: Raw | undefined;
    try {
      layer = getSettingsScoped("compactor", scope, cwd);
    } catch {
      layer = undefined;
    }
    if (!layer) continue;
    if (Array.isArray(layer.summarySections)) return layer.summarySections.map(String);
    if (isRecord(layer.sections)) {
      const legacy = layer.sections;
      return SUMMARY_SECTION_IDS.filter((id) => legacy[id] !== false);
    }
  }
  return undefined;
}

/**
 * `summarySections` (string[]) present → the internal `sections` object
 * derives from membership; absent → the default selection stands.
 */
function normalizeSummarySections(config: Raw): void {
  if (!Array.isArray(config.summarySections)) return;
  const on = new Set(config.summarySections.map(String));
  const sections: Raw = {};
  for (const id of SUMMARY_SECTION_IDS) sections[id] = on.has(id);
  config.sections = sections;
}

/**
 * Write translated legacy keys into each scope's file once, so the settings
 * hub shows the effective values. Additive only: old keys stay, untouched.
 */
export function migrateLegacyConfigFiles(cwd: string = process.cwd()): void {
  for (const scope of ["global", "project"] as const) {
    try {
      const raw = getSettingsScoped("compactor", scope, cwd);
      if (!raw) continue;
      // summarySections: derive from a stored legacy sections object once, so
      // the hub shows the effective selection. Additive — booleans stay.
      if (!Array.isArray(raw.summarySections) && isRecord(raw.sections)) {
        const derived = SUMMARY_SECTION_IDS.filter((id) => (raw.sections as Raw)[id] !== false);
        setSettings("compactor", { summarySections: [...derived] }, scope, cwd);
        raw.summarySections = derived;
      }
      if (!("overrideDefaultCompaction" in raw) && !("autoCompaction" in raw)) continue;
      const translated = translateLegacyConfig(raw);
      const patch: Raw = {};
      for (const key of ["method", "trigger", "thresholdPercent", "notify", "summarySections"]) {
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
