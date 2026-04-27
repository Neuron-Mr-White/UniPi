/**
 * Diff rendering engine — LCS-based diff with 3 layouts and 3 indicators
 */

export type DiffLayout = "auto" | "split" | "unified";
export type DiffIndicator = "bars" | "classic" | "none";

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
  if (style === "bars") {
    return type === "add" ? "│ " : type === "remove" ? "│ " : "  ";
  }
  return type === "add" ? "+ " : type === "remove" ? "- " : "  ";
}

function renderUnified(diff: DiffLine[], indicator: DiffIndicator): string {
  return diff.map((line) => {
    const prefix = indicator === "bars"
      ? (line.type === "add" ? "│ " : line.type === "remove" ? "│ " : "  ")
      : indicatorChar(line.type, indicator);
    return prefix + line.text;
  }).join("\n");
}

function renderSplit(diff: DiffLine[], indicator: DiffIndicator): string {
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

  const maxWidth = Math.max(...left.map((l) => l.length), 40);
  const result: string[] = [];
  for (let i = 0; i < left.length; i++) {
    const l = left[i].padEnd(maxWidth);
    const sep = left[i] && right[i] ? " │ " : "   ";
    result.push(l + sep + right[i]);
  }

  return result.join("\n");
}

export function renderDiff(
  before: string,
  after: string,
  opts?: { layout?: DiffLayout; indicator?: DiffIndicator; maxWidth?: number },
): string {
  const layout = opts?.layout ?? "auto";
  const indicator = opts?.indicator ?? "bars";
  const maxWidth = opts?.maxWidth ?? 120;

  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const diff = computeDiff(beforeLines, afterLines);

  const effectiveLayout = layout === "auto"
    ? (maxWidth >= 100 ? "split" : "unified")
    : layout;

  if (effectiveLayout === "split") {
    return renderSplit(diff, indicator);
  }

  return renderUnified(diff, indicator);
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
