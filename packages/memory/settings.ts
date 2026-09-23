/**
 * @unipi/memory — Embedding settings
 *
 * Manages embedding configuration: provider, model, API key.
 * Stored in ~/.unipi/memory/config.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getSettings, registerSettings, setSettings, settingsLayers } from "@pi-unipi/core";

/** Embedding provider type */
export type EmbeddingProvider = "none" | "inherit" | "openrouter" | "custom";

/** OpenRouter's published embeddings catalog (GET /api/v1/embeddings/models). */
export const EMBEDDING_PRESETS = [
  "openai/text-embedding-3-small",
  "openai/text-embedding-3-large",
  "qwen/qwen3-embedding-8b",
  "qwen/qwen3-embedding-4b",
  "google/gemini-embedding-001",
  "baai/bge-m3",
  "mistralai/mistral-embed-2312",
  "nvidia/nemotron-3-embed-1b:free",
  "liquid/lfm-2.5-embedding-350m:free",
] as const;

/** Embedding configuration */
export interface EmbeddingConfig {
  /** Provider for embeddings */
  provider: EmbeddingProvider;
  /** Model ID (e.g. "openai/text-embedding-3-small") */
  model: string;
  /** OpenRouter API key (encrypted or plaintext) */
  apiKey?: string;
  /** Custom gateway base URL (provider=custom); empty = provider default */
  baseUrl: string;
  /** Embedding dimensions (default 384 for compatibility) */
  dimensions: number;
  /** Model that was used to generate existing embeddings */
  lastModel?: string;
  /** Whether to show migration warning on startup */
  suppressMigrationWarning?: boolean;
  /** Keep the MemPalace backend current via a daily PyPI check + uv upgrade */
  mempalaceAutoUpdate?: boolean;
}

/** Default configuration */
const DEFAULT_CONFIG: EmbeddingConfig = {
  provider: "none",
  model: "openai/text-embedding-3-small",
  baseUrl: "",
  dimensions: 384,
  suppressMigrationWarning: false,
  mempalaceAutoUpdate: true,
};

/** Known embedding models on OpenRouter */
export const OPENROUTER_EMBEDDING_MODELS = [
  {
    id: "openai/text-embedding-3-small",
    name: "OpenAI text-embedding-3-small",
    dimensions: 1536,
    costPer1k: "$0.00002",
    description: "Fast, cheap, good quality. Supports custom dimensions.",
  },
  {
    id: "openai/text-embedding-3-large",
    name: "OpenAI text-embedding-3-large",
    dimensions: 3072,
    costPer1k: "$0.00013",
    description: "Highest quality. Supports custom dimensions.",
  },
  {
    id: "openai/text-embedding-ada-002",
    name: "OpenAI text-embedding-ada-002 (legacy)",
    dimensions: 1536,
    costPer1k: "$0.0001",
    description: "Legacy model. Does NOT support custom dimensions.",
  },
];

/** Get config file path */
function getConfigPath(): string {
  return path.join(os.homedir(), ".unipi", "memory", "config.json");
}

// Registered with the unified settings hub. Memory's config lived under its
// own root (~/.unipi/memory/config.json) — imported once into the engine
// layout on first read, legacy file left in place for MemPalace tooling.
registerSettings({
  namespace: "memory",
  label: "Memory",
  defaults: DEFAULT_CONFIG as unknown as Record<string, unknown>,
  schema: [
    {
      title: "Embeddings",
      fields: [
        {
          key: "provider",
          type: "enum",
          label: "Provider",
          options: [
            { value: "none", label: "none (fuzzy-only)" },
            { value: "inherit", label: "inherit (pi registry provider)" },
            { value: "openrouter", label: "openrouter" },
            { value: "custom", label: "custom (Base URL + key)" },
          ],
          description: "Semantic search over stored memories",
        },
        {
          key: "model",
          type: "model",
          label: "Model",
          capability: "text",
          providerKey: "provider",
          presetsByProvider: {
            openrouter: EMBEDDING_PRESETS,
            custom: [],
          },
        },
        { key: "baseUrl", type: "string", label: "Base URL", emptyLabel: "provider default", description: "required when provider=custom" },
        { key: "dimensions", type: "number", label: "Dimensions", min: 1 },
        { key: "apiKey", type: "secret", label: "API key", emptyLabel: "unset (no semantic search)" },
        { key: "mempalaceAutoUpdate", type: "boolean", label: "MemPalace auto-update", description: "Daily PyPI check + uv upgrade" },
      ],
    },
  ],
});

/** One-time import from the legacy ~/.unipi/memory/config.json root. */
function importLegacyMemoryConfig(): void {
  const layers = settingsLayers("memory", process.cwd());
  if (layers.global || layers.project) return;
  try {
    const raw = fs.readFileSync(getConfigPath(), "utf-8");
    const parsed = JSON.parse(raw);
    setSettings("memory", parsed as Record<string, unknown>, "global", process.cwd());
  } catch {
    // Absent/unreadable legacy config — defaults apply.
  }
}

/** Load embedding config */
export function loadEmbeddingConfig(): EmbeddingConfig {
  try {
    importLegacyMemoryConfig();
    const parsed = getSettings("memory", process.cwd());
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    // Ignore parse errors
  }
  return { ...DEFAULT_CONFIG };
}

/** Save embedding config */
export function saveEmbeddingConfig(config: EmbeddingConfig): void {
  setSettings("memory", config as unknown as Record<string, unknown>, "global", process.cwd());
}

/** Update partial config */
export function updateEmbeddingConfig(partial: Partial<EmbeddingConfig>): EmbeddingConfig {
  const config = loadEmbeddingConfig();
  const updated = { ...config, ...partial };
  saveEmbeddingConfig(updated);
  return updated;
}

/** Check if embeddings are configured and usable (any non-none provider). */
export function isEmbeddingReady(): boolean {
  const config = loadEmbeddingConfig();
  if (!config.model) return false;
  return !!resolveEmbeddingEndpoint(config, piRegistryReader)?.apiKey;
}

// ─── Endpoint resolution (pure, testable) ────────────────────────────────

export interface EmbeddingEndpoint {
  readonly url: string;
  readonly apiKey?: string;
}

/** A pi registry provider's endpoint bits (from ~/.pi/agent/models.json). */
export interface RegistryProviderInfo {
  readonly baseUrl?: string;
  readonly apiKey?: string;
}

export type RegistryReader = (provider: string) => RegistryProviderInfo | undefined;

const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";

/**
 * Embeddings URL for a gateway base. A base already ending in a version
 * segment (`/v1`, `/api/v1`) is the API root → append `/embeddings`; a bare
 * host gets `/v1/embeddings` (same convention as the judge's chat URL).
 */
export function embeddingsUrl(base: string): string {
  const trimmed = base.trim().replace(/\/$/, "");
  if (/\/(?:api\/)?v\d+$/.test(trimmed)) return `${trimmed}/embeddings`;
  return `${trimmed}/v1/embeddings`;
}

/** models.json provider keys use `$VAR` for environment indirection. */
export function resolveEnvApiKey(
  key: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (!key) return undefined;
  if (key.startsWith("$")) {
    const name = key.slice(1);
    return name ? env[name] : undefined;
  }
  return key;
}

/**
 * Resolve where (and with what key) an embedding call goes for a config.
 * Returns null when the provider is none or the config is incomplete —
 * callers treat that as "semantic search unavailable".
 */
export function resolveEmbeddingEndpoint(
  config: EmbeddingConfig,
  registryReader: RegistryReader,
  env: Record<string, string | undefined> = process.env,
): EmbeddingEndpoint | null {
  if (config.provider === "none") return null;
  if (config.provider === "openrouter") {
    return {
      url: OPENROUTER_EMBEDDINGS_URL,
      apiKey: config.apiKey || env.OPENROUTER_API_KEY || env.OPEN_ROUTER_API_KEY,
    };
  }
  if (config.provider === "custom") {
    if (!config.baseUrl.trim()) return null;
    return { url: embeddingsUrl(config.baseUrl), apiKey: config.apiKey || env.OPENROUTER_API_KEY };
  }
  // inherit — the model's first segment names a pi registry provider whose
  // baseUrl + apiKey (a $VAR name or a literal) this call reuses.
  const slash = config.model.indexOf("/");
  if (slash <= 0) return null;
  const info = registryReader(config.model.slice(0, slash));
  const base = info?.baseUrl?.trim();
  if (!base) return null;
  return { url: embeddingsUrl(base), apiKey: resolveEnvApiKey(info?.apiKey, env) };
}

/** Default registry reader over ~/.pi/agent/models.json. */
export function piRegistryReader(provider: string): RegistryProviderInfo | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "models.json"), "utf8")) as {
      providers?: Record<string, { baseUrl?: unknown; apiKey?: unknown }>;
    };
    const def = raw.providers?.[provider];
    if (!def || typeof def !== "object") return undefined;
    return {
      baseUrl: typeof def.baseUrl === "string" ? def.baseUrl : undefined,
      apiKey: typeof def.apiKey === "string" ? def.apiKey : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Check if model changed since last embedding generation */
export function hasModelChanged(): boolean {
  const config = loadEmbeddingConfig();
  if (!config.lastModel) return false;
  return config.model !== config.lastModel;
}

/** Mark current model as the one used for embedding generation */
export function markModelUsed(): void {
  updateEmbeddingConfig({ lastModel: loadEmbeddingConfig().model });
}

/** Get API key from env or config */
export function getApiKey(): string | undefined {
  const config = loadEmbeddingConfig();
  if (config.apiKey) return config.apiKey;
  return process.env.OPENROUTER_API_KEY || process.env.OPEN_ROUTER_API_KEY;
}

/** Set API key */
export function setApiKey(key: string): void {
  updateEmbeddingConfig({ apiKey: key, provider: "openrouter" });
}

/** Remove API key and reset provider */
export function clearApiKey(): void {
  updateEmbeddingConfig({ apiKey: undefined, provider: "none" });
}
