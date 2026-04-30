/**
 * @pi-unipi/footer — Status extension segment
 *
 * Segment renderer for extension statuses from footerData.
 */

import type { FooterSegment, FooterSegmentContext, RenderedSegment } from "../types.js";
import { applyColor } from "../rendering/theme.js";
import { getIcon } from "../rendering/icons.js";

function withIcon(segmentId: string, text: string): string {
  const icon = getIcon(segmentId);
  return icon ? `${icon} ${text}` : text;
}

function renderExtensionStatusesSegment(ctx: FooterSegmentContext): RenderedSegment {
  const footerData = ctx.footerData as any;
  if (!footerData || typeof footerData.getExtensionStatuses !== "function") {
    return { content: "", visible: false };
  }

  const statuses = footerData.getExtensionStatuses() as Map<string, string>;
  if (!statuses || statuses.size === 0) return { content: "", visible: false };

  // Collect compact status strings, skip empty ones
  const parts: string[] = [];
  for (const value of statuses.values()) {
    if (value && value.trim()) {
      // Strip ANSI codes for compact display, keep visible text
      const stripped = value.replace(/\x1b\[[0-9;]*m/g, "").trim();
      if (stripped) {
        parts.push(stripped);
      }
    }
  }

  if (parts.length === 0) return { content: "", visible: false };

  const content = parts.join(" · ");
  return { content, visible: true };
}

export const STATUS_EXT_SEGMENTS: FooterSegment[] = [
  { id: "extension_statuses", label: "Extensions", icon: "", render: renderExtensionStatusesSegment, defaultShow: true },
];
