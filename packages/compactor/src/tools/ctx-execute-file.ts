/**
 * ctx_execute_file tool — process file via FILE_CONTENT variable
 */

import { PolyglotExecutor } from "../executor/executor.js";
import type { Language, ExecResult } from "../types.js";
import { readFileSync } from "node:fs";

export interface CtxExecuteFileInput {
  language: Language;
  path: string;
  timeout?: number;
}

export async function ctxExecuteFile(input: CtxExecuteFileInput): Promise<ExecResult> {
  const content = readFileSync(input.path, "utf-8");
  const code = `const FILE_CONTENT = ${JSON.stringify(content)};\n// User script follows:\n`;
  
  const executor = new PolyglotExecutor();
  return executor.executeFile({
    language: input.language,
    path: input.path,
    code,
    timeout: input.timeout ?? 30000,
  });
}
