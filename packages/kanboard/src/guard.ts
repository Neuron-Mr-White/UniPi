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
export const WRITE_CREDITS_USED_UP =
  "kanboard write credits used up — run /unipi:kanboard-do to reload (board reads, `start` and `finish` are always free)";
export const addCapReason = (limit: number): string => `at most ${limit} new tasks per turn`;
/** @deprecated tests should read the limit through the guard's getter instead. */
export const ADD_CAP = 20;
export const ADD_CAP_REASON = addCapReason(ADD_CAP);

/** Subcommands that never write to the board. */
const READONLY = new Set(["list", "show", "attachments", "next", "chain", "search", "status"]);

/**
 * Writes that cost nothing and need no -do window: `start`/`finish` only touch
 * tasks the session claims itself (the binary enforces ownership), and the
 * board should always show what is being worked.
 */
const FREE_WRITES = new Set(["start", "finish"]);

/** Global flags that take a value; `--json` is the only valueless one. */
const GLOBAL_VALUE_FLAGS = new Set(["--actor", "--project", "--gate", "--session"]);

/** Quoted spans (single or double quotes), masked before splitting segments. */
const QUOTED_SPAN = /(["'])(?:\\.|(?!\1).)*\1/g;

/**
 * Split a command line into shell segments on `&&`, `||`, `;`, `|` and
 * newlines — ignoring separators inside quoted spans (the mask keeps the
 * original length, so the cut positions map back onto the input exactly).
 */
export function shellSegments(command: string): string[] {
  const masked = command.replace(QUOTED_SPAN, (span) => " ".repeat(span.length));
  const out: string[] = [];
  let at = 0;
  for (const match of masked.matchAll(/&&|\|\||[;|\n]/g)) {
    out.push(command.slice(at, match.index));
    at = match.index + match[0].length;
  }
  out.push(command.slice(at));
  return out;
}

/** `VAR=value` prefixes that may sit in front of the command word. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Wrappers that keep the wrapped word in command position. */
const COMMAND_PREFIXES = new Set(["exec", "command", "env"]);

/**
 * Every subcommand the CLI understands (crates/kanboard/src/cli.rs `Command`,
 * kebab-case as clap spells it). Anything else — a typo like `done`, a bare
 * binary with no subcommand — is the binary's own usage error; the guard
 * neither charges nor blocks it.
 */
export const KNOWN_SUBCOMMANDS = new Set([
  "project", "add", "list", "show", "move", "note", "attach", "attachments",
  "edit", "link", "unlink", "order", "claim-next", "start", "finish", "next",
  "reap", "queue", "unqueue", "chain", "search", "release", "set-run",
  "duplicate", "archive-sweep", "serve", "settings", "rotate-token", "status",
  "stop", "validate",
]);

export interface KanboardInvocation {
  /** First positional after the binary name ("" when absent). */
  sub: string;
  /** Everything after the subcommand. */
  args: string[];
}

/**
 * Every `unipi-kanboard` invocation inside a shell command line. A token
 * counts only when it is positioned like a command: the first word of its
 * segment (segments split on `&&`/`||`/`;`/`|`/newlines, quotes masked),
 * past leading `VAR=value` assignments and the `exec`/`command`/`env`
 * wrappers. `which unipi-kanboard` or `find -name "unipi-kanboard"` merely
 * mention the binary and are not invocations.
 */
export function kanboardInvocations(command: string): KanboardInvocation[] {
  const out: KanboardInvocation[] = [];
  for (const segment of shellSegments(command)) {
    const tokens = tokenizeArgs(segment);
    let head = 0;
    while (head < tokens.length && (ASSIGNMENT.test(tokens[head]!) || COMMAND_PREFIXES.has(tokens[head]!))) {
      head += 1;
    }
    // The binary may be a bare name or an absolute path (and .exe on Windows).
    if (head >= tokens.length || !/unipi-kanboard(\.exe)?$/.test(tokens[head]!)) continue;
    const rest = tokens.slice(head + 1);
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

/** A write that is free and allowed without a -do window (`start`, `finish`). */
export function isFreeWrite(invocation: KanboardInvocation): boolean {
  return FREE_WRITES.has(invocation.sub);
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
 * reads and `start`/`finish` are free and never blocked. Invocations whose
 * subcommand does not exist are skipped: the binary itself rejects them with
 * a usage error, and one typo must not block the rest of a compound call. A
 * runner task keeps unlimited access (still add-capped). Credits persist
 * across turns and follow-up questions until spent; /unipi:kanboard-do tops
 * up to N without stacking past N.
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
        // An unknown subcommand (a typo, a bare binary) is the binary's own
        // usage error — never a reason to block or charge the whole call.
        if (!KNOWN_SUBCOMMANDS.has(invocation.sub)) continue;
        if (isReadonly(invocation) || isFreeWrite(invocation)) continue;
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
