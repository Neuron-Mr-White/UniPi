/**
 * @pi-unipi/footer — Footer help overlay
 *
 * Shows an overlay listing all enabled segments grouped by zone,
 * with icons, short labels, and descriptions.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { FooterSegment, SegmentZone } from "./types.js";
import { getIcon } from "./rendering/icons.js";
import { loadFooterSettings, isSegmentEnabled } from "./config.js";
import { getPreset } from "./presets.js";

/** Zone display names and order */
const ZONE_META: Record<SegmentZone, { title: string; order: number }> = {
  left: { title: "LEFT ZONE (Identity)", order: 0 },
  center: { title: "CENTER ZONE (Metrics)", order: 1 },
  right: { title: "RIGHT ZONE (Time)", order: 2 },
};

/** Build the help content lines */
function buildHelpLines(
  segments: FooterSegment[],
  presetName: string,
): string[] {
  const settings = loadFooterSettings();
  const preset = getPreset(presetName);
  const enabledIds = new Set([
    ...preset.leftSegments,
    ...preset.rightSegments,
    ...preset.secondarySegments,
  ]);

  // Filter to enabled segments only
  const enabled = segments.filter(seg => {
    if (!enabledIds.has(seg.id)) return false;
    return isSegmentEnabled(getGroupForSegment(seg.id), seg.id);
  });

  if (enabled.length === 0) {
    return ["No segments enabled."];
  }

  // Group by zone
  const zones: Record<SegmentZone, FooterSegment[]> = { left: [], center: [], right: [] };
  for (const seg of enabled) {
    zones[seg.zone].push(seg);
  }

  const lines: string[] = [];

  for (const zoneKey of (["left", "center", "right"] as SegmentZone[])) {
    const zoneSegs = zones[zoneKey];
    if (zoneSegs.length === 0) continue;

    const meta = ZONE_META[zoneKey];
    lines.push(`  ${meta.title}`);
    lines.push("");

    for (const seg of zoneSegs) {
      const icon = getIcon(seg.id);
      const label = seg.shortLabel;
      const desc = seg.description;
      const iconStr = icon ? `${icon} ` : "  ";
      lines.push(`    ${iconStr}${label.padEnd(6)} ${desc}`);
    }

    lines.push("");
  }

  return lines;
}

/** Simple group lookup for help */
function getGroupForSegment(segId: string): string {
  const coreIds = ["model", "api_state", "tool_count", "git", "context_pct", "cost", "tokens_total", "tokens_in", "tokens_out", "session", "hostname", "time", "tps", "clock", "duration", "thinking_level"];
  if (coreIds.includes(segId)) return "core";
  const compactorIds = ["session_events", "compactions", "tokens_saved", "compression_ratio", "indexed_docs", "sandbox_runs", "search_queries"];
  if (compactorIds.includes(segId)) return "compactor";
  if (["project_count", "total_count", "consolidations"].includes(segId)) return "memory";
  if (["servers_total", "servers_active", "tools_total", "servers_failed"].includes(segId)) return "mcp";
  if (["active_loops", "total_iterations", "loop_status"].includes(segId)) return "ralph";
  if (["current_command", "sandbox_level", "command_duration"].includes(segId)) return "workflow";
  if (["docs_count", "tasks_done", "tasks_total", "task_pct"].includes(segId)) return "kanboard";
  if (["platforms_enabled", "last_sent"].includes(segId)) return "notify";
  if (segId === "extension_statuses") return "status_ext";
  return "core";
}

/**
 * Show the footer help overlay.
 * Lists all enabled segments grouped by zone with descriptions.
 */
export function showFooterHelp(
  pi: ExtensionAPI,
  segments: FooterSegment[],
  presetName: string,
): void {
  const lines = buildHelpLines(segments, presetName);

  // Use pi's custom UI overlay
  const ctx = (pi as any)._ctx;
  if (ctx?.ui?.custom) {
    ctx.ui.custom((tui: any) => {
      let scrollOffset = 0;

      return {
        dispose() {},
        render(width: number, height: number): string[] {
          const maxVisible = height - 2; // border lines
          const visibleLines = lines.slice(scrollOffset, scrollOffset + maxVisible);

          const result: string[] = [];

          // Top border
          const title = " ? Footer Segment Guide ";
          const borderLen = Math.max(width - 2, title.length + 4);
          result.push(`\x1b[2m┌${"─".repeat(borderLen)}┐\x1b[0m`);

          // Title
          result.push(`\x1b[2m│\x1b[0m \x1b[1m${title}\x1b[0m${" ".repeat(Math.max(0, borderLen - title.length - 1))}\x1b[2m│\x1b[0m`);

          // Content
          for (const line of visibleLines) {
            const padded = line.length > borderLen - 2
              ? line.slice(0, borderLen - 2)
              : line + " ".repeat(Math.max(0, borderLen - 2 - line.length));
            result.push(`\x1b[2m│\x1b[0m ${padded} \x1b[2m│\x1b[0m`);
          }

          // Bottom border
          result.push(`\x1b[2m├${"─".repeat(borderLen)}┤\x1b[0m`);
          result.push(`\x1b[2m│\x1b[0m \x1b[2m↑↓ scroll · q close\x1b[0m${" ".repeat(Math.max(0, borderLen - 20))} \x1b[2m│\x1b[0m`);
          result.push(`\x1b[2m└${"─".repeat(borderLen)}┘\x1b[0m`);

          return result;
        },
        handleInput(key: string): boolean {
          if (key === "q" || key === "Escape" || key === "Enter") {
            return false; // Close overlay
          }
          if (key === "ArrowUp" || key === "k") {
            scrollOffset = Math.max(0, scrollOffset - 1);
            return true;
          }
          if (key === "ArrowDown" || key === "j") {
            scrollOffset = Math.min(Math.max(0, lines.length - 5), scrollOffset + 1);
            return true;
          }
          return true; // Consume all other keys
        },
      };
    });
  } else {
    // Fallback: print to console
    for (const line of lines) {
      console.log(line);
    }
  }
}
