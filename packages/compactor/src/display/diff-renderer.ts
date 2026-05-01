/**
 * Diff rendering engine — LCS-based diff with 3 layouts, 3 indicators,
 * syntax highlighting, and Nerd Font detection
 */

import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";

export type DiffLayout = "auto" | "split" | "unified";
export type DiffIndicator = "bars" | "classic" | "nerd" | "none";

// --- Nerd Font Detection ---

let nerdFontDetected: boolean | null = null;

/** Detect if terminal supports Nerd Font icons */
export function detectNerdFont(): boolean {
  if (nerdFontDetected !== null) return nerdFontDetected;
  // Check common Nerd Font env vars or terminal emulators
  const term = process.env.TERM_PROGRAM ?? "";
  const termFont = process.env.TERM_FONT ?? "";
  nerdFontDetected =
    termFont.toLowerCase().includes("nerd") ||
    process.env.NERD_FONT === "1" ||
    term === "WezTerm" ||
    term === "iTerm.app" ||
    (process.env.TERMINAL_EMULATOR ?? "").includes("JetBrains") ||
    false;
  return nerdFontDetected;
}

/** Nerd Font indicator chars */
const NERD_INDICATORS = {
  add: "\uf055 ",   // nf-fa-plus_circle
  remove: "\uf056 ", // nf-fa-minus_circle
  same: "  ",
} as const;

// --- Syntax Highlighting ---

const KEYWORDS: Record<string, Set<string>> = {
  js: new Set(["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "import", "export", "from", "async", "await", "try", "catch", "throw", "new", "this", "typeof", "instanceof", "in", "of", "switch", "case", "break", "continue", "default", "yield", "void", "delete", "null", "undefined", "true", "false"]),
  py: new Set(["def", "class", "import", "from", "return", "if", "elif", "else", "for", "while", "try", "except", "finally", "raise", "with", "as", "yield", "lambda", "pass", "break", "continue", "and", "or", "not", "in", "is", "None", "True", "False", "self", "async", "await"]),
  ts: new Set(["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "import", "export", "from", "async", "await", "try", "catch", "throw", "new", "this", "typeof", "instanceof", "interface", "type", "enum", "namespace", "module", "declare", "implements", "extends", "public", "private", "protected", "readonly", "static", "abstract", "override", "keyof", "infer", "never", "unknown", "any", "void", "string", "number", "boolean", "null", "undefined", "true", "false"]),
  sh: new Set(["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "return", "local", "export", "readonly", "declare", "unset", "shift", "source", "exit", "echo", "printf", "read", "test", "true", "false"]),
};

/** Apply basic syntax highlighting to a line */
function highlightLine(line: string, lang?: string): string {
  if (!lang) return line;
  const keywords = KEYWORDS[lang] ?? KEYWORDS.js;
  // Highlight keywords (simple word boundary match)
  return line.replace(/\b([a-zA-Z_]\w*)\b/g, (match) => {
    if (keywords.has(match)) return `\x1b[34m${match}\x1b[0m`; // blue
    return match;
  });
}

/** Detect language from file extension or content */
function detectLanguage(filePath?: string, content?: string): string | undefined {
  if (filePath) {
    const ext = filePath.split(".").pop()?.toLowerCase();
    const extMap: Record<string, string> = {
      js: "js", mjs: "js", cjs: "js", jsx: "js",
      ts: "ts", mts: "ts", cts: "ts", tsx: "ts",
      py: "py", pyw: "py",
      sh: "sh", bash: "sh", zsh: "sh",
    };
    if (ext && extMap[ext]) return extMap[ext];
  }
  if (content) {
    if (content.includes("def ") || content.includes("import ")) return "py";
    if (content.includes("function ") || content.includes("const ")) return "js";
    if (content.includes("#!/bin/")) return "sh";
  }
  return undefined;
}

interface DiffLine {
  type: "same" | "add" | "remove";
  text: string;
}

function lcs<T>(a: T[], b: T[]): T[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const result: T[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}

function computeDiff(before: string[], after: string[]): DiffLine[] {
  const common = lcs(before, after);
  const result: DiffLine[] = [];
  let i = 0, j = 0, k = 0;

  while (i < before.length || j < after.length) {
    if (k < common.length && before[i] === common[k] && after[j] === common[k]) {
      result.push({ type: "same", text: after[j] });
      i++;
      j++;
      k++;
    } else if (i < before.length && (k >= common.length || before[i] !== common[k])) {
      result.push({ type: "remove", text: before[i] });
      i++;
    } else if (j < after.length && (k >= common.length || after[j] !== common[k])) {
      result.push({ type: "add", text: after[j] });
      j++;
    } else {
      break;
    }
  }

  return result;
}

function indicatorChar(type: DiffLine["type"], style: DiffIndicator): string {
  if (style === "none") return "  ";
  if (style === "nerd") {
    if (type === "add") return `\x1b[32m${NERD_INDICATORS.add}\x1b[0m`;
    if (type === "remove") return `\x1b[31m${NERD_INDICATORS.remove}\x1b[0m`;
    return NERD_INDICATORS.same;
  }
  if (style === "bars") {
    if (type === "add") return `\x1b[32m│ \x1b[0m`;
    if (type === "remove") return `\x1b[31m│ \x1b[0m`;
    return "  ";
  }
  return type === "add" ? "+ " : type === "remove" ? "- " : "  ";
}

function renderUnified(
  diff: DiffLine[],
  indicator: DiffIndicator,
  maxWidth?: number,
): string {
  return diff.map((line) => {
    const prefix = indicator === "bars"
      ? (line.type === "add" ? "│ " : line.type === "remove" ? "│ " : "  ")
      : indicatorChar(line.type, indicator);
    const rendered = prefix + line.text;
    if (maxWidth && visibleWidth(rendered) > maxWidth) {
      return truncateToWidth(rendered, maxWidth, "…");
    }
    return rendered;
  }).join("\n");
}

function renderSplit(
  diff: DiffLine[],
  indicator: DiffIndicator,
  maxW?: number,
): string {
  const left: string[] = [];
  const right: string[] = [];

  for (const line of diff) {
    if (line.type === "same") {
      left.push("  " + line.text);
      right.push("  " + line.text);
    } else if (line.type === "remove") {
      left.push(indicatorChar("remove", indicator) + line.text);
      right.push("");
    } else if (line.type === "add") {
      left.push("");
      right.push(indicatorChar("add", indicator) + line.text);
    }
  }

  const halfW = maxW ? Math.floor(maxW / 2) - 2 : 40;
  const colW = Math.max(
    ...left.map((l) => visibleWidth(l)),
    ...right.map((l) => visibleWidth(l)),
    Math.min(halfW, 40),
  );
  const result: string[] = [];
  for (let i = 0; i < left.length; i++) {
    const lTrunc = visibleWidth(left[i]) > colW
      ? truncateToWidth(left[i], colW, "…")
      : left[i].padEnd(colW);
    const sep = left[i] && right[i] ? " │ " : "   ";
    let rLine = right[i];
    if (maxW && visibleWidth(lTrunc + sep + rLine) > maxW) {
      const rBudget = maxW - visibleWidth(lTrunc + sep);
      rLine = truncateToWidth(rLine, Math.max(1, rBudget), "…");
    }
    result.push(lTrunc + sep + rLine);
  }

  return result.join("\n");
}

export function renderDiff(
  before: string,
  after: string,
  opts?: { layout?: DiffLayout; indicator?: DiffIndicator; maxWidth?: number; filePath?: string; highlight?: boolean },
): string {
  const layout = opts?.layout ?? "auto";
  let indicator = opts?.indicator ?? "bars";
  const maxWidth = opts?.maxWidth ?? 120;
  const doHighlight = opts?.highlight ?? true;

  // Auto-detect Nerd Font for indicator selection
  if (indicator === "bars" && detectNerdFont()) {
    indicator = "nerd";
  }

  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const diff = computeDiff(beforeLines, afterLines);

  const effectiveLayout = layout === "auto"
    ? (maxWidth >= 100 ? "split" : "unified")
    : layout;

  let effectiveIndicator = indicator;
  // Auto mode: use classic indicator for unified to keep output clean
  if (layout === "auto" && effectiveLayout === "unified" && indicator !== "nerd") {
    effectiveIndicator = "classic";
  }

  // Apply syntax highlighting if enabled
  let highlightedDiff = diff;
  if (doHighlight) {
    const lang = detectLanguage(opts?.filePath, after);
    if (lang) {
      highlightedDiff = diff.map((line) => ({
        ...line,
        text: highlightLine(line.text, lang),
      }));
    }
  }

  if (effectiveLayout === "split") {
    return renderSplit(highlightedDiff, effectiveIndicator, maxWidth);
  }

  return renderUnified(highlightedDiff, effectiveIndicator, maxWidth);
}

export function renderEditDiffResult(
  previousContent: string,
  newContent: string,
  opts?: { layout?: DiffLayout; indicator?: DiffIndicator; maxWidth?: number },
): string {
  return renderDiff(previousContent, newContent, opts);
}

export function renderWriteDiffResult(
  previousContent: string | undefined,
  newContent: string,
  opts?: { layout?: DiffLayout; indicator?: DiffIndicator; maxWidth?: number },
): string {
  if (!previousContent) {
    return "[New file created]\n" + newContent.split("\n").map((l) => "+ " + l).join("\n");
  }
  return renderDiff(previousContent, newContent, opts);
}
