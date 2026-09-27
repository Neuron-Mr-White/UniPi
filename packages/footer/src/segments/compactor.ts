/**
 * @pi-unipi/footer — Compactor segment
 *
 * One dense, icon-free segment, shown once the session has compacted:
 *
 *   cmp 4× 39k→13k · 3m
 *
 * count, tokens before → after across all compactions, time since the last.
 * Read from the session branch (Pi's compaction entries).
 */

import type { FooterSegment, FooterSegmentContext, RenderedSegment } from "../types.js";
import { applyColor } from "../rendering/theme.js";

function formatTokens(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Tokens left after a compaction: our recorded estimate, else the summary size. */
function tokensAfterOf(entry: any, before: number): number {
  const recorded = Number(entry?.details?.tokensAfter ?? 0);
  if (recorded > 0) return Math.min(recorded, before);
  const summaryChars = typeof entry?.summary === "string" ? entry.summary.length : 0;
  return Math.min(before, Math.ceil(summaryChars / 4));
}

function branchOf(ctx: FooterSegmentContext): any[] {
  const sm = (ctx.piContext as Record<string, unknown> | undefined)?.sessionManager as any;
  try {
    return typeof sm?.getBranch === "function" ? (sm.getBranch() ?? []) : [];
  } catch {
    return [];
  }
}

export function compactionSummary(branch: readonly any[], now = Date.now()): { count: number; before: number; after: number; lastAt?: number } {
  let count = 0;
  let before = 0;
  let after = 0;
  let lastAt: number | undefined;
  for (const e of branch) {
    if (e?.type !== "compaction") continue;
    count++;
    const b = Number(e.tokensBefore ?? 0);
    before += b;
    after += tokensAfterOf(e, b);
    const at = Date.parse(e.timestamp ?? "");
    if (Number.isFinite(at) && at <= now) lastAt = at;
  }
  return { count, before, after, ...(lastAt != null ? { lastAt } : {}) };
}

function renderCompactionsSegment(ctx: FooterSegmentContext): RenderedSegment {
  const s = compactionSummary(branchOf(ctx));
  if (s.count === 0) return { content: "", visible: false };
  const dim = (t: string) => `\x1b[2m${t}\x1b[22m`;
  const sizes = s.before > 0 ? ` ${formatTokens(s.before)}→${formatTokens(s.after)}` : "";
  const age = s.lastAt != null ? dim(` · ${ago(Date.now() - s.lastAt)}`) : "";
  const content = `${dim("cmp")} ${applyColor("compactor", `${s.count}×${sizes}`, ctx.theme, ctx.colors)}${age}`;
  return { content, visible: true };
}

export const COMPACTOR_SEGMENTS: FooterSegment[] = [
  {
    id: "compactions",
    label: "Compactions",
    shortLabel: "CMP",
    description: "Compactions this session: count, tokens before → after, time since the last (hidden until the first)",
    zone: "center",
    render: renderCompactionsSegment,
    defaultShow: true,
  },
];
