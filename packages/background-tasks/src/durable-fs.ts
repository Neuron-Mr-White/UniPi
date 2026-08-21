/**
 * @pi-unipi/background-tasks — Durable file operations
 *
 * Ported verbatim (behavior-preserving) from pi-background-tasks
 * src/core/durable-fs.ts. ISC-licensed reference: Copyright Ismail
 * <ismailsalikhodjaev@gmail.com>.
 */

import { randomBytes } from "node:crypto";
import { open as nodeOpen, rename as nodeRename, rm as nodeRm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type DurableData = Buffer | string;
export type DurableWriteFlag = "w" | "wx";
export type DurableOperation =
  | "open_file"
  | "write_file"
  | "sync_file"
  | "close_file"
  | "rename_file"
  | "remove_temp"
  | "open_directory"
  | "sync_directory"
  | "close_directory";

export interface DurableFailure {
  operation: DurableOperation;
  path: string;
  cause: unknown;
}

export interface DurableWritableHandle {
  writeFile(data: DurableData): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface DurableDirectoryHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface DurableFileOperations {
  platform: NodeJS.Platform;
  openWritable(path: string, flag: DurableWriteFlag, mode?: number): Promise<DurableWritableHandle>;
  openDirectory(path: string): Promise<DurableDirectoryHandle>;
  rename(source: string, target: string): Promise<void>;
  remove(path: string): Promise<void>;
  temporaryPath(target: string): string;
}

export interface DurableFileWriter {
  write(path: string, data: DurableData): Promise<void>;
  replace(path: string, data: DurableData): Promise<void>;
}

interface DurableErrorInput {
  operation: DurableOperation;
  path: string;
  cause: unknown;
  cleanupFailures: readonly DurableFailure[];
  targetPath: string | undefined;
  temporaryPath: string | undefined;
  renameCompleted: boolean;
}

interface WritableSequenceResult {
  primaryFailure: DurableFailure | undefined;
  cleanupFailures: DurableFailure[];
}

export class DurableFileError extends Error {
  readonly operation: DurableOperation;
  readonly path: string;
  readonly nativeCode: string | undefined;
  readonly primaryCause: unknown;
  readonly cleanupFailures: readonly DurableFailure[];
  readonly targetPath: string | undefined;
  readonly temporaryPath: string | undefined;
  readonly renameCompleted: boolean;

  constructor(input: {
    operation: DurableOperation;
    path: string;
    cause: unknown;
    cleanupFailures: readonly DurableFailure[];
    targetPath: string | undefined;
    temporaryPath: string | undefined;
    renameCompleted: boolean;
  }) {
    super(formatDurableMessage(input));
    this.name = "DurableFileError";
    this.operation = input.operation;
    this.path = input.path;
    this.nativeCode = nativeCodeForCause(input.cause);
    this.primaryCause = input.cause;
    this.cleanupFailures = [...input.cleanupFailures];
    this.targetPath = input.targetPath;
    this.temporaryPath = input.temporaryPath;
    this.renameCompleted = input.renameCompleted;
  }
}

function failure(operation: DurableOperation, path: string, cause: unknown): DurableFailure {
  return { operation, path, cause };
}

function durableError(input: DurableErrorInput): DurableFileError {
  return new DurableFileError(input);
}

function nativeCodeForCause(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const code = Reflect.get(cause, "code");
  return typeof code === "string" ? code : undefined;
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const message = cause.message.length > 0 ? cause.message : String(cause);
    return `${cause.name}: ${message}`;
  }
  return String(cause);
}

function formatFailureForMessage(entry: DurableFailure): string {
  const code = nativeCodeForCause(entry.cause);
  const codeText = code === undefined ? "" : ` (code ${code})`;
  return `${entry.operation} ${entry.path}${codeText}: ${describeCause(entry.cause)}`;
}

function formatDurableMessage(input: DurableErrorInput): string {
  const primary = formatFailureForMessage({
    operation: input.operation,
    path: input.path,
    cause: input.cause,
  });
  const segments = [`Durable file operation failed: ${primary}`];
  if (input.targetPath !== undefined) segments.push(`target: ${input.targetPath}`);
  if (input.temporaryPath !== undefined) segments.push(`temporary: ${input.temporaryPath}`);
  if (input.renameCompleted) {
    const target = input.targetPath ?? input.path;
    segments.push(`Replacement may already be visible at ${target}.`);
  }
  if (input.cleanupFailures.length > 0) {
    const cleanupText = input.cleanupFailures.map(formatFailureForMessage).join("; ");
    segments.push(`Cleanup failures: ${cleanupText}`);
  }
  return segments.join(" ");
}

async function writeSyncClose(
  handle: DurableWritableHandle,
  path: string,
  data: DurableData,
): Promise<WritableSequenceResult> {
  const cleanupFailures: DurableFailure[] = [];
  let primaryFailure: DurableFailure | undefined;
  try {
    await handle.writeFile(data);
  } catch (error) {
    primaryFailure = failure("write_file", path, error);
  }
  if (primaryFailure === undefined) {
    try {
      await handle.sync();
    } catch (error) {
      primaryFailure = failure("sync_file", path, error);
    }
  }
  try {
    await handle.close();
  } catch (error) {
    const closeFailure = failure("close_file", path, error);
    if (primaryFailure === undefined) primaryFailure = closeFailure;
    else cleanupFailures.push(closeFailure);
  }
  return { primaryFailure, cleanupFailures };
}

async function syncCloseDirectory(handle: DurableDirectoryHandle, path: string): Promise<WritableSequenceResult> {
  const cleanupFailures: DurableFailure[] = [];
  let primaryFailure: DurableFailure | undefined;
  try {
    await handle.sync();
  } catch (error) {
    primaryFailure = failure("sync_directory", path, error);
  }
  try {
    await handle.close();
  } catch (error) {
    const closeFailure = failure("close_directory", path, error);
    if (primaryFailure === undefined) primaryFailure = closeFailure;
    else cleanupFailures.push(closeFailure);
  }
  return { primaryFailure, cleanupFailures };
}

function throwDurable(
  primaryFailure: DurableFailure,
  cleanupFailures: readonly DurableFailure[],
  targetPath: string | undefined,
  temporaryPath: string | undefined,
  renameCompleted: boolean,
): never {
  throw durableError({
    operation: primaryFailure.operation,
    path: primaryFailure.path,
    cause: primaryFailure.cause,
    cleanupFailures,
    targetPath,
    temporaryPath,
    renameCompleted,
  });
}

async function removeTemporary(
  operations: DurableFileOperations,
  temporaryPath: string,
  cleanupFailures: DurableFailure[],
): Promise<void> {
  try {
    await operations.remove(temporaryPath);
  } catch (error) {
    cleanupFailures.push(failure("remove_temp", temporaryPath, error));
  }
}

async function writeWithOperations(
  operations: DurableFileOperations,
  path: string,
  data: DurableData,
): Promise<void> {
  let handle: DurableWritableHandle;
  try {
    handle = await operations.openWritable(path, "w");
  } catch (error) {
    throwDurable(failure("open_file", path, error), [], path, undefined, false);
  }
  const result = await writeSyncClose(handle, path, data);
  if (result.primaryFailure !== undefined) {
    throwDurable(result.primaryFailure, result.cleanupFailures, path, undefined, false);
  }
}

async function syncDirectoryAfterRename(
  operations: DurableFileOperations,
  targetPath: string,
  temporaryPath: string,
): Promise<void> {
  if (operations.platform === "win32") return;
  const directoryPath = dirname(targetPath);
  let handle: DurableDirectoryHandle;
  try {
    handle = await operations.openDirectory(directoryPath);
  } catch (error) {
    throwDurable(failure("open_directory", directoryPath, error), [], targetPath, temporaryPath, true);
  }
  const result = await syncCloseDirectory(handle, directoryPath);
  if (result.primaryFailure !== undefined) {
    throwDurable(result.primaryFailure, result.cleanupFailures, targetPath, temporaryPath, true);
  }
}

async function replaceWithOperations(
  operations: DurableFileOperations,
  path: string,
  data: DurableData,
): Promise<void> {
  const temporaryPath = operations.temporaryPath(path);
  let handle: DurableWritableHandle;
  try {
    handle = await operations.openWritable(temporaryPath, "wx", 0o600);
  } catch (error) {
    throwDurable(failure("open_file", temporaryPath, error), [], path, temporaryPath, false);
  }
  const writeResult = await writeSyncClose(handle, temporaryPath, data);
  if (writeResult.primaryFailure !== undefined) {
    await removeTemporary(operations, temporaryPath, writeResult.cleanupFailures);
    throwDurable(writeResult.primaryFailure, writeResult.cleanupFailures, path, temporaryPath, false);
  }
  const renameError = await renameWithWindowsContention(operations, temporaryPath, path);
  if (renameError !== undefined) {
    const cleanupFailures: DurableFailure[] = [];
    await removeTemporary(operations, temporaryPath, cleanupFailures);
    throwDurable(failure("rename_file", path, renameError), cleanupFailures, path, temporaryPath, false);
  }
  await syncDirectoryAfterRename(operations, path, temporaryPath);
}

/**
 * Windows sharing-violation codes for a replace-rename.
 *
 * POSIX `rename(2)` atomically replaces the target. Windows `MoveFileEx` fails
 * with a sharing violation when another process momentarily holds the target
 * open, including transient scanners, indexers, and concurrent writers. The
 * operation is legitimate and simply needs to be reattempted.
 */
const WINDOWS_RENAME_CONTENTION_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

const WINDOWS_RENAME_ATTEMPTS = 10;
const WINDOWS_RENAME_RETRY_DELAY_MS = 20;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Rename the temporary file over the target, retrying only Windows sharing
 * violations.
 *
 * This is a bounded retry of a transient OS condition, not a fallback: the
 * final failure is still returned and raised loudly, no alternative write path
 * is taken, and no other platform or error code is retried.
 *
 * Returns the failure cause, or undefined on success.
 */
async function renameWithWindowsContention(
  operations: DurableFileOperations,
  temporaryPath: string,
  targetPath: string,
): Promise<unknown> {
  const attempts = operations.platform === "win32" ? WINDOWS_RENAME_ATTEMPTS : 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await operations.rename(temporaryPath, targetPath);
      return undefined;
    } catch (error) {
      lastError = error;
      const code = nativeCodeForCause(error);
      const retryable =
        operations.platform === "win32" && code !== undefined && WINDOWS_RENAME_CONTENTION_CODES.has(code);
      if (!retryable || attempt === attempts) return error;
      await delay(WINDOWS_RENAME_RETRY_DELAY_MS * attempt);
    }
  }
  return lastError;
}

function temporaryPathForTarget(target: string): string {
  return join(dirname(target), `.${basename(target)}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`);
}

const nodeOperations: DurableFileOperations = {
  platform: process.platform,
  async openWritable(path: string, flag: DurableWriteFlag, mode?: number) {
    if (mode === undefined) return nodeOpen(path, flag);
    return nodeOpen(path, flag, mode);
  },
  async openDirectory(path: string) {
    return nodeOpen(path, "r");
  },
  async rename(source: string, target: string) {
    await nodeRename(source, target);
  },
  async remove(path: string) {
    // `force` ignores a missing path only. Permission and other failures still
    // throw and are surfaced as `remove_temp` cleanup failures.
    await nodeRm(path, { force: true });
  },
  temporaryPath: temporaryPathForTarget,
};

const defaultWriter = createDurableFileWriter(nodeOperations);

export function createDurableFileWriter(operations: DurableFileOperations): DurableFileWriter {
  return {
    async write(path: string, data: DurableData): Promise<void> {
      await writeWithOperations(operations, path, data);
    },
    async replace(path: string, data: DurableData): Promise<void> {
      await replaceWithOperations(operations, path, data);
    },
  };
}

export function writeFileDurable(path: string, data: DurableData): Promise<void> {
  return defaultWriter.write(path, data);
}

export function replaceFileDurable(path: string, data: DurableData): Promise<void> {
  return defaultWriter.replace(path, data);
}
