/**
 * @pi-unipi/footer — Memory segments
 *
 * Segment renderers for the memory group: project_count, total_count, consolidations.
 * Data sourced from MEMORY_STORED/DELETED/CONSOLIDATED events via registry cache.
 */

import type { FooterSegment, FooterSegmentContext, RenderedSegment } from "../types.js";
import { applyColor } from "../rendering/theme.js";
import { getIcon } from "../rendering/icons.js";

function withIcon(segmentId: string, text: string): string {
  const icon = getIcon(segmentId);
  return icon ? `${icon} ${text}` : text;
}

function getMemoryData(ctx: FooterSegmentContext): Record<string, unknown> {
  const data = ctx.data;
  if (!data || typeof data !== "object") return {};
  return data as Record<string, unknown>;
}

function renderProjectCountSegment(ctx: FooterSegmentContext): RenderedSegment {
  const data = getMemoryData(ctx);
  const value = data.projectCount ?? "—";
  const content = withIcon("projectCount", `${value}`);
  return { content: applyColor("memory", content, ctx.theme, ctx.colors), visible: true };
}

function renderTotalCountSegment(ctx: FooterSegmentContext): RenderedSegment {
  const data = getMemoryData(ctx);
  const value = data.totalCount ?? "—";
  const content = withIcon("totalCount", `${value}`);
  return { content: applyColor("memory", content, ctx.theme, ctx.colors), visible: true };
}

function renderConsolidationsSegment(ctx: FooterSegmentContext): RenderedSegment {
  const data = getMemoryData(ctx);
  const lastConsolidated = data.lastConsolidated as Record<string, unknown> | undefined;
  const count = lastConsolidated?.count ?? "—";
  const content = withIcon("consolidations", `${count}`);
  return { content: applyColor("memory", content, ctx.theme, ctx.colors), visible: true };
}

export const MEMORY_SEGMENTS: FooterSegment[] = [
  { id: "project_count", label: "Project Count", icon: "", render: renderProjectCountSegment, defaultShow: true },
  { id: "total_count", label: "Total Count", icon: "", render: renderTotalCountSegment, defaultShow: true },
  { id: "consolidations", label: "Consolidations", icon: "", render: renderConsolidationsSegment, defaultShow: false },
];
