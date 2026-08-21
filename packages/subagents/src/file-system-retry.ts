/**
 * @pi-unipi/subagents — File-system retry ladder
 *
 * Ported from pi-subagents src/shared/file-system-retry.ts (the blocking
 * waitForFileSystemRetry primitive + ladder constants). Env override uses OUR
 * prefix: UNIPI_SUBAGENT_FS_RETRY_MAX_TOTAL_MS.
 */

const WAIT_BUFFER = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(4) : undefined;
const WAIT_VIEW = WAIT_BUFFER ? new Int32Array(WAIT_BUFFER) : undefined;

export const FS_RETRY_MAX_TOTAL_MS_ENV = "UNIPI_SUBAGENT_FS_RETRY_MAX_TOTAL_MS";
export const BASE_FILE_SYSTEM_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 500, 1000, 2000, 4000] as const;

export function resolveFileSystemRetryDelays(
  env: NodeJS.ProcessEnv = process.env,
  base: readonly number[] = BASE_FILE_SYSTEM_RETRY_DELAYS_MS,
): readonly number[] {
  const raw = env[FS_RETRY_MAX_TOTAL_MS_ENV];
  if (raw === undefined || raw.trim() === "") return base;
  const budget = Number(raw);
  if (!Number.isInteger(budget) || budget < 0) {
    throw new Error(`${FS_RETRY_MAX_TOTAL_MS_ENV} must be a non-negative integer number of milliseconds.`);
  }
  let spent = 0;
  return base.map((delay) => {
    const remaining = budget - spent;
    spent += delay;
    if (remaining <= 0) return 0;
    return Math.min(delay, remaining);
  });
}

export const DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS = resolveFileSystemRetryDelays();

export function waitForFileSystemRetry(delayMs: number): void {
  if (delayMs <= 0) return;
  if (WAIT_VIEW) {
    try {
      Atomics.wait(WAIT_VIEW, 0, 0, delayMs);
      return;
    } catch {
      // fall through to setTimeout-free busy wait fallback below
    }
  }
  const end = Date.now() + delayMs;
  while (Date.now() < end) {
    // Blocking sleep fallback for runtimes without Atomics.wait
  }
}
