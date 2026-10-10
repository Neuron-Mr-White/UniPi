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

function stripQuotes(word: string): string {
  return /^(".*"|'.*')$/.test(word) ? word.slice(1, -1) : word;
}

function isTrivialSegment(segment: string, variables: Map<string, string>): boolean {
  let rest = segment.trim();
  const assignments = new Map<string, string>();
  // Strip leading VAR=value env assignments and a leading `timeout <n>` prefix.
  for (;;) {
    const assignment = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)=("(?:\\.|[^"\\])*"|'[^']*'|\S*)(?:\s+|$)/);
    if (!assignment) break;
    assignments.set(assignment[1], stripQuotes(assignment[2]));
    rest = rest.slice(assignment[0].length).trim();
  }
  if (!rest) {
    for (const [name, value] of assignments) variables.set(name, value);
    return true;
  }
  const variable = rest.match(/^(?:\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|"\$([A-Za-z_][A-Za-z0-9_]*)"|"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")(?=\s|$)/);
  if (variable) {
    const name = variable.slice(1).find((name) => name !== undefined)!;
    const value = variables.get(name);
    if (value === undefined) return false;
    rest = value + rest.slice(variable[0].length);
  }
  const timeout = rest.match(/^timeout\s+\d+(?:\.\d+)?\S*\s+/);
  if (timeout) rest = rest.slice(timeout[0].length).trim();
  if (!rest) return true;

  const headWord = rest.match(/^("[^"]*"|'[^']*'|\S+)/)?.[0] ?? "";
  const head = stripQuotes(headWord);
  const bin = head.split("/").pop() ?? head;
  const args = rest.slice(headWord.length).trim().split(/\s+/);

  // Board writes are lead-only, so delegating any kanboard invocation is wrong too.
  if (bin === "unipi-kanboard") return true;
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
 * segment starts with a read-only tool or the lead-only kanboard CLI.
 */
export function isTrivialShell(command: string): boolean {
  const rest = command
    .trim()
    .replace(/2>&1/g, " ")
    .replace(/[12]?>\s*\/dev\/null/g, " ")
    .replace(/&>\s*\/dev\/null/g, " ");
  const segments: string[] = [];
  let start = 0;
  let quote = "";
  for (let i = 0; i < rest.length; i++) {
    const char = rest[i];
    if (char === "\\" && quote !== "'") {
      i++;
      continue;
    }
    if (quote !== "'" && (rest.startsWith("$(", i) || char === "`")) return false;
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ">" || rest.startsWith("<<", i)) return false;
    if (char === ";" || char === "|" || char === "\n" || rest.startsWith("&&", i)) {
      segments.push(rest.slice(start, i));
      if (rest.startsWith("&&", i) || rest.startsWith("||", i)) i++;
      start = i + 1;
    }
  }
  segments.push(rest.slice(start));
  const variables = new Map<string, string>();
  return segments.every((segment) => isTrivialSegment(segment, variables));
}
