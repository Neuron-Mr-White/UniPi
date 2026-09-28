/**
 * @pi-unipi/utility — response formatting helpers (pure)
 *
 * Splits a shell command into shell text and embedded code (heredoc bodies,
 * `python -c "…"`, `node -e '…'`) with the embedded language, parses pi's
 * display diff, and pulls exit codes and test summaries out of tool output.
 */

export interface Segment {
  kind: "shell" | "code";
  text: string;
  lang: string;
}

const RUNTIME_LANG: Array<[RegExp, string]> = [
  [/\b(?:python3?|uv run python|ipython)\b/, "python"],
  [/\b(?:node|deno|bun|tsx|ts-node)\b/, "javascript"],
  [/\b(?:psql|sqlite3|mysql|duckdb|clickhouse-client)\b/, "sql"],
  [/\b(?:ruby|irb)\b/, "ruby"],
  [/\b(?:php)\b/, "php"],
  [/\b(?:perl)\b/, "perl"],
  [/\b(?:lua|luajit)\b/, "lua"],
  [/\b(?:bash|sh|zsh|ssh\s+\S+)\b/, "bash"],
  [/\bjq\b/, "json"],
];

const EXT_LANG: Record<string, string> = {
  py: "python", js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", mts: "typescript", tsx: "tsx", jsx: "jsx",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml", sql: "sql", sh: "bash", bash: "bash", rs: "rust", go: "go",
  rb: "ruby", md: "markdown", html: "html", css: "css", xml: "xml", ini: "ini", conf: "ini", dockerfile: "dockerfile",
};

/** Language of code fed to the command before the heredoc marker. */
export function langForPrefix(prefix: string): string {
  const line = prefix.split("\n").pop() ?? prefix;
  const target = line.match(/(?:>|tee\s+(?:-a\s+)?)\s*["']?([^\s"'|;&]+)["']?\s*(?:<<|$)/)?.[1];
  const ext = target?.split(".").pop()?.toLowerCase();
  if (ext && EXT_LANG[ext]) return EXT_LANG[ext]!;
  for (const [re, lang] of RUNTIME_LANG) if (re.test(line)) return lang;
  return "text";
}

/**
 * Shell text and embedded code, in order. Heredocs (`<<EOF`, `<<'EOF'`,
 * `<<-"EOF"`) take the language of their command; `-c/-e` string arguments
 * of known runtimes are highlighted as that runtime's language.
 */
export function splitCommand(command: string): Segment[] {
  const out: Segment[] = [];
  const push = (kind: Segment["kind"], text: string, lang: string) => {
    if (!text) return;
    const last = out.at(-1);
    if (last && last.kind === kind && last.lang === lang) last.text += text;
    else out.push({ kind, text, lang });
  };
  const heredoc = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n/g;
  let at = 0;
  for (let m = heredoc.exec(command); m; m = heredoc.exec(command)) {
    const tag = m[2]!;
    const bodyStart = m.index + m[0].length;
    const end = new RegExp(`^[\\t ]*${tag}[\\t ]*$`, "m");
    const rest = command.slice(bodyStart);
    const close = end.exec(rest);
    if (!close) continue;
    pushInline(command.slice(at, bodyStart), push);
    push("code", rest.slice(0, close.index), langForPrefix(command.slice(0, m.index)));
    at = bodyStart + close.index;
    heredoc.lastIndex = at;
  }
  pushInline(command.slice(at), push);
  return out;
}

/** `python -c "…"` / `node -e '…'` → code segment; the rest stays shell. */
function pushInline(text: string, push: (kind: Segment["kind"], text: string, lang: string) => void): void {
  const inline = /\b(python3?|node|deno|bun|ruby|perl|psql|sqlite3)\b([^\n'"]*?\s-(?:c|e|-eval|-command)\s+)(["'])([\s\S]*?)\3/g;
  let at = 0;
  for (let m = inline.exec(text); m; m = inline.exec(text)) {
    const quoteStart = m.index + m[1]!.length + m[2]!.length;
    push("shell", text.slice(at, quoteStart + 1), "bash");
    push("code", m[4]!, langForPrefix(m[1]!));
    push("shell", m[3]!, "bash");
    at = m.index + m[0].length;
  }
  push("shell", text.slice(at), "bash");
}

export interface DiffRow {
  kind: "add" | "del" | "ctx" | "gap";
  line?: number;
  text: string;
}

/** pi's display diff (`+12 text`, `-12 text`, ` 12 text`, `...`) → rows. */
export function parseDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const raw of diff.split("\n")) {
    const m = raw.match(/^([+\- ])(\s*\d+) (.*)$/);
    if (m) {
      rows.push({ kind: m[1] === "+" ? "add" : m[1] === "-" ? "del" : "ctx", line: Number(m[2]), text: m[3]! });
    } else if (/^\s*\.\.\.\s*$/.test(raw) || /^[+\- ]\s*\.\.\.$/.test(raw)) {
      rows.push({ kind: "gap", text: "" });
    } else if (raw.length) {
      rows.push({ kind: "ctx", text: raw });
    }
  }
  return rows;
}

export function diffStats(rows: readonly DiffRow[]): { added: number; removed: number } {
  return { added: rows.filter((r) => r.kind === "add").length, removed: rows.filter((r) => r.kind === "del").length };
}

/** Exit code from pi's bash error text; 0 for a successful result. */
export function exitCode(text: string, isError: boolean): number | undefined {
  const m = text.match(/Command exited with code (\d+)\s*$/);
  if (m) return Number(m[1]);
  if (/Command (?:aborted|terminated without an exit code)\s*$/.test(text)) return undefined;
  return isError ? 1 : 0;
}

/** Output without pi's trailing status line. */
export function stripStatus(text: string): string {
  return text.replace(/\n*(?:Command exited with code \d+|Command aborted|Command terminated without an exit code)\s*$/, "");
}

/** "83 passed · 0 failed" from common test runners' summary lines. */
export function testSummary(output: string): { passed: number; failed: number } | undefined {
  let passed: number | undefined;
  let failed: number | undefined;
  const set = (p?: string, f?: string) => {
    if (p !== undefined) passed = (passed ?? 0) + Number(p);
    if (f !== undefined) failed = (failed ?? 0) + Number(f);
  };
  for (const line of output.split("\n")) {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, "");
    let m: RegExpMatchArray | null;
    if ((m = clean.match(/^ℹ pass (\d+)/))) set(m[1]);
    else if ((m = clean.match(/^ℹ fail (\d+)/))) set(undefined, m[1]);
    else if ((m = clean.match(/Tests?:?\s+(?:(\d+) failed[,|\s]+)?(\d+) passed/i))) set(m[2], m[1] ?? "0");
    else if ((m = clean.match(/test result: \w+\. (\d+) passed; (\d+) failed/))) set(m[1], m[2]);
    else if ((m = clean.match(/^=+ (?:(\d+) failed, )?(\d+) passed/))) set(m[2], m[1] ?? "0");
  }
  return passed === undefined && failed === undefined ? undefined : { passed: passed ?? 0, failed: failed ?? 0 };
}

/** Pretty JSON when the whole output is one JSON value; else undefined. */
export function asJson(output: string): string | undefined {
  const t = output.trim();
  if (!/^[[{]/.test(t) || t.length > 200_000) return undefined;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return undefined;
  }
}
