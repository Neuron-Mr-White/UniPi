/**
 * @pi-unipi/utility — Settings
 *
 * Namespace `utility` in the settings hub. Sections:
 *   rename — automatic session naming (jev-gated, isolated one-tool session)
 *   skills — skill exposure (judged | all | off)
 *   decisionModel — inherit | custom Decision Model override
 *
 * Legacy inputs migrated on read: `badge.*` (v2/v3-alpha badge overlay),
 * `<cwd>/.unipi/config/util-settings.json`, `.unipi/config/badge.json`, and
 * pi settings.json `unipi.skills.discovery`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getSettings, globalSettingsPath, projectSettingsPath, registerSettings, setSettings, settingsLayers, decisionModelSection, DEFAULT_DECISION_OVERRIDE } from "@pi-unipi/core";

/** Automatic session naming. */
export interface RenameSettings {
  /** Rename after confirmed rounds that start or change the topic. */
  auto: boolean;
  /** Model for the rename session; "" / "inherit" = the session model. */
  model: string;
  /** Mirror the session name to the Herdr pane title / tab label. */
  herdrSync: boolean;
}

/**
 * Skill exposure (migrated from the unipi.skills.discovery boolean):
 *   judged — jev decides which skills stay in the system-prompt catalog
 *   all    — every discovered skill stays (no judging)
 *   off    — old "false" behavior (bundled skills stripped)
 */
export type SkillExposureMode = "judged" | "all" | "off";

export interface SkillDiscoverySection {
  mode: SkillExposureMode;
  /** Minimum jev relevance (noul 0–1) for a skill to stay exposed. */
  threshold: number;
  /** Hard cap on exposed skills; above this the catalog gets judged. */
  maxSkills: number;
  /** Suggest newly relevant hidden skills on later prompts. */
  recheck: boolean;
}

export interface UtilSettings {
  rename: RenameSettings;
  skills: SkillDiscoverySection;
}

export const DEFAULT_RENAME_SETTINGS: RenameSettings = {
  auto: true,
  model: "",
  herdrSync: true,
};

const DEFAULT_SKILL_DISCOVERY: SkillDiscoverySection = {
  mode: "judged",
  threshold: 0.3,
  maxSkills: 12,
  recheck: true,
};

const DEFAULT_SETTINGS: UtilSettings = {
  rename: { ...DEFAULT_RENAME_SETTINGS },
  skills: { ...DEFAULT_SKILL_DISCOVERY },
};

const UTIL_SETTINGS_FILE = ".unipi/config/util-settings.json";
const BADGE_CONFIG_FILE = ".unipi/config/badge.json";

registerSettings({
  namespace: "utility",
  label: "Utility",
  defaults: { ...DEFAULT_SETTINGS, decisionModel: DEFAULT_DECISION_OVERRIDE } as unknown as Record<string, unknown>,
  schema: [
    {
      title: "Session name",
      description: "Automatic naming after rounds that start or change the topic",
      fields: [
        { key: "rename.auto", type: "boolean", label: "Auto-rename", description: "Name the session when a real request starts or changes the topic (greetings and short replies are skipped)" },
        { key: "rename.model", type: "model", label: "Naming model", capability: "text", emptyLabel: "inherit (session model)", emptyOption: "inherit (session model)" },
        { key: "rename.herdrSync", type: "boolean", label: "Herdr sync", description: "Show the session name as the Herdr pane title and tab label" },
        { key: "rename.now", type: "action", label: "Rename now", description: "Name the session from the recent requests", command: "unipi:rename-now" },
      ],
    },
    {
      title: "Skills",
      description: "Skill startup discovery",
      fields: [
        {
          key: "skills.mode",
          type: "enum",
          label: "Skill exposure",
          options: [
            { value: "judged", label: "judged (jev decides)" },
            { value: "all", label: "all (no judging)" },
            { value: "off", label: "off (bundled stripped)" },
          ],
          description: "judged = jev picks the skills exposed per session",
        },
        { key: "skills.threshold", type: "number", label: "Relevance threshold", min: 0, max: 1, description: "Minimum jev relevance for a skill to stay exposed" },
        { key: "skills.maxSkills", type: "number", label: "Max skills exposed", min: 1 },
        { key: "skills.recheck", type: "boolean", label: "Suggest newly relevant skills on later prompts" },
      ],
    },
    decisionModelSection({ title: "Decision model (naming + skills)" }),
  ],
});

function atomicWrite(filePath: string, data: string): void {
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, data, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * One-time import of `unipi.skills.discovery` from pi's settings.json into the
 * engine layout (global scope), so the hub owns the value from here on.
 */
function importLegacySkillDiscovery(): void {
  try {
    const agentDir = process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
    const raw = readJson(path.join(agentDir, "settings.json")) as { unipi?: { skills?: { discovery?: unknown } } } | null;
    const discovery = raw?.unipi?.skills?.discovery;
    if (typeof discovery !== "boolean") return;
    if (settingsLayers("utility", process.cwd()).global) return; // engine value wins
    setSettings("utility", { skills: { mode: discovery ? "judged" : "off" } } as unknown as Record<string, unknown>, "global", process.cwd());
  } catch {
    // Absent/unreadable legacy value — default applies.
  }
}

/**
 * One-time in-file migration: stored `skills.discovery` boolean → `skills.mode`
 * (false → "off", true/absent → "judged").
 */
export function migrateSkillsDiscovery(cwd: string): void {
  for (const file of [globalSettingsPath("utility"), projectSettingsPath(cwd, "utility")]) {
    try {
      const raw = readJson(file) as { skills?: Record<string, unknown> } | null;
      const skills = raw?.skills;
      if (!skills || typeof skills !== "object" || skills.mode !== undefined || skills.discovery === undefined) continue;
      const mode = skills.discovery === false ? "off" : "judged";
      const { discovery: _dropped, ...rest } = skills;
      atomicWrite(file, JSON.stringify({ ...raw, skills: { ...rest, mode } }, null, 2));
    } catch {
      // Corrupt layer — defaults apply.
    }
  }
}

/**
 * One-time in-file migration: `badge.*` (removed badge overlay) → `rename.*`
 * per layer, so an explicit old choice (e.g. autoGen: false) survives the new
 * defaults merge. badgeEnabled/agentTool have no successor and are dropped.
 */
export function migrateBadgeToRename(cwd: string): void {
  for (const file of [globalSettingsPath("utility"), projectSettingsPath(cwd, "utility")]) {
    try {
      const raw = readJson(file) as { badge?: Record<string, unknown>; rename?: unknown } | null;
      if (!raw?.badge || typeof raw.badge !== "object") continue;
      const { badge, ...rest } = raw;
      const rename: Record<string, unknown> = { ...(typeof raw.rename === "object" && raw.rename ? raw.rename as Record<string, unknown> : {}) };
      if (rename.auto === undefined && typeof badge.autoGen === "boolean") rename.auto = badge.autoGen;
      if (rename.herdrSync === undefined && typeof badge.herdrSync === "boolean") rename.herdrSync = badge.herdrSync;
      if (rename.model === undefined && typeof badge.generationModel === "string" && badge.generationModel !== "inherit") rename.model = badge.generationModel;
      atomicWrite(file, JSON.stringify(Object.keys(rename).length ? { ...rest, rename } : rest, null, 2));
    } catch {
      // Corrupt layer — defaults apply.
    }
  }
}

/** One-time import from the legacy in-repo util-settings.json / badge.json. */
function importLegacyUtilSettings(): void {
  const layers = settingsLayers("utility", process.cwd());
  if (layers.global || layers.project) return;
  const legacy = readJson(path.resolve(process.cwd(), UTIL_SETTINGS_FILE))
    ?? (() => {
      const badge = readJson(path.resolve(process.cwd(), BADGE_CONFIG_FILE));
      return badge ? { badge } : null;
    })();
  if (legacy) setSettings("utility", normalizeSettings(legacy) as unknown as Record<string, unknown>, "project", process.cwd());
}

/** Pure normalizer; maps legacy `badge.*` onto `rename.*` when rename is unset. */
export function normalizeSettings(parsed: unknown): UtilSettings {
  const p = (parsed ?? {}) as { rename?: Record<string, unknown>; badge?: Record<string, unknown>; skills?: Record<string, unknown> };
  const rename = p.rename ?? {};
  const badge = p.badge ?? {};
  const bool = (v: unknown, legacy: unknown, d: boolean) => typeof v === "boolean" ? v : typeof legacy === "boolean" ? legacy : d;
  const legacyModel = typeof badge.generationModel === "string" && badge.generationModel !== "inherit" ? badge.generationModel : undefined;
  const model = typeof rename.model === "string" ? rename.model : legacyModel ?? DEFAULT_RENAME_SETTINGS.model;
  const skills = p.skills ?? {};
  return {
    rename: {
      auto: bool(rename.auto, badge.autoGen, DEFAULT_RENAME_SETTINGS.auto),
      model: model === "inherit" ? "" : model,
      herdrSync: bool(rename.herdrSync, badge.herdrSync, DEFAULT_RENAME_SETTINGS.herdrSync),
    },
    skills: {
      mode:
        skills.mode === "judged" || skills.mode === "all" || skills.mode === "off"
          ? skills.mode
          : skills.discovery === false ? "off" : "judged",
      threshold:
        typeof skills.threshold === "number" && skills.threshold >= 0 && skills.threshold <= 1
          ? skills.threshold
          : DEFAULT_SKILL_DISCOVERY.threshold,
      maxSkills:
        typeof skills.maxSkills === "number" && skills.maxSkills >= 1 ? skills.maxSkills : DEFAULT_SKILL_DISCOVERY.maxSkills,
      recheck: typeof skills.recheck === "boolean" ? skills.recheck : DEFAULT_SKILL_DISCOVERY.recheck,
    },
  };
}

export function readUtilSettings(cwd: string = process.cwd()): UtilSettings {
  try {
    importLegacyUtilSettings();
    importLegacySkillDiscovery();
    migrateBadgeToRename(cwd);
    return normalizeSettings(getSettings("utility", cwd));
  } catch {
    return normalizeSettings({});
  }
}

export function readRenameSettings(cwd: string = process.cwd()): RenameSettings {
  return readUtilSettings(cwd).rename;
}
