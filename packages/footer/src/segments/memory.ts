/**
 * @pi-unipi/footer — Memory segments
 *
 * Segment renderers for the memory group: project_count, total_count, consolidations.
 *
 * Data sources (in priority order):
 * 1. `globalThis.__unipi_info_registry` — the info-screen registry exposes a
 *    memory group with a dataProvider that returns { projectCount: { value }, totalCount: { value } }.
 *    We read from its cache synchronously via getCachedData("memory").
 * 2. `ctx.data` — the footer registry cache, populated by MEMORY_STORED/DELETED/CONSOLIDATED
 *    events. These carry raw event payloads (not aggregate counts), so they are NOT
 *    used for count segments. They may still carry lastConsolidated info.
 *
 * If no data source has aggregate counts available, segments return visible: false
 * instead of showing a stale "—" placeholder.
 *
 * Display format:  76/102 (project/total) — uses  Nerd Font icon
 */

import type { FooterSegment, FooterSegmentContext, RenderedSegment } from "../types.js";
import { applyColor, mutedPlaceholder } from "../rendering/theme.js";
import { getIcon } from "../rendering/icons.js";
import { isSegmentEnabled } from "../config.js";

function withIcon(segmentId: string, text: string): string {
  const icon = getIcon(segmentId);
  return icon ? `${icon} ${text}` : text;
}

/**
 * Shape of the info-screen memory group data:
 * { projectCount: { value: string }, totalCount: { value: string }, ... }
 */
interface InfoMemoryData {
  projectCount?: { value: string };
  totalCount?: { value: string };
  consolidations?: { value: string };
  [key: string]: unknown;
}

/**
 * Shape of the info-screen registry (subset we use).
 */
interface InfoRegistryLike {
  getCachedData(groupId: string): Record<string, unknown> | null;
}

/**
 * Try to read memory stats from the info-screen registry on globalThis.
 * Returns the cached data for the "memory" group if available.
 */
function getInfoRegistryMemoryData(): InfoMemoryData | null {
  try {
    const g = globalThis as Record<string, unknown>;
    const registry = g.__unipi_info_registry;
    if (!registry || typeof registry !== "object") return null;

    // The info registry exposes getCachedData(groupId) synchronously
    const getCached = (registry as InfoRegistryLike).getCachedData;
    if (typeof getCached !== "function") return null;

    const data = getCached.call(registry, "memory");
    if (!data || typeof data !== "object") return null;

    return data as InfoMemoryData;
  } catch {
    return null;
  }
}

/** Get project and total counts from info registry */
function getMemoryCounts(): { project: number | null; total: number | null } {
  const infoData = getInfoRegistryMemoryData();
  const projectStr = infoData?.projectCount?.value;
  const totalStr = infoData?.totalCount?.value;
  return {
    project: projectStr !== undefined ? parseInt(projectStr, 10) : null,
    total: totalStr !== undefined ? parseInt(totalStr, 10) : null,
  };
}

function renderProjectCountSegment(ctx: FooterSegmentContext): RenderedSegment {
  const counts = getMemoryCounts();
  if (counts.project === null) {
    if (isSegmentEnabled("memory", "project_count")) {
      return { content: mutedPlaceholder("🧠 MEM 0"), visible: true };
    }
    return { content: "", visible: false };
  }

  // Show as 76/102 format when both are available
  if (counts.total !== null) {
    const content = withIcon("projectCount", `${counts.project}/${counts.total}`);
    return { content: applyColor("memory", content, ctx.theme, ctx.colors), visible: true };
  }

  const content = withIcon("projectCount", `${counts.project}`);
  return { content: applyColor("memory", content, ctx.theme, ctx.colors), visible: true };
}

function renderTotalCountSegment(ctx: FooterSegmentContext): RenderedSegment {
  // If project_count already shows project/total, this segment is redundant
  // Only show when project_count isn't showing the combined format
  const counts = getMemoryCounts();
  if (counts.total === null) {
    return { content: "", visible: false };
  }

  // If both project and total are available, project_count shows the combined view
  // Only show this as standalone when project count isn't available
  if (counts.project !== null) {
    return { content: "", visible: false };
  }

  const content = withIcon("totalCount", `${counts.total}`);
  return { content: applyColor("memory", content, ctx.theme, ctx.colors), visible: true };
}

function renderConsolidationsSegment(ctx: FooterSegmentContext): RenderedSegment {
  const infoData = getInfoRegistryMemoryData();

  // Check for explicit consolidations stat from info registry
  const consolidationsValue = infoData?.consolidations?.value;
  if (consolidationsValue !== undefined && consolidationsValue !== null) {
    const content = withIcon("consolidations", `cns:${consolidationsValue}`);
    return { content: applyColor("memory", content, ctx.theme, ctx.colors), visible: true };
  }

  // Fall back to lastConsolidated from footer event cache (ctx.data)
  const eventData = ctx.data as Record<string, unknown> | undefined;
  const lastConsolidated = eventData?.lastConsolidated as Record<string, unknown> | undefined;
  const count = lastConsolidated?.count;

  if (count === undefined || count === null) {
    return { content: "", visible: false };
  }

  const content = withIcon("consolidations", `cns:${count}`);
  return { content: applyColor("memory", content, ctx.theme, ctx.colors), visible: true };
}

export const MEMORY_SEGMENTS: FooterSegment[] = [
  { id: "project_count", label: "Project Memory", shortLabel: "MEM", description: "Memory entries for this project", zone: "center", icon: "", render: renderProjectCountSegment, defaultShow: true },
  { id: "total_count", label: "Total Memory", shortLabel: "TOT", description: "Total memory entries across projects", zone: "center", icon: "", render: renderTotalCountSegment, defaultShow: true },
  { id: "consolidations", label: "Consolidations", shortLabel: "CNS", description: "Number of memory consolidations", zone: "center", icon: "", render: renderConsolidationsSegment, defaultShow: false },
];
