/**
 * @pi-unipi/utility — Width Management Utilities
 *
 * Safe width clamping, line wrapping, and line collapsing.
 * Handles ANSI escape sequences correctly.
 */

import type { WidthOptions } from "../types.js";

/** ANSI escape sequence regex */
const ANSI_REGEX =
  /\u001b\[[\d;]*[a-zA-Z]|\u001b\][^\u0007]*\u0007|\u001b\[[\d;]*[\u0020-\u002f]*[\u0030-\u007e]/g;

/** Strip ANSI escape sequences from text */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

/** Get visual width of text (excluding ANSI codes) */
export function visualWidth(text: string): number {
  return stripAnsi(text).length;
}

/** Default width options */
const DEFAULT_WIDTH_OPTS: Required<WidthOptions> = {
  ellipsis: "…",
  breakWords: false,
};

/**
 * Clamp text to maxWidth visual characters.
 * Preserves ANSI sequences at the end of truncated text.
 */
export function clampWidth(
  text: string,
  maxWidth: number,
  options: WidthOptions = {},
): string {
  const opts = { ...DEFAULT_WIDTH_OPTS, ...options };
  const plain = stripAnsi(text);

  if (plain.length <= maxWidth) {
    return text;
  }

  // Need to truncate while preserving ANSI
  const ellipsisWidth = visualWidth(opts.ellipsis);
  const targetWidth = maxWidth - ellipsisWidth;

  if (targetWidth <= 0) {
    return opts.ellipsis.slice(0, maxWidth);
  }

  // Walk through text, tracking ANSI state
  let visualCount = 0;
  let result = "";
  let inAnsi = false;
  let ansiBuffer = "";

  for (const char of text) {
    if (char === "\u001b") {
      inAnsi = true;
      ansiBuffer = char;
      continue;
    }

    if (inAnsi) {
      ansiBuffer += char;
      // Check if ANSI sequence is complete
      if (/[a-zA-Z\u0007]/.test(char) || (ansiBuffer.startsWith("\u001b]") && char === "\u0007")) {
        inAnsi = false;
        result += ansiBuffer;
        ansiBuffer = "";
      }
      continue;
    }

    if (visualCount < targetWidth) {
      result += char;
      visualCount++;
    } else {
      break;
    }
  }

  // Add any pending ANSI sequences and reset
  if (ansiBuffer) {
    result += ansiBuffer;
  }
  result += "\u001b[0m"; // Reset ANSI
  result += opts.ellipsis;

  return result;
}

/**
 * Wrap text into lines of maxWidth visual characters.
 * Respects word boundaries unless breakWords is true.
 */
export function wrapLines(
  text: string,
  maxWidth: number,
  options: WidthOptions = {},
): string[] {
  const opts = { ...DEFAULT_WIDTH_OPTS, ...options };
  const lines: string[] = [];
  const paragraphs = text.split("\n");

  for (const paragraph of paragraphs) {
    if (visualWidth(paragraph) <= maxWidth) {
      lines.push(paragraph);
      continue;
    }

    const words = paragraph.split(/(\s+)/);
    let currentLine = "";
    let currentWidth = 0;

    for (const word of words) {
      const wordWidth = visualWidth(word);

      if (wordWidth === 0) {
        // Whitespace-only word
        currentLine += word;
        continue;
      }

      if (currentWidth + wordWidth > maxWidth) {
        if (currentLine) {
          lines.push(currentLine);
          currentLine = "";
          currentWidth = 0;
        }

        // Word itself might be longer than maxWidth
        if (!opts.breakWords && wordWidth > maxWidth) {
          // Break the long word
          let remaining = word;
          while (visualWidth(remaining) > maxWidth) {
            let chunk = "";
            let chunkWidth = 0;
            for (const char of remaining) {
              const charWidth = visualWidth(char);
              if (chunkWidth + charWidth > maxWidth) {
                break;
              }
              chunk += char;
              chunkWidth += charWidth;
            }
            lines.push(chunk);
            remaining = remaining.slice(chunk.length);
          }
          if (remaining) {
            currentLine = remaining;
            currentWidth = visualWidth(remaining);
          }
        } else {
          currentLine = word;
          currentWidth = wordWidth;
        }
      } else {
        currentLine += word;
        currentWidth += wordWidth;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }
  }

  return lines;
}

/**
 * Collapse consecutive empty lines down to maxEmpty.
 */
export function collapseLines(
  lines: string[],
  maxEmpty: number = 1,
): string[] {
  const result: string[] = [];
  let emptyCount = 0;

  for (const line of lines) {
    const isEmpty = stripAnsi(line).trim().length === 0;

    if (isEmpty) {
      emptyCount++;
      if (emptyCount <= maxEmpty) {
        result.push(line);
      }
    } else {
      emptyCount = 0;
      result.push(line);
    }
  }

  return result;
}

/**
 * Pad text to target width with spaces.
 * Respects ANSI sequences.
 */
export function padWidth(text: string, targetWidth: number): string {
  const currentWidth = visualWidth(text);
  if (currentWidth >= targetWidth) {
    return text;
  }
  return text + " ".repeat(targetWidth - currentWidth);
}

/**
 * Center text within target width.
 */
export function centerWidth(text: string, targetWidth: number): string {
  const currentWidth = visualWidth(text);
  if (currentWidth >= targetWidth) {
    return text;
  }
  const padding = targetWidth - currentWidth;
  const left = Math.floor(padding / 2);
  const right = padding - left;
  return " ".repeat(left) + text + " ".repeat(right);
}
