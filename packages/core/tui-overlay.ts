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
export class OverlayTheme {
  private theme: Theme | null = null;

  setTheme(theme: Theme | null): void {
    this.theme = theme;
  }

  /** Color text using the active theme, or a fallback ANSI code. */
  fg(color: string, text: string): string {
    if (this.theme) return this.theme.fg(color as never, text);
    return `${FALLBACK_COLORS[color] ?? ""}${text}\x1b[0m`;
  }

  /** Bold text using the active theme, or a fallback ANSI code. */
  bold(text: string): string {
    if (this.theme) return this.theme.bold(text);
    return `\x1b[1m${text}\x1b[0m`;
  }

  /** Background color using the active theme, or text unchanged. */
  bg(color: string, text: string): string {
    if (this.theme) return this.theme.bg(color as never, text);
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
