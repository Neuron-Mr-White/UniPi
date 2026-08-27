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

// ─── Git metadata (dirty / ahead / behind) ──────────────────────────────
//
// pi's ReadonlyFooterDataProvider only exposes getGitBranch(). For glance-style
// adornments we probe git ourselves: fire-and-forget async refresh, cached,
// at most one probe every GIT_PROBE_MS. Renders read the last known values.

const GIT_PROBE_MS = 2000;

interface GitMeta {
	cwd: string;
	at: number;
	inFlight: boolean;
	dirty: boolean | null;
	ahead: number | null;
	behind: number | null;
}

const gitMetaCache: GitMeta = {
	cwd: "", at: 0, inFlight: false, dirty: null, ahead: null, behind: null,
};

function probeGitMeta(cwd: string): void {
	if (gitMetaCache.inFlight) return;
	gitMetaCache.inFlight = true;
	void import("node:child_process").then(({ execFile }) => {
		execFile(
			"git",
			["--no-optional-locks", "status", "--porcelain=v1", "--branch"],
			{ cwd, timeout: 1500 },
			(err, stdout) => {
				gitMetaCache.inFlight = false;
				gitMetaCache.at = Date.now();
				if (err || !stdout) {
					gitMetaCache.dirty = null;
					return;
				}
				let dirty = false;
				let ahead = 0;
				let behind = 0;
				for (const line of stdout.split("\n")) {
					if (line.startsWith("##")) {
						const ab = line.match(/\[ahead (\d+)(?:,\s*behind (\d+))?\]|\[behind (\d+)\]/);
						if (ab) {
							ahead = Number(ab[1] ?? 0);
							behind = Number(ab[2] ?? ab[3] ?? 0);
						}
					} else if (line.trim()) {
						dirty = true;
					}
				}
				gitMetaCache.dirty = dirty;
				gitMetaCache.ahead = ahead;
				gitMetaCache.behind = behind;
			},
		);
	});
}

function getGitMeta(cwd: string): { dirty: boolean | null; ahead: number | null; behind: number | null } {
	const now = Date.now();
	if (gitMetaCache.cwd !== cwd || now - gitMetaCache.at > GIT_PROBE_MS) {
		gitMetaCache.cwd = cwd;
		probeGitMeta(cwd);
	}
	return { dirty: gitMetaCache.dirty, ahead: gitMetaCache.ahead, behind: gitMetaCache.behind };
}

function renderGitSegment(ctx: FooterSegmentContext): RenderedSegment {
  const footerData = ctx.footerData as any;
  const branch = footerData?.getGitBranch?.() ?? null;
  if (!branch) return { content: "", visible: false };

  const piCtx = ctx.piContext as Record<string, unknown> | undefined;
  const cwd = (piCtx?.sessionManager as any)?.getCwd?.() ?? (piCtx as any)?.cwd ?? process.cwd();
  const meta = getGitMeta(String(cwd));
  const isDirty = meta.dirty === true || (meta.dirty === null && (footerData?.getGitDirty?.() ?? false));
  const semanticColor: SemanticColor = isDirty ? "gitDirty" : "gitClean";

  // Glance-style adornments: * dirty, ↑N ahead, ↓N behind
  let marks = "";
  if (isDirty) marks += "*";
  if ((meta.ahead ?? 0) > 0) marks += `↑${meta.ahead}`;
  if ((meta.behind ?? 0) > 0) marks += `↓${meta.behind}`;

  const content = withIcon("git", `${branch}${marks}`);
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
  const content = withIcon("cost", costDisplay);
  return { content: color(ctx, "cost", content), visible: true };
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

function renderUniBrandSegment(ctx: FooterSegmentContext): RenderedSegment {
  return { content: color(ctx, "brand", "UNI"), visible: true };
}

function renderDirectorySegment(ctx: FooterSegmentContext): RenderedSegment {
  const piCtx = ctx.piContext as Record<string, unknown> | undefined;
  const cwd = (piCtx?.sessionManager as any)?.getCwd?.() ?? (piCtx as any)?.cwd ?? process.cwd();
  const dir = String(cwd).split("/").filter(Boolean).pop() ?? "~";
  const content = withIcon("directory", dir);
  return { content: color(ctx, "directory", content), visible: true };
}

// ─── TPS tier color function ────────────────────────────────────────────────

function getTpsSemanticColor(tps: number): SemanticColor {
  if (tps > 200) return "tpsBlazing";
  if (tps > 100) return "tpsFast";
  if (tps > 50) return "tpsGood";
  if (tps > 30) return "tpsModerate";
  return "tpsSlow";
}

/** Format a TTFT duration for display: "1.2s" or "350ms". */
function formatTtft(ms: number): string {
  if (ms >= 10000) return `${Math.round(ms / 1000)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function renderTpsSegment(ctx: FooterSegmentContext): RenderedSegment {
  const streaming = tpsTracker.isStreaming();
  const liveTps = tpsTracker.getLiveTps();
  const avgTps = tpsTracker.getSessionAvgTps();
  // Harness-style TTFT average; null until a full turn→first-word sample exists.
  const avgTtft = tpsTracker.getAvgTtftMs();

  // No data yet — hide
  if (!tpsTracker.getTotalOutput() && avgTtft === null) return { content: "", visible: false };

  const icon = getIcon("tps");

  const ttftPart = avgTtft !== null ? ` TTFT ${formatTtft(avgTtft)} \u00b7` : "";

  if (streaming && liveTps > 0) {
    // Active generation: show live rate + avg + ttft
    const liveDisplay = Math.round(liveTps);
    const avgDisplay = Math.round(avgTps);
    const liveText = `\u2191 ${liveDisplay} T/S`;
    const avgText = `AVG ${avgDisplay}`;
    const liveColored = applyColor(getTpsSemanticColor(liveTps), liveText, ctx.theme, ctx.colors);
    const avgColored = applyColor("tpsIdle", `${ttftPart} ${avgText}`.trimStart(), ctx.theme, ctx.colors);
    const content = icon ? `${icon} ${liveColored} \u00b7 ${avgColored}` : `${liveColored} \u00b7 ${avgColored}`;
    return { content, visible: true };
  }

  // Idle: show session average (or just TTFT when nothing else yet)
  if (!tpsTracker.getTotalOutput()) {
    const text = `TTFT ${formatTtft(avgTtft ?? 0)}`;
    const colored = applyColor("tpsIdle", text, ctx.theme, ctx.colors);
    return { content: icon ? `${icon} ${colored}` : colored, visible: true };
  }
  const avgDisplay = Math.round(avgTps);
  const avgText = `AVG ${avgDisplay} T/S`;
  const avgColored = applyColor("tpsIdle", `${ttftPart} ${avgText}`.trimStart(), ctx.theme, ctx.colors);
  const content = icon ? `${icon} ${avgColored}` : avgColored;
  return { content, visible: true };
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
  { id: "model", label: "Model", shortLabel: "MDL", description: "Current model name", zone: "left", render: renderModelSegment, defaultShow: true },
  { id: "api_state", label: "API", shortLabel: "API", description: "API connection state", zone: "left", render: renderApiStateSegment, defaultShow: true },
  { id: "tool_count", label: "Tool Count", shortLabel: "TLS", description: "Number of tools available", zone: "left", render: renderToolCountSegment, defaultShow: true },
  { id: "git", label: "Git", shortLabel: "GIT", description: "Current git branch + dirty/clean status", zone: "left", render: renderGitSegment, defaultShow: true },
  { id: "tps", label: "TPS", shortLabel: "TPS", description: "Tokens per second \u2014 live during generation", zone: "center", render: renderTpsSegment, defaultShow: true },
  { id: "context_pct", label: "Context %", shortLabel: "CTX", description: "Context window usage percentage", zone: "center", render: renderContextPctSegment, defaultShow: true },
  { id: "cost", label: "Cost", shortLabel: "CST", description: "Session cost in USD", zone: "center", render: renderCostSegment, defaultShow: true },
  { id: "tokens_total", label: "Tokens Total", shortLabel: "TOK", description: "Total tokens used this session", zone: "center", render: renderTokensSegment("total"), defaultShow: false },
  { id: "tokens_in", label: "Tokens In", shortLabel: "TIN", description: "Input tokens consumed", zone: "center", render: renderTokensSegment("in"), defaultShow: false },
  { id: "tokens_out", label: "Tokens Out", shortLabel: "TOUT", description: "Output tokens generated", zone: "center", render: renderTokensSegment("out"), defaultShow: false },
  { id: "session", label: "Session", shortLabel: "SES", description: "Session identifier", zone: "left", render: renderSessionSegment, defaultShow: false },
  { id: "hostname", label: "Hostname", shortLabel: "HST", description: "Machine hostname", zone: "left", render: renderHostnameSegment, defaultShow: false },
  { id: "uni", label: "Unipi", shortLabel: "UNI", description: "Unipi brand mark", zone: "left", render: renderUniBrandSegment, defaultShow: true },
  { id: "directory", label: "Directory", shortLabel: "DIR", description: "Current directory name", zone: "left", render: renderDirectorySegment, defaultShow: true },
  { id: "clock", label: "Clock", shortLabel: "CLK", description: "Current wall time (HH:MM:SS)", zone: "right", render: renderClockSegment, defaultShow: true },
  { id: "duration", label: "Duration", shortLabel: "DUR", description: "Session duration", zone: "right", render: renderDurationSegment, defaultShow: true },
  { id: "thinking_level", label: "Thinking", shortLabel: "THK", description: "Current model thinking level", zone: "center", render: renderThinkingLevelSegment, defaultShow: false },
];
