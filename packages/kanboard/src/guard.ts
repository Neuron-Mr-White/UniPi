/**
 * @pi-unipi/kanboard — the write window.
 *
 * Bash calls into `unipi-kanboard` are split into always-allowed reads and
 * writes that are only allowed while a `/unipi:kanboard-do` turn is open or the
 * runner has a task in flight. The window is a `tool_call` gate: it never edits
 * the command, it just returns a block reason or lets the call through.
 */

import { tokenizeArgs } from "./commands.js";

export const DEFAULT_DO_CREDITS = 10;
export const WRITE_CREDITS_USED_UP = "kanboard write credits used up — run /unipi:kanboard-do to reload";
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
  /** Grant / top up the session's write credits to N (kanboard.doCredits). */
  open(): void;
  /** Revoke remaining credits (/unipi:kanboard-do off). */
  revoke(): void;
  /** Credits left this session. */
  remaining(): number;
  /** Arm the agent_end closer right after the -do prompt was sent. */
  noteSent(): void;
  /** Credits persist across turns; this only closes the -do window label. */
  onAgentEnd(): boolean;
  /** null when the command is allowed; otherwise the block reason. */
  check(command: string): string | null;
}

/**
 * Writes cost session credits (one per write subcommand in the command line);
 * reads are free and never blocked. A runner task keeps unlimited access
 * (still add-capped). Credits persist across turns and follow-up questions
 * until spent; /unipi:kanboard-do tops up to N without stacking past N.
 */
export function createWriteGuard(
  runnerTask: () => string | null,
  addLimit: () => number = () => ADD_CAP,
  doCredits: () => number = () => DEFAULT_DO_CREDITS,
): WriteGuard {
  let credits = 0;
  let doOpen = false;
  let sentAt = 0;
  let adds = 0;
  let lastTask: string | null = null;
  const countAdd = (invocation: KanboardInvocation): string | null => {
    if (invocation.sub !== "add") return null;
    adds += 1;
    const limit = addLimit();
    return limit > 0 && adds > limit ? addCapReason(limit) : null;
  };
  return {
    open() {
      credits = Math.max(credits, Math.max(0, doCredits()));
      adds = 0;
      lastTask = null;
      doOpen = true;
    },
    revoke() {
      credits = 0;
      doOpen = false;
    },
    remaining() {
      return credits;
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
        if (task !== null) {
          const cap = countAdd(invocation);
          if (cap) return cap;
          continue;
        }
        if (credits <= 0) return WRITE_CREDITS_USED_UP;
        credits -= 1;
        const cap = countAdd(invocation);
        if (cap) return cap;
      }
      return null;
    },
  };
}
