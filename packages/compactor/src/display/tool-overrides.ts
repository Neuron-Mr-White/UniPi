/**
 * Tool override renderers — mode-aware output for built-in tools
 */

import type { OutputMode } from "../types.js";
import { previewLines, countNonEmptyLines, shortenPath } from "./render-utils.js";

export interface ToolOverrideConfig {
  readOutputMode: OutputMode;
  searchOutputMode: OutputMode;
  bashOutputMode: OutputMode;
  previewLines: number;
  bashCollapsedLines: number;
  showTruncationHints: boolean;
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
      return previewLines(content, config.previewLines);
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
      return previewLines(results, config.previewLines);
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
      return previewLines(output, config.bashCollapsedLines);
    default:
      return output;
  }
}
