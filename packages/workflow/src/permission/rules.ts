/**
 * Saved permission rules — glob-matched allow/deny decisions stored in the
 * `permission` settings namespace (project scope by default).
 *
 * Deny always wins: a deny rule blocks the same subject an allow rule matches,
 * in every mode including `full`.
 */

export type RuleDecision = "allow" | "deny";
export type RuleScope = "project" | "global";

export interface PermissionRule {
  /** Tool name (`bash`, `write`, `edit`) or `*` for any tool. */
  tool: string;
  /** Glob over the bash command, the write/edit path, or the args summary. */
  pattern: string;
  decision: RuleDecision;
  scope: RuleScope;
}

const GLOB_SPECIALS = /[.+^${}()|[\]\\]/g;

/** `*` → any run, `?` → one char, everything else literal (case-insensitive). */
export function globMatches(pattern: string, subject: string): boolean {
  const body = pattern
    .split("")
    .map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(GLOB_SPECIALS, "\\$&")))
    .join("");
  try {
    return new RegExp(`^${body}$`, "is").test(subject);
  } catch {
    return false;
  }
}

export function ruleMatches(rule: PermissionRule, tool: string, subject: string): boolean {
  if (rule.tool !== "*" && rule.tool !== tool) return false;
  return globMatches(rule.pattern, subject);
}

/** The applicable rule for a subject — a deny rule shadows an allow rule. */
export function matchRule(
  rules: readonly PermissionRule[],
  tool: string,
  subject: string,
): PermissionRule | undefined {
  const applicable = rules.filter((rule) => ruleMatches(rule, tool, subject));
  return applicable.find((rule) => rule.decision === "deny") ?? applicable.find((rule) => rule.decision === "allow");
}

/** Strip rule entries that are not well formed (settings files are user-editable). */
export function normalizeRules(value: unknown): PermissionRule[] {
  if (!Array.isArray(value)) return [];
  const out: PermissionRule[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const rule = entry as Record<string, unknown>;
    if (typeof rule.pattern !== "string" || rule.pattern.length === 0) continue;
    if (rule.decision !== "allow" && rule.decision !== "deny") continue;
    out.push({
      tool: typeof rule.tool === "string" && rule.tool.length > 0 ? rule.tool : "*",
      pattern: rule.pattern,
      decision: rule.decision,
      scope: rule.scope === "global" ? "global" : "project",
    });
  }
  return out;
}

/** First words that must never be widened into a `*` rule. */
const EXACT_ONLY_BINS = new Set([
  "rm", "rmdir", "mv", "cp", "dd", "mkfs", "chmod", "chown", "chgrp", "chattr",
  "sudo", "su", "doas", "kill", "pkill", "killall", "tee", "truncate", "ln", "install", "shred",
]);

/**
 * The pattern offered as "Always allow …": for bash the first word(s) up to the
 * first flag/path, for a path the containing directory glob. Commands whose
 * first word is destructive stay exact — `Allow always` on `rm -rf x` must not
 * become `rm *`.
 */
export function suggestPattern(tool: string, subject: string): string {
  if (tool !== "bash") {
    const dir = subject.replace(/\/[^/]*$/, "");
    return dir && dir !== subject ? `${dir}/*` : subject;
  }
  const trimmed = subject.trim();
  // Compound commands (&&, ||, ;, |, newlines) must stay exact: `Always allow
  // \`cd *\`` would otherwise also cover whatever follows the `cd`.
  if (/[&|;\n]/.test(trimmed)) return trimmed;
  const words = trimmed.split(/\s+/);
  const bin = (words[0] ?? "").split("/").pop() ?? "";
  if (EXACT_ONLY_BINS.has(bin)) return trimmed;
  const head: string[] = [];
  for (const word of words) {
    if (head.length > 0 && (word.startsWith("-") || word.includes("/") || word.includes("="))) break;
    head.push(word);
    if (head.length === 2) break;
  }
  const base = head.join(" ") || words[0] || subject;
  return subject.trim() === base ? base : `${base} *`;
}
