/**
 * @pi-unipi/core — Shared TUI overlay helpers
 *
 * Eliminates the frameLine/borderLine/ruleLine/fg/bold duplication across
 * 9+ overlay files. Each overlay creates an OverlayTheme instance and
 * delegates box-drawing and theming to it.
 *
 * The key-handling bug (raw \x1b comparisons vs matchesKey) would have been
 * caught at one site instead of 10 if these helpers had existed from the start.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { safeRepeat } from "./tui-width.js";

/** ANSI codes used when no Theme is available (terminal default). */
const FALLBACK_COLORS: Record<string, string> = {
  accent: "\x1b[36m",
  success: "\x1b[32m",
  warning: "\x1b[33m",
  error: "\x1b[31m",
  dim: "\x1b[2m",
  borderMuted: "\x1b[90m",
};

/**
 * Shared theme + box-drawing helper for TUI overlays.
 *
 * Usage:
 * ```ts
 * class MyOverlay implements Component {
 *   private overlay = new OverlayTheme();
 *
 *   setTheme(theme: Theme) { this.overlay.setTheme(theme); }
 *
 *   render(width: number): string[] {
 *     const inner = boxInnerWidth(width);
 *     return [
 *       this.overlay.borderLine(inner, "top"),
 *       this.overlay.frameLine("Title", inner),
 *       this.overlay.borderLine(inner, "bottom"),
 *     ];
 *   }
 * }
 * ```
 */
/** Drop a trailing full reset so a targeted-off close can follow instead. */
function stripTrailingReset(styled: string): string {
  return styled.replace(/\x1b\[0m$/, "");
}

export class OverlayTheme {
  private theme: Theme | null = null;

  setTheme(theme: Theme | null): void {
    this.theme = theme;
  }

  /** Theme keys pi rejected (a hostile theme.fg throws on unknown keys). */
  private unsupportedKeys = new Set<string>();

  /** Color text using the active theme, or a fallback ANSI code.
   *  Closes with fg-off (\x1b[39m), NOT the full reset — a mid-line \x1b[0m
   *  would kill an enclosing background and paint rows partially.
   *  A theme that rejects a key (e.g. "textMuted") degrades to the fallback
   *  ANSI code instead of crashing the overlay mid-render. */
  fg(color: string, text: string): string {
    if (this.theme && !this.unsupportedKeys.has(color)) {
      try {
        return stripTrailingReset(this.theme.fg(color as never, text)) + "\x1b[39m";
      } catch {
        this.unsupportedKeys.add(color);
      }
    }
    return `${FALLBACK_COLORS[color] ?? ""}${text}\x1b[39m`;
  }

  /** Bold text using the active theme, or a fallback ANSI code.
   *  Closes with bold-off (\x1b[22m) for the same background-safety reason. */
  bold(text: string): string {
    if (this.theme) {
      try {
        return stripTrailingReset(this.theme.bold(text)) + "\x1b[22m";
      } catch {
        // Fall through to the plain-bold fallback.
      }
    }
    return `\x1b[1m${text}\x1b[22m`;
  }

  /** Background color using the active theme, or text unchanged. */
  bg(color: string, text: string): string {
    if (this.theme && !this.unsupportedKeys.has(color)) {
      try {
        return this.theme.bg(color as never, text);
      } catch {
        this.unsupportedKeys.add(color);
      }
    }
    return text;
  }

  /** Frame a content line with `│` borders, padded and truncated to innerWidth. */
  frameLine(content: string, innerWidth: number): string {
    const truncated = truncateToWidth(content, innerWidth, "");
    const padding = Math.max(0, innerWidth - visibleWidth(truncated));
    return `${this.fg("borderMuted", "│")}${truncated}${safeRepeat(" ", padding)}${this.fg("borderMuted", "│")}`;
  }

  /** Horizontal rule: `├───┤`. */
  ruleLine(innerWidth: number): string {
    return this.fg("borderMuted", `├${safeRepeat("─", innerWidth)}┤`);
  }

  /** Top or bottom border: `┌───┐` / `└───┘`. */
  borderLine(innerWidth: number, edge: "top" | "bottom"): string {
    const left = edge === "top" ? "┌" : "└";
    const right = edge === "top" ? "┐" : "┘";
    return this.fg("borderMuted", `${left}${safeRepeat("─", innerWidth)}${right}`);
  }
}

/**
 * Wrap already-rendered body lines in a solid, opaque frame so an overlay
 * never lets the transcript bleed through. Every row is padded to the full
 * inner width and tinted with `bgFn` (defaults to a dark neutral), which is
 * what makes it opaque — pi's overlay compositor only paints the cells a
 * component returns.
 */
export function frameOverlay(
  body: readonly string[],
  width: number,
  options: {
    title?: string | undefined;
    borderFg?: ((text: string) => string) | undefined;
    bgFn?: ((text: string) => string) | undefined;
  } = {},
): string[] {
  const inner = Math.max(1, width - 2);
  const border = options.borderFg ?? ((t: string) => `\x1b[38;2;83;160;215m${t}\x1b[0m`);
  const bg = options.bgFn ?? ((t: string) => `\x1b[48;2;24;26;32m${t}\x1b[49m`);
  // Full-bleed paint: the bg wraps the ENTIRE line including the border
  // columns — a frame whose borders show through reads as "paint here and
  // there". Border coloring uses targeted-off closes (see OverlayTheme.fg).
  const row = (content: string): string => {
    const cut = truncateToWidth(content, inner, "");
    const padded = cut + safeRepeat(" ", Math.max(0, inner - visibleWidth(cut)));
    return bg(`${border("│")}${padded}${border("│")}`);
  };
  const titleText = options.title ? ` ${options.title} ` : "";
  const topFill = Math.max(0, inner - visibleWidth(titleText));
  const lines = [bg(border(`╭${titleText}${safeRepeat("─", topFill)}╮`))];
  for (const line of body) lines.push(row(line));
  lines.push(bg(border(`╰${safeRepeat("─", inner)}╯`)));
  return lines;
}
