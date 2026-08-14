/**
 * ctx_batch_execute tool — atomic batch of commands
 */

import { PolyglotExecutor } from "../executor/executor.js";
import type { Language, ExecResult } from "../types.js";

export interface BatchCommand {
  type: "execute";
  language: Language;
  code: string;
  timeout?: number;
}

export type BatchItem = BatchCommand;

export interface BatchResult {
  results: Array<
    { type: "execute"; result: ExecResult }
  >;
}

export async function ctxBatchExecute(
  items: BatchItem[],
  executor = new PolyglotExecutor(),
): Promise<BatchResult> {
  const results: BatchResult["results"] = [];

  for (const item of items) {
    if (item.type === "execute") {
      const result = await executor.execute({
        language: item.language,
        code: item.code,
        timeout: item.timeout ?? 30000,
      });
      results.push({ type: "execute", result });
    }
  }

  return { results };
}
