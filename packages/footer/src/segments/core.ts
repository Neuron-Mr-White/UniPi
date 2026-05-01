/**
 * @pi-unipi/footer — Core segments
 *
 * Segment renderers for the core group: model, api_state, tool_count, git,
 * context_pct, cost, tokens_total, tokens_in, tokens_out, session,
 * hostname, time.
 */

import { hostname as osHostname } from "node:os";
import type { FooterSegment, FooterSegmentContext, RenderedSegment, SemanticColor } from "../types.js";
import { applyColor } from "../rendering/theme.js";
import { getIcon } from "../rendering/icons.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function withIcon(segmentId: string, text: string): string {
  const icon = getIcon(segmentId);
  return icon ? `${icon} ${text}` : text;
}

function formatTokens(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
  return `${Math.round(n / 1000000)}M`;
}

function color(ctx: FooterSegmentContext, semantic: SemanticColor, text: string): string {
  return applyColor(semantic, text, ctx.theme, ctx.colors);
}

/** Extract usage stats from piContext */
interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

function getUsageStats(piContext: unknown): UsageStats {
  const ctx = piContext as Record<string, unknown> | undefined;
  if (!ctx) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
  const sessionEvents = (ctx.sessionManager as any)?.getBranch?.() ?? [];
  for (const e of sessionEvents) {
    if (!e || typeof e !== "object") continue;
    if (e.type !== "message") continue;
    const m = e.message;
    if (!m || m.role !== "assistant") continue;
    if (m.stopReason === "error" || m.stopReason === "aborted") continue;
    input += m.usage?.input ?? 0;
    output += m.usage?.output ?? 0;
    cacheRead += m.usage?.cacheRead ?? 0;
    cacheWrite += m.usage?.cacheWrite ?? 0;
    cost += m.usage?.cost?.total ?? 0;
  }
  return { input, output, cacheRead, cacheWrite, cost };
}

// ─── Rainbow helpers (kept for potential future use) ─────────────────────────

/** ANSI 256-color rainbow palette */
const RAINBOW_COLORS = [
  "\x1b[38;5;196m", // red
  "\x1b[38;5;202m", // orange
  "\x1b[38;5;226m", // yellow
  "\x1b[38;5;82m",  // green
  "\x1b[38;5;45m",  // blue
  "\x1b[38;5;129m", // indigo
  "\x1b[38;5;171m", // violet
];

const ANSI_RESET = "\x1b[0m";

/** Apply rainbow coloring to text, cycling through colors per character */
export function rainbowText(text: string): string {
  let result = "";
  let colorIdx = 0;
  for (const char of text) {
    if (char === " ") {
      result += char;
    } else {
      result += `${RAINBOW_COLORS[colorIdx % RAINBOW_COLORS.length]}${char}${ANSI_RESET}`;
      colorIdx++;
    }
  }
  return result;
}

/** Render a rainbow border line of the given width */
export function rainbowBorder(width: number): string {
  let result = "";
  for (let i = 0; i < width; i++) {
    result += `${RAINBOW_COLORS[i % RAINBOW_COLORS.length]}─${ANSI_RESET}`;
  }
  return result;
}

// ─── Segment Renderers ──────────────────────────────────────────────────────

function renderModelSegment(ctx: FooterSegmentContext): RenderedSegment {
  const piCtx = ctx.piContext as Record<string, unknown> | undefined;
  const model = piCtx?.model as Record<string, unknown> | undefined;
  let modelName = (model?.name || model?.id || "no-model") as string;
  if (modelName.startsWith("Claude ")) {
    modelName = modelName.slice(7);
  }
  const content = withIcon("model", modelName);
  return { content: color(ctx, "model", content), visible: true };
}

function renderApiStateSegment(ctx: FooterSegmentContext): RenderedSegment {
  // Show WEB to indicate the web-api package is active.
  const content = withIcon("apiState", "WEB");
  return { content: color(ctx, "model", content), visible: true };
}

function renderToolCountSegment(ctx: FooterSegmentContext): RenderedSegment {
  // Tool count is not directly exposed in piContext yet.
  // TODO: Connect to actual tool count when pi exposes it.
  const content = withIcon("toolCount", "—");
  return { content: color(ctx, "model", content), visible: true };
}

function renderGitSegment(ctx: FooterSegmentContext): RenderedSegment {
  const footerData = ctx.footerData as any;
  const branch = footerData?.getGitBranch?.() ?? null;
  if (!branch) return { content: "", visible: false };

  const content = withIcon("git", branch);
  return { content: color(ctx, "git", content), visible: true };
}

function renderContextPctSegment(ctx: FooterSegmentContext): RenderedSegment {
  const piCtx = ctx.piContext as Record<string, unknown> | undefined;

  // Use pi's built-in getContextUsage() — handles compaction and cache correctly
  const contextUsage = typeof (piCtx as any)?.getContextUsage === "function"
    ? (piCtx as any).getContextUsage()
    : undefined;

  const model = piCtx?.model as Record<string, unknown> | undefined;
  const contextWindow = contextUsage?.contextWindow ?? (model?.contextWindow as number) ?? 0;
  if (!contextWindow) return { content: "", visible: false };

  const pct = contextUsage?.percent;
  const tokens = contextUsage?.tokens;

  // If percent is null (post-compaction, awaiting next response), show ?%
  const pctDisplay = pct !== null && pct !== undefined ? pct.toFixed(1) : "?";
  const text = `${pctDisplay}%/${formatTokens(contextWindow)}`;
  const content = withIcon("context", text);

  let semanticColor: SemanticColor = "context";
  if (pct !== null && pct !== undefined) {
    if (pct > 90) semanticColor = "contextError";
    else if (pct > 70) semanticColor = "contextWarn";
  }

  return { content: color(ctx, semanticColor, content), visible: true };
}

function renderCostSegment(ctx: FooterSegmentContext): RenderedSegment {
  const piCtx = ctx.piContext as Record<string, unknown> | undefined;
  const stats = getUsageStats(piCtx);
  const usingSubscription = piCtx?.model
    ? (piCtx as any).modelRegistry?.isUsingOAuth?.(piCtx.model) ?? false
    : false;

  if (!stats.cost && !usingSubscription) return { content: "", visible: false };

  const costDisplay = usingSubscription ? "(sub)" : `$${stats.cost.toFixed(2)}`;
  return { content: color(ctx, "cost", costDisplay), visible: true };
}

function renderTokensSegment(variant: "total" | "in" | "out"): (ctx: FooterSegmentContext) => RenderedSegment {
  return (ctx: FooterSegmentContext) => {
    const piCtx = ctx.piContext as Record<string, unknown> | undefined;
    const stats = getUsageStats(piCtx);

    let value: number;
    let segmentId: string;
    if (variant === "in") {
      value = stats.input;
      segmentId = "tokensIn";
    } else if (variant === "out") {
      value = stats.output;
      segmentId = "tokensOut";
    } else {
      value = stats.input + stats.output + stats.cacheRead + stats.cacheWrite;
      segmentId = "tokens";
    }

    if (!value) return { content: "", visible: false };

    const content = withIcon(segmentId, formatTokens(value));
    return { content: color(ctx, "tokens", content), visible: true };
  };
}

function renderSessionSegment(ctx: FooterSegmentContext): RenderedSegment {
  const piCtx = ctx.piContext as Record<string, unknown> | undefined;
  const sessionId = (piCtx?.sessionManager as any)?.getSessionId?.();
  const display = sessionId?.slice(0, 8) || "new";
  const content = withIcon("session", display);
  return { content: color(ctx, "model", content), visible: true };
}

function renderHostnameSegment(_ctx: FooterSegmentContext): RenderedSegment {
  const name = osHostname().split(".")[0];
  const content = withIcon("hostname", name);
  return { content, visible: true };
}

function renderTimeSegment(ctx: FooterSegmentContext): RenderedSegment {
  const now = new Date();
  const hours = now.getHours();
  const mins = now.getMinutes().toString().padStart(2, "0");
  const timeStr = `${hours}:${mins}`;
  const content = withIcon("time", timeStr);
  return { content, visible: true };
}

// ─── Core segments array ────────────────────────────────────────────────────

export const CORE_SEGMENTS: FooterSegment[] = [
  { id: "model", label: "Model", icon: "", render: renderModelSegment, defaultShow: true },
  { id: "api_state", label: "WEB", icon: "", render: renderApiStateSegment, defaultShow: true },
  { id: "tool_count", label: "Tool Count", icon: "", render: renderToolCountSegment, defaultShow: true },
  { id: "git", label: "Git", icon: "", render: renderGitSegment, defaultShow: true },
  { id: "context_pct", label: "Context %", icon: "", render: renderContextPctSegment, defaultShow: true },
  { id: "cost", label: "Cost", icon: "", render: renderCostSegment, defaultShow: true },
  { id: "tokens_total", label: "Tokens Total", icon: "", render: renderTokensSegment("total"), defaultShow: false },
  { id: "tokens_in", label: "Tokens In", icon: "", render: renderTokensSegment("in"), defaultShow: false },
  { id: "tokens_out", label: "Tokens Out", icon: "", render: renderTokensSegment("out"), defaultShow: false },
  { id: "session", label: "Session", icon: "", render: renderSessionSegment, defaultShow: false },
  { id: "hostname", label: "Hostname", icon: "", render: renderHostnameSegment, defaultShow: false },
  { id: "time", label: "Time", icon: "", render: renderTimeSegment, defaultShow: false },
];
