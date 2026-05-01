/**
 * @pi-unipi/footer — FooterRenderer
 *
 * Main renderer using pi's setFooter + setWidget APIs.
 * Implements responsive layout with top row + secondary row.
 * Segments fit into available width; overflow goes to secondary.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import type { PresetDef, FooterSegmentContext, FooterSegment, ColorScheme, RenderedSegment, SegmentZone } from "../types.js";
import type { FooterRegistry } from "../registry/index.js";
import { visibleWidth as piVisibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import { getSeparator, separatorVisibleWidth } from "./separators.js";
import { getDefaultColors } from "./theme.js";
import { setIconStyle } from "./icons.js";
import { getPreset } from "../presets.js";
import { isSegmentEnabled, loadFooterSettings } from "../config.js";

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

/** ANSI-aware visible width using pi-tui */
function visibleWidth(text: string): number {
  return piVisibleWidth(text);
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
    this.syncIconStyle();

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
    this.syncIconStyle();
  }

  /** Sync the icon style from settings to the icons module */
  private syncIconStyle(): void {
    const settings = loadFooterSettings();
    setIconStyle(settings.iconStyle);
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
   * Compute responsive zone-based layout for the given width.
   * Segments are grouped by zone (left/center/right) and rendered with alignment.
   */
  computeLayout(width: number): { topContent: string; secondaryContent: string } {
    // Return cached layout if still valid
    const now = Date.now();
    if (this.lastLayoutResult && this.lastLayoutWidth === width && !this.layoutDirty && now - this.lastLayoutTimestamp < 5000) {
      return this.lastLayoutResult;
    }

    const presetDef = getPreset(this.presetName);
    const colors = presetDef.colors ?? getDefaultColors();
    const settings = loadFooterSettings();
    const labelMode = settings.showFullLabels ? "labeled" as const : "compact" as const;

    // Collect all segment IDs from preset
    const primaryIds = [...presetDef.leftSegments, ...presetDef.rightSegments];
    const secondaryIds = [...presetDef.secondarySegments];

    // Render segments grouped by their zone
    const zones: Record<SegmentZone, RenderedSegmentWithWidth[]> = {
      left: [],
      center: [],
      right: [],
    };
    const overflowZones: Record<SegmentZone, RenderedSegmentWithWidth[]> = {
      left: [],
      center: [],
      right: [],
    };

    // Render primary segments and group by zone
    for (const segId of primaryIds) {
      const rendered = this.renderSegment(segId, colors, width, labelMode);
      if (!rendered) continue;
      const segment = this.segmentLookup.get(segId);
      const zone = segment?.zone ?? "center";
      zones[zone].push(rendered);
    }

    // Render secondary segments
    const secondaryRendered: RenderedSegmentWithWidth[] = [];
    for (const segId of secondaryIds) {
      const rendered = this.renderSegment(segId, colors, width, labelMode);
      if (!rendered) continue;
      secondaryRendered.push(rendered);
    }

    // Check if we have any content
    const totalSegments = zones.left.length + zones.center.length + zones.right.length;
    if (totalSegments === 0 && secondaryRendered.length === 0) {
      this.lastLayoutResult = { topContent: "", secondaryContent: "" };
      this.lastLayoutWidth = width;
      this.lastLayoutTimestamp = now;
      this.layoutDirty = false;
      return this.lastLayoutResult;
    }

    const sepDef = getSeparator(settings.separator);
    const sepWidth = visibleWidth(sepDef.left) + 2;
    const zoneSep = presetDef.zoneSeparator ?? settings.zoneSeparator ?? "\u2502";
    const zoneSepWidth = visibleWidth(zoneSep) + 2; // +2 for spaces around zone sep
    const dimZoneSep = `\x1b[2m${zoneSep}\x1b[0m`; // dimmed zone separator

    // Calculate widths per zone
    const leftWidth = this.measureZoneWidth(zones.left, sepWidth);
    const rightWidth = this.measureZoneWidth(zones.right, sepWidth);
    const numZoneSeps = (leftWidth > 0 ? 1 : 0) + (rightWidth > 0 ? 1 : 0);
    const availableForCenter = width - leftWidth - rightWidth - numZoneSeps * zoneSepWidth - 2; // -2 for margins

    // Overflow check: if center doesn't fit, move excess to overflow
    const centerWidth = this.measureZoneWidth(zones.center, sepWidth);
    if (centerWidth > Math.max(0, availableForCenter)) {
      // Move overflow center segments to secondary
      let fitWidth = 0;
      let cutoffIdx = 0;
      for (let i = 0; i < zones.center.length; i++) {
        const needed = zones.center[i].width + (i > 0 ? sepWidth : 0);
        if (fitWidth + needed <= Math.max(0, availableForCenter)) {
          fitWidth += needed;
          cutoffIdx = i + 1;
        } else {
          break;
        }
      }
      const overflow = zones.center.splice(cutoffIdx);
      overflowZones.center.push(...overflow);
    }

    // Build top row with zones
    const topContent = this.buildZoneRow(zones, width, sepDef, dimZoneSep);

    // Build secondary row with overflow + preset secondary segments
    const allSecondary = [...overflowZones.center, ...secondaryRendered];
    const secondaryContent = this.buildContentFromParts(
      allSecondary.map(s => s.content),
      sepDef,
    );

    this.lastLayoutResult = { topContent, secondaryContent };
    this.lastLayoutWidth = width;
    this.lastLayoutTimestamp = now;
    this.layoutDirty = false;

    return this.lastLayoutResult;
  }

  /** Render a single segment by ID, returns null if not visible */
  private renderSegment(
    segId: string,
    colors: ColorScheme,
    fullWidth: number,
    labelMode: "compact" | "labeled",
  ): RenderedSegmentWithWidth | null {
    if (!isSegmentEnabled(this.getGroupForSegment(segId), segId)) return null;

    const segment = this.segmentLookup.get(segId);
    if (!segment) return null;

    const ctx: FooterSegmentContext = {
      theme: this.getThemeLike(),
      colors,
      data: this.registry.getGroupData(this.getGroupForSegment(segId)),
      width: fullWidth,
      piContext: this.piContext,
      footerData: this.footerData,
      labelMode,
    };

    const rendered = segment.render(ctx);
    if (!rendered.visible || !rendered.content) return null;

    return {
      content: rendered.content,
      width: visibleWidth(rendered.content),
      visible: true,
    };
  }

  /** Measure total width of a zone's rendered segments */
  private measureZoneWidth(segments: RenderedSegmentWithWidth[], sepWidth: number): number {
    if (segments.length === 0) return 0;
    let total = 0;
    for (let i = 0; i < segments.length; i++) {
      total += segments[i].width + (i > 0 ? sepWidth : 0);
    }
    return total;
  }

  /** Build a zone-based row string */
  private buildZoneRow(
    zones: Record<SegmentZone, RenderedSegmentWithWidth[]>,
    fullWidth: number,
    sepDef: { left: string },
    dimZoneSep: string,
  ): string {
    const parts: string[] = [];

    // Left zone
    const leftContent = this.buildContentFromPartsRaw(
      zones.left.map(s => s.content),
      sepDef,
    );

    // Center zone
    const centerContent = this.buildContentFromPartsRaw(
      zones.center.map(s => s.content),
      sepDef,
    );

    // Right zone
    const rightContent = this.buildContentFromPartsRaw(
      zones.right.map(s => s.content),
      sepDef,
    );

    // Assemble zones with alignment
    const leftWidth = zones.left.length > 0 ? this.measureZoneWidth(zones.left, visibleWidth(sepDef.left) + 2) : 0;
    const rightWidth = zones.right.length > 0 ? this.measureZoneWidth(zones.right, visibleWidth(sepDef.left) + 2) : 0;

    // Simple case: no zones → return empty
    if (!leftContent && !centerContent && !rightContent) return "";

    // Build with zone separators
    let result = " "; // leading margin

    if (leftContent) {
      result += leftContent;
    }

    if (centerContent) {
      if (leftContent) result += ` ${dimZoneSep} `;
      result += centerContent;
    }

    if (rightContent) {
      const currentLen = visibleWidth(result);
      const rightStart = fullWidth - rightWidth - 1; // -1 for trailing margin
      const gap = rightStart - currentLen;

      if (gap > 0) {
        // Pad to right-align the right zone
        result += " ".repeat(gap);
      }

      if (centerContent || leftContent) {
        // Only add zone separator if there's content before it
        if (gap > visibleWidth(dimZoneSep) + 2) {
          // Place zone sep right before right content
          const sepPos = result.length - gap + Math.floor((gap - visibleWidth(dimZoneSep)) / 2);
          // Simpler: just put it at the boundary
        }
      }

      result += rightContent;
    }

    result += " "; // trailing margin
    return result;
  }

  /** Build content from parts array (raw strings) */
  private buildContentFromPartsRaw(parts: string[], sepDef: { left: string }): string {
    if (parts.length === 0) return "";
    const sep = sepDef.left;
    const sepAnsi = getFgAnsiCode(getPreset(this.presetName).colors ?? getDefaultColors(), "separator");
    return parts.join(` ${sepAnsi}${sep}${ANSI_RESET} `);
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
    const coreIds = ["model", "api_state", "tool_count", "git", "context_pct", "cost", "tokens_total", "tokens_in", "tokens_out", "session", "hostname", "time", "tps", "clock", "duration", "thinking_level"];
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
