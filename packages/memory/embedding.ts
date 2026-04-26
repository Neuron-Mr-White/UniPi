/**
 * @unipi/memory — Embedding generation
 *
 * Primary: OpenRouter API (openai/text-embedding-3-small)
 * Fallback: fuzzy-only mode (returns null)
 *
 * Embedding dimensions default to 384 for sqlite-vec compatibility.
 * openai/text-embedding-3 supports custom dimensions via API param.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  loadEmbeddingConfig,
  getApiKey,
  markModelUsed,
  isEmbeddingReady,
  type EmbeddingConfig,
} from "./settings.js";

/** Cached config to avoid reading file on every call */
let cachedConfig: EmbeddingConfig | null = null;
let lastConfigLoad = 0;
const CONFIG_CACHE_MS = 30_000; // 30 seconds

function getConfig(): EmbeddingConfig {
  const now = Date.now();
  if (!cachedConfig || now - lastConfigLoad > CONFIG_CACHE_MS) {
    cachedConfig = loadEmbeddingConfig();
    lastConfigLoad = now;
  }
  return cachedConfig;
}

/** Force refresh config cache */
export function refreshConfig(): void {
  cachedConfig = null;
  lastConfigLoad = 0;
}

/**
 * Generate an embedding for the given text via OpenRouter API.
 * Returns null if not configured or on error.
 */
export async function generateEmbedding(
  text: string,
  _ai?: ExtensionAPI | any
): Promise<Float32Array | null> {
  const config = getConfig();
  const apiKey = getApiKey();

  if (config.provider !== "openrouter" || !apiKey || !config.model) {
    return null; // Fuzzy-only mode
  }

  try {
    const truncated = text.slice(0, 8000); // OpenRouter/OpenAI limit ~8192 tokens

    const body: any = {
      model: config.model,
      input: truncated,
    };

    // openai/text-embedding-3 supports custom dimensions
    // ada-002 does NOT — only add if not ada
    if (!config.model.includes("ada-002")) {
      body.dimensions = config.dimensions;
    }

    const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/Neuron-Mr-White/unipi",
        "X-Title": "unipi-memory",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "unknown");
      console.warn(`[unipi/memory] Embedding API error ${response.status}: ${errText}`);
      return null;
    }

    const data = await response.json() as any;
    const values = data?.data?.[0]?.embedding;

    if (!Array.isArray(values)) {
      console.warn("[unipi/memory] Unexpected embedding response format");
      return null;
    }

    // Convert to Float32Array, truncate to configured dimensions
    const dims = config.dimensions;
    const vec = new Float32Array(dims);
    for (let i = 0; i < Math.min(values.length, dims); i++) {
      vec[i] = values[i];
    }

    return vec;
  } catch (err: any) {
    if (err?.name === "TimeoutError") {
      console.warn("[unipi/memory] Embedding API timeout");
    } else {
      console.warn("[unipi/memory] Embedding error:", err?.message || err);
    }
    return null;
  }
}

/**
 * Generate embeddings for multiple texts in a single API call.
 * More efficient than calling generateEmbedding() per text.
 * Returns array of Float32Array (null for failures).
 */
export async function generateEmbeddingsBatch(
  texts: string[],
  _ai?: ExtensionAPI | any
): Promise<(Float32Array | null)[]> {
  const config = getConfig();
  const apiKey = getApiKey();

  if (config.provider !== "openrouter" || !apiKey || !config.model) {
    return texts.map(() => null);
  }

  try {
    const truncated = texts.map((t) => t.slice(0, 8000));

    const body: any = {
      model: config.model,
      input: truncated,
    };

    if (!config.model.includes("ada-002")) {
      body.dimensions = config.dimensions;
    }

    const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/Neuron-Mr-White/unipi",
        "X-Title": "unipi-memory",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      return texts.map(() => null);
    }

    const data = await response.json() as any;
    const dims = config.dimensions;

    return (data?.data || []).map((item: any) => {
      if (!Array.isArray(item.embedding)) return null;
      const vec = new Float32Array(dims);
      for (let i = 0; i < Math.min(item.embedding.length, dims); i++) {
        vec[i] = item.embedding[i];
      }
      return vec;
    });
  } catch {
    return texts.map(() => null);
  }
}

/**
 * Re-embed all memories across all projects.
 * Returns count of successfully re-embedded memories.
 */
export async function reembedAllMemories(pi: ExtensionAPI): Promise<number> {
  const { getAllProjectDirs, MemoryStorage } = await import("./storage.js");
  const projectDirs = getAllProjectDirs();
  let count = 0;

  for (const { name: projectName, dir } of projectDirs) {
    try {
      const storage = new MemoryStorage(projectName);
      storage.init();

      const memories = storage.listAll();
      if (memories.length === 0) {
        storage.close();
        continue;
      }

      // Load full records
      const fullRecords = memories
        .map((m) => storage.getById(m.id))
        .filter((r): r is NonNullable<typeof r> => r !== null);

      // Generate embeddings in batch
      const texts = fullRecords.map((r) => `${r.title} ${r.content}`);
      const embeddings = await generateEmbeddingsBatch(texts, pi);

      // Update records
      for (let i = 0; i < fullRecords.length; i++) {
        if (embeddings[i]) {
          fullRecords[i].embedding = embeddings[i];
          storage.store(fullRecords[i]);
          count++;
        }
      }

      storage.close();
    } catch (err) {
      console.warn(`[unipi/memory] Failed to re-embed project ${projectName}:`, err);
    }
  }

  return count;
}

/**
 * Convert Float32Array to Buffer for SQLite storage.
 */
export function vectorToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer);
}

/**
 * Convert Buffer from SQLite to Float32Array.
 */
export function bufferToVector(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * Check if embeddings are available (sqlite-vec loaded).
 */
export function hasEmbeddings(db: any): boolean {
  try {
    db.prepare("SELECT * FROM memories_vec LIMIT 1").get();
    return true;
  } catch {
    return false;
  }
}
