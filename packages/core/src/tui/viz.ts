/**
 * @pi-unipi/core — viz kit: Unicode + colour pieces that make numbers fun to read.
 *
 *   Paint        theme-aware RGB painter (truecolor, 256-colour fallback)
 *   gradient     per-cell colour ramps over any plain text
 *   bigText      3-row "future" digits  ┏━┓ ╺┓  ┏━┓ for headline numbers
 *   spark        ▁▂▃▅▇ one-row sparkline
 *   columns      multi-row column chart with eighth-block tops
 *   brailleArea  2×4-dot braille area chart (dense, smooth)
 *   gauge        smooth eighth-block meter with a colour ramp
 *   shareBar     stacked share bar of coloured segments
 *   pie          ○◔◑◕● quarter glyph for small ratios
 *   chip         ▐ label ▌ pill on a coloured background
 *   grid         names laid out in fixed columns
 *
 * Contract: every function returns lines whose visible width is EXACTLY the
 * width asked for (or the natural width when none is asked). Callers can
 * stack pieces side by side without measuring again.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type RGB = readonly [number, number, number];

/** Minimal theme surface the kit reads (pi's Theme satisfies it). */
export interface VizThemeLike {
  fg(color: never, text: string): string;
  bold?(text: string): string;
  getFgAnsi?(color: never): string;
  getColorMode?(): "truecolor" | "256color";
}

// ── colour ──────────────────────────────────────────────────────────────────

/** Unicrab's shell, from core/src/hints/crab-data.ts CRAB_PALETTE. */
export const CRAB = {
  red: [240, 24, 24] as RGB,
  ember: [240, 48, 24] as RGB,
  orange: [240, 120, 24] as RGB,
  amber: [240, 168, 24] as RGB,
  gold: [240, 192, 48] as RGB,
  cream: [240, 240, 168] as RGB,
  shell: [216, 0, 24] as RGB,
};

/** Fallback RGB per theme token (pi's dark theme), used when the theme is 256-colour or unreadable. */
const TOKEN_FALLBACK: Record<string, RGB> = {
  accent: [138, 190, 183],
  borderAccent: [0, 215, 255],
  border: [95, 135, 255],
  borderMuted: [80, 80, 80],
  success: [181, 189, 104],
  warning: [255, 255, 0],
  error: [204, 102, 102],
  muted: [128, 128, 128],
  dim: [102, 102, 102],
  text: [212, 212, 212],
  mdHeading: [240, 198, 116],
  syntaxKeyword: [86, 156, 214],
  syntaxFunction: [220, 220, 170],
  syntaxString: [206, 145, 120],
  syntaxNumber: [181, 206, 168],
  syntaxType: [78, 201, 176],
  thinkingHigh: [178, 148, 187],
  thinkingXhigh: [209, 131, 232],
};

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

export function mix(a: RGB, b: RGB, t: number): RGB {
  const k = clamp01(t);
  return [Math.round(a[0] + (b[0] - a[0]) * k), Math.round(a[1] + (b[1] - a[1]) * k), Math.round(a[2] + (b[2] - a[2]) * k)];
}

/** Sample a multi-stop ramp at t ∈ [0,1]. */
export function ramp(stops: readonly RGB[], t: number): RGB {
  if (stops.length === 0) return [255, 255, 255];
  if (stops.length === 1) return stops[0]!;
  const k = clamp01(t) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(k));
  return mix(stops[i]!, stops[i + 1]!, k - i);
}

/** Nearest xterm-256 colour index for an RGB (6×6×6 cube or grey ramp). */
export function rgbTo256(c: RGB): number {
  const [r, g, b] = c;
  if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10) {
    if (r < 8) return 16;
    if (r > 238) return 231;
    return 232 + Math.round(((r - 8) / 247) * 24);
  }
  const q = (v: number): number => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

function parseAnsiRgb(ansi: string): RGB | null {
  const m = /38;2;(\d+);(\d+);(\d+)/.exec(ansi);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Theme-aware painter. All colour in the kit flows through one of these so a
 * 256-colour terminal still gets sensible output and theme tokens still win.
 */
export class Paint {
  readonly trueColor: boolean;
  private readonly cache = new Map<string, RGB>();

  constructor(readonly theme?: VizThemeLike, trueColor?: boolean) {
    this.trueColor = trueColor ?? (theme?.getColorMode ? theme.getColorMode() === "truecolor" : true);
  }

  /** RGB of a theme token (parsed from the theme's ANSI, else a dark-theme default). */
  token(name: string): RGB {
    const hit = this.cache.get(name);
    if (hit) return hit;
    let rgb: RGB | null = null;
    try {
      const ansi = this.theme?.getFgAnsi?.(name as never);
      if (ansi) rgb = parseAnsiRgb(ansi);
    } catch {
      rgb = null;
    }
    const out = rgb ?? TOKEN_FALLBACK[name] ?? TOKEN_FALLBACK.text!;
    this.cache.set(name, out);
    return out;
  }

  fgOpen(c: RGB): string {
    return this.trueColor ? `\x1b[38;2;${c[0]};${c[1]};${c[2]}m` : `\x1b[38;5;${rgbTo256(c)}m`;
  }

  bgOpen(c: RGB): string {
    return this.trueColor ? `\x1b[48;2;${c[0]};${c[1]};${c[2]}m` : `\x1b[48;5;${rgbTo256(c)}m`;
  }

  rgb(c: RGB, text: string): string {
    return text === "" ? "" : `${this.fgOpen(c)}${text}\x1b[39m`;
  }

  on(fg: RGB, bg: RGB, text: string): string {
    return text === "" ? "" : `${this.fgOpen(fg)}${this.bgOpen(bg)}${text}\x1b[39m\x1b[49m`;
  }

  /** Theme token colour (exact theme ANSI when available). */
  fg(token: string, text: string): string {
    if (text === "") return "";
    if (this.theme) {
      try {
        return this.theme.fg(token as never, text).replace(/\x1b\[0m$/, "") + "\x1b[39m";
      } catch {
        // fall through to RGB
      }
    }
    return this.rgb(this.token(token), text);
  }

  bold(text: string): string {
    return `\x1b[1m${text}\x1b[22m`;
  }

  dim(text: string): string {
    return this.fg("dim", text);
  }
}

// ── layout helpers ──────────────────────────────────────────────────────────

/** Pad or cut to exactly `w` visible cells. */
export function fitTo(s: string, w: number): string {
  if (w <= 0) return "";
  const vw = visibleWidth(s);
  if (vw > w) {
    const cut = truncateToWidth(s, w, "…");
    return cut + " ".repeat(Math.max(0, w - visibleWidth(cut)));
  }
  return s + " ".repeat(w - vw);
}

/** Centre inside exactly `w` cells. */
export function centerTo(s: string, w: number): string {
  const vw = visibleWidth(s);
  if (vw >= w) return fitTo(s, w);
  const left = Math.floor((w - vw) / 2);
  return " ".repeat(left) + s + " ".repeat(w - vw - left);
}

/** Right-align inside exactly `w` cells. */
export function rightTo(s: string, w: number): string {
  const vw = visibleWidth(s);
  if (vw >= w) return fitTo(s, w);
  return " ".repeat(w - vw) + s;
}

/** `left ··· right` (or spaces) in exactly `w` cells. */
export function spreadTo(left: string, right: string, w: number, fill = " ", fillPaint?: (s: string) => string): string {
  const gap = w - visibleWidth(left) - visibleWidth(right);
  if (gap < 1) return fitTo(`${left} ${right}`, w);
  const paint = fillPaint ?? ((s: string) => s);
  const mid = fill === " " || gap < 3 ? " ".repeat(gap) : ` ${paint(fill.repeat(gap - 2))} `;
  return fitTo(left + mid + right, w);
}

/**
 * Lay blocks of lines side by side. Each block is fitted to its width and
 * padded to the tallest block's height. Total width = sum(widths) + gaps.
 */
export function sideBySide(blocks: ReadonlyArray<{ lines: readonly string[]; width: number }>, gap = 2): string[] {
  const h = Math.max(0, ...blocks.map((b) => b.lines.length));
  const out: string[] = [];
  for (let i = 0; i < h; i++) {
    out.push(blocks.map((b) => fitTo(b.lines[i] ?? "", b.width)).join(" ".repeat(gap)));
  }
  return out;
}

/** Split `total` cells into `n` widths that sum to total - gaps. */
export function splitWidth(total: number, n: number, gap = 2): number[] {
  const usable = Math.max(n, total - gap * (n - 1));
  const base = Math.floor(usable / n);
  const extra = usable - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

// ── gradient text ───────────────────────────────────────────────────────────

/** Colour each visible cell of plain `text` along a ramp. Spaces stay uncoloured. */
export function gradient(p: Paint, text: string, stops: readonly RGB[], bold = false): string {
  const chars = Array.from(text);
  const n = Math.max(1, chars.length - 1);
  let out = "";
  chars.forEach((ch, i) => {
    out += ch === " " ? " " : p.rgb(ramp(stops, i / n), ch);
  });
  return bold ? p.bold(out) : out;
}

/** Apply a ramp column-wise across several plain rows (keeps big text coherent). */
export function gradientRows(p: Paint, rows: readonly string[], stops: readonly RGB[], bold = false): string[] {
  const w = Math.max(1, ...rows.map((r) => Array.from(r).length));
  return rows.map((r) => {
    let out = "";
    Array.from(r).forEach((ch, i) => {
      out += ch === " " ? " " : p.rgb(ramp(stops, w <= 1 ? 0 : i / (w - 1)), ch);
    });
    return bold ? p.bold(out) : out;
  });
}

// ── big text ────────────────────────────────────────────────────────────────

const BIG: Record<string, readonly [string, string, string]> = {
  "0": ["┏━┓", "┃ ┃", "┗━┛"],
  "1": ["╺┓ ", " ┃ ", "╺┻╸"],
  "2": ["┏━┓", "┏━┛", "┗━╸"],
  "3": ["┏━┓", "╺━┫", "┗━┛"],
  "4": ["╻ ╻", "┗━┫", "  ╹"],
  "5": ["┏━╸", "┗━┓", "╺━┛"],
  "6": ["┏━╸", "┣━┓", "┗━┛"],
  "7": ["╺━┓", "  ┃", "  ╹"],
  "8": ["┏━┓", "┣━┫", "┗━┛"],
  "9": ["┏━┓", "┗━┫", "╺━┛"],
  ".": [" ", " ", "▪"],
  ",": [" ", " ", "▖"],
  ":": [" ", "╏", " "],
  "-": ["  ", "╺╸", "  "],
  "$": ["┏╋┓", "┗╋┓", "┗╋┛"],
  "%": ["╻ ╱", " ╱ ", "╱ ╹"],
  " ": [" ", " ", " "],
};

/**
 * Three-row headline text. Digits and `.,:-$%` are drawn big; any other
 * character (units like `k`, `M`, `m`) is set small on the baseline, which
 * reads like a typographic superscript-in-reverse: big number, small unit.
 */
export function bigText(text: string): [string, string, string] {
  const rows: [string, string, string] = ["", "", ""];
  let prevBig = false;
  for (const ch of Array.from(text)) {
    const g = BIG[ch];
    if (g) {
      const sep = prevBig && ch !== "." && ch !== "," && ch !== ":" ? " " : "";
      rows[0] += sep + g[0];
      rows[1] += sep + g[1];
      rows[2] += sep + g[2];
      prevBig = ch !== " ";
    } else {
      rows[0] += " ";
      rows[1] += " ";
      rows[2] += ch;
      prevBig = false;
    }
  }
  // Small unit chars were padded one cell; normalise widths across rows.
  const w = Math.max(...rows.map((r) => visibleWidth(r)));
  return rows.map((r) => r + " ".repeat(w - visibleWidth(r))) as [string, string, string];
}

/** Visible width of `bigText(text)`. */
export function bigTextWidth(text: string): number {
  return visibleWidth(bigText(text)[0]);
}

// ── charts ──────────────────────────────────────────────────────────────────

const BLOCKS = "▁▂▃▄▅▆▇█";
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/** Resample `values` to exactly `n` buckets (max within each bucket). */
export function resample(values: readonly number[], n: number): number[] {
  if (n <= 0) return [];
  if (values.length === 0) return new Array<number>(n).fill(0);
  if (values.length <= n) return [...new Array<number>(n - values.length).fill(0), ...values];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * values.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * values.length) / n));
    let m = 0;
    for (let j = a; j < b; j++) m = Math.max(m, values[j] ?? 0);
    out.push(m);
  }
  return out;
}

/** One-row sparkline of exactly `width` cells, coloured along `stops` by height. */
export function spark(p: Paint, values: readonly number[], width: number, stops: readonly RGB[]): string {
  const v = resample(values, width);
  const max = Math.max(0, ...v);
  return v
    .map((x) => {
      if (max <= 0 || x <= 0) return p.fg("borderMuted", "▁");
      const t = x / max;
      const i = Math.min(7, Math.max(0, Math.round(t * 7)));
      return p.rgb(ramp(stops, t), BLOCKS[i]!);
    })
    .join("");
}

/**
 * Column chart: `height` rows × `width` cells, eighth-block tops, each column
 * coloured by its height along `stops`. Returns rows top → bottom.
 */
export function columns(p: Paint, values: readonly number[], width: number, height: number, stops: readonly RGB[]): string[] {
  const v = resample(values, width);
  const max = Math.max(0, ...v);
  const rows: string[] = [];
  for (let r = height - 1; r >= 0; r--) {
    let line = "";
    for (const x of v) {
      const t = max > 0 ? x / max : 0;
      const units = Math.round(t * height * 8);
      const here = units - r * 8;
      const color = ramp(stops, t);
      if (here >= 8) line += p.rgb(color, "█");
      else if (here > 0) line += p.rgb(color, BLOCKS[here - 1]!);
      else line += r === 0 ? p.fg("borderMuted", "▁") : " ";
    }
    rows.push(line);
  }
  return rows;
}

const BRAILLE_BITS = [
  [0x40, 0x04, 0x02, 0x01], // left column, bottom → top
  [0x80, 0x20, 0x10, 0x08], // right column, bottom → top
] as const;

/**
 * Braille area chart: `width` cells × `height` rows, 2 samples per cell and
 * 4 dot-rows per line, so it is 8× denser than block bars. Colour per row
 * follows `stops` bottom → top.
 */
export function brailleArea(p: Paint, values: readonly number[], width: number, height: number, stops: readonly RGB[]): string[] {
  const samples = resample(values, width * 2);
  const max = Math.max(0, ...samples);
  const dotsTall = height * 4;
  const filled = samples.map((x) => (max > 0 ? Math.round((x / max) * dotsTall) : 0));
  const rows: string[] = [];
  for (let r = height - 1; r >= 0; r--) {
    let line = "";
    const color = ramp(stops, height <= 1 ? 1 : r / (height - 1));
    for (let c = 0; c < width; c++) {
      let bits = 0;
      for (let side = 0; side < 2; side++) {
        const f = filled[c * 2 + side] ?? 0;
        for (let d = 0; d < 4; d++) {
          if (f > r * 4 + d) bits |= BRAILLE_BITS[side]![d]!;
        }
      }
      line += bits === 0 ? (r === 0 ? p.fg("borderMuted", "⣀") : " ") : p.rgb(color, String.fromCharCode(0x2800 + bits));
    }
    rows.push(line);
  }
  return rows;
}

/**
 * Smooth meter of exactly `width` cells. The filled part is coloured along
 * `stops` (position-wise, so a full bar shows the whole ramp), the track is
 * a quiet dotted line.
 */
export function gauge(p: Paint, ratio: number, width: number, stops: readonly RGB[], track = "·"): string {
  if (width <= 0) return "";
  const units = Math.round(clamp01(ratio) * width * 8);
  const full = Math.floor(units / 8);
  const part = units % 8;
  let out = "";
  for (let i = 0; i < full; i++) out += p.rgb(ramp(stops, width <= 1 ? 1 : i / (width - 1)), "█");
  let used = full;
  if (part > 0 && used < width) {
    out += p.rgb(ramp(stops, width <= 1 ? 1 : used / (width - 1)), EIGHTHS[part]!);
    used++;
  }
  if (used < width) out += p.fg("borderMuted", track.repeat(width - used));
  return out;
}

export interface Share {
  value: number;
  color: RGB;
}

/** Stacked bar of exactly `width` cells; each segment gets at least one cell when non-zero. */
export function shareBar(p: Paint, parts: readonly Share[], width: number, glyph = "█"): string {
  const total = parts.reduce((s, x) => s + Math.max(0, x.value), 0);
  if (total <= 0 || width <= 0) return p.fg("borderMuted", "·".repeat(Math.max(0, width)));
  const live = parts.filter((x) => x.value > 0);
  const cells = live.map((x) => Math.max(1, Math.round((x.value / total) * width)));
  let sum = cells.reduce((a, b) => a + b, 0);
  while (sum > width) {
    const i = cells.indexOf(Math.max(...cells));
    cells[i]!--;
    sum--;
  }
  while (sum < width) {
    const i = cells.indexOf(Math.max(...cells));
    cells[i]!++;
    sum++;
  }
  return live.map((x, i) => p.rgb(x.color, glyph.repeat(Math.max(0, cells[i]!)))).join("");
}

/** ○◔◑◕● — one-cell ratio glyph. */
export function pie(ratio: number): string {
  return "○◔◑◕●"[Math.round(clamp01(ratio) * 4)]!;
}

/** `▐ label ▌` pill: coloured caps around a label on the same colour. */
export function chip(p: Paint, label: string, bg: RGB, fg: RGB = [16, 16, 20]): string {
  return `${p.rgb(bg, "▐")}${p.on(fg, bg, p.bold(label))}${p.rgb(bg, "▌")}`;
}

/** Visible width of `chip(label)`. */
export const chipWidth = (label: string): number => visibleWidth(label) + 2;

/**
 * Lay `items` (already styled; `plain` gives their width) into as many
 * equal columns as fit `width`, row-major. Each line is exactly `width`.
 */
export function grid(items: ReadonlyArray<{ text: string; plain: number }>, width: number, minCol = 14, maxRows = Infinity): { lines: string[]; hidden: number } {
  if (items.length === 0) return { lines: [], hidden: 0 };
  const widest = Math.max(...items.map((i) => i.plain));
  const colW = Math.max(minCol, Math.min(widest + 2, width));
  const cols = Math.max(1, Math.floor(width / colW));
  const rows = Math.ceil(items.length / cols);
  const shownRows = Math.min(rows, maxRows);
  const lines: string[] = [];
  for (let r = 0; r < shownRows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      const it = items[r * cols + c];
      line += it ? fitTo(it.text, colW) : " ".repeat(colW);
    }
    lines.push(fitTo(line, width));
  }
  const hidden = Math.max(0, items.length - shownRows * cols);
  return { lines, hidden };
}

// ── number formatting ───────────────────────────────────────────────────────

/** 1234 → 1.2k, 1_234_567 → 1.2M (no trailing .0). */
export function compact(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const a = Math.abs(n);
  const f = (v: number, u: string): string => `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}${u}`;
  if (a >= 1e9) return f(n / 1e9, "B");
  if (a >= 1e6) return f(n / 1e6, "M");
  if (a >= 1e3) return f(n / 1e3, "k");
  return String(Math.round(n));
}

/** $0.0042 → $0.004, $3.4 → $3.40, $1234 → $1.2k */
export function money(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 1000) return `$${compact(n)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

/** 95s → 1m 35s, 3700s → 1h 01m */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}
