/**
 * @pi-unipi/footer — Glance session stats strip
 *
 * The centered stats line below the input box:
 *
 *   ↑12.3k in · ↓4.1k out | $1.23 | 350ms avg ttft · 84.0 tok/s |
 *   3 turn · 12 steps | 00:12 · tool 00:04 | 73% cache hit |
 *   2 compactions · 39k→13k · 3m ago
 *
 * Parts carry a priority; when the line does not fit `width - 1` the
 * lowest-priority parts are dropped whole (never truncated mid-part — issue
 * #31's one-column margin applies). Reads the cached session snapshot
 * (session-scan.ts) and the TPS tracker — never the branch per paint.
 *
 * Height rule: on terminals shorter than MIN_STRIP_ROWS the strip is hidden
 * (the frame stays) so the input keeps the rows it needs.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { tpsTracker } from "./tps-tracker.js";
import type { FooterSettings, StripToggles } from "./types.js";
import type { SessionSnapshot } from "./session-scan.js";
import { getResolvedIconStyle } from "./rendering/icons.js";

/** Below this many terminal rows the strip and process line hide. */
export const MIN_STRIP_ROWS = 20;

/** Never write the last column (issue #31 wrap desync). */
const WIDTH_MARGIN = 1;

/** Pure height gate: rows unknown → shown. */
export function stripVisibleAtRows(rows: number | undefined | null): boolean {
  if (typeof rows !== "number" || !Number.isFinite(rows)) return true;
  return rows >= MIN_STRIP_ROWS;
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

/** Format ms as stopwatch duration: 00:12 / 1:00:14 (h:mm:ss past 1h). */
function fmtWall(ms: number): string {
	if (ms < 1000) return "00:00";
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	const mm = String(m).padStart(2, "0");
	const ss = String(s).padStart(2, "0");
	return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmtTokensShort(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

function agoShort(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

/** Cache hit % from the snapshot's usage sums; null when no data. */
export function cacheHitPct(snapshot: SessionSnapshot): number | null {
  const denom = snapshot.input + snapshot.cacheRead + snapshot.cacheWrite;
  if (denom <= 0) return null;
  return Math.round((snapshot.cacheRead / denom) * 100);
}

/** Basic truecolor accents for strip numbers. */
const STRIP_COLOR = {
	count: "\x1b[96m", // cyan — turns/steps
	time: "\x1b[93m", // amber — wall · tool
	ttft: "\x1b[95m", // magenta — avg ttft
	tokens: "\x1b[94m", // blue — in/out tokens
	cost: "\x1b[92m", // green — cost
	psGood: "\x1b[92m", // green — ≥ 30 tok/s
	psSlow: "\x1b[91m", // red — < 10 tok/s
	psMid: "\x1b[97m", // white — in between
	cacheHit: "\x1b[92m", // green — high hit
	cacheWarn: "\x1b[93m", // amber — lowish hit
	compact: "\x1b[94m", // blue — compactions
	reset: "\x1b[39m",
} as const;

const c = (code: string, text: string) => `${code}${text}${STRIP_COLOR.reset}`;

// ─── Strip parts ────────────────────────────────────────────────────────────

export type StripPartId =
  | "tokens" | "cost" | "speed" | "turns" | "time" | "cache" | "compactions";

/** Drop priority when the strip is too wide — higher survives longer. */
export const STRIP_PRIORITIES: Record<StripPartId, number> = {
  tokens: 7,
  cost: 6,
  speed: 5,
  turns: 4,
  time: 3,
  cache: 2,
  compactions: 1,
};

export interface StripPart {
  id: StripPartId;
  priority: number;
  text: string;
}

/**
 * Drop lowest-priority parts (ties: the later one) until the joined line fits
 * `width - 1`. A single over-wide part is returned as-is — the caller's final
 * truncate is the safety net.
 */
export function fitStripParts(parts: StripPart[], width: number): StripPart[] {
  const cap = Math.max(1, width - WIDTH_MARGIN);
  const widthOf = (ps: StripPart[]) => visibleWidth(ps.map(p => p.text).join(" | "));
  const kept = [...parts];
  while (kept.length > 1 && widthOf(kept) > cap) {
    let dropIdx = 0;
    for (let i = 1; i < kept.length; i++) {
      if (kept[i].priority <= kept[dropIdx].priority) dropIdx = i;
    }
    kept.splice(dropIdx, 1);
  }
  return kept;
}

/** True when the model is billed via OAuth/subscription (shows `sub`). */
function isUsingSubscription(piContext: unknown): boolean {
  const ctx = piContext as { model?: unknown; modelRegistry?: { isUsingOAuth?: (m: unknown) => boolean } } | undefined;
  try {
    return ctx?.model ? (ctx.modelRegistry?.isUsingOAuth?.(ctx.model) ?? false) : false;
  } catch {
    return false;
  }
}

/**
 * Build the visible strip parts from the cached snapshot + tracker state,
 * honoring the strip.* toggles. Order in the line: tokens, cost, speed,
 * turns, time, cache, compactions.
 */
export function buildStripParts(
  settings: StripToggles,
  snapshot: SessionSnapshot,
  piContext: unknown,
  now = Date.now(),
): StripPart[] {
  const parts: StripPart[] = [];
  const push = (id: StripPartId, enabled: boolean, text: string | null): void => {
    if (enabled && text) parts.push({ id, priority: STRIP_PRIORITIES[id], text });
  };

  // Tokens: in/out as pi reports them (cache rides the cache-hit part).
  const inOut = snapshot.input + snapshot.output;
  if (inOut > 0) {
    const textIcon = getResolvedIconStyle() === "text";
    const inLabel = `${fmtTokensShort(snapshot.input)} in`;
    const outLabel = `${fmtTokensShort(snapshot.output)} out`;
    push("tokens", settings.tokens, `${c(STRIP_COLOR.tokens, textIcon ? inLabel : `↑${inLabel}`)} \u00b7 ${c(STRIP_COLOR.tokens, textIcon ? outLabel : `↓${outLabel}`)}`);
  }

  // Cost: `$1.23`, or `sub` when the model runs on a subscription.
  const subscription = isUsingSubscription(piContext);
  if (snapshot.cost > 0 || subscription) {
    push("cost", settings.cost, c(STRIP_COLOR.cost, subscription ? "sub" : `$${snapshot.cost.toFixed(2)}`));
  }

  // Speed: avg TTFT + tok/s.
  const ttft = tpsTracker.getAvgTtftMs();
  const steps = tpsTracker.getStepCount();
  if (settings.speed && (ttft !== null || steps > 0)) {
    const avgTps = tpsTracker.getSessionAvgTps();
    const tpsColor = avgTps >= 30 ? STRIP_COLOR.psGood : avgTps < 10 ? STRIP_COLOR.psSlow : STRIP_COLOR.psMid;
    const avgTpsLabel = avgTps >= 100 ? String(Math.round(avgTps)) : avgTps > 0 ? avgTps.toFixed(1) : "0";
    const seg = [
      ttft !== null ? c(STRIP_COLOR.ttft, ttft >= 10000 ? `${Math.round(ttft / 1000)}s` : `${ttft}ms`) + " avg ttft" : null,
      steps > 0 ? c(tpsColor, `${avgTpsLabel} tok/s`) : null,
    ].filter(Boolean).join(" \u00b7 ");
    push("speed", true, seg || null);
  }

  // Turns/steps.
  const turns = tpsTracker.getTurnCount();
  if (turns > 0 || steps > 0) {
    push("turns", settings.turns, `${c(STRIP_COLOR.count, String(turns))} turn \u00b7 ${c(STRIP_COLOR.count, String(steps))} step${steps === 1 ? "" : "s"}`);
  }

  // Wall + tool time (rendered together once anything is known).
  if (turns > 0 || steps > 0) {
    push("time", settings.time, `${c(STRIP_COLOR.time, fmtWall(tpsTracker.getSessionLlmMs()))} \u00b7 tool ${c(STRIP_COLOR.time, fmtWall(tpsTracker.getToolMs()))}`);
  }

  // Cache hit %.
  const hit = cacheHitPct(snapshot);
  if (hit !== null) {
    const hitColor = hit >= 70 ? STRIP_COLOR.cacheHit : STRIP_COLOR.cacheWarn;
    push("cache", settings.cache, c(hitColor, `${hit}% cache hit`));
  }

  // Compactions: hidden until the first one; age computed at paint time.
  if (snapshot.compactionCount > 0) {
    const sizes = snapshot.compactionBefore > 0
      ? ` \u00b7 ${c(STRIP_COLOR.compact, `${fmtTokensShort(snapshot.compactionBefore)}\u2192${fmtTokensShort(snapshot.compactionAfter)}`)}`
      : "";
    const age = snapshot.compactionLastAt != null ? ` \u00b7 ${agoShort(now - snapshot.compactionLastAt)}` : "";
    push("compactions", settings.compactions, `${c(STRIP_COLOR.compact, String(snapshot.compactionCount))} compaction${snapshot.compactionCount === 1 ? "" : "s"}${sizes}${age}`);
  }

  return parts;
}

/**
 * Render the strip lines for a terminal width: build parts, fit, center.
 * Returns [] when nothing is displayable.
 */
export function renderSessionStrip(
  settings: FooterSettings,
  snapshot: SessionSnapshot,
  piContext: unknown,
  width: number,
): string[] {
  if (width <= 1) return [];
  const parts = fitStripParts(buildStripParts(settings.strip, snapshot, piContext), width);
  if (parts.length === 0) return [];

  // Centered under the input box, one column short of the terminal (issue #31).
  const strip = parts.map(p => p.text).join(" | ");
  const cap = Math.max(1, width - WIDTH_MARGIN);
  const w = visibleWidth(strip);
  const line = w > cap ? truncateToWidth(strip, cap) : strip;
  const leftPad = Math.floor((width - visibleWidth(line)) / 2);
  return [leftPad > 0 ? " ".repeat(leftPad) + line : line];
}
