/**
 * @pi-unipi/footer — Notify segments
 *
 * Segment renderers for the notify group: platforms_enabled, last_sent.
 * Data sourced from NOTIFICATION_SENT event via registry cache.
 */

import type { FooterSegment, FooterSegmentContext, RenderedSegment } from "../types.js";
import { applyColor } from "../rendering/theme.js";
import { getIcon } from "../rendering/icons.js";

function withIcon(segmentId: string, text: string): string {
  const icon = getIcon(segmentId);
  return icon ? `${icon} ${text}` : text;
}

function getNotifyData(ctx: FooterSegmentContext): Record<string, unknown> {
  const data = ctx.data;
  if (!data || typeof data !== "object") return {};
  return data as Record<string, unknown>;
}

function renderPlatformsEnabledSegment(ctx: FooterSegmentContext): RenderedSegment {
  const data = getNotifyData(ctx);
  const platforms = data.platforms as string[] | undefined;
  if (!platforms || platforms.length === 0) return { content: "", visible: false };

  const content = withIcon("platformsEnabled", platforms.join(","));
  return { content: applyColor("notify", content, ctx.theme, ctx.colors), visible: true };
}

function renderLastSentSegment(ctx: FooterSegmentContext): RenderedSegment {
  const data = getNotifyData(ctx);
  const timestamp = data.timestamp as string | undefined;
  if (!timestamp) return { content: "", visible: false };

  // Show relative time
  const sent = new Date(timestamp);
  const diffMs = Date.now() - sent.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const display = diffMin < 1 ? "just now" : diffMin < 60 ? `${diffMin}m ago` : `${Math.floor(diffMin / 60)}h ago`;

  const content = withIcon("lastSent", display);
  return { content: applyColor("notify", content, ctx.theme, ctx.colors), visible: true };
}

export const NOTIFY_SEGMENTS: FooterSegment[] = [
  { id: "platforms_enabled", label: "Platforms", icon: "", render: renderPlatformsEnabledSegment, defaultShow: true },
  { id: "last_sent", label: "Last Sent", icon: "", render: renderLastSentSegment, defaultShow: true },
];
