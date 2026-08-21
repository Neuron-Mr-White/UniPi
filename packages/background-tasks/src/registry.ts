/**
 * @pi-unipi/background-tasks — Task registry
 *
 * Ported from pi-background-tasks src/core/registry.ts. Full process lifecycle
 * lands in Phase 1; this module currently owns the shared child-process
 * interface consumed by types.ts.
 */

import type { SpawnOptions } from "node:child_process";
import type { ChildStdin } from "./common.js";

/** Minimal child-process surface the registry drives. */
export interface BackgroundTaskChildProcess {
  pid?: number | undefined;
  stdin?: ChildStdin | null | undefined;
  stdout?: OutputEventSource | null | undefined;
  stderr?: OutputEventSource | null | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

/** Readable side of a child output pipe. */
export interface OutputEventSource {
  on(event: "data", listener: (data: Buffer | string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  [Symbol.asyncIterator](): AsyncIterableIterator<Buffer>;
}

/** Model registry surface the registry needs for route resolution. */
export interface BackgroundTaskModelRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  find?(provider: string, modelId: string): any;
  isUsingOAuth?(model: unknown): boolean;
}

/** Extension context slice the registry needs. */
export interface BackgroundTaskContext {
  cwd: string;
  sessionId?: string | undefined;
  modelRegistry: BackgroundTaskModelRegistry;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model?: any;
}

export type BackgroundTaskSpawnOptions = SpawnOptions;

export type BackgroundTaskSpawn = (
  command: string,
  args: string[],
  options?: BackgroundTaskSpawnOptions,
) => BackgroundTaskChildProcess;
