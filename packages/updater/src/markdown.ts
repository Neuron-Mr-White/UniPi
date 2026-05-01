/**
 * @pi-unipi/updater — Markdown terminal renderer
 *
 * Renders markdown to terminal-formatted strings.
 * When a Theme is provided, uses the full Markdown component from pi-tui
 * with theme-aware styling. Falls back to simple ANSI rendering otherwise.
 */

import { Markdown } from "@mariozechner/pi-tui";
import type { MarkdownTheme } from "@mariozechner/pi-tui";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";

/**
 * Render markdown text to terminal-formatted lines.
 *
 * When a Theme is provided, uses the full Markdown component from pi-tui
 * with syntax highlighting, proper list nesting, tables, etc.
 *
 * @param text - Markdown text to render
 * @param width - Available width for rendering
 * @param theme - Optional Theme for styled rendering
 * @returns Array of rendered terminal lines
 */
export function renderMarkdown(text: string, width: number, theme?: Theme): string[] {
  if (theme) {
    return renderWithTheme(text, width, theme);
  }
  return renderSimple(text, width);
}

/**
 * Render using the full Markdown component with theme support.
 */
function renderWithTheme(text: string, width: number, theme: Theme): string[] {
  const mdTheme = getMarkdownTheme();
  const md = new Markdown(text, 1, 0, mdTheme);
  return md.render(width);
}

/**
 * Simple fallback renderer using basic ANSI codes.
 * Used when no Theme is available.
 */

/** ANSI escape codes */
const ESC = "\x1b";
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const UNDERLINE = `${ESC}[4m`;
const RESET = `${ESC}[0m`;

/** Wrap text in ANSI formatting */
function fmt(code: string, text: string): string {
  return `${code}${text}${RESET}`;
}

/** Word-wrap a line to fit within width */
function wordWrap(line: string, width: number): string[] {
  // Strip ANSI for length calculation but preserve in output
  const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
  if (stripped.length <= width) return [line];

  const words = line.split(/(\s+)/);
  const result: string[] = [];
  let currentLine = "";
  let currentWidth = 0;

  for (const word of words) {
    const wordWidth = word.replace(/\x1b\[[0-9;]*m/g, "").length;
    if (currentWidth + wordWidth > width && currentLine) {
      result.push(currentLine);
      currentLine = word.trimStart();
      currentWidth = currentLine.replace(/\x1b\[[0-9;]*m/g, "").length;
    } else {
      currentLine += word;
      currentWidth += wordWidth;
    }
  }
  if (currentLine) result.push(currentLine);
  return result.length > 0 ? result : [""];
}

/** Apply inline formatting: bold, italic, code, links */
function formatInline(text: string): string {
  // Inline code: `code`
  text = text.replace(/`([^`]+)`/g, (_, code) => fmt(DIM, code));

  // Bold: **text**
  text = text.replace(/\*\*([^*]+)\*\*/g, (_, bold) => fmt(BOLD, bold));

  // Italic: *text*
  text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, italic) => fmt(UNDERLINE, italic));

  // Links: [text](url) → underlined text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, (_, linkText) => fmt(UNDERLINE, linkText));

  return text;
}

/**
 * Simple markdown renderer (fallback).
 */
function renderSimple(text: string, width: number): string[] {
  const lines = text.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Code fence toggle
    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    // Inside code block — dim, no formatting
    if (inCodeBlock) {
      const formatted = fmt(DIM, line);
      result.push(...wordWrap(formatted, width));
      continue;
    }

    // Heading: #, ##, ###
    if (trimmed.startsWith("### ")) {
      const heading = trimmed.slice(4);
      const formatted = fmt(BOLD + UNDERLINE, heading);
      result.push(...wordWrap(formatted, width));
      continue;
    }
    if (trimmed.startsWith("## ")) {
      const heading = trimmed.slice(3);
      const formatted = fmt(BOLD, heading);
      result.push(...wordWrap(formatted, width));
      continue;
    }
    if (trimmed.startsWith("# ")) {
      const heading = trimmed.slice(2);
      const formatted = fmt(BOLD, heading);
      result.push(...wordWrap(formatted, width));
      continue;
    }

    // Bullet list: - or *
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      const content = trimmed.slice(2);
      const formatted = "  • " + formatInline(content);
      result.push(...wordWrap(formatted, width));
      continue;
    }

    // Numbered list: 1. 2. etc.
    const numberMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (numberMatch) {
      const formatted = `  ${numberMatch[1]}. ${formatInline(numberMatch[2])}`;
      result.push(...wordWrap(formatted, width));
      continue;
    }

    // Empty line — preserve spacing
    if (!trimmed) {
      result.push("");
      continue;
    }

    // Regular paragraph — apply inline formatting
    const formatted = formatInline(trimmed);
    result.push(...wordWrap(formatted, width));
  }

  return result;
}
