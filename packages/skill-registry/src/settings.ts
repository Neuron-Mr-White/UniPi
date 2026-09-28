/**
 * @pi-unipi/skill-registry — settings (namespace `skills`)
 *
 *   proxy          — off (default): pi's skills pass through untouched (only
 *                    exposure judging applies) and vault skills stay hidden.
 *                    on: the per-skill states below apply, vault included.
 *   states.<name>  — "on" | "unlisted" | "off" per skill, one hub row each
 *                    (listed by where the skill lives). The engine merges
 *                    global + project layers, so a project can turn a vault
 *                    skill on (or a global skill off) just for that repo.
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
  registerSettings,
  type SettingsField,
  type SettingsSection,
} from "@pi-unipi/core";
import { skillSource, type CatalogSkill, type SkillSource } from "./registry.js";

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

/**
 *   on       — listed for the model and runnable
 *   unlisted — not in the system prompt; /skill:name still works
 *   off      — removed from the session entirely (/skill:name blocked too)
 */
export type SkillState = "on" | "unlisted" | "off";

export interface SkillsSettings {
  proxy: boolean;
  states: Record<string, SkillState>;
  exposure: ExposureSettings;
}

export const DEFAULT_EXPOSURE: ExposureSettings = {
  mode: "judged",
  threshold: 0.3,
  maxSkills: 12,
  recheck: true,
};

export const NAMESPACE = "skills";

const STATIC_SECTIONS: SettingsSection[] = [
  {
    title: "Skill registry",
    description: "Turn skills on or off per project, and keep a vault of extra skills",
    fields: [
      { key: "proxy", type: "boolean", label: "Skill proxy", description: "Apply the per-skill choices below and include ~/.unipi/skill-vault (off = pi's skills as-is, vault hidden)" },
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
          { value: "judged", label: "judged (jev decides)" },
          { value: "all", label: "all (no judging)" },
          { value: "off", label: "off (bundled stripped)" },
        ],
        description: "judged = jev picks the skills listed for the session",
      },
      { key: "exposure.threshold", type: "number", label: "Relevance threshold", min: 0, max: 1, description: "Minimum jev relevance for a skill to stay listed" },
      { key: "exposure.maxSkills", type: "number", label: "Max skills listed", min: 1 },
      { key: "exposure.recheck", type: "boolean", label: "Announce newly relevant skills on later prompts" },
    ],
  },
];

const STATE_OPTIONS = [
  { value: "on", label: "on · listed" },
  { value: "unlisted", label: "on · unlisted" },
  { value: "off", label: "off" },
];

const SOURCE_TITLE: Record<SkillSource, string> = {
  vault: "Vault (off until turned on)",
  project: "Project skills",
  user: "User skills",
  unipi: "UniPi skills",
  package: "Package skills",
};

/**
 * (Re)register the namespace with one row per known skill, grouped by where
 * it lives. Called at session start and whenever the catalog changes, so the
 * hub always lists the current skills. Defaults encode the source rule
 * (vault off, everything else on), so "d default" in the hub does the right thing.
 */
export function registerSkillsSettings(skills: readonly CatalogSkill[] = [], cwd = process.cwd(), vault = ""): void {
  const bySource = new Map<SkillSource, SettingsField[]>();
  const defaults: Record<string, SkillState> = {};
  const seen = new Set<string>();
  for (const skill of [...skills].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!skill.name || skill.name.includes(".") || seen.has(skill.name)) continue;
    seen.add(skill.name);
    const source = skillSource(skill, cwd, vault);
    defaults[skill.name] = source === "vault" ? "off" : "on";
    const fields = bySource.get(source) ?? [];
    fields.push({
      key: `states.${skill.name}`,
      type: "enum",
      label: skill.name,
      options: STATE_OPTIONS,
      clearable: true,
      description: skill.description.replace(/\s+/g, " ").slice(0, 160),
    });
    bySource.set(source, fields);
  }
  const lists: SettingsSection[] = (["project", "user", "vault", "unipi", "package"] as SkillSource[])
    .filter((src) => bySource.has(src))
    .map((src) => ({ title: SOURCE_TITLE[src], description: "Applies while the skill proxy is on", fields: bySource.get(src)! }));
  registerSettings({
    namespace: NAMESPACE,
    label: "Skills",
    defaults: {
      proxy: false,
      states: defaults,
      exposure: { ...DEFAULT_EXPOSURE },
      decisionModel: DEFAULT_DECISION_OVERRIDE,
    },
    schema: [...STATIC_SECTIONS, ...lists, decisionModelSection({ title: "Skills — Decision model" })],
  });
}

registerSkillsSettings();

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

/** Per-skill states; accepts the earlier { enabled, discoverable } shape. */
export function normalizeStates(raw: unknown): Record<string, SkillState> {
  const out: Record<string, SkillState> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === "on" || value === "unlisted" || value === "off") out[name] = value;
    else if (value && typeof value === "object") {
      const v = value as { enabled?: unknown; discoverable?: unknown };
      if (v.enabled === false) out[name] = "off";
      else if (v.discoverable === false) out[name] = "unlisted";
      else if (v.enabled === true) out[name] = "on";
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

