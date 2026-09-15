/**
 * @pi-unipi/fusion — fusion preset store
 *
 * The preset is the user-curated, finite model list the `/unipi:model` picker
 * shows (pi's full catalogue can be 400+ entries). It also remembers the
 * per-model effort (thinking level), the default lead/sidekick pair, the
 * currently active selection, and the MRU list.
 *
 * Layers (deep-merged, project on top; arrays replace, objects merge):
 *   global  ~/.unipi/config/fusion/preset.json
 *   project <cwd>/.unipi/fusion-preset.json
 *
 * Writes go to the layer the user chose (default global). The active
 * selection + recent list are runtime state and always persist globally.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PRESET_SCHEMA_VERSION = 1;

/** pi thinking levels in ascending effort order (used by ←/→ in the picker). */
export const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export type FusionBadge = "new" | "promotion" | "beta";

export const RECENT_LIMIT = 5;

/** `provider/modelId` */
export type ModelKey = string;

export interface FusionPair {
  lead: ModelKey;
  sidekick: ModelKey;
}

export type ActiveSelection =
  | { kind: "single"; model: ModelKey }
  | {
      kind: "fusion";
      lead: ModelKey;
      sidekick: ModelKey;
      /** Fusion-row efforts are independent of per-model memory. */
      leadEffort?: EffortLevel | undefined;
      sidekickEffort?: EffortLevel | undefined;
    };

export interface FusionPreset {
  schema_version: number;
  /** Models offered as lead (also shown as plain single-model rows). */
  lead: ModelKey[];
  /** Models offered as sidekick. */
  sidekick: ModelKey[];
  /** Default pair used when the Fusion row is confirmed without editing. */
  default: Partial<FusionPair>;
  /** Remembered per-model effort. */
  effort: Record<ModelKey, EffortLevel>;
  /** MRU single models / leads, newest first, max RECENT_LIMIT. */
  recent: ModelKey[];
  /** Optional hand-curated model badge metadata. */
  badges: Record<ModelKey, FusionBadge>;
  /** Manual pricing overrides for providers that report no pricing. */
  prices: Record<ModelKey, { input: number; cachedInput: number; output: number }>;
  /** What the user last confirmed in the picker. */
  active?: ActiveSelection | undefined;
}

export function emptyPreset(): FusionPreset {
  return {
    schema_version: PRESET_SCHEMA_VERSION,
    lead: [],
    sidekick: [],
    default: {},
    effort: {},
    recent: [],
    badges: {},
    prices: {},
  };
}

export function globalPresetPath(home = homedir()): string {
  return join(home, ".unipi", "config", "fusion", "preset.json");
}

export function projectPresetPath(cwd: string): string {
  return join(cwd, ".unipi", "fusion-preset.json");
}

export function modelKey(model: { provider: string; id: string }): ModelKey {
  return `${model.provider}/${model.id}`;
}

export function splitModelKey(key: ModelKey): { provider: string; id: string } | undefined {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return undefined;
  return { provider: key.slice(0, slash), id: key.slice(slash + 1) };
}

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.includes("/") && !out.includes(entry)) out.push(entry);
  }
  return out;
}

/** Validate + normalise an arbitrary JSON value into a partial preset. */
export function parsePreset(raw: unknown): Partial<FusionPreset> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<FusionPreset> = {};
  if ("lead" in r) out.lead = stringArray(r["lead"]);
  if ("sidekick" in r) out.sidekick = stringArray(r["sidekick"]);
  if (typeof r["default"] === "object" && r["default"] !== null) {
    const d = r["default"] as Record<string, unknown>;
    out.default = {};
    if (typeof d["lead"] === "string") out.default.lead = d["lead"];
    if (typeof d["sidekick"] === "string") out.default.sidekick = d["sidekick"];
  }
  if (typeof r["effort"] === "object" && r["effort"] !== null) {
    const effort: Record<string, EffortLevel> = {};
    for (const [k, v] of Object.entries(r["effort"] as Record<string, unknown>)) {
      if (isEffortLevel(v)) effort[k] = v;
    }
    out.effort = effort;
  }
  if ("recent" in r) out.recent = stringArray(r["recent"]).slice(0, RECENT_LIMIT);
  if (typeof r["badges"] === "object" && r["badges"] !== null) {
    const badges: Record<ModelKey, FusionBadge> = {};
    for (const [k, v] of Object.entries(r["badges"] as Record<string, unknown>)) {
      if (v === "new" || v === "promotion" || v === "beta") badges[k] = v;
    }
    out.badges = badges;
  }
  if (typeof r["prices"] === "object" && r["prices"] !== null) {
    const prices: FusionPreset["prices"] = {};
    for (const [k, v] of Object.entries(r["prices"] as Record<string, unknown>)) {
      if (typeof v !== "object" || v === null) continue;
      const price = v as Record<string, unknown>;
      const input = price["input"];
      const cachedInput = price["cachedInput"];
      const output = price["output"];
      if ([input, cachedInput, output].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) {
        prices[k] = { input: input as number, cachedInput: cachedInput as number, output: output as number };
      }
    }
    out.prices = prices;
  }
  const active = r["active"];
  if (typeof active === "object" && active !== null) {
    const a = active as Record<string, unknown>;
    if (a["kind"] === "single" && typeof a["model"] === "string") {
      out.active = { kind: "single", model: a["model"] };
    } else if (
      a["kind"] === "fusion" &&
      typeof a["lead"] === "string" &&
      typeof a["sidekick"] === "string"
    ) {
      out.active = {
        kind: "fusion",
        lead: a["lead"],
        sidekick: a["sidekick"],
        ...(isEffortLevel(a["leadEffort"]) ? { leadEffort: a["leadEffort"] } : {}),
        ...(isEffortLevel(a["sidekickEffort"]) ? { sidekickEffort: a["sidekickEffort"] } : {}),
      };
    }
  }
  return out;
}

export function mergePresets(base: FusionPreset, over: Partial<FusionPreset>): FusionPreset {
  return {
    schema_version: PRESET_SCHEMA_VERSION,
    lead: over.lead ?? base.lead,
    sidekick: over.sidekick ?? base.sidekick,
    default: { ...base.default, ...(over.default ?? {}) },
    effort: { ...base.effort, ...(over.effort ?? {}) },
    recent: over.recent ?? base.recent,
    badges: { ...base.badges, ...(over.badges ?? {}) },
    prices: { ...base.prices, ...(over.prices ?? {}) },
    active: over.active ?? base.active,
  };
}

function readJson(path: string): unknown {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export interface LoadedPreset {
  preset: FusionPreset;
  globalPath: string;
  projectPath: string;
  hasProjectLayer: boolean;
}

export function loadPreset(cwd: string, home = homedir()): LoadedPreset {
  const globalPath = globalPresetPath(home);
  const projectPath = projectPresetPath(cwd);
  const globalRaw = readJson(globalPath);
  const projectRaw = readJson(projectPath);
  let preset = mergePresets(emptyPreset(), parsePreset(globalRaw));
  const hasProjectLayer = projectRaw !== undefined;
  if (hasProjectLayer) preset = mergePresets(preset, parsePreset(projectRaw));
  return { preset, globalPath, projectPath, hasProjectLayer };
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/** Persist the curated lists (lead/sidekick/default) to one layer. */
export function saveCuration(
  path: string,
  curation: Pick<FusionPreset, "lead" | "sidekick" | "default">,
): void {
  const existing = parsePreset(readJson(path));
  writeJsonAtomic(path, {
    schema_version: PRESET_SCHEMA_VERSION,
    ...existing,
    lead: curation.lead,
    sidekick: curation.sidekick,
    default: curation.default,
  });
}

/** Persist runtime state (effort / recent / active) — always to the global layer. */
export function saveRuntimeState(
  globalPath: string,
  state: Pick<FusionPreset, "effort" | "recent"> & { active?: ActiveSelection | undefined },
): void {
  const existing = parsePreset(readJson(globalPath));
  writeJsonAtomic(globalPath, {
    schema_version: PRESET_SCHEMA_VERSION,
    lead: existing.lead ?? [],
    sidekick: existing.sidekick ?? [],
    default: existing.default ?? {},
    ...existing,
    effort: state.effort,
    recent: state.recent.slice(0, RECENT_LIMIT),
    active: state.active,
  });
}

// ── pure helpers used by the picker ────────────────────────────────────────

export function pushRecent(recent: readonly ModelKey[], key: ModelKey): ModelKey[] {
  return [key, ...recent.filter((k) => k !== key)].slice(0, RECENT_LIMIT);
}

export function stepEffort(current: EffortLevel, delta: -1 | 1): EffortLevel {
  const index = EFFORT_LEVELS.indexOf(current);
  const next = Math.min(EFFORT_LEVELS.length - 1, Math.max(0, index + delta));
  return EFFORT_LEVELS[next] ?? current;
}

/** Devin-style label: off→None, xhigh→XHigh, max→Max, others capitalised. */
export function effortLabel(level: EffortLevel): string {
  if (level === "off") return "None";
  if (level === "xhigh") return "XHigh";
  if (level === "max") return "Max";
  return level.charAt(0).toUpperCase() + level.slice(1);
}
