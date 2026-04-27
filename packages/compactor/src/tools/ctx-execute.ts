/**
 * ctx_execute tool — run code in sandbox, only stdout enters context
 */

import { PolyglotExecutor } from "../executor/executor.js";
import type { Language, ExecResult } from "../types.js";

export interface CtxExecuteInput {
  language: Language;
  code: string;
  timeout?: number;
}

export async function ctxExecute(input: CtxExecuteInput): Promise<ExecResult> {
  const executor = new PolyglotExecutor();
  return executor.execute({
    language: input.language,
    code: input.code,
    timeout: input.timeout ?? 30000,
  });
}
