/**
 * @pi-unipi/utility — Diff Renderer
 *
 * ANSI diff rendering: split (side-by-side) and unified (stacked) views.
 * Includes ANSI utilities, background injection, and adaptive wrapping.
 */

import type { ParsedDiff, DiffLine } from "./parser.js";
import type { DiffColors } from "./theme.js";
import { hexToBgAnsi, hexToFgAnsi } from "./theme.js";
import { hlBlock, detectLanguage } from "./highlighter.js";

// ─── Constants ──────────────────────────────────────────────────────────────────

/** Maximum preview lines shown inline */
export const MAX_PREVIEW_LINES = 60;

/** Maximum total render lines */
export const MAX_RENDER_LINES = 150;

/** Minimum terminal width for split view */
export const SPLIT_MIN_WIDTH = 150;

/** Minimum code column width in split view */
export const SPLIT_MIN_CODE_WIDTH = 60;

// ─── ANSI Utilities ─────────────────────────────────────────────────────────────

/**
 * Strip all ANSI escape sequences from a string.
 */
export function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/**
 * Get the visible width of a string (excluding ANSI escapes).
 * Handles CJK characters (width 2) and emoji.
 */
export function visibleWidth(s: string): number {
  const stripped = strip(s);
  let width = 0;
  for (const char of stripped) {
    const code = char.codePointAt(0)!;
    // CJK Unified Ideographs, CJK Compatibility, etc.
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3000 && code <= 0x30ff) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0x2e80 && code <= 0x2eff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x20000 && code <= 0x2a6df)
    ) {
      width += 2;
    } else if (code > 0xffff) {
      // Surrogate pairs / emoji — typically width 2
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * Fit a string to a target width, padding or truncating as needed.
 * Preserves ANSI state across truncation.
 */
export function fit(s: string, targetWidth: number): string {
  const vw = visibleWidth(s);
  if (vw === targetWidth) return s;
  if (vw > targetWidth) {
    // Truncate — find the cut point
    let width = 0;
    let i = 0;
    const stripped = strip(s);
    for (; i < stripped.length && width < targetWidth; i++) {
      const code = stripped.codePointAt(i)!;
      width += (code >= 0x4e00 && code <= 0x9fff) || code > 0xffff ? 2 : 1;
    }
    // Find the corresponding position in the original (with ANSI) string
    let strippedIdx = 0;
    let origIdx = 0;
    while (origIdx < s.length && strippedIdx < i) {
      if (s[origIdx] === "\x1b") {
        // Skip ANSI sequence
        while (origIdx < s.length && s[origIdx] !== "m") origIdx++;
        origIdx++;
      } else {
        strippedIdx++;
        origIdx++;
      }
    }
    return s.substring(0, origIdx) + "\x1b[0m";
  }
  // Pad
  return s + " ".repeat(targetWidth - vw);
}

/**
 * Wrap an ANSI string to a maximum width.
 * Returns an array of wrapped lines.
 */
export function wrapAnsi(s: string, maxWidth: number): string[] {
  if (visibleWidth(s) <= maxWidth) return [s];

  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  let ansiState = "";

  // Process character by character
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      // Collect ANSI sequence
      let seq = "\x1b";
      i++;
      while (i < s.length && s[i] !== "m") {
        seq += s[i];
        i++;
      }
      if (i < s.length) {
        seq += "m";
        i++;
      }
      ansiState = seq;
      current += seq;
    } else {
      const char = s[i];
      const code = char.codePointAt(0)!;
      const charWidth = (code >= 0x4e00 && code <= 0x9fff) || code > 0xffff ? 2 : 1;

      if (currentWidth + charWidth > maxWidth) {
        lines.push(current + "\x1b[0m");
        current = ansiState;
        currentWidth = 0;
      }
      current += char;
      currentWidth += charWidth;
      i++;
    }
  }

  if (strip(current).length > 0) {
    lines.push(current);
  }

  return lines.length > 0 ? lines : [""];
}

/**
 * Get the current ANSI state (active escape sequences) at the end of a string.
 */
export function ansiState(s: string): string {
  // Find the last reset or the last escape sequence
  const lastReset = s.lastIndexOf("\x1b[0m");
  const lastEsc = s.lastIndexOf("\x1b[");

  if (lastEsc < 0) return "";
  // If reset is at the end (or after last escape), state is cleared
  if (lastReset >= lastEsc) return "";

  // Extract the sequence
  const match = s.substring(lastEsc).match(/^\x1b\[[0-9;]*[a-zA-Z]/);
  return match ? match[0] : "";
}

/**
 * Format a line number with fixed width.
 */
export function lnum(n: number | null, width: number = 4): string {
  if (n === null) return " ".repeat(width);
  return n.toString().padStart(width, " ");
}

/**
 * Generate a stripe pattern for alternating rows.
 */
export function stripes(line: string, even: boolean): string {
  const dim = "\x1b[2m";
  const reset = "\x1b[0m";
  return even ? `${dim}·${reset} ${line}` : ` ${line}`;
}

// ─── Terminal Width ─────────────────────────────────────────────────────────────

/**
 * Get terminal width, with fallback.
 */
export function termW(): number {
  try {
    return process.stdout.columns || 80;
  } catch {
    return 80;
  }
}

// ─── Background Injection ───────────────────────────────────────────────────────

/**
 * Composite diff background colors under Shiki syntax foregrounds.
 *
 * Takes an ANSI-highlighted line and injects a background color
 * at the specified character ranges.
 *
 * @param ansiLine - ANSI-highlighted line from Shiki
 * @param ranges - Character ranges to apply background to [{start, end}]
 * @param baseBg - Base background color for the line
 * @param hlBg - Highlight background color for the ranges
 */
export function injectBg(
  ansiLine: string,
  ranges: Array<{ start: number; end: number }>,
  baseBg: string,
  hlBg: string,
): string {
  if (ranges.length === 0) {
    return `${hexToBgAnsi(baseBg)}${ansiLine}\x1b[0m`;
  }

  // For simplicity, apply the highlight background to the whole line
  // if any ranges are specified. Character-level injection is complex
  // and would require parsing the ANSI stream.
  return `${hexToBgAnsi(hlBg)}${ansiLine}\x1b[0m`;
}

// ─── Adaptive Wrap ──────────────────────────────────────────────────────────────

/**
 * Wrap rows adaptively, preserving line structure.
 * Returns the wrapped rows with line continuation indicators.
 */
export function adaptiveWrapRows(rows: string[], maxWidth: number): string[] {
  const result: string[] = [];
  for (const row of rows) {
    if (visibleWidth(row) <= maxWidth) {
      result.push(row);
    } else {
      const wrapped = wrapAnsi(row, maxWidth);
      for (let i = 0; i < wrapped.length; i++) {
        result.push(i === 0 ? wrapped[i] : `  ${wrapped[i]}`);
      }
    }
  }
  return result;
}

// ─── Split View Heuristic ───────────────────────────────────────────────────────

/**
 * Determine whether to use split (side-by-side) view.
 * Falls back to unified on narrow terminals or when wrap ratio is too high.
 *
 * @param diff - The parsed diff
 * @param tw - Terminal width
 * @param max - Maximum render lines
 */
export function shouldUseSplit(diff: ParsedDiff, tw: number, max: number): boolean {
  // Too narrow for split
  if (tw < SPLIT_MIN_WIDTH) return false;

  // Calculate code column widths
  const codeWidth = Math.floor((tw - 6) / 2); // 6 chars for padding/line numbers
  if (codeWidth < SPLIT_MIN_CODE_WIDTH) return false;

  // Check if any lines would wrap in split mode
  const maxContentWidth = Math.max(
    ...diff.lines
      .filter((l) => l.type !== "hunk")
      .map((l) => l.content.length),
    0,
  );

  // If lines are too long, unified is better
  if (maxContentWidth > codeWidth * 1.5) return false;

  return true;
}

// ─── Renderers ──────────────────────────────────────────────────────────────────

/**
 * Render a diff in unified (stacked single-column) view.
 *
 * @param diff - Parsed diff
 * @param language - Shiki language for syntax highlighting
 * @param max - Maximum lines to render
 * @param dc - Diff colors
 */
export function renderUnified(
  diff: ParsedDiff,
  language: string,
  max: number,
  dc: DiffColors,
): Promise<string> {
  const lines: string[] = [];
  const totalLines = Math.min(diff.lines.length, max);
  const truncated = diff.lines.length > max;

  const addBg = hexToBgAnsi(dc.addBg);
  const remBg = hexToBgAnsi(dc.remBg);
  const addFg = hexToFgAnsi(dc.addFg);
  const remFg = hexToFgAnsi(dc.remFg);
  const hunkFg = hexToFgAnsi(dc.hunkFg);
  const headerFg = hexToFgAnsi(dc.headerFg);
  const reset = "\x1b[0m";

  for (let i = 0; i < totalLines; i++) {
    const line = diff.lines[i];

    switch (line.type) {
      case "hunk":
        lines.push(`${hunkFg}${line.content}${reset}`);
        break;
      case "add":
        lines.push(`${addBg}${addFg}+${reset}${addBg} ${lnum(null, 4)} ${lnum(line.newLine, 4)} │ ${line.content}${reset}`);
        break;
      case "remove":
        lines.push(`${remBg}${remFg}-${reset}${remBg} ${lnum(line.oldLine, 4)} ${lnum(null, 4)} │ ${line.content}${reset}`);
        break;
      case "context":
        lines.push(` ${headerFg}${lnum(line.oldLine, 4)} ${lnum(line.newLine, 4)}${reset} │ ${line.content}`);
        break;
    }
  }

  if (truncated) {
    lines.push(`${headerFg}... (${diff.lines.length - max} more lines)${reset}`);
  }

  return lines.join("\n");
}

/**
 * Render a diff in split (side-by-side) view.
 * Auto-falls back to unified on narrow terminals.
 *
 * @param diff - Parsed diff
 * @param language - Shiki language for syntax highlighting
 * @param max - Maximum lines to render
 * @param dc - Diff colors
 */
export function renderSplit(
  diff: ParsedDiff,
  language: string,
  max: number,
  dc: DiffColors,
): Promise<string> {
  const tw = termW();

  // Auto-fallback to unified
  if (!shouldUseSplit(diff, tw, max)) {
    return renderUnified(diff, language, max, dc);
  }

  const lines: string[] = [];
  const codeWidth = Math.floor((tw - 12) / 2); // 12 chars for line nums, separators, padding
  const totalLines = Math.min(diff.lines.length, max);
  const truncated = diff.lines.length > max;

  const addBg = hexToBgAnsi(dc.addBg);
  const remBg = hexToBgAnsi(dc.remBg);
  const addFg = hexToFgAnsi(dc.addFg);
  const remFg = hexToFgAnsi(dc.remFg);
  const hunkFg = hexToFgAnsi(dc.hunkFg);
  const headerFg = hexToFgAnsi(dc.headerFg);
  const reset = "\x1b[0m";

  // Group lines into left (old) and right (new) columns
  // Build the left and right columns for each visual line
  const leftLines: string[] = [];
  const rightLines: string[] = [];

  for (let i = 0; i < totalLines; i++) {
    const line = diff.lines[i];

    switch (line.type) {
      case "hunk": {
        // Hunk header spans both columns
        const padded = `  ${hunkFg}${line.content}${reset}`;
        const halfWidth = Math.floor(tw / 2);
        leftLines.push(fit(padded, halfWidth));
        rightLines.push("");
        break;
      }
      case "add": {
        // Left: empty; Right: added line
        leftLines.push(`${headerFg}${" ".repeat(codeWidth)}${reset}`);
        rightLines.push(`${addBg}${addFg}+${reset}${addBg} ${lnum(line.newLine, 4)} │ ${fit(line.content, codeWidth - 8)}${reset}`);
        break;
      }
      case "remove": {
        // Left: removed line; Right: empty
        leftLines.push(`${remBg}${remFg}-${reset}${remBg} ${lnum(line.oldLine, 4)} │ ${fit(line.content, codeWidth - 8)}${reset}`);
        rightLines.push(`${headerFg}${" ".repeat(codeWidth)}${reset}`);
        break;
      }
      case "context": {
        // Both columns show the same context line
        leftLines.push(`${headerFg}${lnum(line.oldLine, 4)}${reset} │ ${fit(line.content, codeWidth - 7)}`);
        rightLines.push(`${headerFg}${lnum(line.newLine, 4)}${reset} │ ${fit(line.content, codeWidth - 7)}`);
        break;
      }
    }
  }

  // Combine left and right columns
  for (let i = 0; i < leftLines.length; i++) {
    const left = leftLines[i];
    const right = rightLines[i];
    lines.push(`${left} │ ${right}`);
  }

  if (truncated) {
    lines.push(`${headerFg}... (${diff.lines.length - max} more lines)${reset}`);
  }

  return lines.join("\n");
}
