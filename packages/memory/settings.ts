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
export type EmbeddingProvider = "openrouter" | "none";

/** Embedding configuration */
export interface EmbeddingConfig {
  /** Provider for embeddings */
  provider: EmbeddingProvider;
  /** Model ID (e.g. "openai/text-embedding-3-small") */
  model: string;
  /** OpenRouter API key (encrypted or plaintext) */
  apiKey?: string;
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
          options: ["none", "openrouter"],
          description: "Semantic search over stored memories",
        },
        { key: "model", type: "model", label: "Model" },
        { key: "dimensions", type: "number", label: "Dimensions", min: 1 },
        { key: "apiKey", type: "secret", label: "OpenRouter key", emptyLabel: "unset (no semantic search)" },
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

/** Check if embeddings are configured and usable */
export function isEmbeddingReady(): boolean {
  const config = loadEmbeddingConfig();
  return config.provider === "openrouter" && !!config.apiKey && !!config.model;
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
