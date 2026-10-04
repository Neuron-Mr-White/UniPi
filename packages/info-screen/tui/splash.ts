/**
 * @pi-unipi/info-screen — the Unicrab startup splash.
 *
 *   ╭──────────────────────────────────────────────────────────────────────╮
 *   │  <Unicrab 22×10>   ╻ ╻┏┓╻╻┏━┓╻   ▐α24▌                              │
 *   │                    ┃ ┃┃┗┫┃┣━┛┃   v3.0.0-alpha.24 · pi 0.87.1        │
 *   │                    ┗━┛╹ ╹╹╹  ╹                                      │
 *   │                    Good evening — I'm Unicrab.                       │
 *   │                    ● ready in 412ms · 21 modules · 64 tools          │
 *   │                    ● today $107 across 12 sessions                    │
 *   │                    ● resumed · 98 replies · 12.5M tokens              │
 *   │                    /unipi:info dashboard   alt+s shortcuts            │
 *   │  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │  ← drains
 *   ╰──────────────────────────────────────────────────────────────────────╯
 *
 * The mascot is the existing Unicrab half-block art (core/src/hints). The
 * wordmark shimmers (a ramp offset by time); the bottom bar drains while the
 * auto-close timer runs. Every row is exactly `width` cells.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import {
  CRAB,
  CRAB_14_LINES_256,
  CRAB_14_LINES_TRUECOLOR,
  CRAB_22_LINES_256,
  CRAB_22_LINES_TRUECOLOR,
  Paint,
  fitTo,
  ramp,
  type RGB,
  type VizThemeLike,
} from "@pi-unipi/core";
import { PANEL_BG } from "../palette.js";

/** 3-row block letters (half-block bottom row = 2.5 cells tall). */
const WORD: Record<string, [string, string, string]> = {
  U: ["█  █", "█  █", "▀▀▀▀"],
  N: ["██▄█", "█ ▀█", "▀  ▀"],
  I: ["█", "█", "▀"],
  P: ["█▀▀█", "█▀▀▀", "▀   "],
};

export function wordmarkRows(text = "UNIPI"): [string, string, string] {
  const rows: [string, string, string] = ["", "", ""];
  Array.from(text).forEach((ch, i) => {
    const g = WORD[ch] ?? [" ", " ", " "];
    const sep = i > 0 ? " " : "";
    rows[0] += sep + g[0];
    rows[1] += sep + g[1];
    rows[2] += sep + g[2];
  });
  return rows;
}

const SHIMMER: RGB[] = [CRAB.gold, CRAB.orange, CRAB.red, CRAB.orange, CRAB.gold, CRAB.cream];

/** Wordmark with a moving highlight (phase in [0,1)). */
function shimmerRows(p: Paint, phase: number): string[] {
  const rows = wordmarkRows();
  const w = Math.max(...rows.map((r) => Array.from(r).length));
  return rows.map((r) =>
    p.bold(
      Array.from(r)
        .map((ch, i) => (ch === " " ? " " : p.rgb(ramp(SHIMMER, ((i / Math.max(1, w - 1)) * 0.6 + phase) % 1), ch)))
        .join(""),
    ),
  );
}

export interface SplashFacts {
  modules?: number;
  tools?: number;
  todayCost?: number;
  todaySessions?: number;
  /** Resumed-session summary (absent for a fresh session). */
  resumed?: { replies: number; tokens: string; cost: string } | null;
  cwd?: string;
  branch?: string | null;
  update?: string | null;
}

export interface SplashOptions {
  width: number;
  theme?: VizThemeLike;
  trueColor?: boolean;
  unipiVersion: string;
  piVersion: string;
  readyMs?: number;
  facts?: SplashFacts;
  /** Animation clock (ms). */
  now?: number;
  /** Remaining fraction of the auto-close timer (1 → 0), or null for none. */
  remaining?: number | null;
  /** Whether keys do anything (interactive "on" mode). */
  interactive?: boolean;
}

function greeting(now: Date): string {
  const h = now.getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function shortVersion(v: string): string {
  const m = /alpha\.(\d+)/.exec(v) ?? /beta\.(\d+)/.exec(v);
  if (m) return `${v.includes("beta") ? "β" : "α"}${m[1]}`;
  return v.split(".").slice(0, 2).join(".");
}

const money = (n: number): string => (n >= 100 ? `$${Math.round(n)}` : n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(3)}` : "$0");

/** The splash as exact-width lines (empty below 44 columns). */
export function renderSplash(o: SplashOptions): string[] {
  const W = Math.floor(o.width);
  if (W < 44) return [];
  const p = new Paint(o.theme, o.trueColor);
  const trueColor = p.trueColor;
  const big = W >= 76;
  const crab = big ? (trueColor ? CRAB_22_LINES_TRUECOLOR : CRAB_22_LINES_256) : trueColor ? CRAB_14_LINES_TRUECOLOR : CRAB_14_LINES_256;
  const crabW = big ? 22 : 14;
  const inner = W - 2;
  const pad = big ? 2 : 1;
  const gap = big ? 4 : 2;
  const rightW = Math.max(10, inner - pad * 2 - crabW - gap);
  const now = o.now ?? Date.now();
  const phase = (now % 2400) / 2400;
  const dim = (s: string): string => p.fg("dim", s);
  const muted = (s: string): string => p.fg("muted", s);
  const facts = o.facts ?? {};

  // ── right column ──
  const right: string[] = [];
  const word = shimmerRows(p, phase);
  const ver = shortVersion(o.unipiVersion);
  const chip = `${p.rgb(CRAB.orange, "▐")}${p.on([20, 14, 10], CRAB.orange, p.bold(ver))}${p.rgb(CRAB.orange, "▌")}`;
  right.push(`${word[0]}   ${chip}`);
  right.push(`${word[1]}   ${dim(`v${o.unipiVersion}`)}`);
  right.push(`${word[2]}   ${dim(`pi ${o.piVersion}`)}`);
  if (big) right.push("");
  right.push(`${p.bold(greeting(new Date(now)))}${muted(" — I'm ")}${p.bold(p.rgb(CRAB.orange, "Unicrab"))}${muted(".")}`);

  const bullet = (c: RGB): string => p.rgb(c, "●");
  const ready: string[] = [];
  if (o.readyMs && o.readyMs > 0) ready.push(`ready in ${p.bold(o.readyMs >= 1000 ? `${(o.readyMs / 1000).toFixed(1)}s` : `${o.readyMs}ms`)}`);
  if (facts.modules) ready.push(`${p.bold(String(facts.modules))} modules`);
  if (facts.tools) ready.push(`${p.bold(String(facts.tools))} tools`);
  if (ready.length) right.push(`${bullet([120, 200, 120])} ${muted(ready.join(dim(" · ")))}`);
  if (facts.resumed) {
    right.push(`${bullet([0, 200, 240])} ${muted(`resumed · ${p.bold(String(facts.resumed.replies))} replies · ${facts.resumed.tokens} tokens · ${facts.resumed.cost}`)}`);
  } else if (facts.cwd) {
    right.push(`${bullet([0, 200, 240])} ${muted(`new session in ${p.bold(facts.cwd)}${facts.branch ? dim(` on ${facts.branch}`) : ""}`)}`);
  }
  if (facts.todayCost !== undefined && facts.todayCost > 0) {
    right.push(`${bullet(CRAB.gold)} ${muted(`today ${p.bold(p.rgb(CRAB.gold, money(facts.todayCost)))}${facts.todaySessions ? ` across ${facts.todaySessions} session${facts.todaySessions === 1 ? "" : "s"}` : ""}`)}`);
  }
  if (facts.update) {
    right.push(`${p.rgb(CRAB.amber, "▲")} ${p.rgb(CRAB.amber, `update ${p.bold(shortVersion(facts.update))} available`)} ${dim("/unipi:update")}`);
  }
  // Hints row pinned to the bottom of the crab.
  const hint = `${p.rgb(CRAB.orange, "/unipi:info")} ${dim("dashboard")}   ${p.fg("muted", "alt+s")} ${dim("shortcuts")}${o.interactive ? `   ${p.fg("muted", "any key")} ${dim("close")}` : ""}`;

  const bodyH = Math.max(crab.length, right.length + 1);
  while (right.length < bodyH - 1) right.push("");
  right.push(hint);

  // ── frame ──
  const bgOpen = p.bgOpen(PANEL_BG);
  const opaque = (s: string): string => bgOpen + s.replace(/\x1b\[(?:0|49)m/g, (m) => m + bgOpen) + "\x1b[49m";
  const borderRamp: RGB[] = [CRAB.gold, CRAB.orange, CRAB.red, CRAB.orange, CRAB.gold];
  const edge = (s: string, from: number, total: number): string =>
    Array.from(s)
      .map((ch, i) => p.rgb(ramp(borderRamp, (((from + i) / Math.max(1, total - 1)) * 0.5 + phase) % 1), ch))
      .join("");
  const side = (left: boolean): string => p.rgb(left ? CRAB.gold : CRAB.gold, "│");

  const lines: string[] = [];
  lines.push(opaque(edge(`╭${"─".repeat(inner)}╮`, 0, W)));
  const crabTop = Math.floor((bodyH - crab.length) / 2);
  for (let i = 0; i < bodyH; i++) {
    const c = crab[i - crabTop] ?? " ".repeat(crabW);
    const r = fitTo(right[i] ?? "", rightW);
    lines.push(opaque(`${side(true)}${" ".repeat(pad)}${fitTo(c, crabW)}${" ".repeat(gap)}${r}${" ".repeat(pad)}${side(false)}`));
  }
  // Countdown bar (drains right → left) or a quiet rule.
  const barW = inner - pad * 2;
  let bar: string;
  if (o.remaining !== null && o.remaining !== undefined) {
    const units = Math.round(Math.max(0, Math.min(1, o.remaining)) * barW * 8);
    const full = Math.floor(units / 8);
    const part = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"][units % 8]!;
    let s = "";
    for (let i = 0; i < full; i++) s += p.rgb(ramp([CRAB.red, CRAB.orange, CRAB.gold], i / Math.max(1, barW - 1)), "▔");
    if (part) s += p.rgb(CRAB.gold, "▔");
    bar = s + " ".repeat(Math.max(0, barW - visibleWidth(s)));
  } else {
    bar = p.fg("borderMuted", "┄".repeat(barW));
  }
  lines.push(opaque(`${side(true)}${" ".repeat(pad)}${fitTo(bar, barW)}${" ".repeat(pad)}${side(false)}`));
  lines.push(opaque(edge(`╰${"─".repeat(inner)}╯`, 0, W)));
  return lines;
}
