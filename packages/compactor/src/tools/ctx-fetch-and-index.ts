/**
 * ctx_fetch_and_index tool — fetch URL → markdown → index
 */

import type { ContentStore } from "../store/index.js";
import type { IndexResult } from "../types.js";

export interface CtxFetchAndIndexInput {
  url: string;
  label?: string;
  chunkSize?: number;
}

export async function ctxFetchAndIndex(store: ContentStore, input: CtxFetchAndIndexInput): Promise<IndexResult> {
  const label = input.label ?? input.url;

  const response = await fetch(input.url, {
    headers: { "User-Agent": "pi-unipi-compactor/0.1.0" },
  });

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();

  return store.index(label, text, {
    contentType: "plain",
    source: input.url,
    chunkSize: input.chunkSize,
  });
}
