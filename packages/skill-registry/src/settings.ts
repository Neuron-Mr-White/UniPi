/**
 * @pi-unipi/skill-registry — settings (namespace `skills`)
 *
 *   proxy          — off (default): pi's skills pass through untouched (only
 *                    exposure judging applies) and vault skills stay hidden.
 *                    on: the per-skill states below apply, vault included.
 *   states.<name>  — { enabled, mustShow } per skill, edited in
 *                    the "Skill settings…" overlay (src/editor.ts). The engine
 *                    merges global + project layers per option, so a project
 *                    can turn a vault skill on (or pin a skill) just for itself.
 *   exposure       — judged | all | off, threshold, maxSkills, recheck.
 *
 * Migrates the pre-registry `utility.skills` block into `skills.exposure`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  decisionModelSection,
  DEFAULT_DECISION_OVERRIDE,
  getSettings,
  globalSettingsPath,
  projectSettingsPath,
  getSettingsScoped,
  registerSettings,
  setSettings,
  unsetSettings,
  type SettingsSection,
} from "@pi-unipi/core";

export type ExposureMode = "judged" | "all" | "off";

export interface ExposureSettings {
  mode: ExposureMode;
  /** Minimum jev relevance (0–1) for a skill to stay listed. */
  threshold: number;
  /** Cap on listed skills; a catalog at or under it is never judged. */
  maxSkills: number;
  /** Announce newly relevant hidden skills on later prompts. */
  recheck: boolean;
}

export interface SkillState {
  /** false = removed from the session entirely (catalog and /skill:name). */
  enabled?: boolean;
  /** true = always listed and enabled, even when exposure judging would hide it. */
  mustShow?: boolean;
}

export interface SkillsSettings {
  proxy: boolean;
  states: Record<string, SkillState>;
  exposure: ExposureSettings;
}

export const DEFAULT_EXPOSURE: ExposureSettings = {
  mode: "judged",
  threshold: 0.8,
  maxSkills: 12,
  recheck: true,
};

export const NAMESPACE = "skills";

const STATIC_SECTIONS: SettingsSection[] = [
  {
    title: "Skill registry",
    description: "Turn skills on or off per project, and keep a vault of extra skills",
    fields: [
      { key: "proxy", type: "boolean", label: "Skill proxy", description: "Apply the per-skill choices below and include ~/.unipi/skill-vault. Off leaves pi's skills as-is and hides the vault." },
    ],
  },
  {
    title: "Exposure",
    description: "Which skills are listed in the system prompt",
    fields: [
      {
        key: "exposure.mode",
        type: "enum",
        label: "Skill exposure",
        options: [
          { value: "judged", label: "judged", description: "jev picks the skills listed for the session" },
          { value: "all", label: "all", description: "list everything, no judging" },
          { value: "off", label: "off", description: "strip bundled skills from the system prompt" },
        ],
        description: "How the session's skill list is picked.",
      },
      { key: "exposure.threshold", type: "number", label: "Relevance threshold", min: 0, max: 1, description: "Minimum jev relevance for a skill to stay listed." },
      { key: "exposure.maxSkills", type: "number", label: "Max skills listed", min: 1, description: "At or under this size the catalog is never judged." },
      { key: "exposure.recheck", type: "boolean", label: "Announce new skills", description: "Tell the agent when a hidden skill becomes relevant on a later prompt." },
    ],
  },
];

registerSettings({
  namespace: NAMESPACE,
  label: "Skills",
  defaults: {
    proxy: false,
    states: {},
    exposure: { ...DEFAULT_EXPOSURE },
    decisionModel: DEFAULT_DECISION_OVERRIDE,
  },
  schema: [
    {
      ...STATIC_SECTIONS[0]!,
      fields: [
        ...STATIC_SECTIONS[0]!.fields,
        { key: "states", type: "action", label: "Skill settings…", description: "Per skill Enabled / Must show, per global or project scope.", command: "unipi:skills-editor" },
      ],
    },
    ...STATIC_SECTIONS.slice(1),
    decisionModelSection({ title: "Skills — Decision model" }),
  ],
});

type Layer = Record<string, SkillState>;

/** The raw per-skill states of each layer (what the editor starts from). */
export function readStateLayers(cwd: string): { global: Layer; project: Layer } {
  const layer = (scope: "global" | "project") => normalizeStates((getSettingsScoped(NAMESPACE, scope, cwd) ?? {}).states);
  return { global: layer("global"), project: layer("project") };
}

const OPTIONS = ["enabled", "mustShow"] as const;

/**
 * Write only what changed: a set option becomes `states.<name>.<opt>`, a
 * cleared one is unset (inherits again). Returns the number of cells written.
 */
export function writeStateLayers(cwd: string, before: { global: Layer; project: Layer }, after: { global: Layer; project: Layer }): number {
  let writes = 0;
  for (const scope of ["global", "project"] as const) {
    const names = new Set([...Object.keys(before[scope]), ...Object.keys(after[scope])]);
    for (const name of names) {
      for (const opt of OPTIONS) {
        const was = before[scope][name]?.[opt];
        const now = after[scope][name]?.[opt];
        if (was === now) continue;
        if (now === undefined) unsetSettings(NAMESPACE, `states.${name}.${opt}`, scope, cwd);
        else setSettings(NAMESPACE, { states: { [name]: { [opt]: now } } }, scope, cwd);
        writes++;
      }
    }
  }
  return writes;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

/**
 * One-time per layer: `utility.skills` (mode/threshold/maxSkills/recheck, or
 * the older `discovery` boolean) → `skills.exposure`. The utility block is
 * removed so the value has a single owner.
 */
export function migrateUtilitySkills(cwd: string): void {
  const pairs: Array<[string, string]> = [
    [globalSettingsPath("utility"), globalSettingsPath(NAMESPACE)],
    [projectSettingsPath(cwd, "utility"), projectSettingsPath(cwd, NAMESPACE)],
  ];
  for (const [from, to] of pairs) {
    try {
      const util = readJson(from);
      const old = util?.skills as Record<string, unknown> | undefined;
      if (!util || !old || typeof old !== "object") continue;
      const exposure: Record<string, unknown> = {};
      if (old.mode === "judged" || old.mode === "all" || old.mode === "off") exposure.mode = old.mode;
      else if (old.discovery === false) exposure.mode = "off";
      for (const key of ["threshold", "maxSkills", "recheck"]) if (old[key] !== undefined) exposure[key] = old[key];
      const target = readJson(to) ?? {};
      const existing = (target.exposure as Record<string, unknown> | undefined) ?? {};
      writeJson(to, { ...target, exposure: { ...exposure, ...existing } });
      const { skills: _moved, ...rest } = util;
      writeJson(from, rest);
    } catch {
      // Corrupt layer — defaults apply.
    }
  }
}

/** v2: pi settings.json `unipi.skills.discovery` → global `skills.exposure.mode`, once. */
function importPiSettingsDiscovery(): void {
  try {
    const agentDir = process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
    const raw = readJson(path.join(agentDir, "settings.json")) as { unipi?: { skills?: { discovery?: unknown } } } | null;
    const discovery = raw?.unipi?.skills?.discovery;
    if (typeof discovery !== "boolean") return;
    const file = globalSettingsPath(NAMESPACE);
    const layer = readJson(file) ?? {};
    const exposure = (layer.exposure as Record<string, unknown> | undefined) ?? {};
    if (exposure.mode !== undefined) return;
    writeJson(file, { ...layer, exposure: { ...exposure, mode: discovery ? "judged" : "off" } });
  } catch {
    // absent / unreadable — defaults apply
  }
}

export function normalizeExposure(raw: unknown): ExposureSettings {
  const e = (raw ?? {}) as Record<string, unknown>;
  return {
    mode: e.mode === "judged" || e.mode === "all" || e.mode === "off" ? e.mode : DEFAULT_EXPOSURE.mode,
    threshold: typeof e.threshold === "number" && e.threshold >= 0 && e.threshold <= 1 ? e.threshold : DEFAULT_EXPOSURE.threshold,
    maxSkills: typeof e.maxSkills === "number" && e.maxSkills >= 1 ? Math.floor(e.maxSkills) : DEFAULT_EXPOSURE.maxSkills,
    recheck: typeof e.recheck === "boolean" ? e.recheck : DEFAULT_EXPOSURE.recheck,
  };
}

/**
 * Per-skill states. Migrates on read: the legacy "on" | "unlisted" | "off"
 * strings, and the dropped `discoverable` flag — `discoverable: false` was the
 * old unlisted state and now means disabled, unless mustShow (which wins).
 */
export function normalizeStates(raw: unknown): Record<string, SkillState> {
  const out: Record<string, SkillState> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === "off" || value === "unlisted") out[name] = { enabled: false };
    else if (value === "on") out[name] = { enabled: true };
    else if (value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      const state: SkillState = {};
      if (typeof v.enabled === "boolean") state.enabled = v.enabled;
      if (typeof v.mustShow === "boolean") state.mustShow = v.mustShow;
      if (v.discoverable === false && state.enabled !== false && !state.mustShow) state.enabled = false;
      out[name] = state;
    }
  }
  return out;
}

export function readSkillsSettings(cwd: string = process.cwd()): SkillsSettings {
  try {
    migrateUtilitySkills(cwd);
    importPiSettingsDiscovery();
    const raw = getSettings(NAMESPACE, cwd) as Record<string, unknown>;
    return {
      proxy: raw.proxy === true,
      states: normalizeStates(raw.states),
      exposure: normalizeExposure(raw.exposure),
    };
  } catch {
    return { proxy: false, states: {}, exposure: { ...DEFAULT_EXPOSURE } };
  }
}

