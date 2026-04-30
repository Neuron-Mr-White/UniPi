/**
 * @pi-unipi/footer — Core segments
 *
 * Segment renderers for the core group: model, thinking, path, git,
 * context_pct, cost, tokens_total, tokens_in, tokens_out, session,
 * hostname, time.
 */

import { hostname as osHostname } from "node:os";
import { basename } from "node:path";
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

function renderThinkingSegment(ctx: FooterSegmentContext): RenderedSegment {
  const piCtx = ctx.piContext as Record<string, unknown> | undefined;
  const thinkingLevel = typeof piCtx?.getThinkingLevel === "function"
    ? (piCtx as any).getThinkingLevel()
    : "off";

  if (thinkingLevel === "off") return { content: "", visible: false };

  const levelText: Record<string, string> = {
    minimal: "min", low: "low", medium: "med", high: "high", xhigh: "xhigh",
  };
  const label = levelText[thinkingLevel] || thinkingLevel;
  const content = `think:${label}`;

  let semanticColor: SemanticColor = "thinking";
  if (thinkingLevel === "minimal") semanticColor = "thinkingMinimal";
  else if (thinkingLevel === "low") semanticColor = "thinkingLow";
  else if (thinkingLevel === "medium") semanticColor = "thinkingMedium";

  return { content: color(ctx, semanticColor, content), visible: true };
}

function renderPathSegment(ctx: FooterSegmentContext): RenderedSegment {
  const piCtx = ctx.piContext as Record<string, unknown> | undefined;
  const cwd = (piCtx?.cwd as string) || process.cwd();
  const home = process.env.HOME || process.env.USERPROFILE;
  let pwd = cwd;

  if (home && pwd.startsWith(home)) {
    pwd = `~${pwd.slice(home.length)}`;
  }
  // For brevity, show basename by default
  if (pwd.length > 30) {
    pwd = `…${pwd.slice(-29)}`;
  }

  const content = withIcon("path", pwd);
  return { content: color(ctx, "path", content), visible: true };
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
  const model = piCtx?.model as Record<string, unknown> | undefined;
  const contextWindow = (model?.contextWindow as number) || 0;
  if (!contextWindow) return { content: "", visible: false };

  const stats = getUsageStats(piCtx);
  const totalTokens = stats.input + stats.output + stats.cacheRead + stats.cacheWrite;
  const pct = contextWindow > 0 ? (totalTokens / contextWindow) * 100 : 0;

  const text = `${pct.toFixed(1)}%/${formatTokens(contextWindow)}`;
  const content = withIcon("context", text);

  let semanticColor: SemanticColor = "context";
  if (pct > 90) semanticColor = "contextError";
  else if (pct > 70) semanticColor = "contextWarn";

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
  { id: "thinking", label: "Thinking", icon: "", render: renderThinkingSegment, defaultShow: true },
  { id: "path", label: "Path", icon: "", render: renderPathSegment, defaultShow: true },
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
