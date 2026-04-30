/**
 * ctx_fetch_and_index tool — fetch URL → markdown → index
 * With 24h TTL cache (matching context-mode behavior)
 */

import { ContentStore } from "../store/index.js";
import type { IndexResult } from "../types.js";
import { loadConfig } from "../config/manager.js";

/** TTL: 24 hours in milliseconds */
const TTL_MS = 24 * 60 * 60 * 1000;

export interface CtxFetchAndIndexInput {
  url: string;
  label?: string;
  chunkSize?: number;
  force?: boolean;
  contentType?: "markdown" | "json" | "plain";
}

export async function ctxFetchAndIndex(input: CtxFetchAndIndexInput): Promise<IndexResult> {
  const label = input.label ?? input.url;
  const store = new ContentStore();
  await store.init();

  try {
    // TTL cache check: if source was indexed within 24h, return cached hint
    // Only if pipeline.ttlCache is enabled
    const config = loadConfig();
    if (!input.force && config.pipeline.ttlCache) {
      const meta = store.getSourceMeta(label);
      if (meta) {
        const indexedAt = new Date(meta.indexedAt + "Z"); // SQLite datetime is UTC without Z
        const ageMs = Date.now() - indexedAt.getTime();
        if (ageMs < TTL_MS) {
          const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
          const ageMin = Math.floor(ageMs / (60 * 1000));
          const _ageStr = ageHours > 0 ? `${ageHours}h ago` : ageMin > 0 ? `${ageMin}m ago` : "just now";
          return {
            sourceId: -1,
            label: meta.label,
            totalChunks: meta.chunkCount,
            codeChunks: 0,
            cacheHit: true,
            cachedAt: meta.indexedAt,
          };
        }
        // Stale (>24h) — fall through to re-fetch
      }
    }

    // Fetch and index
    const response = await fetch(input.url, {
      headers: { "User-Agent": "pi-unipi-compactor/0.1.0" },
    });

    if (!response.ok) {
      throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
    }

    const text = await response.text();

    const result = await store.index(label, text, {
      contentType: input.contentType ?? "plain",
      source: input.url,
      chunkSize: input.chunkSize,
    });

    return { ...result, cacheHit: false };
  } finally {
    store.close();
  }
}
