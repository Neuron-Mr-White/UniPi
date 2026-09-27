/**
 * @pi-unipi/core — shared TUI kit: one visual language for every UniPi surface.
 *
 *   spinner      crafted, multi-cell, colour-animated (pi uses braille ⠋⠙⠹…)
 *   badge        inverse chip `AGENT`, `DONE`, `WAIT` …
 *   leader       left ···· right on one line
 *   rail         `▌ left            right` — memory's framing
 *   progressBar  `████▒▒░░░░` — solid done, shade in progress, light left
 *
 * Everything takes theme tokens (never raw hex) so it follows the Pi theme.
 * Preview every piece with `npm run tui:gallery`.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface KitTheme {
  fg(color: ThemeColor, text: string): string;
  bold(text: string): string;
}

// ── spinners ────────────────────────────────────────────────────────────────

export type SpinnerStyle = "orbit" | "comet" | "scanner" | "helix" | "diamond" | "bars" | "quad";
export const SPINNER_STYLES: readonly SpinnerStyle[] = ["orbit", "comet", "scanner", "helix", "diamond", "bars", "quad"];
/** The UniPi default. Change here to switch every surface at once. */
export const DEFAULT_SPINNER: SpinnerStyle = "orbit";
export const SPINNER_MS = 90;

/** Braille dot bit for (column 0..1, row 0..3) inside one cell. */
const DOT = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
] as const;
const braille = (bits: number) => String.fromCharCode(0x2800 + bits);
/** Head → tail colours for trails. */
const TRAIL: ThemeColor[] = ["accent", "muted", "dim"];

/** Paint dots on a (cells×2) × 4 braille canvas; each cell takes the colour of its brightest dot. */
function canvas(t: KitTheme, cells: number, dots: Array<{ x: number; y: number; level: number }>): string {
  const bits = new Array<number>(cells).fill(0);
  const level = new Array<number>(cells).fill(99);
  for (const d of dots) {
    const c = Math.floor(d.x / 2);
    if (c < 0 || c >= cells) continue;
    bits[c]! |= DOT[d.x % 2]![d.y]!;
    level[c] = Math.min(level[c]!, d.level);
  }
  return bits.map((b, i) => (b === 0 ? " " : t.fg(TRAIL[Math.min(level[i]!, TRAIL.length - 1)]!, braille(b)))).join("");
}

// 4×4 perimeter of a two-cell braille block, clockwise.
const ORBIT: Array<[number, number]> = [[0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [3, 2], [3, 3], [2, 3], [1, 3], [0, 3], [0, 2], [0, 1]];

const STYLES: Record<SpinnerStyle, { cells: number; frame: (t: KitTheme, n: number) => string }> = {
  // A dot circling a 4×4 grid with a fading two-dot tail.
  orbit: {
    cells: 2,
    frame: (t, n) => canvas(t, 2, [0, 1, 2].map((k) => {
      const [x, y] = ORBIT[(n - k + ORBIT.length * 4) % ORBIT.length]!;
      return { x, y, level: k };
    })),
  },
  // A comet bouncing across three cells, trail fading behind it.
  comet: {
    cells: 3,
    frame: (t, n) => {
      const span = 6;
      const p = n % (span * 2 - 2);
      const x = p < span ? p : span * 2 - 2 - p;
      const dir = p < span ? -1 : 1;
      return canvas(t, 3, [0, 1, 2].map((k) => ({ x: x + dir * k, y: 1 + (k === 0 ? 0 : 1) * ((n + k) % 2), level: k })));
    },
  },
  // ◆ sweeping over three cells, ◇ neighbours.
  scanner: {
    cells: 3,
    frame: (t, n) => {
      const p = n % 4;
      const x = p < 3 ? p : 1;
      return [0, 1, 2].map((i) => (i === x ? t.fg("accent", "◆") : Math.abs(i - x) === 1 ? t.fg("muted", "◇") : t.fg("dim", "·"))).join("");
    },
  },
  // A sine wave scrolling through two braille cells.
  helix: {
    cells: 2,
    frame: (t, n) => canvas(t, 2, [0, 1, 2, 3].map((x) => ({ x, y: Math.round(((Math.sin((x + n) / 1.3) + 1) / 2) * 3), level: x === 3 ? 0 : x === 2 ? 0 : 1 }))),
  },
  // ◇ ◈ ◆ ◈ with a brightness pulse.
  diamond: {
    cells: 1,
    frame: (t, n) => {
      const f = n % 6;
      const glyph = ["◇", "◈", "◆", "◆", "◈", "◇"][f]!;
      const color: ThemeColor = f === 2 || f === 3 ? "accent" : f === 1 || f === 4 ? "muted" : "dim";
      return t.fg(color, glyph);
    },
  },
  // Three bars breathing out of phase.
  bars: {
    cells: 3,
    frame: (t, n) => {
      const H = "▁▂▃▄▅▆▇█";
      return [0, 1, 2].map((i) => {
        const h = Math.round(((Math.sin((n - i * 2) / 2) + 1) / 2) * 7);
        return t.fg(h > 5 ? "accent" : h > 2 ? "muted" : "dim", H[h]!);
      }).join("");
    },
  },
  // A quarter block rotating.
  quad: {
    cells: 1,
    frame: (t, n) => t.fg(n % 2 === 0 ? "accent" : "muted", ["▖", "▘", "▝", "▗"][n % 4]!),
  },
};

/** Current frame of a spinner (time-based, so any re-render animates it). */
export function spinner(t: KitTheme, style: SpinnerStyle = DEFAULT_SPINNER, now = Date.now()): string {
  return STYLES[style].frame(t, Math.floor(now / SPINNER_MS));
}

/** Frame by index (tests, gallery). */
export function spinnerFrame(t: KitTheme, style: SpinnerStyle, n: number): string {
  return STYLES[style].frame(t, n);
}

export function spinnerCells(style: SpinnerStyle = DEFAULT_SPINNER): number {
  return STYLES[style].cells;
}

/** A static glyph padded to the spinner's width, so text doesn't jump when running ends. */
export function settledGlyph(glyph: string, style: SpinnerStyle = DEFAULT_SPINNER): string {
  return glyph + " ".repeat(Math.max(0, spinnerCells(style) - visibleWidth(glyph)));
}

// ── states ──────────────────────────────────────────────────────────────────

export type RunState = "running" | "completed" | "failed" | "cancelled";
export const STATE_COLOR: Record<RunState, ThemeColor> = { running: "accent", completed: "success", failed: "error", cancelled: "warning" };
export const STATE_GLYPH: Record<Exclude<RunState, "running">, string> = { completed: "✓", failed: "✗", cancelled: "⊘" };
export const STATE_BADGE: Record<RunState, string> = { running: "RUN ", completed: "DONE", failed: "FAIL", cancelled: "STOP" };

/** Spinner while running, else the coloured settled glyph (same width). */
export function stateGlyph(t: KitTheme, state: RunState, now = Date.now()): string {
  return state === "running" ? spinner(t, DEFAULT_SPINNER, now) : t.fg(STATE_COLOR[state], settledGlyph(STATE_GLYPH[state]));
}

// ── lines ───────────────────────────────────────────────────────────────────

/** Inverse chip: ` DONE ` on the colour. Needs no extra glyphs or fonts. */
export function badge(t: KitTheme, color: ThemeColor, label: string): string {
  return `\x1b[7m${t.fg(color, ` ${label} `)}\x1b[27m`;
}

/** `left ········ right`, fitted to width. */
export function leader(t: KitTheme, left: string, right: string, width: number): string {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap < 4) return truncateToWidth(`${left}  ${right}`, width, "…");
  return `${left} ${t.fg("borderMuted", "·".repeat(gap - 2))} ${right}`;
}

/** Left + right on one line, padded between. */
export function spread(left: string, right: string, width: number): string {
  if (right === "") return truncateToWidth(left, width, "…");
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap < 2) return truncateToWidth(`${left}  ${right}`, width, "…");
  return `${left}${" ".repeat(gap)}${right}`;
}

/** `▌ left            right` — a coloured bar that groups related lines. */
export function rail(t: KitTheme, color: ThemeColor, left: string, right: string, width: number): string {
  return spread(`${t.fg(color, "▌")} ${left}`, right, width);
}

// ── progress ────────────────────────────────────────────────────────────────

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/** Smooth meter (8 steps per cell) for scores: `█████▍░░`. */
export function meter(t: KitTheme, ratio: number, width = 8, color: ThemeColor = "accent"): string {
  const units = Math.round(Math.max(0, Math.min(1, ratio)) * width * 8);
  const full = "█".repeat(Math.floor(units / 8)) + EIGHTHS[units % 8]!;
  return t.fg(color, full) + t.fg("borderMuted", "░".repeat(Math.max(0, width - visibleWidth(full))));
}

/**
 * `████▒▒░░░░`: `done` solid, `active` shaded (in progress), the rest light.
 * Counts are clamped; total 0 renders an empty track.
 */
export function progressBar(t: KitTheme, done: number, active: number, total: number, width = 20, color: ThemeColor = "accent"): string {
  if (total <= 0) return t.fg("borderMuted", "░".repeat(width));
  const d = Math.max(0, Math.min(total, done));
  const a = Math.max(0, Math.min(total - d, active));
  const solid = Math.round((d / total) * width);
  const shade = a > 0 ? Math.max(1, Math.round(((d + a) / total) * width) - solid) : 0;
  const rest = Math.max(0, width - solid - shade);
  return t.fg(color, "█".repeat(solid)) + t.fg(color, "▒".repeat(Math.min(shade, width - solid))) + t.fg("borderMuted", "░".repeat(rest));
}
