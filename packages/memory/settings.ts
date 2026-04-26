/**
 * @unipi/memory — Embedding settings
 *
 * Manages embedding configuration: provider, model, API key.
 * Stored in ~/.unipi/memory/config.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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
}

/** Default configuration */
const DEFAULT_CONFIG: EmbeddingConfig = {
  provider: "none",
  model: "openai/text-embedding-3-small",
  dimensions: 384,
  suppressMigrationWarning: false,
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

/** Load embedding config */
export function loadEmbeddingConfig(): EmbeddingConfig {
  const configPath = getConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch {
    // Ignore parse errors
  }
  return { ...DEFAULT_CONFIG };
}

/** Save embedding config */
export function saveEmbeddingConfig(config: EmbeddingConfig): void {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
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
