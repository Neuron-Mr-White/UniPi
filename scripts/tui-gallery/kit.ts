// Small rendering toolkit for the gallery. Everything here is plain ANSI that
// pi-tui passes through untouched, so what you see is what an extension can ship.
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type Color =
  | "accent" | "border" | "borderAccent" | "borderMuted" | "success" | "error" | "warning" | "muted" | "dim" | "text"
  | "toolTitle" | "toolOutput" | "mdHeading" | "mdLink" | "mdCode" | "customMessageLabel" | "syntaxKeyword"
  | "syntaxString" | "syntaxType" | "syntaxFunction" | "thinkingLow" | "thinkingMedium" | "thinkingHigh" | "thinkingXhigh";
export type Bg = "selectedBg" | "userMessageBg" | "customMessageBg" | "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

export interface Th {
  fg(c: Color, s: string): string;
  bg(c: Bg, s: string): string;
  bold(s: string): string;
  italic(s: string): string;
  underline(s: string): string;
  inverse(s: string): string;
  strikethrough(s: string): string;
  getFgAnsi(c: Color): string;
  getBgAnsi(c: Bg): string;
  getColorMode(): "truecolor" | "256color";
}

export interface Ctx {
  t: Th;
  width: number;
  /** Animation frame counter (~12 fps). */
  frame: number;
}

export const RESET = "\x1b[0m";
export const dimAttr = (s: string) => `\x1b[2m${s}\x1b[22m`;

/** Pad (or cut) to an exact visible width. */
export function fit(s: string, width: number): string {
  const w = visibleWidth(s);
  if (w > width) return truncateToWidth(s, width, "…");
  return s + " ".repeat(width - w);
}

/** Fill a whole line with a theme background, like Pi's tool card box. */
export function fill(ctx: Ctx, bg: Bg, line: string, padX = 1): string {
  const inner = fit(" ".repeat(padX) + line, ctx.width - padX) + " ".repeat(padX);
  // Re-apply bg after any inner resets so the fill is continuous.
  const open = ctx.t.getBgAnsi(bg);
  return open + inner.replace(/\x1b\[(0|49)m/g, (m) => m + open) + "\x1b[49m";
}

/** Pi's default tool shell: blank line, content lines, blank line, all on the card bg. */
export function card(ctx: Ctx, bg: Bg, lines: string[]): string[] {
  return [fill(ctx, bg, ""), ...lines.map((l) => fill(ctx, bg, l)), fill(ctx, bg, "")];
}

/** Left text + right text on one line, with an optional leader between. */
export function spread(left: string, right: string, width: number, leader = " ", leaderStyle: (s: string) => string = (s) => s): string {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap < 2) return truncateToWidth(`${left}  ${right}`, width, "…");
  const lead = leader === " " ? " ".repeat(gap) : ` ${leaderStyle(leader.repeat(gap - 2))} `;
  return left + lead + right;
}

export const SPINNERS: Record<string, string[]> = {
  dots: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  line: ["-", "\\", "|", "/"],
  arc: ["◜", "◠", "◝", "◞", "◡", "◟"],
  circle: ["◐", "◓", "◑", "◒"],
  pulse: ["●", "●", "◉", "○", "◉"],
  bounce: ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"],
  blocks: ["▁", "▃", "▄", "▅", "▆", "▇", "▆", "▅", "▄", "▃"],
  star: ["✶", "✸", "✹", "✺", "✹", "✷"],
  square: ["◰", "◳", "◲", "◱"],
  toggle: ["⊶", "⊷"],
};

export const spin = (ctx: Ctx, name = "dots", slow = 1): string => {
  const f = SPINNERS[name] ?? SPINNERS.dots!;
  return f[Math.floor(ctx.frame / slow) % f.length]!;
};

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
/** Smooth horizontal bar using eighth blocks (8× the resolution of a cell). */
export function smoothBar(ratio: number, width: number): { full: string; rest: string } {
  const units = Math.round(Math.max(0, Math.min(1, ratio)) * width * 8);
  const full = "█".repeat(Math.floor(units / 8)) + EIGHTHS[units % 8]!;
  return { full, rest: " ".repeat(Math.max(0, width - visibleWidth(full))) };
}

const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
export const spark = (values: number[]): string => {
  const max = Math.max(...values, 1);
  return values.map((v) => SPARK[Math.min(7, Math.floor((v / max) * 7.999))]).join("");
};

/** Truecolor escape, ignoring the theme (for capability demos only). */
export const rgb = (r: number, g: number, b: number, s: string, bg = false) =>
  `\x1b[${bg ? 48 : 38};2;${r};${g};${b}m${s}\x1b[${bg ? 49 : 39}m`;

export function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** Box with an optional title set into the top border. */
export function box(
  ctx: Ctx,
  body: string[],
  o: { title?: string; right?: string; style?: keyof typeof BORDERS; color?: Color; width?: number } = {},
): string[] {
  const b = BORDERS[o.style ?? "round"];
  const w = o.width ?? ctx.width;
  const c = (s: string) => ctx.t.fg(o.color ?? "borderMuted", s);
  const title = o.title ? ` ${o.title} ` : "";
  const right = o.right ? ` ${o.right} ` : "";
  const dash = Math.max(0, w - 2 - visibleWidth(title) - visibleWidth(right) - 1);
  const top = c(b.tl + b.h) + title + c(b.h.repeat(dash)) + right + c(b.tr);
  const mid = body.map((l) => c(b.v) + " " + fit(l, w - 4) + " " + c(b.v));
  return [top, ...mid, c(b.bl + b.h.repeat(Math.max(0, w - 2)) + b.br)];
}

export const BORDERS = {
  light: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  round: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  heavy: { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" },
  double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
  dashed: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "┄", v: "┆" },
  ascii: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" },
};
