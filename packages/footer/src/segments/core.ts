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
import { tpsTracker } from "../tps-tracker.js";

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
  const content = "WEB";
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

  const isDirty = footerData?.getGitDirty?.() ?? false;
  const semanticColor: SemanticColor = isDirty ? "gitDirty" : "gitClean";
  const content = withIcon("git", branch);
  return { content: color(ctx, semanticColor, content), visible: true };
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
  return { content: color(ctx, "session", content), visible: true };
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

// ─── TPS tier color function ────────────────────────────────────────────────

function getTpsSemanticColor(tps: number): SemanticColor {
  if (tps > 200) return "tpsBlazing";
  if (tps > 100) return "tpsFast";
  if (tps > 50) return "tpsGood";
  if (tps > 30) return "tpsModerate";
  return "tpsSlow";
}

function renderTpsSegment(ctx: FooterSegmentContext): RenderedSegment {
  const generating = tpsTracker.isGenerating();
  const liveTps = tpsTracker.getLiveTps();
  const avgTps = tpsTracker.getSessionAvgTps();

  // No data yet — hide
  if (!tpsTracker.getTotalOutput()) return { content: "", visible: false };

  const icon = getIcon("tps");

  if (generating && liveTps > 0) {
    // Active generation: show live rate + avg
    const liveDisplay = Math.round(liveTps);
    const avgDisplay = Math.round(avgTps);
    const liveText = `\u2191 ${liveDisplay} t/s`;
    const avgText = `avg ${avgDisplay}`;
    const liveColored = applyColor(getTpsSemanticColor(liveTps), liveText, ctx.theme, ctx.colors);
    const avgColored = applyColor("tpsIdle", avgText, ctx.theme, ctx.colors);
    const content = icon ? `${icon} ${liveColored} \u00b7 ${avgColored}` : `${liveColored} \u00b7 ${avgColored}`;
    return { content, visible: true };
  }

  // Idle: show session average
  const avgDisplay = Math.round(avgTps);
  const avgText = `avg ${avgDisplay} t/s`;
  const avgColored = applyColor("tpsIdle", avgText, ctx.theme, ctx.colors);
  const content = icon ? `${icon} ${avgColored}` : avgColored;
  return { content: avgColored, visible: true };
}

function renderClockSegment(ctx: FooterSegmentContext): RenderedSegment {
  const now = new Date();
  const h = now.getHours().toString().padStart(2, "0");
  const m = now.getMinutes().toString().padStart(2, "0");
  const s = now.getSeconds().toString().padStart(2, "0");
  const timeStr = `${h}:${m}:${s}`;
  const content = withIcon("clock", timeStr);
  return { content: color(ctx, "clock", content), visible: true };
}

function renderDurationSegment(ctx: FooterSegmentContext): RenderedSegment {
  // Derive session duration from sessionManager
  const piCtx = ctx.piContext as Record<string, unknown> | undefined;
  const sessionStart = (piCtx?.sessionManager as any)?.getSessionStartTime?.();
  if (!sessionStart) {
    // Fallback: show current time segment style
    return { content: "", visible: false };
  }

  const elapsedMs = Date.now() - sessionStart;
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  let display: string;
  if (hours > 0) {
    display = `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  } else {
    display = `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }

  const content = withIcon("duration", display);
  return { content: color(ctx, "duration", content), visible: true };
}

// ─── Thinking level ──────────────────────────────────────────────────────────

/** Map thinking level to semantic color */
function getThinkingSemanticColor(level: string | undefined): SemanticColor {
  switch (level) {
    case "minimal": return "thinkingMinimal";
    case "low": return "thinkingLow";
    case "medium": return "thinkingMedium";
    case "high": return "thinkingHigh";
    case "xhigh": return "thinkingXhigh";
    default: return "thinking";
  }
}

function renderThinkingLevelSegment(ctx: FooterSegmentContext): RenderedSegment {
  const piCtx = ctx.piContext as Record<string, unknown> | undefined;
  const model = piCtx?.model as Record<string, unknown> | undefined;
  const thinkingLevel = model?.thinkingLevel as string | undefined;

  if (!thinkingLevel || thinkingLevel === "off") return { content: "", visible: false };

  const semanticColor = getThinkingSemanticColor(thinkingLevel);
  const content = withIcon("thinkingLevel", thinkingLevel);
  return { content: color(ctx, semanticColor, content), visible: true };
}

// ─── Core segments array ────────────────────────────────────────────────────

export const CORE_SEGMENTS: FooterSegment[] = [
  { id: "model", label: "Model", shortLabel: "mdl", description: "Current model name", zone: "left", icon: "", render: renderModelSegment, defaultShow: true },
  { id: "api_state", label: "API", shortLabel: "api", description: "API connection state", zone: "left", icon: "", render: renderApiStateSegment, defaultShow: true },
  { id: "tool_count", label: "Tool Count", shortLabel: "tls", description: "Number of tools available", zone: "left", icon: "", render: renderToolCountSegment, defaultShow: true },
  { id: "git", label: "Git", shortLabel: "git", description: "Current git branch + dirty/clean status", zone: "left", icon: "", render: renderGitSegment, defaultShow: true },
  { id: "tps", label: "TPS", shortLabel: "tps", description: "Tokens per second \u2014 live during generation", zone: "center", icon: "", render: renderTpsSegment, defaultShow: true },
  { id: "context_pct", label: "Context %", shortLabel: "ctx", description: "Context window usage percentage", zone: "center", icon: "", render: renderContextPctSegment, defaultShow: true },
  { id: "cost", label: "Cost", shortLabel: "cst", description: "Session cost in USD", zone: "center", icon: "", render: renderCostSegment, defaultShow: true },
  { id: "tokens_total", label: "Tokens Total", shortLabel: "tok", description: "Total tokens used this session", zone: "center", icon: "", render: renderTokensSegment("total"), defaultShow: false },
  { id: "tokens_in", label: "Tokens In", shortLabel: "tin", description: "Input tokens consumed", zone: "center", icon: "", render: renderTokensSegment("in"), defaultShow: false },
  { id: "tokens_out", label: "Tokens Out", shortLabel: "tout", description: "Output tokens generated", zone: "center", icon: "", render: renderTokensSegment("out"), defaultShow: false },
  { id: "session", label: "Session", shortLabel: "ses", description: "Session identifier", zone: "left", icon: "", render: renderSessionSegment, defaultShow: false },
  { id: "hostname", label: "Hostname", shortLabel: "hst", description: "Machine hostname", zone: "left", icon: "", render: renderHostnameSegment, defaultShow: false },
  { id: "clock", label: "Clock", shortLabel: "clk", description: "Current wall time (HH:MM:SS)", zone: "right", icon: "", render: renderClockSegment, defaultShow: true },
  { id: "duration", label: "Duration", shortLabel: "dur", description: "Session duration", zone: "right", icon: "", render: renderDurationSegment, defaultShow: true },
  { id: "thinking_level", label: "Thinking", shortLabel: "thk", description: "Current model thinking level", zone: "center", icon: "", render: renderThinkingLevelSegment, defaultShow: false },
];
