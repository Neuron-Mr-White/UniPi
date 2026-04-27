/**
 * ctx_index tool — chunk content → index into FTS5
 */

import { ContentStore } from "../store/index.js";
import type { IndexResult } from "../types.js";
import { readFileSync } from "node:fs";

export interface CtxIndexInput {
  label: string;
  content?: string;
  filePath?: string;
  contentType?: "markdown" | "json" | "plain";
  chunkSize?: number;
}

export async function ctxIndex(input: CtxIndexInput): Promise<IndexResult> {
  const store = new ContentStore();
  await store.init();

  let text: string;
  let source: string;

  if (input.filePath) {
    text = readFileSync(input.filePath, "utf-8");
    source = input.filePath;
  } else if (input.content) {
    text = input.content;
    source = input.label;
  } else {
    throw new Error("Either content or filePath must be provided");
  }

  const result = await store.index(input.label, text, {
    contentType: input.contentType ?? "plain",
    source,
    chunkSize: input.chunkSize,
  });

  store.close();
  return result;
}
