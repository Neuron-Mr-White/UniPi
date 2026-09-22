/**
 * @pi-unipi/image — Settings
 *
 * Config lives at `~/.unipi/config/image/config.json`. Every read is
 * try/catch-to-defaults so a corrupt file can never break the tools.
 *
 * The config directory is overridable via `UNIPI_IMAGE_CONFIG_DIR` so tests
 * do not have to reach into the real home directory.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Default system prompt for image recognition. */
export const DEFAULT_RECOGNIZE_SYSTEM_PROMPT =
  "You are a precise image analyst assisting a software engineer. " +
  "Describe what is actually visible — never speculate about what is not shown. " +
  "For screenshots, transcribe visible text, UI structure, and any errors verbatim. " +
  "For diagrams, describe the components and their relationships. " +
  "For photographs, describe the subject, setting, and notable detail. " +
  "Be specific and concise; lead with the single most important observation.";

/** Default image-generation model. */
export const DEFAULT_GENERATE_MODEL = "openrouter/google/gemini-3-pro-image";

export interface GenerateSettings {
  /** Whether the image_generate tool is registered. */
  enabled: boolean;
  /** Model as "provider/model-id". */
  model: string;
  /** Directory for saved images. `~` is expanded. */
  outputDir: string;
  /** Whether to also write generated images to disk. */
  saveToDisk: boolean;
}

export interface RecognizeSettings {
  /** Whether the image_recognize tool is registered. */
  enabled: boolean;
  /** Model as "provider/model-id". Empty = use the session's current model. */
  model: string;
  /** System prompt sent with every recognition request. */
  systemPrompt: string;
}

export interface ImageConfig {
  generate: GenerateSettings;
  recognize: RecognizeSettings;
}

export const DEFAULT_CONFIG: ImageConfig = {
  generate: {
    enabled: true,
    model: DEFAULT_GENERATE_MODEL,
    outputDir: "~/.unipi/images",
    saveToDisk: true,
  },
  recognize: {
    enabled: true,
    model: "",
    systemPrompt: DEFAULT_RECOGNIZE_SYSTEM_PROMPT,
  },
};

/** Resolve the config directory, honouring the test override. */
import { getSettings, registerSettings, setSettings } from "@pi-unipi/core";

// Registered with the unified settings hub — canonical path already matched.
registerSettings({
  namespace: "image",
  label: "Image",
  defaults: DEFAULT_CONFIG as unknown as Record<string, unknown>,
  schema: [
    {
      title: "Generate",
      fields: [
        { key: "generate.enabled", type: "boolean", label: "Generate enabled", description: "Register the image_generate tool" },
        { key: "generate.model", type: "model", label: "Generate model", description: "Image generation model" },
        { key: "generate.outputDir", type: "string", label: "Output dir", description: "~ expanded" },
        { key: "generate.saveToDisk", type: "boolean", label: "Save to disk" },
      ],
    },
    {
      title: "Recognize",
      fields: [
        { key: "recognize.enabled", type: "boolean", label: "Recognize enabled", description: "Register the image_recognize tool" },
        { key: "recognize.model", type: "model", label: "Recognize model", emptyLabel: "inherit (session model)" },
      ],
    },
  ],
});

export function getConfigDir(): string {
  const override = process.env.UNIPI_IMAGE_CONFIG_DIR;
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), ".unipi", "config", "image");
}

function getConfigPath(): string {
  return path.join(getConfigDir(), "config.json");
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(target: string): string {
  if (target === "~") return os.homedir();
  if (target.startsWith("~/") || target.startsWith("~\\")) {
    return path.join(os.homedir(), target.slice(2));
  }
  return target;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Merge a loaded section over its defaults, ignoring wrong-typed fields. */
function mergeSection<T extends object>(defaults: T, loaded: unknown): T {
  if (!isRecord(loaded)) return { ...defaults };

  const merged: T = { ...defaults };
  for (const key of Object.keys(defaults) as Array<keyof T & string>) {
    const value = loaded[key];
    if (value === undefined || value === null) continue;
    // Only accept a value whose type matches the default's.
    if (typeof value === typeof defaults[key]) {
      merged[key] = value as T[keyof T & string];
    }
  }
  return merged;
}

/** Load config (engine-layered), falling back to defaults on any problem. */
export function loadConfig(): ImageConfig {
  try {
    const parsed: unknown = getSettings("image", process.cwd());
    if (!isRecord(parsed)) return structuredClone(DEFAULT_CONFIG);
    return {
      generate: mergeSection(DEFAULT_CONFIG.generate, parsed.generate),
      recognize: mergeSection(DEFAULT_CONFIG.recognize, parsed.recognize),
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

/** Persist config. Returns false instead of throwing when the write fails. */
export function saveConfig(config: ImageConfig): boolean {
  try {
    setSettings("image", config as unknown as Record<string, unknown>, "global", process.cwd());
    return true;
  } catch {
    return false;
  }
}

/** Apply a partial update, merging one level deep. */
export function updateConfig(partial: Partial<ImageConfig>): ImageConfig {
  const current = loadConfig();
  const next: ImageConfig = {
    generate: { ...current.generate, ...partial.generate },
    recognize: { ...current.recognize, ...partial.recognize },
  };
  saveConfig(next);
  return next;
}

/** Resolved absolute output directory for generated images. */
export function getOutputDir(config: ImageConfig = loadConfig()): string {
  const dir = config.generate.outputDir?.trim();
  return expandHome(dir && dir.length > 0 ? dir : DEFAULT_CONFIG.generate.outputDir);
}
