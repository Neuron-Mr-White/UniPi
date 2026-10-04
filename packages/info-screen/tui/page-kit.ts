/**
 * @pi-unipi/info-screen — page building blocks on top of the core viz kit.
 *
 * Pages are plain functions `(PageContext) → string[]`; these helpers give
 * them one visual language: spaced small-caps section rules, big-number
 * tiles, labelled meters, ranked bars, legends and key/value leaders.
 * Every helper returns lines of EXACTLY `width` cells.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import {
  bigText,
  bigTextWidth,
  fitTo,
  gauge,
  gradientRows,
  gradient,
  ramp,
  rightTo,
  sideBySide,
  splitWidth,
  type Paint,
  type RGB,
} from "@pi-unipi/core";
import type { GroupData, PageContext } from "../types.js";
import { accentRamp, shade, SCOPE_COLOR, SCOPE_WORD, type Scope } from "../palette.js";

/** One-cell scope tag: `s` session (cyan) · `p` project (green) · `g` global (amber). */
export function tag(p: Paint, scope: Scope): string {
  return p.bold(p.rgb(SCOPE_COLOR[scope], scope));
}

/** `s session  p project  g global` — legend for the footer. */
export function scopeLegend(p: Paint, scopes: readonly Scope[] = ["s", "p", "g"]): string {
  return scopes.map((sc) => `${tag(p, sc)} ${p.fg("dim", SCOPE_WORD[sc])}`).join("  ");
}

export const GOOD_BAD: RGB[] = [[120, 200, 120], [240, 200, 60], [230, 90, 80]];

/** `T O O L S` — letter-spaced small caps. */
export function spaced(text: string): string {
  return Array.from(text.toUpperCase()).join(" ");
}

/** `▍ T O K E N S ─────────────── right` */
export function section(pc: PageContext, title: string, right = "", scope?: Scope): string {
  const p = pc.paint;
  const head = `${p.rgb(pc.accent, "▍")}${p.bold(p.rgb(shade(pc.accent, 0.35), spaced(title)))} ${scope ? `${tag(p, scope)} ` : ""}`;
  const tail = right ? ` ${right}` : "";
  const rule = Math.max(0, pc.width - visibleWidth(head) - visibleWidth(tail));
  return fitTo(head + p.fg("borderMuted", "─".repeat(rule)) + tail, pc.width);
}

/** Dim text helper. */
export const dim = (p: Paint, s: string): string => p.fg("dim", s);
export const muted = (p: Paint, s: string): string => p.fg("muted", s);

export interface Tile {
  label: string;
  value: string;
  sub?: string;
  stops?: readonly RGB[];
  /** Scope tag shown before the label. */
  scope?: Scope;
}

const tileLabel = (p: Paint, t: Tile, upper = false): string =>
  `${t.scope ? `${tag(p, t.scope)} ` : ""}${dim(p, upper ? t.label.toUpperCase() : spaced(t.label))}`;

/**
 * Headline tiles: small-caps label, 3-row gradient number, dim sub line.
 * All tiles share one row. When the big numbers don't fit side by side the
 * tiles switch to a compact 2-row form (bold gradient value + sub), so a
 * narrow terminal never stacks four 5-row tiles on top of each other.
 */
export function tiles(pc: PageContext, items: readonly Tile[], gap = 3): string[] {
  const p = pc.paint;
  if (items.length === 0) return [];
  const n = items.length;
  const widths = splitWidth(pc.width, n, gap);
  const colW = widths[n - 1]!;
  const big = colW >= Math.max(...items.map((t) => Math.max(bigTextWidth(t.value), visibleWidth(t.label) * 2 + (t.scope ? 1 : -1))));
  if (big) {
    const blocks = items.map((t, j) => {
      const stops = t.stops ?? accentRamp(pc.accent);
      return {
        lines: [tileLabel(p, t), ...gradientRows(p, bigText(t.value), stops, true), t.sub ? muted(p, t.sub) : ""],
        width: widths[j]!,
      };
    });
    return sideBySide(blocks, gap).map((l) => fitTo(l, pc.width));
  }
  // Compact: `LABEL value` over `sub`, as many per row as fit (min 18 cells).
  let per = n;
  while (per > 1 && splitWidth(pc.width, per, gap)[per - 1]! < 18) per--;
  const out: string[] = [];
  for (let i = 0; i < n; i += per) {
    const row = items.slice(i, i + per);
    const ws = splitWidth(pc.width, per, gap);
    const blocks = row.map((t, j) => {
      const stops = t.stops ?? accentRamp(pc.accent);
      return {
        lines: [`${tileLabel(p, t, true)} ${p.bold(gradient(p, t.value, stops))}`, t.sub ? muted(p, t.sub) : ""],
        width: ws[j]!,
      };
    });
    out.push(...sideBySide(blocks, gap).map((l) => fitTo(l, pc.width)));
  }
  return out;
}

/** `label  ██████▌·········  value` — a labelled meter. */
export function meterRow(pc: PageContext, label: string, ratio: number, value: string, stops: readonly RGB[] = GOOD_BAD, labelW = 10): string {
  const p = pc.paint;
  const vW = Math.max(visibleWidth(value), 6);
  const barW = Math.max(4, pc.width - labelW - vW - 4);
  return fitTo(`${fitTo(muted(p, label), labelW)}  ${gauge(p, ratio, barW, stops)}  ${rightTo(value, vW)}`, pc.width);
}

/** Ranked horizontal bars: `name ········ ████▌ value`. */
export function rankBars(
  pc: PageContext,
  rows: ReadonlyArray<{ name: string; value: number; label: string; color?: RGB }>,
  max: number,
  opts: { nameW?: number; barW?: number } = {},
): string[] {
  const p = pc.paint;
  if (rows.length === 0) return [];
  const top = Math.max(1e-9, ...rows.map((r) => r.value));
  const valW = Math.max(...rows.map((r) => visibleWidth(r.label)));
  const nameW = opts.nameW ?? Math.min(22, Math.max(...rows.map((r) => visibleWidth(r.name))) + 1);
  const barW = opts.barW ?? Math.max(6, pc.width - nameW - valW - 6);
  return rows.slice(0, max).map((r, i) => {
    const c = r.color ?? ramp(accentRamp(pc.accent), 1 - i / Math.max(1, rows.length));
    const rank = dim(p, `${i + 1}`.padStart(2));
    const bar = gauge(p, r.value / top, barW, [shade(c, -0.25), c], " ");
    return fitTo(`${rank} ${fitTo(r.name, nameW)} ${bar} ${rightTo(p.bold(r.label), valW)}`, pc.width);
  });
}

/** `■ input 42%  ■ output 9%  …` legend, wrapped onto as many rows as needed. */
export function legend(pc: PageContext, items: ReadonlyArray<{ label: string; color: RGB }>): string[] {
  const p = pc.paint;
  const rows: string[] = [];
  let cur = "";
  for (const i of items) {
    const piece = `${p.rgb(i.color, "■")} ${muted(p, i.label)}`;
    if (cur && visibleWidth(cur) + 3 + visibleWidth(piece) > pc.width) {
      rows.push(fitTo(cur, pc.width));
      cur = piece;
    } else cur = cur ? `${cur}   ${piece}` : piece;
  }
  if (cur) rows.push(fitTo(cur, pc.width));
  return rows;
}

/** `label ··········· value` leader row. */
export function kv(pc: PageContext, label: string, value: string, labelColor?: RGB): string {
  const p = pc.paint;
  const l = labelColor ? p.rgb(labelColor, label) : muted(p, label);
  const gap = pc.width - visibleWidth(label) - visibleWidth(value) - 2;
  if (gap < 2) return fitTo(`${l}  ${value}`, pc.width);
  return fitTo(`${l} ${p.fg("borderMuted", "·".repeat(gap))} ${value}`, pc.width);
}

/** Two kv columns side by side when wide enough, else stacked. */
export function kvColumns(pc: PageContext, pairs: ReadonlyArray<[string, string]>): string[] {
  if (pc.width < 64) return pairs.map(([l, v]) => kv(pc, l, v));
  const [w1, w2] = splitWidth(pc.width, 2, 4);
  const half = Math.ceil(pairs.length / 2);
  const left = pairs.slice(0, half).map(([l, v]) => kv({ ...pc, width: w1! }, l, v));
  const right = pairs.slice(half).map(([l, v]) => kv({ ...pc, width: w2! }, l, v));
  return sideBySide([{ lines: left, width: w1! }, { lines: right, width: w2! }], 4);
}

/** A status dot + text: green ok, amber warn, red bad, grey off. */
export type Health = "ok" | "warn" | "bad" | "off";
const HEALTH: Record<Health, RGB> = { ok: [120, 200, 120], warn: [240, 200, 60], bad: [230, 90, 80], off: [110, 110, 120] };
export function dot(p: Paint, h: Health, glyph = "●"): string {
  return p.rgb(HEALTH[h], glyph);
}
export const healthColor = (h: Health): RGB => HEALTH[h];

/** Placeholder body while a page has no data yet. */
export function skeleton(pc: PageContext, rows = 5): string[] {
  const p = pc.paint;
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    const w = Math.max(4, Math.round(pc.width * [0.55, 0.8, 0.4, 0.7, 0.3][i % 5]!));
    out.push(fitTo(p.fg("borderMuted", "░".repeat(w)), pc.width));
  }
  return out;
}

/** Message centred in the page (empty states). */
export function empty(pc: PageContext, title: string, hint = ""): string[] {
  const p = pc.paint;
  const c = (s: string): string => {
    const w = visibleWidth(s);
    const left = Math.max(0, Math.floor((pc.width - w) / 2));
    return fitTo(" ".repeat(left) + s, pc.width);
  };
  return ["", c(p.rgb(pc.accent, "◇")), c(p.bold(title)), hint ? c(dim(p, hint)) : ""].map((l) => fitTo(l, pc.width));
}

/** Default page: visible stats as aligned key/value rows with details. */
export function genericPage(pc: PageContext, stats: ReadonlyArray<{ id: string; label: string }>, data: GroupData): string[] {
  const p = pc.paint;
  if (stats.length === 0) return empty(pc, "Nothing to show", "every stat is hidden in settings");
  const out: string[] = [];
  const labelW = Math.min(22, Math.max(...stats.map((s) => visibleWidth(s.label))) + 2);
  for (const s of stats) {
    const d = data[s.id] as unknown;
    const value = typeof d === "string" ? d : ((d as { value?: string } | undefined)?.value ?? "—");
    const det = typeof d === "object" && d ? (d as { detail?: string }).detail : undefined;
    const detail = det ? det.split("\n")[0]! : "";
    const head = `${p.rgb(pc.accent, "▸")} ${fitTo(muted(p, s.label), labelW)}${p.bold(value)}`;
    out.push(fitTo(detail ? `${head}  ${dim(p, detail)}` : head, pc.width));
  }
  return out;
}
