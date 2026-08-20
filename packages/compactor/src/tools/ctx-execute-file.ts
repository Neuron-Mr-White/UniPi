/**
 * ctx_execute_file tool — process file via FILE_CONTENT variable
 */

import { PolyglotExecutor } from "../executor/executor.js";
import type { Language, ExecResult } from "../types.js";

export interface CtxExecuteFileInput {
  language: Language;
  path: string;
  timeout?: number;
}

export async function ctxExecuteFile(
  input: CtxExecuteFileInput,
  executor = new PolyglotExecutor(),
): Promise<ExecResult> {
  return executor.executeFile({
    language: input.language,
    path: input.path,
    timeout: input.timeout ?? 30000,
  });
}
