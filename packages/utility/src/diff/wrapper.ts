/**
 * @pi-unipi/utility — Diff Tool Wrapper
 *
 * Wraps the default Pi write/edit tools with Shiki-powered diff rendering.
 * When enabled, enhanced tools are registered that:
 * 1. Read old content before write
 * 2. Delegate to the original tool
 * 3. Compute diff
 * 4. Store diff in result.details for async rendering
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ToolDefinition, AgentToolResult } from "@mariozechner/pi-coding-agent";
import { visibleWidth as piVisibleWidth, truncateToWidth as piTruncateToWidth } from "@mariozechner/pi-tui";
import { readDiffSettings } from "./settings.js";
import { parseDiff } from "./parser.js";
import { resolveDiffColors, applyDiffPalette } from "./theme.js";
import { renderSplit, renderUnified, termW, SPLIT_MIN_WIDTH, truncateToTermWidth } from "./renderer.js";
import { detectLanguageFromPath, hlBlock, MAX_HL_CHARS } from "./highlighter.js";

// ─── Types ──────────────────────────────────────────────────────────────────────

/** Extended tool result with diff data */
interface DiffToolDetails {
  /** Old file content (null for new files) */
  oldContent: string | null;
  /** New file content */
  newContent: string;
  /** Parsed diff */
  diff: ReturnType<typeof parseDiff>;
  /** File path */
  filePath: string;
  /** Detected language */
  language: string;
}

/** Edit operation from the edit tool */
export interface EditOperation {
  oldText: string;
  newText: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Normalize edit tool input to get the list of edit operations.
 * Handles both single-edit and multi-edit parameter formats.
 */
export function getEditOperations(input: any): EditOperation[] {
  if (Array.isArray(input?.edits)) {
    return input.edits.map((e: any) => ({
      oldText: e.oldText ?? e.old_text ?? "",
      newText: e.newText ?? e.new_text ?? "",
    }));
  }
  if (input?.oldText !== undefined || input?.old_text !== undefined) {
    return [{
      oldText: input.oldText ?? input.old_text ?? "",
      newText: input.newText ?? input.new_text ?? "",
    }];
  }
  return [];
}

/**
 * Summarize edit operations into aggregate diff stats.
 */
export function summarizeEditOperations(operations: EditOperation[]): {
  totalEdits: number;
  totalAdditions: number;
  totalDeletions: number;
} {
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const op of operations) {
    const oldLines = op.oldText.split("\n");
    const newLines = op.newText.split("\n");
    totalDeletions += oldLines.length;
    totalAdditions += newLines.length;
  }

  return {
    totalEdits: operations.length,
    totalAdditions,
    totalDeletions,
  };
}

/**
 * Read file content safely. Returns null if file doesn't exist.
 */
function readFileSafe(filePath: string): string | null {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf-8");
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

// ─── Tool Registration ──────────────────────────────────────────────────────────

/**
 * Register the enhanced write tool that wraps the default with diff rendering.
 */
export function registerEnhancedWriteTool(pi: ExtensionAPI, cwd: string): void {
  // We need to re-register a tool with the same name "write" to override it.
  // The approach: register our own tool that reads old content, writes the file,
  // computes the diff, and stores it for rendering.

  pi.registerTool({
    name: "write",
    label: "Write File",
    description: "Write content to a file at the given path. Creates parent directories if needed. Shows a syntax-highlighted diff of the changes.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to write" },
        content: { type: "string", description: "Content to write to the file" },
      },
      required: ["path", "content"],
    } as any,
    async execute(toolCallId: string, params: any, signal: any, _onUpdate: any, _ctx: any): Promise<any> {
      const { path: filePath, content } = params;
      const absolutePath = path.resolve(cwd, filePath);
      const dir = path.dirname(absolutePath);

      // Read old content before write
      const oldContent = readFileSafe(absolutePath);

      // Write the file
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(absolutePath, content, "utf-8");

      // Compute diff
      const language = detectLanguageFromPath(filePath);
      const diff = parseDiff(oldContent ?? "", content, 3, filePath, filePath);

      return {
        content: [
          { type: "text", text: `Successfully wrote ${content.length} bytes to ${filePath}` },
        ],
        details: {
          oldContent,
          newContent: content,
          diff,
          filePath,
          language,
        } as DiffToolDetails,
      };
    },
    renderResult(result: any, _options: any, theme: any): any {
      const details = result?.details as DiffToolDetails | undefined;
      if (!details || !details.diff || !details.diff.lines || details.diff.lines.length === 0) {
        // Error or empty-diff case: render the message from result.content so the
        // user sees "Could not find text to replace..." etc. Never return null here
        // because Container.render() will crash on null child.
        const msg = result?.content?.[0]?.text ?? "";
        return {
          setText: () => {},
          text: msg,
          render: (width: number) => (width > 0 ? [msg.slice(0, width)] : [msg]),
        } as any;
      }

      try {
        const dc = resolveDiffColors(theme);
        const tw = termW();
        const max = 60;

        const rendered: string = tw >= SPLIT_MIN_WIDTH
          ? renderSplit(details.diff, details.language, max, dc)
          : renderUnified(details.diff, details.language, max, dc);

        // Split into lines and cache for width-aware rendering.
        // Each line is already truncated to terminal width by
        // truncateToTermWidth() in the renderer, but we also
        // respect the width parameter from Box.render().
        const cachedLines = rendered.split("\n");

        return {
          setText: () => {},
          text: rendered,
          render: (width: number) => {
            // If width is provided, re-truncate lines that
            // still exceed it (e.g., inside nested Boxes)
            const maxW = width > 0 ? width : tw;
            return cachedLines.map((line: string) => {
              if (piVisibleWidth(line) > maxW) {
                return piTruncateToWidth(line, maxW, "…");
              }
              return line;
            });
          },
        } as any;
      } catch {
        return null as any;
      }
    },
  });
}

/**
 * Register the enhanced edit tool that wraps the default with diff rendering.
 */
export function registerEnhancedEditTool(pi: ExtensionAPI, cwd: string): void {
  pi.registerTool({
    name: "edit",
    label: "Edit File",
    description: "Edit a file by replacing text. Shows a syntax-highlighted diff of the changes.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to edit" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string", description: "Text to replace" },
              newText: { type: "string", description: "Replacement text" },
            },
            required: ["oldText", "newText"],
          },
          description: "Array of edit operations",
        },
      },
      required: ["path", "edits"],
    } as any,
    async execute(toolCallId: string, params: any, signal: any, _onUpdate: any, _ctx: any): Promise<any> {
      const { path: filePath, edits } = params;
      const absolutePath = path.resolve(cwd, filePath);

      // Read old content
      const oldContent = readFileSafe(absolutePath);
      if (oldContent === null) {
        return {
          content: [{ type: "text", text: `Error: File not found: ${filePath}` }],
          details: undefined,
          isError: true,
        };
      }

      // Apply edits
      let newContent = oldContent;
      const operations = getEditOperations(params);
      for (const op of operations) {
        const idx = newContent.indexOf(op.oldText);
        if (idx === -1) {
          return {
            content: [{ type: "text", text: `Error: Could not find text to replace in ${filePath}` }],
            details: undefined,
            isError: true,
          };
        }
        newContent = newContent.substring(0, idx) + op.newText + newContent.substring(idx + op.oldText.length);
      }

      // Write the modified content
      fs.writeFileSync(absolutePath, newContent, "utf-8");

      // Compute diff
      const language = detectLanguageFromPath(filePath);
      const diff = parseDiff(oldContent, newContent, 3, filePath, filePath);
      const summary = summarizeEditOperations(operations);

      return {
        content: [
          { type: "text", text: `Successfully edited ${filePath} (${summary.totalEdits} edit${summary.totalEdits !== 1 ? "s" : ""})` },
        ],
        details: {
          oldContent,
          newContent,
          diff,
          filePath,
          language,
        } as DiffToolDetails,
      };
    },
    renderResult(result: any, _options: any, theme: any): any {
      const details = result?.details as DiffToolDetails | undefined;
      if (!details || !details.diff || !details.diff.lines || details.diff.lines.length === 0) {
        return null as any;
      }

      try {
        const dc = resolveDiffColors(theme);
        const tw = termW();
        const max = 60;

        const rendered: string = tw >= SPLIT_MIN_WIDTH
          ? renderSplit(details.diff, details.language, max, dc)
          : renderUnified(details.diff, details.language, max, dc);

        const cachedLines = rendered.split("\n");

        return {
          setText: () => {},
          text: rendered,
          render: (width: number) => {
            const maxW = width > 0 ? width : tw;
            return cachedLines.map((line: string) => {
              if (piVisibleWidth(line) > maxW) {
                return piTruncateToWidth(line, maxW, "…");
              }
              return line;
            });
          },
        } as any;
      } catch {
        return null as any;
      }
    },
  });
}
