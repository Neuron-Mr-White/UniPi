/**
 * Decision Model — one shared setting for the fast calibrated classifier
 * (TypeSafe jev today) that several modules consult: long-horizon mode
 * routing, permission auto-judging, skill exposure, the watchdog, kanboard
 * strategy choice and compactor pruning.
 *
 * The model lives in its own settings namespace ("decision-model"), not in
 * any consumer, so a different decision model can be adopted in one place.
 * Each consumer carries a `decisionModel` block: `source: "inherit"` (the
 * default) uses the shared model; `source: "custom"` overrides provider,
 * model, base URL, key or timeout for that consumer only (empty fields fall
 * back to the shared value).
 */

import { getSettings, getSettingsScoped, registerSettings, setSettings } from "../settings/engine.js";
import type { SettingsField, SettingsSection } from "../settings/schema.js";
import { globalSettingsPath } from "../settings/paths.js";
import type { JevSettings } from "./client.js";

export const DECISION_MODEL_NAMESPACE = "decision-model";

export type DecisionProvider = JevSettings["provider"];

export interface DecisionModelSettings {
  provider: DecisionProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

export interface DecisionModelOverride extends DecisionModelSettings {
  source: "inherit" | "custom";
}

export const DEFAULT_DECISION_MODEL: DecisionModelSettings = {
  provider: "openrouter",
  model: "typesafe/jev-1.13",
  baseUrl: "",
  apiKey: "",
  timeoutMs: 0,
};

/** The per-consumer block's defaults: inherit, custom fields empty. */
export const DEFAULT_DECISION_OVERRIDE: DecisionModelOverride = {
  source: "inherit",
  provider: "openrouter",
  model: "",
  baseUrl: "",
  apiKey: "",
  timeoutMs: 0,
};

const PROVIDER_OPTIONS = [
  { value: "openrouter", label: "openrouter", description: "decisions endpoint for jev and gateway models" },
  { value: "typesafe", label: "typesafe", description: "native systemone transport" },
  { value: "custom", label: "custom", description: "your own OpenRouter-shape gateway (Base URL + key)" },
] as const;

const MODEL_PRESETS = {
  typesafe: ["jev-latest"],
  openrouter: ["typesafe/jev-1.13"],
  custom: ["typesafe/jev-1.13"],
} as const;

/** Provider / model / base URL / key / timeout fields under a key prefix. */
function modelFields(prefix: string, emptyModel?: string): SettingsField[] {
  const k = (name: string) => (prefix ? `${prefix}.${name}` : name);
  return [
    { key: k("provider"), type: "enum", label: "Provider", options: PROVIDER_OPTIONS, description: "Transport the judge call goes through." },
    {
      key: k("model"),
      type: "model",
      label: "Model",
      description: "A decision (classifier) model — jev; custom… for others.",
      providerKey: k("provider"),
      presetsByProvider: MODEL_PRESETS,
      ...(emptyModel ? { emptyLabel: emptyModel, emptyOption: emptyModel } : {}),
    },
    { key: k("baseUrl"), type: "string", label: "Base URL", description: "Gateway URL; required when provider = custom.", emptyLabel: "provider default" },
    { key: k("apiKey"), type: "secret", label: "API key", description: "Stored key wins over the environment (OPENROUTER_API_KEY / TYPESAFE_API_KEY).", emptyLabel: "environment" },
    { key: k("timeoutMs"), type: "number", label: "Timeout", unit: "ms", min: 0, zeroLabel: "auto (1s native / 6s decisions)", description: "Abort budget for one judge call." },
  ];
}

registerSettings({
  namespace: DECISION_MODEL_NAMESPACE,
  label: "Decision Model",
  defaults: DEFAULT_DECISION_MODEL as unknown as Record<string, unknown>,
  schema: [
    {
      title: "Decision model",
      description:
        "A fast calibrated classifier used for mode routing, permission judging, skill exposure, the watchdog, kanboard strategy and compaction pruning. Each of those can inherit this or use its own.",
      fields: modelFields(""),
    },
  ],
});

/**
 * The hub section a consumer adds to its own settings: inherit the shared
 * Decision Model, or use a custom one (fields empty = shared value).
 */
export function decisionModelSection(opts: { title?: string; advanced?: boolean } = {}): SettingsSection {
  return {
    title: opts.title ?? "Decision model",
    description: "inherit = the shared Decision Model settings · custom = override below for this module only (empty = shared value)",
    advanced: opts.advanced ?? true,
    fields: [
      {
        key: "decisionModel.source",
        type: "enum",
        label: "Decision model",
        description: "Whether this module uses the shared Decision Model or its own.",
        options: [
          { value: "inherit", label: "inherit", description: "use the shared Decision Model settings" },
          { value: "custom", label: "custom", description: "override below for this module only" },
        ],
      },
      ...modelFields("decisionModel", "shared model"),
    ],
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function normalize(raw: Record<string, unknown>, fallback: DecisionModelSettings): DecisionModelSettings {
  const provider: DecisionProvider =
    raw.provider === "typesafe" || raw.provider === "custom" || raw.provider === "openrouter" ? raw.provider : fallback.provider;
  const str = (v: unknown, dflt: string) => (typeof v === "string" && v.trim() ? v.trim() : dflt);
  const model = str(raw.model, provider === fallback.provider ? fallback.model : provider === "typesafe" ? "jev-latest" : "typesafe/jev-1.13");
  return {
    provider,
    model,
    baseUrl: str(raw.baseUrl, fallback.baseUrl),
    apiKey: str(raw.apiKey, fallback.apiKey),
    timeoutMs: typeof raw.timeoutMs === "number" && raw.timeoutMs > 0 ? raw.timeoutMs : fallback.timeoutMs,
  };
}

/** Latched per global settings file (one per HOME), not per process. */
const migrated = new Set<string>();

/**
 * One-time move of the pre-namespace settings (long-horizon `judge.*`
 * transport fields) into "decision-model". Additive: long-horizon keeps its
 * copy; runs only while the decision-model global file does not exist.
 */
export function migrateLegacyDecisionModel(cwd: string): void {
  const target = globalSettingsPath(DECISION_MODEL_NAMESPACE);
  if (migrated.has(target)) return;
  migrated.add(target);
  try {
    if (getSettingsScoped(DECISION_MODEL_NAMESPACE, "global", cwd)) return;
    const judge = getSettingsScoped("long-horizon", "global", cwd)?.judge;
    if (!isRecord(judge)) return;
    const patch: Record<string, unknown> = {};
    for (const key of ["provider", "model", "baseUrl", "apiKey", "timeoutMs"]) {
      if (judge[key] !== undefined && judge[key] !== "") patch[key] = judge[key];
    }
    if (patch.provider === "auto") patch.provider = "openrouter";
    if (Object.keys(patch).length > 0) setSettings(DECISION_MODEL_NAMESPACE, patch, "global", cwd);
  } catch {
    // Unreadable legacy settings: defaults apply.
  }
}

/** The shared Decision Model. */
export function readDecisionModel(cwd: string): DecisionModelSettings {
  migrateLegacyDecisionModel(cwd);
  return normalize(getSettings(DECISION_MODEL_NAMESPACE, cwd), DEFAULT_DECISION_MODEL);
}

/**
 * The Decision Model a consumer should use: its own `decisionModel` block
 * when `source: "custom"`, otherwise the shared one.
 */
export function resolveDecisionModel(cwd: string, namespace?: string): DecisionModelSettings {
  const shared = readDecisionModel(cwd);
  if (!namespace) return shared;
  const block = getSettings(namespace, cwd)?.decisionModel;
  if (!isRecord(block) || block.source !== "custom") return shared;
  return normalize(block, shared);
}

/** @deprecated Use resolveDecisionModel(cwd, namespace). */
export const readJudgeJevSettings = (cwd: string): DecisionModelSettings => readDecisionModel(cwd);
