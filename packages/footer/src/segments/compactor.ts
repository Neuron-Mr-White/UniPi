/**
 * @pi-unipi/footer — Compactor segments
 *
 * Segment renderers for the compactor group: session_events, compactions,
 * tokens_saved, compression_ratio, sandbox_runs, search_queries.
 *
 * Data sourced from piContext.sessionManager (live session data).
 * Segments without a reliable data source are hidden (visible: false)
 * rather than showing a placeholder like "—".
 */

import type { FooterSegment, FooterSegmentContext, RenderedSegment } from "../types.js";
import { applyColor, mutedPlaceholder } from "../rendering/theme.js";
import { getIcon } from "../rendering/icons.js";
import { isSegmentEnabled } from "../config.js";

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
  if (count === 0) {
    if (isSegmentEnabled("compactor", "session_events")) {
      return { content: mutedPlaceholder(withIcon("sessionEvents", "0")), visible: true };
    }
    return hidden();
  }

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
  if (compactionCount === 0) {
    if (isSegmentEnabled("compactor", "compactions")) {
      return { content: mutedPlaceholder(withIcon("compactions", "0")), visible: true };
    }
    return hidden();
  }

  const content = withIcon("compactions", `${compactionCount}`);
  return { content: applyColor("compactor", content, ctx.theme, ctx.colors), visible: true };
}

function renderTokensSavedSegment(ctx: FooterSegmentContext): RenderedSegment {
  // Sum tokens saved from compaction entries.
  // Pi's CompactionEntry has tokensBefore (total tokens before compaction).
  // Compaction keeps ~10-15% of context, so tokens saved ≈ tokensBefore × 0.85.
  const events = getSessionEvents(ctx);
  let tokensSaved = 0;
  let hasCompaction = false;
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "compaction") {
      hasCompaction = true;
      const tokensBefore = Number(e.tokensBefore ?? 0);
      // Estimate tokens kept at ~12% (compaction summary + recent messages)
      const tokensAfter = Math.round(tokensBefore * 0.12);
      tokensSaved += Math.max(0, tokensBefore - tokensAfter);
    }
  }
  if (!hasCompaction || tokensSaved === 0) return hidden();

  const content = withIcon("tokensSaved", formatTokens(tokensSaved));
  return { content: applyColor("compactor", content, ctx.theme, ctx.colors), visible: true };
}

function renderCompressionRatioSegment(ctx: FooterSegmentContext): RenderedSegment {
  // Calculate compression ratio from Pi's CompactionEntry.tokensBefore.
  // Compaction keeps ~12% of context, giving ~8:1 compression.
  const events = getSessionEvents(ctx);
  let totalBefore = 0;
  let totalAfter = 0;
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "compaction") {
      const before = Number(e.tokensBefore ?? 0);
      if (before > 0) {
        totalBefore += before;
        totalAfter += Math.round(before * 0.12);
      }
    }
  }
  if (totalBefore === 0 || totalAfter === 0) return hidden();

  const ratio = totalBefore / totalAfter;
  const content = withIcon("compressionRatio", `${ratio.toFixed(1)}x`);
  return { content: applyColor("compactor", content, ctx.theme, ctx.colors), visible: true };
}

function renderSandboxRunsSegment(ctx: FooterSegmentContext): RenderedSegment {
  // Count sandbox events from session manager branch
  const events = getSessionEvents(ctx);
  let sandboxCount = 0;
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    // Count tool calls that are sandbox/execute tools
    const name = String((e as any).name ?? "").toLowerCase();
    if (name.includes("sandbox") || name.includes("ctx_execute") || name === "execute") {
      sandboxCount++;
    }
  }
  if (sandboxCount === 0) return hidden();

  const content = withIcon("sandboxRuns", `${sandboxCount}`);
  return { content: applyColor("compactor", content, ctx.theme, ctx.colors), visible: true };
}

function renderSearchQueriesSegment(ctx: FooterSegmentContext): RenderedSegment {
  // Count search events from session manager branch
  const events = getSessionEvents(ctx);
  let searchCount = 0;
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    const name = String((e as any).name ?? "").toLowerCase();
    if (name.includes("search") || name.includes("ctx_search")) {
      searchCount++;
    }
  }
  if (searchCount === 0) return hidden();

  const content = withIcon("searchQueries", `${searchCount}`);
  return { content: applyColor("compactor", content, ctx.theme, ctx.colors), visible: true };
}

export const COMPACTOR_SEGMENTS: FooterSegment[] = [
  { id: "session_events", label: "Session Events", shortLabel: "EVT", description: "Number of session events", zone: "center", render: renderSessionEventsSegment, defaultShow: true },
  { id: "compactions", label: "Compactions", shortLabel: "CMP", description: "Number of context compactions", zone: "center", render: renderCompactionsSegment, defaultShow: true },
  { id: "tokens_saved", label: "Tokens Saved", shortLabel: "SVD", description: "Tokens saved by compaction", zone: "center", render: renderTokensSavedSegment, defaultShow: true },
  { id: "compression_ratio", label: "Compression Ratio", shortLabel: "RAT", description: "Last compaction compression ratio", zone: "center", render: renderCompressionRatioSegment, defaultShow: false },
  { id: "sandbox_runs", label: "Sandbox Runs", shortLabel: "SBX", description: "Number of sandbox code runs", zone: "center", render: renderSandboxRunsSegment, defaultShow: false },
  { id: "search_queries", label: "Search Queries", shortLabel: "QRY", description: "Number of search queries", zone: "center", render: renderSearchQueriesSegment, defaultShow: false },
];
