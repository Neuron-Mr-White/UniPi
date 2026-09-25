/**
 * @pi-unipi/kanboard — the write window.
 *
 * Bash calls into `unipi-kanboard` are split into always-allowed reads and
 * writes that are only allowed while a `/unipi:kanboard-do` turn is open or the
 * runner has a task in flight. The window is a `tool_call` gate: it never edits
 * the command, it just returns a block reason or lets the call through.
 */

import { tokenizeArgs } from "./commands.js";

export const WRITE_BLOCK_REASON =
  "kanboard board writes are only allowed during /unipi:kanboard-do or a runner task";
export const addCapReason = (limit: number): string => `at most ${limit} new tasks per turn`;
/** @deprecated tests should read the limit through the guard's getter instead. */
export const ADD_CAP = 20;
export const ADD_CAP_REASON = addCapReason(ADD_CAP);

/** Subcommands that never write to the board. */
const READONLY = new Set(["list", "show", "attachments", "next", "chain", "search", "status"]);

/** Global flags that take a value; `--json` is the only valueless one. */
const GLOBAL_VALUE_FLAGS = new Set(["--actor", "--project", "--gate", "--session"]);

export interface KanboardInvocation {
  /** First positional after the binary name ("" when absent). */
  sub: string;
  /** Everything after the subcommand. */
  args: string[];
}

/** Every `unipi-kanboard` invocation inside a shell command line. */
export function kanboardInvocations(command: string): KanboardInvocation[] {
  const tokens = tokenizeArgs(command);
  const out: KanboardInvocation[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    // The binary may be a bare name or an absolute path (and .exe on Windows).
    if (!/unipi-kanboard(\.exe)?$/.test(token)) continue;
    const rest = tokens.slice(index + 1);
    let cursor = 0;
    while (cursor < rest.length) {
      const arg = rest[cursor]!;
      if (arg === "--json") {
        cursor += 1;
        continue;
      }
      if (GLOBAL_VALUE_FLAGS.has(arg)) {
        cursor += 2;
        continue;
      }
      if ([...GLOBAL_VALUE_FLAGS].some((flag) => arg.startsWith(`${flag}=`))) {
        cursor += 1;
        continue;
      }
      break;
    }
    out.push({ sub: rest[cursor] ?? "", args: rest.slice(cursor + 1) });
  }
  return out;
}

/** Read-only means: no writes, and the board does not change. */
export function isReadonly(invocation: KanboardInvocation): boolean {
  if (READONLY.has(invocation.sub)) return true;
  if (invocation.sub === "queue") {
    // `queue --list` (or bare `queue`, which lists) is read-only; ids write.
    return invocation.args.every((arg) => arg === "--list" || arg === "--json") || invocation.args.length === 0;
  }
  if (invocation.sub === "project") {
    return invocation.args[0] === "list" || invocation.args[0] === "show";
  }
  if (invocation.sub === "settings") {
    return invocation.args[0] !== "set"; // bare/`show` reads; `set` writes
  }
  if (invocation.sub === "validate") {
    return !invocation.args.includes("--fix");
  }
  return false;
}

export interface WriteGuard {
  /** Open the window for a `/unipi:kanboard-do` turn. */
  open(): void;
  /** Arm the agent_end closer right after the -do prompt was sent. */
  noteSent(): void;
  /**
   * A window opened by -do closes on the first agent_end that isn't the
   * pre-send echo (>150ms after noteSent). Returns true when it just closed.
   */
  onAgentEnd(): boolean;
  /** null when the command is allowed; otherwise the block reason. */
  check(command: string): string | null;
}

/**
 * The window is open during a -do turn (`doOpen`) or while the runner has a
 * task in phase `running`. `runnerTask` returns that task's id (null when the
 * runner is not running one) — the `add` counter resets whenever the running
 * task changes, so autowork/queue drains get a fresh 20 per task.
 */
export function createWriteGuard(runnerTask: () => string | null, addLimit: () => number = () => ADD_CAP): WriteGuard {
  let doOpen = false;
  let sentAt = 0;
  let adds = 0;
  let lastTask: string | null = null;
  return {
    open() {
      doOpen = true;
      adds = 0;
      lastTask = null;
    },
    noteSent() {
      sentAt = Date.now();
    },
    onAgentEnd() {
      if (!doOpen) return false;
      if (Date.now() - sentAt < 150) return false; // late end from the previous turn
      doOpen = false;
      return true;
    },
    check(command: string) {
      const invocations = kanboardInvocations(command);
      if (invocations.length === 0) return null;
      const task = runnerTask();
      // A new runner task is a new window for the cap (a -do open resets too).
      if (task !== null && task !== lastTask) {
        adds = 0;
        lastTask = task;
      }
      for (const invocation of invocations) {
        if (isReadonly(invocation)) continue;
        if (!(doOpen || task !== null)) return WRITE_BLOCK_REASON;
        if (invocation.sub === "add") {
          adds += 1;
          const limit = addLimit();
          if (limit > 0 && adds > limit) return addCapReason(limit);
        }
      }
      return null;
    },
  };
}
