/**
 * @pi-unipi/footer — MCP segments
 *
 * Segment renderers for the MCP group: servers_total, servers_active,
 * tools_total, servers_failed.
 *
 * Data sourced from:
 * 1. globalThis.__unipi_mcp_stats (if available — direct from MCP registry)
 * 2. ctx.data aggregate fields maintained by events.ts handlers
 * 3. Falls back to hidden when no meaningful data is available
 *
 * Never shows "—" — segments hide instead of showing placeholder values.
 */

import type { FooterSegment, FooterSegmentContext, RenderedSegment } from "../types.js";
import { applyColor, mutedPlaceholder } from "../rendering/theme.js";
import { getIcon } from "../rendering/icons.js";
import { isSegmentEnabled } from "../config.js";

/** Shape of aggregate MCP stats from globalThis or registry */
interface McpStats {
  serversTotal?: number;
  serversActive?: number;
  serversFailed?: number;
  toolsTotal?: number;
}

/** Shape of the global escape-hatch object */
interface GlobalMcpStats extends McpStats {}

declare global {
  // eslint-disable-next-line no-var
  var __unipi_mcp_stats: GlobalMcpStats | undefined;
}

function withIcon(segmentId: string, text: string): string {
  const icon = getIcon(segmentId);
  return icon ? `${icon} ${text}` : text;
}

/**
 * Resolve MCP stats from available sources:
 * 1. globalThis.__unipi_mcp_stats (direct from MCP registry)
 * 2. ctx.data aggregate fields (maintained by events.ts)
 */
function getMcpStats(ctx: FooterSegmentContext): McpStats {
  // Source 1: globalThis escape hatch (future: MCP registry may expose this)
  const global = globalThis.__unipi_mcp_stats;
  if (global && typeof global === "object") {
    return global;
  }

  // Source 2: registry data with aggregate fields
  const data = ctx.data;
  if (data && typeof data === "object") {
    return data as McpStats;
  }

  return {};
}

function hasUsefulValue(value: unknown): value is number {
  return typeof value === "number";
}

function renderServersTotalSegment(ctx: FooterSegmentContext): RenderedSegment {
  const stats = getMcpStats(ctx);
  if (!hasUsefulValue(stats.serversTotal)) {
    if (isSegmentEnabled("mcp", "servers_total")) {
      return { content: mutedPlaceholder("🖥️ MCP 0"), visible: true };
    }
    return { content: "", visible: false };
  }
  const content = withIcon("serversTotal", `${stats.serversTotal}`);
  return { content: applyColor("mcp", content, ctx.theme, ctx.colors), visible: true };
}

function renderServersActiveSegment(ctx: FooterSegmentContext): RenderedSegment {
  const stats = getMcpStats(ctx);
  if (!hasUsefulValue(stats.serversActive)) {
    if (isSegmentEnabled("mcp", "servers_active")) {
      const total = stats.serversTotal ?? 0;
      return { content: mutedPlaceholder(`🖥️ MCP ${total}/0`), visible: true };
    }
    return { content: "", visible: false };
  }
  const content = withIcon("serversActive", `${stats.serversActive}`);
  return { content: applyColor("mcp", content, ctx.theme, ctx.colors), visible: true };
}

function renderToolsTotalSegment(ctx: FooterSegmentContext): RenderedSegment {
  const stats = getMcpStats(ctx);
  if (!hasUsefulValue(stats.toolsTotal)) {
    if (isSegmentEnabled("mcp", "tools_total")) {
      return { content: mutedPlaceholder("🖥️ MCP 0"), visible: true };
    }
    return { content: "", visible: false };
  }
  const content = withIcon("toolsTotal", `${stats.toolsTotal}`);
  return { content: applyColor("mcp", content, ctx.theme, ctx.colors), visible: true };
}

function renderServersFailedSegment(ctx: FooterSegmentContext): RenderedSegment {
  const stats = getMcpStats(ctx);
  if (!hasUsefulValue(stats.serversFailed) || stats.serversFailed === 0) {
    return { content: "", visible: false };
  }
  const content = withIcon("serversFailed", `${stats.serversFailed}`);
  return { content: applyColor("mcp", content, ctx.theme, ctx.colors), visible: true };
}

export const MCP_SEGMENTS: FooterSegment[] = [
  { id: "servers_total", label: "Servers", shortLabel: "SRV", description: "Total MCP servers configured", zone: "center", icon: "", render: renderServersTotalSegment, defaultShow: true },
  { id: "servers_active", label: "Active", shortLabel: "ACT", description: "Currently connected MCP servers", zone: "center", icon: "", render: renderServersActiveSegment, defaultShow: true },
  { id: "tools_total", label: "Tools", shortLabel: "TLS", description: "Total MCP tools available", zone: "center", icon: "", render: renderToolsTotalSegment, defaultShow: true },
  { id: "servers_failed", label: "Failed", shortLabel: "ERR", description: "Failed MCP server connections", zone: "center", icon: "", render: renderServersFailedSegment, defaultShow: true },
];
