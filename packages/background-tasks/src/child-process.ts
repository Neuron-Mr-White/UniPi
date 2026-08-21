/**
 * @pi-unipi/background-tasks — Shared child-process & context interfaces
 *
 * Consumed by types.ts, registry.ts, attested-pi-run.ts, and tests.
 */

import type { SpawnOptions } from "node:child_process";
import type { Writable } from "node:stream";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = any;

/** Writable stdin side of a spawned child. */
export type ChildStdin = Writable;

/** Readable side of a child output pipe. */
export interface OutputEventSource {
  on(event: "data", listener: (data: Buffer | string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  [Symbol.asyncIterator](): AsyncIterableIterator<Buffer>;
}

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

export type BackgroundTaskSpawnOptions = SpawnOptions;

export type BackgroundTaskSpawn = (
  command: string,
  args: string[],
  options?: BackgroundTaskSpawnOptions,
) => BackgroundTaskChildProcess;

/** Model registry surface the registry needs for route resolution. */
export interface BackgroundTaskModelRegistry {
  getAll(): ReadonlyArray<{ id: unknown; provider: unknown; contextWindow: unknown }>;
  find?(provider: string, modelId: string): AnyModel;
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
