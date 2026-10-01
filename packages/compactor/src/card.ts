/**
 * The compaction card — one line in the transcript after each compaction,
 * details on ctrl+o. A custom entry: rendered, never sent to the model.
 *
 * Pi draws its own `[compaction] Compacted from N tokens` block (expands to
 * the summary); this card adds what Pi does not say: the size after, the
 * method, what triggered it, and what was kept.
 */

import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { formatTokens, rail, type KitTheme } from "@pi-unipi/core";
import type { CompactionMethod } from "./types.js";

export const CARD_TYPE = "unipi-compaction";

export type CompactionTrigger = "manual" | "threshold" | "overflow" | "percent";

export interface CompactionCardData {
  method: CompactionMethod;
  trigger: CompactionTrigger;
  /** The command that ran it (manual only), e.g. "unipi:compact-vcc". */
  command?: string;
  tokensBefore: number;
  tokensAfter?: number;
  summaryTokens?: number;
  keptTurns?: number;
  totalTurns?: number;
  keptTokens?: number;
  sections?: string[];
  percent?: number;
  threshold?: number;
}

const METHOD_NAME: Record<CompactionMethod, string> = {
  vcc: "lossless",
  llm: "model summary",
};

const COLOR = "customMessageLabel";

function triggerShort(d: CompactionCardData): string {
  if (d.trigger === "percent") return d.percent != null ? `at ${Math.round(d.percent)}%` : "at threshold";
  if (d.trigger === "threshold") return "context limit";
  if (d.trigger === "overflow") return "overflow";
  return d.command ? `/${d.command}` : "manual";
}

function triggerLong(d: CompactionCardData): string {
  if (d.trigger === "percent") return `${d.percent != null ? `${Math.round(d.percent)}%` : "threshold"} of context${d.threshold != null ? ` (setting: ${d.threshold}%)` : ""}`;
  if (d.trigger === "threshold") return "Pi's context limit";
  if (d.trigger === "overflow") return "context overflow — the request did not fit";
  return d.command ? `/${d.command}` : "manual /compact";
}

/** The collapsed line: sizes, method, notable outcome, trigger. */
export function cardHeadline(d: CompactionCardData): string {
  const size = d.tokensAfter != null ? `${formatTokens(d.tokensBefore)} → ${formatTokens(d.tokensAfter)}` : `from ${formatTokens(d.tokensBefore)}`;
  const parts = [`Compacted ${size} tokens`, METHOD_NAME[d.method]];
  parts.push(triggerShort(d));
  return parts.join(" · ");
}

/** Label/value rows for the expanded card. */
export function cardDetails(d: CompactionCardData): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ["Method", METHOD_NAME[d.method]],
    ["Trigger", triggerLong(d)],
  ];
  if (d.keptTurns != null && d.totalTurns != null) {
    rows.push(["Kept", `last ${d.keptTurns} of ${d.totalTurns} turns${d.keptTokens != null ? ` · ~${formatTokens(d.keptTokens)} tokens verbatim` : ""}`]);
  }
  if (d.summaryTokens != null) {
    rows.push(["Summary", `~${formatTokens(d.summaryTokens)} tokens${d.sections?.length ? ` · ${d.sections.join(", ")}` : ""}`]);
  }
  rows.push(["Recall", "everything before stays searchable: /unipi:session-recall"]);
  return rows;
}

export function renderCompactionCard(d: CompactionCardData, expanded: boolean, theme: KitTheme): Component {
  const lines = (width: number): string[] => {
    const out = [rail(theme, COLOR, cardHeadline(d), expanded ? "" : theme.fg("dim", "ctrl+o"), width)];
    if (expanded) {
      for (const [label, value] of cardDetails(d)) {
        out.push(rail(theme, COLOR, `${theme.fg("dim", label.padEnd(8))} ${theme.fg("muted", value)}`, "", width));
      }
    }
    return out.map((l) => truncateToWidth(l, width));
  };
  return { invalidate() {}, render: lines };
}
