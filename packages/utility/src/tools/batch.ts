/**
 * @pi-unipi/utility — Batch Execution Tool
 *
 * Atomic batch of commands + searches with rollback on failure.
 */

import type {
  BatchCommand,
  BatchOptions,
  BatchResult,
  BatchReport,
} from "../types.js";

/** Default options */
const DEFAULTS: Required<BatchOptions> = {
  failFast: true,
  commandTimeoutMs: 30000,
  totalTimeoutMs: 300000,
};

/** Executor function type — provided by the host environment */
export type CommandExecutor = (
  command: BatchCommand,
) => Promise<unknown>;

/** Rollback function type */
export type RollbackFn = (
  results: BatchResult[],
) => Promise<void>;

/**
 * Execute a batch of commands atomically.
 *
 * @param commands - Array of commands to execute
 * @param executor - Function that executes a single command
 * @param options - Batch execution options
 * @param rollback - Optional rollback function called on failure
 */
export async function executeBatch(
  commands: BatchCommand[],
  executor: CommandExecutor,
  options: BatchOptions = {},
  rollback?: RollbackFn,
): Promise<BatchReport> {
  const opts = { ...DEFAULTS, ...options };
  const results: BatchResult[] = [];
  const startTime = Date.now();

  // Total timeout guard
  const totalDeadline = startTime + opts.totalTimeoutMs;

  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];
    const cmdStart = Date.now();

    // Check total timeout
    if (Date.now() > totalDeadline) {
      const timeoutResult: BatchResult = {
        command,
        success: false,
        error: `Total batch timeout exceeded (${opts.totalTimeoutMs}ms)`,
        durationMs: Date.now() - cmdStart,
      };
      results.push(timeoutResult);

      if (opts.failFast) {
        const report = createReport(results, startTime, !!rollback);
        if (rollback) {
          await rollback(results).catch(() => {
            // Best-effort rollback
          });
        }
        return report;
      }
      continue;
    }

    // Execute with per-command timeout
    try {
      const result = await withTimeout(
        executor(command),
        opts.commandTimeoutMs,
        `Command timeout exceeded (${opts.commandTimeoutMs}ms)`,
      );

      results.push({
        command,
        success: true,
        result,
        durationMs: Date.now() - cmdStart,
      });
    } catch (err) {
      const errorResult: BatchResult = {
        command,
        success: false,
        error: (err as Error).message,
        durationMs: Date.now() - cmdStart,
      };
      results.push(errorResult);

      if (opts.failFast) {
        const report = createReport(results, startTime, !!rollback);
        if (rollback) {
          await rollback(results).catch(() => {
            // Best-effort rollback
          });
        }
        return report;
      }
    }
  }

  return createReport(results, startTime, false);
}

/** Create a batch report from results */
function createReport(
  results: BatchResult[],
  startTime: number,
  rolledBack: boolean,
): BatchReport {
  const allSuccess = results.every((r) => r.success);
  return {
    success: allSuccess && !rolledBack,
    results,
    totalDurationMs: Date.now() - startTime,
    rolledBack,
  };
}

/** Wrap a promise with a timeout */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/** Format a batch report as markdown */
export function formatBatchReport(report: BatchReport): string {
  const lines = [
    "## 📦 Batch Execution Report",
    "",
    `**Success:** ${report.success ? "✓ Yes" : "✗ No"}`,
    `**Commands:** ${report.results.length}`,
    `**Duration:** ${report.totalDurationMs}ms`,
    report.rolledBack ? "**Rolled back:** Yes" : "",
    "",
  ].filter(Boolean);

  for (let i = 0; i < report.results.length; i++) {
    const r = report.results[i];
    const icon = r.success ? "✓" : "✗";
    lines.push(
      `### ${i + 1}. ${icon} ${r.command.type}:${r.command.name}`,
      `**Duration:** ${r.durationMs}ms`,
    );
    if (r.success) {
      lines.push(`**Result:** \`${JSON.stringify(r.result).slice(0, 200)}\``);
    } else {
      lines.push(`**Error:** ${r.error}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Create a simple command batch builder */
export class BatchBuilder {
  private commands: BatchCommand[] = [];
  private opts: BatchOptions = {};
  private rollbackFn?: RollbackFn;

  /** Add a command to the batch */
  addCommand(name: string, args?: Record<string, unknown>): this {
    this.commands.push({ type: "command", name, args });
    return this;
  }

  /** Add a tool call to the batch */
  addTool(name: string, args?: Record<string, unknown>): this {
    this.commands.push({ type: "tool", name, args });
    return this;
  }

  /** Add a search to the batch */
  addSearch(name: string, args?: Record<string, unknown>): this {
    this.commands.push({ type: "search", name, args });
    return this;
  }

  /** Set batch options */
  withOptions(options: BatchOptions): this {
    this.opts = { ...this.opts, ...options };
    return this;
  }

  /** Set rollback function */
  withRollback(rollback: RollbackFn): this {
    this.rollbackFn = rollback;
    return this;
  }

  /** Execute the batch */
  async execute(executor: CommandExecutor): Promise<BatchReport> {
    return executeBatch(this.commands, executor, this.opts, this.rollbackFn);
  }

  /** Get the command list */
  getCommands(): readonly BatchCommand[] {
    return this.commands;
  }
}
