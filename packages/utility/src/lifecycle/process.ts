/**
 * @pi-unipi/utility — Process Lifecycle Manager
 *
 * General-purpose process lifecycle management:
 * - Parent PID polling (orphan detection)
 * - Signal handlers for graceful shutdown
 * - Cleanup callbacks registry
 */

import type {
  CleanupFn,
  LifecycleState,
  ProcessLifecycleOptions,
} from "../types.js";

/** Default options */
const DEFAULTS: Required<ProcessLifecycleOptions> = {
  pollIntervalMs: 30000,
  handleSignals: true,
};

/**
 * ProcessLifecycle manages the lifecycle of the utility process.
 * Detects orphan status via parent PID polling and provides
 * graceful shutdown with registered cleanup callbacks.
 */
export class ProcessLifecycle {
  private state: LifecycleState = "running";
  private parentPid: number | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private cleanups: Set<CleanupFn> = new Set();
  private opts: Required<ProcessLifecycleOptions>;

  constructor(options: ProcessLifecycleOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.parentPid = process.ppid ?? null;

    if (this.opts.handleSignals) {
      this.installSignalHandlers();
    }

    this.startPolling();
  }

  /** Current lifecycle state */
  get currentState(): LifecycleState {
    return this.state;
  }

  /** Whether the process is shutting down */
  get isShuttingDown(): boolean {
    return this.state === "shutting_down";
  }

  /** Whether the process has been orphaned */
  get isOrphaned(): boolean {
    return this.state === "orphaned";
  }

  /** Register a cleanup function to run on shutdown */
  registerCleanup(fn: CleanupFn): () => void {
    this.cleanups.add(fn);
    return () => {
      this.cleanups.delete(fn);
    };
  }

  /** Unregister a cleanup function */
  unregisterCleanup(fn: CleanupFn): void {
    this.cleanups.delete(fn);
  }

  /** Initiate graceful shutdown */
  async shutdown(reason: string = "requested"): Promise<void> {
    if (this.state !== "running") return;
    this.state = "shutting_down";
    this.stopPolling();

    const fns = Array.from(this.cleanups);
    this.cleanups.clear();

    for (const fn of fns) {
      try {
        await fn();
      } catch {
        // Best-effort cleanup — don't let one failure stop others
      }
    }

    this.state = "error";
  }

  /** Start parent PID polling for orphan detection */
  private startPolling(): void {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(() => {
      this.checkParent();
    }, this.opts.pollIntervalMs);

    // Don't block process exit on the timer
    if (this.pollTimer.unref) {
      this.pollTimer.unref();
    }
  }

  /** Stop polling */
  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Check if parent process is still alive */
  private checkParent(): void {
    if (this.parentPid === null) return;

    try {
      // Sending signal 0 checks if process exists without affecting it
      process.kill(this.parentPid, 0);
    } catch {
      // Parent is gone — we're orphaned
      this.state = "orphaned";
      this.stopPolling();
      this.shutdown("orphaned").catch(() => {
        // Ignore shutdown errors in orphan path
      });
    }
  }

  /** Install SIGTERM / SIGINT handlers */
  private installSignalHandlers(): void {
    const handler = (signal: string) => {
      this.shutdown(signal).then(() => {
        process.exit(0);
      });
    };

    process.once("SIGTERM", () => handler("SIGTERM"));
    process.once("SIGINT", () => handler("SIGINT"));
  }
}

/** Global singleton instance */
let globalLifecycle: ProcessLifecycle | null = null;

/** Get or create the global lifecycle manager */
export function getLifecycle(options?: ProcessLifecycleOptions): ProcessLifecycle {
  if (!globalLifecycle) {
    globalLifecycle = new ProcessLifecycle(options);
  }
  return globalLifecycle;
}

/** Dispose the global lifecycle manager */
export function disposeLifecycle(): void {
  if (globalLifecycle) {
    globalLifecycle.shutdown("dispose").catch(() => {});
    globalLifecycle = null;
  }
}
