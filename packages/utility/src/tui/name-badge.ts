/**
 * @pi-unipi/utility — Name Badge Component
 *
 * Pure render component for the session name badge overlay.
 * Displays a single-line bordered box with the current session name.
 * Display-only — no input handling, no focus.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";

/** Placeholder text when no session name is set */
const PLACEHOLDER = "Set a name now";

/**
 * NameBadgeComponent — single-line HUD overlay showing session name.
 *
 * Renders: ┌─ {name} ─┐
 * With accent color for the name, muted for placeholder.
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

    const line = this.renderBadge(width);
    this.cachedLines = [line];
    this.cachedWidth = width;
    return this.cachedLines;
  }

  private renderBadge(width: number): string {
    // Build the badge content
    const prefix = "┌─ ";
    const suffix = " ─┐";
    const prefixW = visibleWidth(prefix);
    const suffixW = visibleWidth(suffix);
    const overhead = prefixW + suffixW;

    // Determine display text and color
    let displayText: string;
    let color: string;
    if (this.name) {
      displayText = this.name;
      color = "accent";
    } else {
      displayText = PLACEHOLDER;
      color = "muted";
    }

    // Available space for the name
    const maxNameWidth = Math.max(1, width - overhead);

    // Truncate name if needed
    if (visibleWidth(displayText) > maxNameWidth) {
      displayText = truncateToWidth(displayText, maxNameWidth - 1, "…");
    }

    // Apply theme colors
    const nameStyled = this.theme
      ? this.theme.fg(color as any, displayText)
      : displayText;
    const borderStyled = this.theme
      ? this.theme.fg("border" as any, "┌─ ")
      : "┌─ ";
    const borderEndStyled = this.theme
      ? this.theme.fg("border" as any, " ─┐")
      : " ─┐";

    return `${borderStyled}${nameStyled}${borderEndStyled}`;
  }
}
