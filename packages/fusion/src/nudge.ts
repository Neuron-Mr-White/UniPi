export const BASH_NUDGE_EVERY = 4;

/** Bins that only read or print. Any first word outside this list is non-trivial. */
const TRIVIAL_BINS = new Set([
  "cd", "ls", "pwd", "cat", "head", "tail", "wc", "echo", "printf", "which",
  "type", "rg", "grep", "stat", "file", "du", "df", "env", "printenv", "date",
  "whoami", "sort", "uniq", "cut", "tr", "jq", "column", "nl", "tree", "fd",
  "basename", "dirname", "realpath", "readlink", "diff", "true",
]);

const GIT_READONLY_SUBCOMMANDS = new Set([
  "status", "log", "diff", "branch", "show", "remote", "rev-parse", "ls-files",
  "blame", "grep", "describe", "shortlog",
]);

const FIND_MUTATORS = /^-(exec|execdir|delete|ok|okdir)$/;

function isTrivialSegment(segment: string): boolean {
  let rest = segment.trim();
  // Strip leading VAR=value env assignments and a leading `timeout <n>` prefix.
  for (;;) {
    const assignment = rest.match(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)(?:\s+|$)/);
    if (!assignment) break;
    rest = rest.slice(assignment[0].length).trim();
  }
  const timeout = rest.match(/^timeout\s+\d+(?:\.\d+)?\S*\s+/);
  if (timeout) rest = rest.slice(timeout[0].length).trim();
  if (!rest) return true;

  const words = rest.split(/\s+/);
  const head = words[0] ?? "";
  const bin = head.split("/").pop() ?? head;
  const args = words.slice(1);

  if (TRIVIAL_BINS.has(bin)) return true;
  if (bin === "find") return !args.some((arg) => FIND_MUTATORS.test(arg));
  if (bin === "sed") return !args.some((arg) => arg.startsWith("-i") || arg.startsWith("--in-place"));
  if (bin === "awk") return !args.join(" ").includes("system(");
  if (bin === "git") return GIT_READONLY_SUBCOMMANDS.has(args[0] ?? "");
  if (bin === "tmux") return args[0] === "capture-pane";
  if (bin === "npm") return ["view", "whoami", "ls"].includes(args[0] ?? "");
  return false;
}

/**
 * True when a command can only read or print: no command substitution, no
 * heredoc, no output redirect, and every `&&`/`||`/`;`/`|`/newline-separated
 * segment starts with a read-only tool. A quoted `|` inside a grep pattern
 * splits the line and fails the check — conservative by design.
 */
export function isTrivialShell(command: string): boolean {
  const rest = command
    .trim()
    .replace(/2>&1/g, " ")
    .replace(/[12]?>\s*\/dev\/null/g, " ")
    .replace(/&>\s*\/dev\/null/g, " ");
  if (rest.includes("$(") || rest.includes("`") || rest.includes("<<") || rest.includes(">")) {
    return false;
  }
  return rest.split(/&&|\|\||[;\n|]/).every((segment) => {
    const trimmed = segment.trim();
    return trimmed.length === 0 || isTrivialSegment(trimmed);
  });
}
