/**
 * @pi-unipi/core — self-animating spinner line widget
 *
 * A one-line `ctx.ui.setWidget()` component that owns its own animation
 * timer and calls `tui.requestRender()` on every frame — the same pattern
 * as pi's built-in `Loader`. Use it for "still working" indicators whose
 * data refreshes slowly (1 s task polls, agent trackers) but whose spinner
 * must still look alive at ~12 fps.
 *
 * The text callback runs on every frame so elapsed times stay fresh; return
 * `undefined` to render nothing (the line collapses) without disposing.
 */

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const SPINNER_INTERVAL_MS = 80;

export interface SpinnerLineOptions {
  /** Produce the line body (without the spinner glyph). `undefined` hides the line. */
  text: () => string | undefined;
  /** Colour the spinner glyph. Defaults to identity. */
  colorSpinner?: ((glyph: string) => string) | undefined;
  /** Animation frames. Defaults to braille dots. */
  frames?: readonly string[] | undefined;
  intervalMs?: number | undefined;
  /** Left padding columns. Defaults to 1. */
  padLeft?: number | undefined;
}

export interface SpinnerLineComponent {
  render(width: number): string[];
  invalidate(): void;
  dispose(): void;
}

type RenderRequester = { requestRender(): void };

/**
 * Create the widget factory to pass to `ctx.ui.setWidget(key, factory, opts)`.
 * The returned component starts animating when constructed and stops on
 * `dispose()` (pi calls `dispose` when the widget is replaced or cleared).
 */
export function createSpinnerLine(
  options: SpinnerLineOptions,
): (tui: RenderRequester, theme: unknown) => SpinnerLineComponent {
  const frames = options.frames ?? SPINNER_FRAMES;
  const intervalMs = options.intervalMs ?? SPINNER_INTERVAL_MS;
  const pad = " ".repeat(Math.max(0, options.padLeft ?? 1));
  const color = options.colorSpinner ?? ((g: string) => g);

  return (tui) => {
    let frame = 0;
    let timer: ReturnType<typeof setInterval> | undefined =
      frames.length > 1
        ? setInterval(() => {
            frame = (frame + 1) % frames.length;
            tui.requestRender();
          }, intervalMs)
        : undefined;

    return {
      render(width: number): string[] {
        const body = options.text();
        if (body === undefined) return [];
        const glyph = frames[frame] ?? "";
        const line = `${pad}${glyph.length > 0 ? `${color(glyph)} ` : ""}${body}`;
        return [width > 0 ? truncateVisible(line, Math.max(1, width - 1)) : line];
      },
      invalidate() {
        /* stateless between renders; frame lives in closure */
      },
      dispose() {
        if (timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
      },
    };
  };
}

/** Cheap width-safe truncation that ignores ANSI escapes when counting. */
function truncateVisible(line: string, max: number): string {
  let visible = 0;
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? "";
    if (ch === "\x1b") {
      const end = line.indexOf("m", i);
      if (end === -1) break;
      out += line.slice(i, end + 1);
      i = end;
      continue;
    }
    if (visible >= max) break;
    out += ch;
    visible++;
  }
  return out;
}
