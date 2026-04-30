/**
 * @pi-unipi/footer — MCP segments
 *
 * Segment renderers for the MCP group: servers_total, servers_active,
 * tools_total, servers_failed.
 * Data sourced from MCP_SERVER_STARTED/STOPPED/ERROR events via registry cache.
 */

import type { FooterSegment, FooterSegmentContext, RenderedSegment } from "../types.js";
import { applyColor } from "../rendering/theme.js";
import { getIcon } from "../rendering/icons.js";

function withIcon(segmentId: string, text: string): string {
  const icon = getIcon(segmentId);
  return icon ? `${icon} ${text}` : text;
}

function getMcpData(ctx: FooterSegmentContext): Record<string, unknown> {
  const data = ctx.data;
  if (!data || typeof data !== "object") return {};
  return data as Record<string, unknown>;
}

function renderServersTotalSegment(ctx: FooterSegmentContext): RenderedSegment {
  const data = getMcpData(ctx);
  const value = data.serversTotal ?? "—";
  const content = withIcon("serversTotal", `${value}`);
  return { content: applyColor("mcp", content, ctx.theme, ctx.colors), visible: true };
}

function renderServersActiveSegment(ctx: FooterSegmentContext): RenderedSegment {
  const data = getMcpData(ctx);
  const value = data.serversActive ?? "—";
  const content = withIcon("serversActive", `${value}`);
  return { content: applyColor("mcp", content, ctx.theme, ctx.colors), visible: true };
}

function renderToolsTotalSegment(ctx: FooterSegmentContext): RenderedSegment {
  const data = getMcpData(ctx);
  const value = data.toolsTotal ?? "—";
  const content = withIcon("toolsTotal", `${value}`);
  return { content: applyColor("mcp", content, ctx.theme, ctx.colors), visible: true };
}

function renderServersFailedSegment(ctx: FooterSegmentContext): RenderedSegment {
  const data = getMcpData(ctx);
  const value = data.serversFailed;
  if (!value || value === 0) return { content: "", visible: false };
  const content = withIcon("serversFailed", `${value}`);
  return { content: applyColor("mcp" as any, content, ctx.theme, ctx.colors), visible: true };
}

export const MCP_SEGMENTS: FooterSegment[] = [
  { id: "servers_total", label: "Servers Total", icon: "", render: renderServersTotalSegment, defaultShow: true },
  { id: "servers_active", label: "Servers Active", icon: "", render: renderServersActiveSegment, defaultShow: true },
  { id: "tools_total", label: "Tools Total", icon: "", render: renderToolsTotalSegment, defaultShow: true },
  { id: "servers_failed", label: "Servers Failed", icon: "", render: renderServersFailedSegment, defaultShow: true },
];
