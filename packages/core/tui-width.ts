/**
 * @pi-unipi/core — TUI width helpers
 *
 * pi-tui's differential renderer throws when a rendered line is wider than the
 * terminal (see `TUI.render` in @earendil-works/pi-tui — it writes
 * `~/.pi/agent/pi-crash.log`, stops the TUI and rethrows). That makes any
 * "minimum width" floor a crash waiting to happen on a narrow terminal:
 *
 *     const innerWidth = Math.max(40, width - 2);   // ← 42-col lines at width=20
 *
 * The invariant every component must hold is:
 *
 *     for every returned line:  visibleWidth(line) <= width
 *
 * These helpers make that invariant easy to satisfy. They are pure arithmetic
 * so this module stays free of a pi-tui dependency.
 */

/**
 * Terminals narrower than this cannot usefully show a bordered box: two
 * columns go to the border, leaving too little for content. Below the
 * threshold, callers should render borderless (see {@link shouldRenderBorder}).
 */
export const MIN_BORDERED_WIDTH = 12;

/** Smallest width any layout is asked to cope with. */
export const MIN_RENDER_WIDTH = 1;

/**
 * Normalize an incoming render width. Guards against `0`, negative, `NaN`
 * and fractional widths, all of which have been observed during terminal
 * resize races.
 */
export function normalizeWidth(width: number): number {
  if (!Number.isFinite(width)) return MIN_RENDER_WIDTH;
  return Math.max(MIN_RENDER_WIDTH, Math.floor(width));
}

/**
 * Whether a bordered box fits at this width. When false, render the content
 * without `│` side borders so the full width is usable.
 */
export function shouldRenderBorder(width: number): boolean {
  return normalizeWidth(width) >= MIN_BORDERED_WIDTH;
}

/**
 * Content width inside a bordered box, i.e. the terminal width minus the two
 * border columns, so that `│ + content + │` is `<= width`.
 *
 * Use this for components that always draw a border. Components that can drop
 * the border on narrow terminals should branch on {@link shouldRenderBorder}
 * and use {@link adaptiveInnerWidth} instead.
 */
export function boxInnerWidth(width: number): number {
  return Math.max(1, normalizeWidth(width) - 2);
}

/**
 * Content width for components that drop their border on narrow terminals:
 * the box inner width when a border fits, otherwise the full width.
 *
 * Pair with {@link shouldRenderBorder} to decide whether to emit the border
 * characters. Together they guarantee every emitted line is `<= width` at any
 * width down to 1.
 */
export function adaptiveInnerWidth(width: number): number {
  const w = normalizeWidth(width);
  return shouldRenderBorder(w) ? boxInnerWidth(w) : w;
}

/**
 * Width remaining after reserving `reserved` columns for a prefix, indent or
 * gutter. Never returns less than 1, so it is safe to pass to wrapping and
 * truncation helpers (which throw or misbehave on non-positive widths).
 */
export function contentWidth(available: number, reserved: number): number {
  return Math.max(1, normalizeWidth(available) - Math.max(0, Math.floor(reserved)));
}

/**
 * Clamp a repeat count to a non-negative integer.
 *
 * `String.prototype.repeat` throws `RangeError: Invalid count value` for
 * negative counts, which crashes the render pass.
 */
export function safeRepeatCount(count: number): number {
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, Math.floor(count));
}

/** `" ".repeat(n)` that cannot throw. */
export function safeRepeat(char: string, count: number): string {
  return char.repeat(safeRepeatCount(count));
}

/**
 * Width-keyed render cache.
 *
 * Components that cache their rendered lines must invalidate on width change.
 * pi-tui's `requestRender()` does *not* call `invalidate()`, so a component
 * that caches `string[]` without keying on width will return stale, over-wide
 * lines after the terminal is made narrower — and the next differential frame
 * throws.
 */
export class WidthKeyedCache {
  private lines: string[] | null = null;
  private width = -1;

  /** Cached lines for this width, or `null` on miss. */
  get(width: number): string[] | null {
    return this.lines !== null && this.width === normalizeWidth(width) ? this.lines : null;
  }

  /** Store lines for this width. Returns the lines for convenient chaining. */
  set(width: number, lines: string[]): string[] {
    this.lines = lines;
    this.width = normalizeWidth(width);
    return lines;
  }

  /** Drop the cache — call from `invalidate()` and on any state change. */
  clear(): void {
    this.lines = null;
    this.width = -1;
  }
}
