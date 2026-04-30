/**
 * @pi-unipi/footer — FooterRenderer
 *
 * Main renderer using pi's setFooter + setWidget APIs.
 * Implements responsive layout with top row + secondary row.
 * Segments fit into available width; overflow goes to secondary.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import type { PresetDef, FooterSegmentContext, FooterSegment, ColorScheme, RenderedSegment } from "../types.js";
import type { FooterRegistry } from "../registry/index.js";
import { getSeparator, separatorVisibleWidth } from "./separators.js";
import { getDefaultColors } from "./theme.js";
import { getPreset } from "../presets.js";
import { isSegmentEnabled } from "../config.js";

/** Segment lookup by ID across all groups */
interface SegmentLookup {
  get(id: string): FooterSegment | undefined;
}

/** Rendered segment with width info */
interface RenderedSegmentWithWidth {
  content: string;
  width: number;
  visible: boolean;
}

// ─── ANSI helpers ───────────────────────────────────────────────────────────

/** Strip ANSI escape codes and measure visible width */
function visibleWidth(text: string): number {
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
  return stripped.length;
}

const ANSI_RESET = "\x1b[0m";

function getFgAnsiCode(colors: ColorScheme, semantic: string): string {
  // Simplified: use dim color for separators
  return "\x1b[2m"; // dim
}

// ─── FooterRenderer class ──────────────────────────────────────────────────

export class FooterRenderer {
  /** Current active preset name */
  private presetName: string;

  /** Footer registry for data access */
  private registry: FooterRegistry;

  /** Segment lookup function */
  private segmentLookup: SegmentLookup;

  /** Current terminal width */
  private currentWidth = 0;

  /** Whether the renderer is active */
  private active = false;

  /** Layout cache */
  private lastLayoutResult: { topContent: string; secondaryContent: string } | null = null;
  private lastLayoutWidth = 0;
  private lastLayoutTimestamp = 0;
  private layoutDirty = true;

  /** Pi context references */
  private piContext: unknown = null;
  private footerData: unknown = null;

  /** Debounce timer for renders */
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly RENDER_DEBOUNCE_MS = 33;

  constructor(
    registry: FooterRegistry,
    segmentLookup: SegmentLookup,
    initialPreset = "default",
  ) {
    this.registry = registry;
    this.segmentLookup = segmentLookup;
    this.presetName = initialPreset;

    // Subscribe to registry changes
    this.registry.subscribe(() => {
      this.layoutDirty = true;
      this.scheduleRender();
    });
  }

  /** Set the active preset */
  setPreset(name: string): void {
    this.presetName = name;
    this.resetLayoutCache();
  }

  /** Get the active preset name */
  getPresetName(): string {
    return this.presetName;
  }

  /** Set pi context references */
  setContext(piContext: unknown, footerData: unknown): void {
    this.piContext = piContext;
    this.footerData = footerData;
    this.resetLayoutCache();
  }

  /** Activate/deactivate the renderer */
  setActive(active: boolean): void {
    this.active = active;
    this.resetLayoutCache();
  }

  /** Whether the renderer is active */
  isActive(): boolean {
    return this.active;
  }

  /** Schedule a debounced render */
  scheduleRender(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => {
      this.layoutDirty = true;
    }, FooterRenderer.RENDER_DEBOUNCE_MS);
  }

  /** Reset layout cache, forcing re-computation on next render */
  resetLayoutCache(): void {
    this.lastLayoutResult = null;
    this.lastLayoutWidth = 0;
    this.layoutDirty = true;
  }

  /**
   * Compute responsive layout for the given width.
   * Segments that don't fit in the top row overflow to the secondary row.
   */
  computeLayout(width: number): { topContent: string; secondaryContent: string } {
    // Return cached layout if still valid
    const now = Date.now();
    if (this.lastLayoutResult && this.lastLayoutWidth === width && !this.layoutDirty && now - this.lastLayoutTimestamp < 5000) {
      return this.lastLayoutResult;
    }

    const presetDef = getPreset(this.presetName);
    const colors = presetDef.colors ?? getDefaultColors();

    // Render all segments
    const allSegmentIds = [
      ...presetDef.leftSegments,
      ...presetDef.rightSegments,
      ...presetDef.secondarySegments,
    ];

    const renderedSegments: RenderedSegmentWithWidth[] = [];
    for (const segId of allSegmentIds) {
      if (!isSegmentEnabled(this.getGroupForSegment(segId), segId)) continue;

      const segment = this.segmentLookup.get(segId);
      if (!segment) continue;

      const ctx: FooterSegmentContext = {
        theme: this.getThemeLike(),
        colors,
        data: this.registry.getGroupData(this.getGroupForSegment(segId)),
        width,
        piContext: this.piContext,
        footerData: this.footerData,
      };

      const rendered = segment.render(ctx);
      if (!rendered.visible || !rendered.content) continue;

      renderedSegments.push({
        content: rendered.content,
        width: visibleWidth(rendered.content),
        visible: true,
      });
    }

    if (renderedSegments.length === 0) {
      this.lastLayoutResult = { topContent: "", secondaryContent: "" };
      this.lastLayoutWidth = width;
      this.lastLayoutTimestamp = now;
      this.layoutDirty = false;
      return this.lastLayoutResult;
    }

    // Separate primary (left+right) from secondary
    const primaryIds = new Set([...presetDef.leftSegments, ...presetDef.rightSegments]);
    const primarySegments: RenderedSegmentWithWidth[] = [];
    const secondarySegments: RenderedSegmentWithWidth[] = [];

    for (const seg of renderedSegments) {
      // Check if this segment's content matches a primary or secondary segment
      // We'll do a simpler approach: fit what fits in top row, overflow to secondary
      primarySegments.push(seg);
    }

    // Compute responsive layout
    const sepDef = getSeparator(presetDef.separator);
    const sepWidth = visibleWidth(sepDef.left) + 2; // separator + spaces

    const baseOverhead = 2; // leading + trailing space
    let currentWidth = baseOverhead;
    let topParts: string[] = [];
    let overflowParts: RenderedSegmentWithWidth[] = [];
    let overflow = false;

    for (const seg of primarySegments) {
      const needed = seg.width + (topParts.length > 0 ? sepWidth : 0);
      if (!overflow && currentWidth + needed <= width) {
        topParts.push(seg.content);
        currentWidth += needed;
      } else {
        overflow = true;
        overflowParts.push(seg);
      }
    }

    // Fit overflow into secondary row
    let secondaryWidth = baseOverhead;
    let secondaryParts: string[] = [];
    for (const seg of overflowParts) {
      const needed = seg.width + (secondaryParts.length > 0 ? sepWidth : 0);
      if (secondaryWidth + needed <= width) {
        secondaryParts.push(seg.content);
        secondaryWidth += needed;
      } else {
        break; // Stop at first non-fitting segment
      }
    }

    const topContent = this.buildContentFromParts(topParts, sepDef);
    const secondaryContent = this.buildContentFromParts(secondaryParts, sepDef);

    this.lastLayoutResult = { topContent, secondaryContent };
    this.lastLayoutWidth = width;
    this.lastLayoutTimestamp = now;
    this.layoutDirty = false;

    return this.lastLayoutResult;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private buildContentFromParts(parts: string[], sepDef: { left: string }): string {
    if (parts.length === 0) return "";
    const sep = sepDef.left;
    const sepAnsi = getFgAnsiCode(getPreset(this.presetName).colors ?? getDefaultColors(), "separator");
    return " " + parts.join(` ${sepAnsi}${sep}${ANSI_RESET} `) + ANSI_RESET + " ";
  }

  /** Map a segment ID to its group ID */
  private getGroupForSegment(segId: string): string {
    // Core segments
    const coreIds = ["model", "thinking", "path", "git", "context_pct", "cost", "tokens_total", "tokens_in", "tokens_out", "session", "hostname", "time"];
    if (coreIds.includes(segId)) return "core";

    // Compactor segments
    const compactorIds = ["session_events", "compactions", "tokens_saved", "compression_ratio", "indexed_docs", "sandbox_runs", "search_queries"];
    if (compactorIds.includes(segId)) return "compactor";

    // Memory segments
    if (["project_count", "total_count", "consolidations"].includes(segId)) return "memory";

    // MCP segments
    if (["servers_total", "servers_active", "tools_total", "servers_failed"].includes(segId)) return "mcp";

    // Ralph segments
    if (["active_loops", "total_iterations", "loop_status"].includes(segId)) return "ralph";

    // Workflow segments
    if (["current_command", "sandbox_level", "command_duration"].includes(segId)) return "workflow";

    // Kanboard segments
    if (["docs_count", "tasks_done", "tasks_total", "task_pct"].includes(segId)) return "kanboard";

    // Notify segments
    if (["platforms_enabled", "last_sent"].includes(segId)) return "notify";

    // Status extension
    if (segId === "extension_statuses") return "status_ext";

    return "core";
  }

  /** Get a ThemeLike object for rendering context */
  private getThemeLike(): { fg: (color: string, text: string) => string } {
    // Use a minimal theme-like that applies ANSI codes based on color names
    // The real theme is passed via setWidget callback
    return {
      fg: (color: string, text: string) => {
        // Return text as-is; actual theming applied by segment renderers
        return text;
      },
    };
  }
}
