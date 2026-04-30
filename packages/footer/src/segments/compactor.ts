/**
 * @pi-unipi/footer — Compactor segments
 *
 * Segment renderers for the compactor group: session_events, compactions,
 * tokens_saved, compression_ratio, indexed_docs, sandbox_runs, search_queries.
 * Data sourced from COMPACTOR_STATS_UPDATED event via registry cache.
 */

import type { FooterSegment, FooterSegmentContext, RenderedSegment } from "../types.js";
import { applyColor } from "../rendering/theme.js";
import { getIcon } from "../rendering/icons.js";

function withIcon(segmentId: string, text: string): string {
  const icon = getIcon(segmentId);
  return icon ? `${icon} ${text}` : text;
}

function formatTokens(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

/** Get compactor data from registry cache */
function getCompactorData(ctx: FooterSegmentContext): Record<string, unknown> {
  const data = ctx.data;
  if (!data || typeof data !== "object") return {};
  return data as Record<string, unknown>;
}

function renderSessionEventsSegment(ctx: FooterSegmentContext): RenderedSegment {
  const data = getCompactorData(ctx);
  const value = data.sessionEvents ?? "—";
  const content = withIcon("sessionEvents", `${value}`);
  return { content: applyColor("compactor", content, ctx.theme, ctx.colors), visible: true };
}

function renderCompactionsSegment(ctx: FooterSegmentContext): RenderedSegment {
  const data = getCompactorData(ctx);
  const value = data.compactions ?? "—";
  const content = withIcon("compactions", `${value}`);
  return { content: applyColor("compactor", content, ctx.theme, ctx.colors), visible: true };
}

function renderTokensSavedSegment(ctx: FooterSegmentContext): RenderedSegment {
  const data = getCompactorData(ctx);
  const value = data.tokensSaved;
  if (value === undefined || value === null) return { content: "", visible: false };
  const content = withIcon("tokensSaved", formatTokens(Number(value)));
  return { content: applyColor("compactor", content, ctx.theme, ctx.colors), visible: true };
}

function renderCompressionRatioSegment(ctx: FooterSegmentContext): RenderedSegment {
  const data = getCompactorData(ctx);
  const lastCompaction = data.lastCompaction as Record<string, unknown> | undefined;
  const ratio = lastCompaction?.compressionRatio;
  if (!ratio) return { content: "", visible: false };
  const content = withIcon("compressionRatio", `${ratio}`);
  return { content: applyColor("compactor", content, ctx.theme, ctx.colors), visible: true };
}

function renderIndexedDocsSegment(ctx: FooterSegmentContext): RenderedSegment {
  const data = getCompactorData(ctx);
  const value = data.indexedDocs ?? "—";
  const content = withIcon("indexedDocs", `${value}`);
  return { content: applyColor("compactor", content, ctx.theme, ctx.colors), visible: true };
}

function renderSandboxRunsSegment(ctx: FooterSegmentContext): RenderedSegment {
  const data = getCompactorData(ctx);
  const value = data.sandboxRuns ?? "—";
  const content = withIcon("sandboxRuns", `${value}`);
  return { content: applyColor("compactor", content, ctx.theme, ctx.colors), visible: true };
}

function renderSearchQueriesSegment(ctx: FooterSegmentContext): RenderedSegment {
  const data = getCompactorData(ctx);
  const value = data.searchQueries ?? "—";
  const content = withIcon("searchQueries", `${value}`);
  return { content: applyColor("compactor", content, ctx.theme, ctx.colors), visible: true };
}

export const COMPACTOR_SEGMENTS: FooterSegment[] = [
  { id: "session_events", label: "Session Events", icon: "", render: renderSessionEventsSegment, defaultShow: true },
  { id: "compactions", label: "Compactions", icon: "", render: renderCompactionsSegment, defaultShow: true },
  { id: "tokens_saved", label: "Tokens Saved", icon: "", render: renderTokensSavedSegment, defaultShow: true },
  { id: "compression_ratio", label: "Compression Ratio", icon: "", render: renderCompressionRatioSegment, defaultShow: false },
  { id: "indexed_docs", label: "Indexed Docs", icon: "", render: renderIndexedDocsSegment, defaultShow: false },
  { id: "sandbox_runs", label: "Sandbox Runs", icon: "", render: renderSandboxRunsSegment, defaultShow: false },
  { id: "search_queries", label: "Search Queries", icon: "", render: renderSearchQueriesSegment, defaultShow: false },
];
