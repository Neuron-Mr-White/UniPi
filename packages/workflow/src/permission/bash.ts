/**
 * Bash classification for the permission gate.
 *
 * A command line is split into simple commands (quote-aware) and classified:
 * `dangerous` (always prompt outside full mode), `read_only` (allowlisted, no
 * jev call needed), or `unknown` (falls through to the jev risk judgement).
 */

export interface ParsedBash {
  /** Simple commands, in order, each trimmed. */
  commands: string[];
  /**
   * Command substitution (`$( )`, backticks) or unbalanced quotes — the real
   * command can't be known statically, so it is never treated as read-only.
   */
  ambiguous: boolean;
}

/** Split on `&&`, `||`, `;`, `|` and newlines, ignoring separators inside quotes. */
export function parseBashCommands(input: string): ParsedBash {
  const commands: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let ambiguous = false;

  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed) commands.push(trimmed);
    current = "";
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    const next = input[i + 1];

    if (quote === null) {
      if (ch === "\\") {
        current += next ?? "";
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
        continue;
      }
      if (ch === "$" && next === "(") ambiguous = true;
      if (ch === "`") ambiguous = true;
      if (ch === "\n" || ch === ";") {
        flush();
        continue;
      }
      if (ch === "&" && next === "&") {
        flush();
        i++;
        continue;
      }
      if (ch === "|") {
        flush();
        if (next === "|") i++;
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === "\\" && quote === '"') {
      current += ch + (next ?? "");
      i++;
      continue;
    }
    if (ch === quote) quote = null;
    current += ch;
  }

  if (quote !== null) ambiguous = true;
  flush();
  return { commands, ambiguous };
}

/** Whitespace-split that keeps quoted spans together and strips the quotes. */
export function tokenize(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === null && (ch === " " || ch === "\t")) {
      if (started) {
        out.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    if (quote === null && (ch === '"' || ch === "'")) {
      quote = ch;
      started = true;
      continue;
    }
    if (quote !== null && ch === quote) {
      quote = null;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) out.push(current);
  return out;
}

/** A `>`/`>>` that writes a file (fd duplication like `2>&1` does not count). */
const WRITE_REDIRECT = /(?:^|[^0-9])>>?(?!&)/;

const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "fd", "pwd", "echo", "printf",
  "which", "type", "file", "stat", "du", "df", "tree", "sort", "uniq", "cut", "tr",
  "jq", "less", "more", "diff", "bat", "basename", "dirname", "realpath", "readlink",
  "date", "whoami", "id", "hostname", "uname", "ps", "printenv", "seq", "nl", "column",
  "git", "find",
]);

const FIND_MUTATORS = /^-(exec|execdir|delete|fprint|fprint0|fls|ok|okdir)$/;

function isReadOnlyGit(argv: string[]): boolean {
  const sub = argv[1];
  if (!sub) return false;
  if (
    ["status", "diff", "log", "show", "blame", "rev-parse", "describe", "shortlog",
      "ls-files", "ls-remote", "whatchanged", "reflog", "fsck", "grep"].includes(sub)
  ) {
    return true;
  }
  if (sub === "branch") {
    return !argv.some((a) => /^-[dDmMcC]$/.test(a) || /^--(delete|move|copy)$/.test(a));
  }
  if (sub === "remote") return argv.length === 2 || argv.includes("-v") || argv.includes("--verbose");
  if (sub === "tag") return argv.length === 2 || argv.includes("-l") || argv.includes("--list");
  if (sub === "config") return argv.some((a) => ["--get", "--list", "-l"].includes(a));
  if (sub === "stash") return argv[2] === "list" || argv[2] === "show";
  if (sub === "worktree") return argv[2] === "list";
  if (sub === "version") return true;
  return false;
}

/** Every simple command must be allowlisted before the line is read-only. */
export function isReadOnlyCommand(command: string): boolean {
  const argv = tokenize(command);
  const head = argv[0];
  if (!head) return true;
  const bin = head.split("/").pop() ?? head;
  if (WRITE_REDIRECT.test(command)) return false;
  if (bin === "find") return !argv.some((a) => FIND_MUTATORS.test(a));
  if (bin === "git") return isReadOnlyGit(argv);
  if (bin === "npm") {
    return ["ls", "list", "view", "info", "outdated", "why", "explain"].includes(argv[1] ?? "");
  }
  if (bin === "node") return argv.length === 2 && /^--?version$|^-v$/.test(argv[1]!);
  return READ_ONLY_COMMANDS.has(bin);
}

/** Directories a write must never touch without an explicit prompt. */
const PROTECTED_PATHS = [/(^|\/|~|\$HOME)\.ssh(\/|$)/, /(^|\/|~|\$HOME)\.aws(\/|$)/, /(^|\/)etc(\/|$)/];
const WRITE_BINS = new Set(["cp", "mv", "rm", "tee", "chmod", "chown", "ln", "install", "truncate", "dd", "rsync", "mkdir", "touch"]);
const SECRET_READ_BINS = new Set(["cat", "less", "more", "head", "tail", "grep", "rg", "sed", "awk", "xxd", "strings", "od", "vi", "vim", "nano"]);
const SECRET_FILES = /(^|[\s/"'])\.env(\.(local|production|development|test|staging))?(?![\w.])|(^|[\s/"'])id_(rsa|ed25519|ecdsa)(?![\w.])|(^|[\s/"'])[^\s/"']*\.pem(?![\w.])/;

/** Reason this simple command is dangerous, or null. */
export function dangerousReason(command: string, argv: string[] = tokenize(command)): string | null {
  const bin = (argv[0] ?? "").split("/").pop() ?? "";
  const text = command;

  if (bin === "sudo" || bin === "su" || bin === "doas") return "privilege escalation";
  if (bin === "dd" || bin.startsWith("mkfs")) return `raw disk tool (${bin})`;

  if (bin === "chmod" || bin === "chown" || bin === "chgrp" || bin === "chattr") {
    if (argv.slice(1).some((a) => /^-R$|^--recursive$|^-[a-zA-Z]*R/.test(a))) return "recursive permission change";
  }

  if (bin === "rm") {
    const flags = argv.slice(1).filter((a) => a.startsWith("-"));
    const recursive = flags.some((f) => /^-[a-zA-Z]*[rR]/.test(f)) || flags.includes("--recursive");
    const force = flags.some((f) => /^-[a-zA-Z]*f/.test(f)) || flags.includes("--force");
    if (recursive && force) return "rm -rf";
  }

  if (bin === "git") {
    const rest = argv.slice(1);
    if (rest[0] === "push" && rest.some((a) => a === "-f" || /^--force(-with-lease)?$/.test(a))) return "git push --force";
    if (rest[0] === "reset" && rest.includes("--hard")) return "git reset --hard";
    if (rest[0] === "clean" && rest.some((a) => /^-[a-zA-Z]*f/.test(a))) return "git clean -f";
    if (rest[0] === "branch" && rest.some((a) => /^-[a-zA-Z]*D/.test(a) || a === "--delete")) return "git branch -D";
    if (rest[0] === "checkout" && rest.includes("--")) return "git checkout -- (discards changes)";
  }

  if (bin === "kill" && argv.some((a) => a === "-9" || a === "-KILL" || a === "-s9")) return "kill -9";
  if (bin === "pkill" || bin === "killall") return "process kill";

  if (/(curl|wget)[^|]*\|\s*(sudo\s+)?(ba|z|k|da)?sh\b/.test(text)) return "piping a download into a shell";

  const writes = WRITE_REDIRECT.test(text) || WRITE_BINS.has(bin);
  if (writes && PROTECTED_PATHS.some((re) => re.test(text))) return "writes outside the project";

  if (SECRET_READ_BINS.has(bin) && SECRET_FILES.test(text)) return "reads secrets";

  return null;
}

/**
 * The board CLI run by an agent: `unipi-kanboard … --actor agent …`. Safe to
 * run without a prompt in auto/full (the task runner taught the agent to call
 * it), but never in ask mode and never for `--actor user|system`.
 */
export function isKanboardAgentCommand(command: string): boolean {
  const argv = tokenize(command);
  const head = argv[0];
  if (!head) return false;
  const bin = head.split("/").pop() ?? head;
  if (bin !== "unipi-kanboard" && bin !== "unipi-kanboard.exe") return false;
  let actor: string | null = null;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--actor") {
      actor = argv[index + 1] ?? null;
      continue;
    }
    if (arg.startsWith("--actor=")) actor = arg.slice("--actor=".length);
  }
  return actor === "agent";
}

export interface BashClassification {
  kind: "dangerous" | "read_only" | "kanboard" | "unknown";
  /** Short human-readable reason (used in prompts and the debug log). */
  reason: string;
}

export function classifyBash(input: string): BashClassification {
  const { commands, ambiguous } = parseBashCommands(input);
  if (commands.length === 0) return { kind: "read_only", reason: "empty command" };

  for (const command of commands) {
    const danger = dangerousReason(command);
    if (danger) return { kind: "dangerous", reason: danger };
  }

  if (ambiguous) return { kind: "unknown", reason: "command substitution or unbalanced quotes" };
  if (commands.every((command) => isReadOnlyCommand(command))) {
    return { kind: "read_only", reason: "read-only command" };
  }
  // Every part must be either read-only or the agent's board CLI; a compound
  // command with anything else keeps the normal rules (jevy/ask).
  if (
    commands.every((command) => isReadOnlyCommand(command) || isKanboardAgentCommand(command)) &&
    commands.some((command) => isKanboardAgentCommand(command))
  ) {
    return { kind: "kanboard", reason: "kanboard CLI (--actor agent)" };
  }
  return { kind: "unknown", reason: "not a known read-only command" };
}
