/**
 * @pi-unipi/footer — Compactor segments
 *
 * Segment renderers for the compactor group: session_events, compactions,
 * tokens_saved, compression_ratio, indexed_docs, sandbox_runs, search_queries.
 *
 * Data sourced from piContext.sessionManager (live session data).
 * Segments without a reliable data source are hidden (visible: false)
 * rather than showing a placeholder like "—".
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

/** Hidden segment — no reliable data source available */
function hidden(): RenderedSegment {
  return { content: "", visible: false };
}

/** Safely extract sessionManager from piContext */
function getSessionManager(ctx: FooterSegmentContext): any {
  const piCtx = ctx.piContext as Record<string, unknown> | undefined;
  return piCtx?.sessionManager as any | undefined;
}

/** Get all session events from sessionManager branch */
function getSessionEvents(ctx: FooterSegmentContext): any[] {
  const sm = getSessionManager(ctx);
  if (!sm || typeof sm.getBranch !== "function") return [];
  try {
    return sm.getBranch() ?? [];
  } catch {
    return [];
  }
}

function renderSessionEventsSegment(ctx: FooterSegmentContext): RenderedSegment {
  const events = getSessionEvents(ctx);
  const count = events.length;
  if (count === 0) return hidden();

  const content = withIcon("sessionEvents", `${count}`);
  return { content: applyColor("compactor", content, ctx.theme, ctx.colors), visible: true };
}

function renderCompactionsSegment(ctx: FooterSegmentContext): RenderedSegment {
  // Count compaction entries in the session events
  const events = getSessionEvents(ctx);
  let compactionCount = 0;
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "compaction" || e.type === "compacted") {
      compactionCount++;
    }
  }
  if (compactionCount === 0) return hidden();

  const content = withIcon("compactions", `${compactionCount}`);
  return { content: applyColor("compactor", content, ctx.theme, ctx.colors), visible: true };
}

function renderTokensSavedSegment(ctx: FooterSegmentContext): RenderedSegment {
  // Sum tokens saved from compaction events if available
  const events = getSessionEvents(ctx);
  let tokensSaved = 0;
  let hasCompaction = false;
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "compaction" || e.type === "compacted") {
      hasCompaction = true;
      tokensSaved += Number(e.tokensSaved ?? e.tokens_saved ?? 0);
    }
  }
  if (!hasCompaction || tokensSaved === 0) return hidden();

  const content = withIcon("tokensSaved", formatTokens(tokensSaved));
  return { content: applyColor("compactor", content, ctx.theme, ctx.colors), visible: true };
}

function renderCompressionRatioSegment(ctx: FooterSegmentContext): RenderedSegment {
  // Check last compaction event for compression ratio
  const events = getSessionEvents(ctx);
  let lastRatio: number | undefined;
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "compaction" || e.type === "compacted") {
      const ratio = e.compressionRatio ?? e.compression_ratio;
      if (ratio !== undefined && ratio !== null) {
        lastRatio = Number(ratio);
      }
    }
  }
  if (lastRatio === undefined) return hidden();

  const content = withIcon("compressionRatio", `${lastRatio.toFixed(1)}x`);
  return { content: applyColor("compactor", content, ctx.theme, ctx.colors), visible: true };
}

function renderIndexedDocsSegment(_ctx: FooterSegmentContext): RenderedSegment {
  // No reliable data source for indexed docs count
  return hidden();
}

function renderSandboxRunsSegment(_ctx: FooterSegmentContext): RenderedSegment {
  // No reliable data source for sandbox run count
  return hidden();
}

function renderSearchQueriesSegment(_ctx: FooterSegmentContext): RenderedSegment {
  // No reliable data source for search query count
  return hidden();
}

export const COMPACTOR_SEGMENTS: FooterSegment[] = [
  { id: "session_events", label: "Session Events", shortLabel: "evt", description: "Number of session events", zone: "center", icon: "", render: renderSessionEventsSegment, defaultShow: true },
  { id: "compactions", label: "Compactions", shortLabel: "cmp", description: "Number of context compactions", zone: "center", icon: "", render: renderCompactionsSegment, defaultShow: true },
  { id: "tokens_saved", label: "Tokens Saved", shortLabel: "svd", description: "Tokens saved by compaction", zone: "center", icon: "", render: renderTokensSavedSegment, defaultShow: true },
  { id: "compression_ratio", label: "Compression Ratio", shortLabel: "rat", description: "Last compaction compression ratio", zone: "center", icon: "", render: renderCompressionRatioSegment, defaultShow: false },
  { id: "indexed_docs", label: "Indexed Docs", shortLabel: "idx", description: "Number of indexed documents", zone: "center", icon: "", render: renderIndexedDocsSegment, defaultShow: false },
  { id: "sandbox_runs", label: "Sandbox Runs", shortLabel: "sbx", description: "Number of sandbox code runs", zone: "center", icon: "", render: renderSandboxRunsSegment, defaultShow: false },
  { id: "search_queries", label: "Search Queries", shortLabel: "qry", description: "Number of search queries", zone: "center", icon: "", render: renderSearchQueriesSegment, defaultShow: false },
];
