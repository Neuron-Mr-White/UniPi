/**
 * @pi-unipi/utility — image settings (namespace `image`, unchanged from the
 * former @pi-unipi/image package, so existing configs keep working)
 *
 *   generate  — text → image      (models whose output includes image)
 *   edit      — image+text → image (models that take an image and output one)
 *   recognize — image → text       (vision chat models; hidden while the
 *                                   session model can see images itself)
 *   keys      — OpenRouter / fal keys (empty = pi's login or the environment)
 *   *.baseUrl — optional custom endpoint: when set, the model id is sent to
 *               that endpoint as typed, with its own key.
 */

import * as os from "node:os";
import * as path from "node:path";
import { getSettings, registerSettings } from "@pi-unipi/core";

export const DEFAULT_RECOGNIZE_SYSTEM_PROMPT =
  "You are a precise image analyst assisting a software engineer. " +
  "Describe what is actually visible — never speculate about what is not shown. " +
  "For screenshots, transcribe visible text, UI structure, and any errors verbatim. " +
  "For diagrams, describe the components and their relationships. " +
  "For photographs, describe the subject, setting, and notable detail. " +
  "Be specific and concise; lead with the single most important observation.";

/** Cheap, fast defaults (FLUX.2 klein 4B does both text→image and edits). */
export const DEFAULT_GENERATE_MODEL = "openrouter/black-forest-labs/flux.2-klein-4b";
export const DEFAULT_EDIT_MODEL = "openrouter/black-forest-labs/flux.2-klein-4b";

export type ImageApi = "openai-images" | "openrouter" | "fal";

export interface EndpointSettings {
  /** Custom endpoint; "" = route by the model's provider. */
  baseUrl: string;
  apiKey: string;
  api: ImageApi;
}

export interface GenerateSettings extends EndpointSettings {
  enabled: boolean;
  model: string;
  outputDir: string;
  saveToDisk: boolean;
}

export interface EditSettings extends EndpointSettings {
  enabled: boolean;
  model: string;
}

export interface RecognizeSettings {
  enabled: boolean;
  /** "" = the session model. */
  model: string;
  systemPrompt: string;
  /** Custom OpenAI-compatible chat endpoint; "" = the model's provider. */
  baseUrl: string;
  apiKey: string;
}

export interface ImageConfig {
  generate: GenerateSettings;
  edit: EditSettings;
  recognize: RecognizeSettings;
  keys: { openrouter: string; fal: string };
}

const NO_ENDPOINT: EndpointSettings = { baseUrl: "", apiKey: "", api: "openai-images" };

export const DEFAULT_CONFIG: ImageConfig = {
  generate: { enabled: true, model: DEFAULT_GENERATE_MODEL, outputDir: "~/.unipi/images", saveToDisk: true, ...NO_ENDPOINT },
  edit: { enabled: true, model: DEFAULT_EDIT_MODEL, ...NO_ENDPOINT },
  recognize: { enabled: true, model: "", systemPrompt: DEFAULT_RECOGNIZE_SYSTEM_PROMPT, baseUrl: "", apiKey: "" },
  keys: { openrouter: "", fal: "" },
};

const API_OPTIONS = [
  { value: "openai-images", label: "OpenAI images", description: "POST /images/generations with the model id as typed" },
  { value: "openrouter", label: "OpenRouter chat", description: "chat completions that return image modalities" },
  { value: "fal", label: "fal", description: "fal.run/<model> REST endpoint" },
];

/** `off` when unset, else the endpoint's host — page summary for Custom endpoint. */
function endpointSummary(baseUrl: unknown): string {
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") return "off";
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.length > 30 ? `${baseUrl.slice(0, 29)}…` : baseUrl;
  }
}

registerSettings({
  namespace: "image",
  label: "Image",
  defaults: DEFAULT_CONFIG as unknown as Record<string, unknown>,
  schema: [
    {
      title: "Generate",
      description: "Text → image (image_generate)",
      fields: [
        { key: "generate.enabled", type: "boolean", label: "Enabled", description: "Give the agent the image_generate tool. Applies from the next session start." },
        { key: "generate.model", type: "model", label: "Model", capability: "image-output", description: "Models whose output includes an image." },
        { key: "generate.outputDir", type: "string", label: "Save to folder", description: "Folder generated images are written to. ~ expands to your home." },
        { key: "generate.saveToDisk", type: "boolean", label: "Save to disk", description: "Write results to the folder; off hands them to the agent only." },
        {
          key: "generate.endpoint",
          type: "page",
          label: "Custom endpoint…",
          description: "Send the model id as typed to your own gateway instead of its provider.",
          summary: (values) => endpointSummary((values as { generate?: { baseUrl?: string } }).generate?.baseUrl),
          sections: [
            {
              title: "Generate endpoint",
              fields: [
                { key: "generate.baseUrl", type: "string", label: "Base URL", emptyLabel: "none (use the model's provider)", description: "OpenAI-compatible base URL the model id is sent to." },
                { key: "generate.apiKey", type: "secret", label: "API key", emptyLabel: "none", description: "Key for the custom endpoint; without it the request goes out unsigned." },
                { key: "generate.api", type: "enum", label: "API", description: "Wire shape the custom endpoint speaks.", options: API_OPTIONS },
              ],
            },
          ],
        },
      ],
    },
    {
      title: "Edit",
      description: "Image + text → image (image_edit)",
      fields: [
        { key: "edit.enabled", type: "boolean", label: "Enabled", description: "Give the agent the image_edit tool. Applies from the next session start." },
        { key: "edit.model", type: "model", label: "Model", capability: "image-edit", description: "Models that take an image and return an image." },
        {
          key: "edit.endpoint",
          type: "page",
          label: "Custom endpoint…",
          description: "Send the model id as typed to your own gateway instead of its provider.",
          summary: (values) => endpointSummary((values as { edit?: { baseUrl?: string } }).edit?.baseUrl),
          sections: [
            {
              title: "Edit endpoint",
              fields: [
                { key: "edit.baseUrl", type: "string", label: "Base URL", emptyLabel: "none (use the model's provider)", description: "OpenAI-compatible base URL the model id is sent to." },
                { key: "edit.apiKey", type: "secret", label: "API key", emptyLabel: "none", description: "Key for the custom endpoint; without it the request goes out unsigned." },
                { key: "edit.api", type: "enum", label: "API", description: "Wire shape the custom endpoint speaks.", options: API_OPTIONS },
              ],
            },
          ],
        },
      ],
    },
    {
      title: "Recognize",
      description: "Image → text (image_recognize; hidden while the session model can see images)",
      fields: [
        { key: "recognize.enabled", type: "boolean", label: "Enabled", description: "Give text-only models the image_recognize tool. Applies from the next session start." },
        { key: "recognize.model", type: "model", label: "Model", capability: "image-input", emptyLabel: "inherit (session model)", emptyOption: "inherit (session model)", description: "Vision model that describes images; empty uses the session model." },
        { key: "recognize.systemPrompt", type: "string", label: "System prompt", emptyLabel: "built-in analyst prompt", description: "Tells the vision model how to describe screenshots and diagrams." },
        {
          key: "recognize.endpoint",
          type: "page",
          label: "Custom endpoint…",
          description: "Chat endpoint the vision call goes to instead of the model's provider.",
          summary: (values) => endpointSummary((values as { recognize?: { baseUrl?: string } }).recognize?.baseUrl),
          sections: [
            {
              title: "Recognize endpoint",
              fields: [
                { key: "recognize.baseUrl", type: "string", label: "Base URL", emptyLabel: "none (use the model's provider)", description: "OpenAI-compatible chat endpoint the vision call goes to." },
                { key: "recognize.apiKey", type: "secret", label: "API key", emptyLabel: "none", description: "Key for the custom endpoint; without it the request goes out unsigned." },
              ],
            },
          ],
        },
      ],
    },
    {
      title: "Keys",
      description: "Used when the model's provider is OpenRouter or fal",
      advanced: true,
      fields: [
        { key: "keys.openrouter", type: "secret", label: "OpenRouter key", emptyLabel: "pi login or OPENROUTER_API_KEY", description: "Stored key wins over the environment for OpenRouter models." },
        { key: "keys.fal", type: "secret", label: "fal key", emptyLabel: "FAL_KEY / FAL_API_KEY", description: "Stored key wins over the environment for fal models." },
      ],
    },
  ],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Merge a loaded section over its defaults, ignoring wrong-typed fields. */
function mergeSection<T extends object>(defaults: T, loaded: unknown): T {
  const merged: T = { ...defaults };
  if (!isRecord(loaded)) return merged;
  for (const key of Object.keys(defaults) as Array<keyof T & string>) {
    const value = loaded[key];
    if (value !== undefined && value !== null && typeof value === typeof defaults[key]) merged[key] = value as T[keyof T & string];
  }
  return merged;
}

export function loadConfig(cwd: string = process.cwd()): ImageConfig {
  try {
    const parsed = getSettings("image", cwd);
    if (!isRecord(parsed)) return structuredClone(DEFAULT_CONFIG);
    const config: ImageConfig = {
      generate: mergeSection(DEFAULT_CONFIG.generate, parsed.generate),
      edit: mergeSection(DEFAULT_CONFIG.edit, parsed.edit),
      recognize: mergeSection(DEFAULT_CONFIG.recognize, parsed.recognize),
      keys: mergeSection(DEFAULT_CONFIG.keys, parsed.keys),
    };
    for (const section of [config.generate, config.edit]) {
      if (!["openai-images", "openrouter", "fal"].includes(section.api)) section.api = "openai-images";
    }
    return config;
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function expandHome(target: string): string {
  if (target === "~") return os.homedir();
  if (target.startsWith("~/") || target.startsWith("~\\")) return path.join(os.homedir(), target.slice(2));
  return target;
}

export function getOutputDir(config: ImageConfig = loadConfig()): string {
  const dir = config.generate.outputDir?.trim();
  return expandHome(dir && dir.length > 0 ? dir : DEFAULT_CONFIG.generate.outputDir);
}
