/**
 * @pi-unipi/updater — Markdown terminal renderer
 *
 * Renders markdown to terminal-formatted strings using the full
 * Markdown component from pi-tui with theme-aware styling.
 */

import { Markdown } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * Render markdown text to terminal-formatted lines.
 *
 * Uses pi-tui's Markdown component with syntax highlighting,
 * proper list nesting, tables, etc.
 *
 * @param text - Markdown text to render
 * @param width - Available width for rendering
 * @param theme - Theme for styled rendering
 * @returns Array of rendered terminal lines
 */
export function renderMarkdown(text: string, width: number, theme: Theme): string[] {
  const mdTheme = getMarkdownTheme();
  const md = new Markdown(text, 1, 0, mdTheme);
  return md.render(width);
}
