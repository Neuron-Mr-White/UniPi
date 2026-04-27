/**
 * Tool override renderers — mode-aware output for built-in tools
 */

import type { OutputMode } from "../types.js";
import { previewLines, countNonEmptyLines, shortenPath } from "./render-utils.js";

export interface ToolOverrideConfig {
  readOutputMode?: OutputMode;
  searchOutputMode?: OutputMode;
  bashOutputMode?: OutputMode;
  previewLines?: number;
  bashCollapsedLines?: number;
  showTruncationHints?: boolean;
}

export function renderReadResult(
  content: string,
  filePath: string,
  config: ToolOverrideConfig,
): string {
  switch (config.readOutputMode) {
    case "hidden":
      return `[Read: ${shortenPath(filePath)}]`;
    case "summary":
      return `[Read: ${shortenPath(filePath)} — ${countNonEmptyLines(content)} lines]`;
    case "preview":
      return previewLines(content, config.previewLines ?? 20);
    default:
      return content;
  }
}

export function renderSearchResult(
  results: string,
  config: ToolOverrideConfig,
): string {
  switch (config.searchOutputMode) {
    case "hidden":
      return `[Search results hidden]`;
    case "count":
      return `[Search: ${countNonEmptyLines(results)} matches]`;
    case "preview":
      return previewLines(results, config.previewLines ?? 20);
    default:
      return results;
  }
}

export function renderBashResult(
  output: string,
  command: string,
  config: ToolOverrideConfig,
): string {
  switch (config.bashOutputMode) {
    case "hidden":
      return `[Bash: ${command.slice(0, 60)}]`;
    case "summary":
      return `[Bash: ${command.slice(0, 60)} — ${countNonEmptyLines(output)} lines]`;
    case "preview":
      return previewLines(output, config.bashCollapsedLines ?? 5);
    default:
      return output;
  }
}

/**
 * Apply display overrides for built-in tool results.
 * Returns modified event result if override applies, undefined otherwise.
 *
 * Call this from the `tool_result` event handler to intercept and transform
 * tool output before it enters the LLM context.
 */
export function applyToolDisplayOverride(
  toolName: string,
  event: Record<string, unknown>,
  config: ToolOverrideConfig,
): { content?: Array<{ type: string; text: string }> } | undefined {
  const content = (event as any).content as Array<{ type: string; text: string }> | undefined;
  if (!content || !Array.isArray(content) || content.length === 0) return undefined;

  const textContent = content[0]?.text ?? "";
  const previewLinesCount = config.previewLines ?? 20;
  const collapsedLines = config.bashCollapsedLines ?? 5;

  let overridden: string | undefined;

  switch (toolName) {
    case "read": {
      const filePath = String((event as any).args?.path ?? "");
      const mode = config.readOutputMode ?? "full";
      if (mode === "hidden") {
        overridden = `[Read: ${shortenPath(filePath)}]`;
      } else if (mode === "summary") {
        overridden = `[Read: ${shortenPath(filePath)} — ${countNonEmptyLines(textContent)} lines]`;
      } else if (mode === "preview") {
        overridden = previewLines(textContent, previewLinesCount);
      }
      break;
    }
    case "grep":
    case "find":
    case "ls": {
      const mode = config.searchOutputMode ?? "full";
      if (mode === "hidden") {
        overridden = `[${toolName} results hidden]`;
      } else if (mode === "count") {
        overridden = `[${toolName}: ${countNonEmptyLines(textContent)} matches]`;
      } else if (mode === "preview") {
        overridden = previewLines(textContent, previewLinesCount);
      }
      break;
    }
    case "bash": {
      const command = String((event as any).args?.command ?? "");
      const mode = config.bashOutputMode ?? "full";
      if (mode === "hidden") {
        overridden = `[Bash: ${command.slice(0, 60)}]`;
      } else if (mode === "summary") {
        overridden = `[Bash: ${command.slice(0, 60)} — ${countNonEmptyLines(textContent)} lines]`;
      } else if (mode === "preview") {
        overridden = previewLines(textContent, collapsedLines);
      }
      break;
    }
    default:
      return undefined;
  }

  if (overridden !== undefined) {
    return {
      content: [{ type: "text", text: overridden }],
    };
  }
  return undefined;
}
