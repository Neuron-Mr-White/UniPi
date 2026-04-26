/**
 * @pi-unipi/subagents — Per-file transparent locking
 *
 * Agents never see lock errors. Write tool queues internally.
 * Per-file granularity: locking src/auth.ts doesn't block src/login.ts.
 */

import type { FileLockEntry } from "./types.js";

export class FileLock {
  /** Active locks by file path. */
  private locks = new Map<string, FileLockEntry>();
  /** Queue of waiting acquires per file path. */
  private queues = new Map<string, Array<() => void>>();

  /**
   * Acquire a lock on a file. Blocks until available.
   * Returns a release function.
   *
   * @param filePath - Absolute path to the file
   * @param agentId - ID of the agent requesting the lock
   * @returns Release function — call when done writing
   */
  async acquire(filePath: string, agentId: string): Promise<() => void> {
    // Wait for existing lock
    while (this.locks.has(filePath)) {
      await new Promise<void>((resolve) => {
        const queue = this.queues.get(filePath) ?? [];
        queue.push(resolve);
        this.queues.set(filePath, queue);
      });
    }

    // Create lock entry
    let releaseFn: () => void;
    const promise = new Promise<void>((resolve) => {
      releaseFn = () => {
        this.locks.delete(filePath);
        resolve();
        // Wake next waiter
        const queue = this.queues.get(filePath);
        if (queue && queue.length > 0) {
          const next = queue.shift()!;
          next();
        }
      };
    });

    const entry: FileLockEntry = {
      agentId,
      filePath,
      promise,
      release: releaseFn!,
    };

    this.locks.set(filePath, entry);
    return releaseFn!;
  }

  /**
   * Check if a file is currently locked.
   */
  isLocked(filePath: string): boolean {
    return this.locks.has(filePath);
  }

  /**
   * Get the agent that holds a lock on a file.
   */
  getHolder(filePath: string): string | undefined {
    return this.locks.get(filePath)?.agentId;
  }

  /**
   * Get count of locked files.
   */
  get lockCount(): number {
    return this.locks.size;
  }

  /**
   * Release all locks held by an agent (on abort).
   */
  releaseAll(agentId: string): void {
    for (const [filePath, entry] of this.locks) {
      if (entry.agentId === agentId) {
        entry.release();
      }
    }
  }

  /**
   * Clear all locks (on shutdown).
   */
  clear(): void {
    for (const entry of this.locks.values()) {
      entry.release();
    }
    this.locks.clear();
    this.queues.clear();
  }
}
