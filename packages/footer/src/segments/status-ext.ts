/**
 * @pi-unipi/footer — Status extension segment
 *
 * Renders extension status entries from footerData.getExtensionStatuses().
 * Uses the configured separator between entries and the current icon style.
 *
 * Status keys from packages:
 *   "unipi-workflow" → "⚡ wf:brainstorm ✓ rl"  (active command shown)
 *   "ralph"          → "rl:loop-name 3/50"
 *   "unipi-memory"   → "⚡ MEM 75p/101all"
 *   "subagents"      → various
 */

import type { FooterSegment, FooterSegmentContext, RenderedSegment } from "../types.js";
import { getIcon } from "../rendering/icons.js";
import { loadFooterSettings } from "../config.js";
import { getSeparator } from "../rendering/separators.js";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

/** Map status keys to short display names and segment IDs for icons */
const STATUS_DISPLAY: Record<string, { short: string; segmentId: string }> = {
  "unipi-workflow": { short: "WF", segmentId: "currentCommand" },
  workflow: { short: "WF", segmentId: "currentCommand" },
  ralph: { short: "RL", segmentId: "activeLoops" },
  memory: { short: "MEM", segmentId: "projectCount" },
  compactor: { short: "CMP", segmentId: "compactions" },
  mcp: { short: "MCP", segmentId: "serversTotal" },
  notify: { short: "NTF", segmentId: "platformsEnabled" },
  kanboard: { short: "KB", segmentId: "docsCount" },
  info: { short: "INF", segmentId: "extensionStatuses" },
  subagents: { short: "SA", segmentId: "extensionStatuses" },
};

/** Get the separator character for the current settings */
function getStatusSeparator(): string {
  const settings = loadFooterSettings();
  const sepDef = getSeparator(settings.separator);
  return sepDef.left;
}

/**
 * Strip any leading emoji/symbol from a status value.
 * The packages set their own icons (⚡, 🔄, 📝, ○, ✓) which we replace
 * with our own based on the configured icon style.
 */
function stripLeadingSymbol(value: string): string {
  // Remove common emoji/symbol prefixes (1-2 chars + optional space)
  return value.replace(/^[\u2600-\u27BF\u2300-\u23FF\u2B50\u25CF\u25CB\u25B6\u23F3\u26A1\u{1F300}-\u{1F9FF}]\s*/u, "");
}

/**
 * Clean up a status value by stripping the package name prefix
 * and existing icons, returning just the meaningful content.
 */
function cleanStatusValue(key: string, value: string): string {
  // First strip any leading emoji/symbol
  let cleaned = stripLeadingSymbol(value);

  // Strip known package name prefixes
  const namePatterns: Record<string, RegExp> = {
    "unipi-workflow": /^wf:?\s*/i,
    workflow: /^wf:?\s*/i,
    "unipi-memory": /^mem:?\s*/i,
    memory: /^mem:?\s*/i,
    ralph: /^rl:?\s*/i,
  };

  const pattern = namePatterns[key.toLowerCase()];
  if (pattern) {
    cleaned = cleaned.replace(pattern, "");
  }

  return cleaned.trim();
}

function renderExtensionStatusesSegment(ctx: FooterSegmentContext): RenderedSegment {
  const footerData = ctx.footerData as any;
  if (!footerData || typeof footerData.getExtensionStatuses !== "function") {
    return { content: "", visible: false };
  }

  const statuses = footerData.getExtensionStatuses() as Map<string, string>;
  if (!statuses || statuses.size === 0) return { content: "", visible: false };

  const sep = getStatusSeparator();

  // Collect compact status strings with icons
  const parts: string[] = [];
  for (const [key, value] of statuses) {
    if (!value || !value.trim()) continue;

    // Strip ANSI codes for compact display
    const stripped = value.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!stripped) continue;

    const display = STATUS_DISPLAY[key.toLowerCase()];
    const icon = display
      ? getIcon(display.segmentId)
      : getIcon("extensionStatuses");

    const shortName = display?.short ?? key;
    const extraContent = cleanStatusValue(key, stripped);

    // Format: "icon shortName extraContent" or "icon shortName"
    const part = extraContent
      ? (icon ? `${icon} ${shortName} ${extraContent}` : `${shortName} ${extraContent}`)
      : (icon ? `${icon} ${shortName}` : shortName);
    parts.push(part);
  }

  if (parts.length === 0) return { content: "", visible: false };

  // Clamp total content to terminal width to prevent TUI crash
  const content = parts.join(` ${sep} `);
  const maxW = ctx.width > 0 ? ctx.width : 120;
  if (visibleWidth(content) > maxW) {
    return { content: truncateToWidth(content, maxW, "…"), visible: true };
  }
  return { content, visible: true };
}

export const STATUS_EXT_SEGMENTS: FooterSegment[] = [
  { id: "extension_statuses", label: "Extensions", shortLabel: "EXT", description: "Extension statuses overview", zone: "center", icon: "", render: renderExtensionStatusesSegment, defaultShow: true },
];
