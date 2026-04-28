/**
 * @pi-unipi/utility — Name Badge Component
 *
 * Pure render component for the session name badge overlay.
 * Displays a bordered box with opaque background and session name.
 * Display-only — no input handling, no focus.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";

/** Placeholder text when no session name is set */
const PLACEHOLDER = "Set a name";

/**
 * Pad content to exact visible width.
 */
function padVisible(content: string, targetWidth: number): string {
  const vw = visibleWidth(content);
  const pad = Math.max(0, targetWidth - vw);
  return content + " ".repeat(pad);
}

/**
 * NameBadgeComponent — bordered box HUD overlay showing session name.
 *
 * Renders a proper box with opaque background:
 * ╭──────────╮
 * │   Best   │
 * ╰──────────╯
 */
export class NameBadgeComponent implements Component {
  private name: string | null;
  private theme: Theme | null = null;
  private cachedLines: string[] | null = null;
  private cachedWidth = -1;

  constructor(name: string | null) {
    this.name = name;
  }

  /** Update the displayed name */
  setName(name: string | null): void {
    if (name !== this.name) {
      this.name = name;
      this.invalidate();
    }
  }

  /** Store theme reference for reactive color updates */
  setTheme(theme: Theme): void {
    this.theme = theme;
    this.invalidate();
  }

  /** Clear cached render lines */
  invalidate(): void {
    this.cachedLines = null;
    this.cachedWidth = -1;
  }

  render(width: number): string[] {
    // Return cached if width unchanged
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines = this.renderBadge(width);
    this.cachedLines = lines;
    this.cachedWidth = width;
    return this.cachedLines;
  }

  private renderBadge(width: number): string[] {
    // Determine display text and color
    let displayText: string;
    let fgColor: string;
    if (this.name) {
      displayText = this.name;
      fgColor = "accent";
    } else {
      displayText = PLACEHOLDER;
      fgColor = "muted";
    }

    // Inner padding around text
    const padX = 2;
    // Overhead: left border(1) + right border(1) + padding(padX * 2)
    const overhead = 2 + padX * 2;
    const maxTextWidth = Math.max(1, width - overhead);

    // Truncate name if needed
    if (visibleWidth(displayText) > maxTextWidth) {
      displayText = truncateToWidth(displayText, maxTextWidth - 1, "…");
    }

    const innerWidth = visibleWidth(displayText) + padX * 2;
    const border = (s: string) => this.theme ? this.theme.fg("accent" as any, s) : s;
    const bgFn = (s: string) => this.theme ? this.theme.bg("customMessageBg" as any, s) : s;

    // Build lines with opaque background
    const topLine = bgFn(border("╭" + "─".repeat(innerWidth) + "╮"));
    const padding = " ".repeat(padX);
    const nameStyled = this.theme
      ? this.theme.fg(fgColor as any, displayText)
      : displayText;
    const contentLine = bgFn(border("│") + padding + nameStyled + padding + border("│"));
    const bottomLine = bgFn(border("╰" + "─".repeat(innerWidth) + "╯"));

    return [topLine, contentLine, bottomLine];
  }
}
