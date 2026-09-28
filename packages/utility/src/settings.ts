/**
 * @pi-unipi/utility — Settings
 *
 * Namespace `utility` in the settings hub. Sections:
 *   rename — automatic session naming (jev-gated, isolated one-tool session)
 *   decisionModel — inherit | custom Decision Model override
 * (Skill exposure moved to @pi-unipi/skill-registry, namespace `skills`.)
 *
 * Legacy inputs migrated on read: `badge.*` (v2/v3-alpha badge overlay),
 * `<cwd>/.unipi/config/util-settings.json` and `.unipi/config/badge.json`.
 */

import * as fs from "node:fs";
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

/** /unipi:answer defaults. */
export interface AnswerSettings {
  method: "editor" | "web";
  /** Web form port; 0 = any free port (47321 is tried first over SSH). */
  port: number;
}

export interface UtilSettings {
  rename: RenameSettings;
  answer: AnswerSettings;
}

export const DEFAULT_RENAME_SETTINGS: RenameSettings = {
  auto: true,
  model: "",
  herdrSync: true,
};


export const DEFAULT_ANSWER_SETTINGS: AnswerSettings = { method: "editor", port: 0 };

const DEFAULT_SETTINGS: UtilSettings = {
  rename: { ...DEFAULT_RENAME_SETTINGS },
  answer: { ...DEFAULT_ANSWER_SETTINGS },
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
      title: "Answer",
      description: "/unipi:answer — answer the last reply's questions without scrolling",
      fields: [
        {
          key: "answer.method",
          type: "enum",
          label: "Default method",
          options: [
            { value: "editor", label: "editor (Q/A template)" },
            { value: "web", label: "web form (browser)" },
          ],
          description: "/unipi:answer editor|web overrides it per use",
        },
        { key: "answer.port", type: "number", label: "Web form port", min: 0, max: 65535, zeroLabel: "any free port (47321 over SSH)", description: "Fix it to keep one ssh -L forward working" },
      ],
    },
    decisionModelSection({ title: "Session name — Decision model" }),
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
  const p = (parsed ?? {}) as { rename?: Record<string, unknown>; badge?: Record<string, unknown>; answer?: Record<string, unknown> };
  const answer = p.answer ?? {};
  const rename = p.rename ?? {};
  const badge = p.badge ?? {};
  const bool = (v: unknown, legacy: unknown, d: boolean) => typeof v === "boolean" ? v : typeof legacy === "boolean" ? legacy : d;
  const legacyModel = typeof badge.generationModel === "string" && badge.generationModel !== "inherit" ? badge.generationModel : undefined;
  const model = typeof rename.model === "string" ? rename.model : legacyModel ?? DEFAULT_RENAME_SETTINGS.model;
  return {
    rename: {
      auto: bool(rename.auto, badge.autoGen, DEFAULT_RENAME_SETTINGS.auto),
      model: model === "inherit" ? "" : model,
      herdrSync: bool(rename.herdrSync, badge.herdrSync, DEFAULT_RENAME_SETTINGS.herdrSync),
    },
    answer: {
      method: answer.method === "web" ? "web" : "editor",
      port: typeof answer.port === "number" && answer.port >= 0 && answer.port <= 65535 ? Math.floor(answer.port) : DEFAULT_ANSWER_SETTINGS.port,
    },
  };
}

export function readUtilSettings(cwd: string = process.cwd()): UtilSettings {
  try {
    importLegacyUtilSettings();
    migrateBadgeToRename(cwd);
    return normalizeSettings(getSettings("utility", cwd));
  } catch {
    return normalizeSettings({});
  }
}

export function readRenameSettings(cwd: string = process.cwd()): RenameSettings {
  return readUtilSettings(cwd).rename;
}
