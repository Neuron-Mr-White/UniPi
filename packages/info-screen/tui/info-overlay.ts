/**
 * @pi-unipi/info-screen — TUI Overlay Component
 *
 * Main dashboard overlay with tabbed navigation.
 * Displays registered groups as tabs with their stats.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { infoRegistry } from "../registry.js";
import { getInfoSettings } from "../config.js";
import type { InfoGroup, GroupData } from "../types.js";

/** ANSI escape codes */
const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  underline: "\x1b[4m",
  // Colors
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  // Backgrounds
  bgDarkGray: "\x1b[48;5;235m",
  bgDarkerGray: "\x1b[48;5;233m",
};

/** Tab color palette */
const TAB_COLORS = [
  ansi.cyan,
  ansi.green,
  ansi.yellow,
  ansi.magenta,
  ansi.blue,
];

/**
 * Info overlay component with tabbed navigation.
 */
export class InfoOverlay implements Component {
  private groups: InfoGroup[] = [];
  private activeTabIndex = 0;
  private groupData = new Map<string, GroupData>();
  private loading = true;
  private error: string | null = null;
  private scrollOffset = 0;
  /** Tab scroll offset for horizontal scrolling */
  private tabScrollOffset = 0;
  /** Callback when overlay should close */
  onClose?: () => void;

  constructor() {
    this.loadData();
  }

  /**
   * Invalidate cached render state.
   */
  invalidate(): void {
    // No cached state to invalidate
  }

  /**
   * Load data for all groups.
   */
  private async loadData(): Promise<void> {
    this.loading = true;
    // Always re-fetch ALL groups to catch late registrations
    this.groups = infoRegistry.getAllGroups();
    
    // Apply saved order from settings
    const settings = getInfoSettings();
    if (settings.groupOrder && settings.groupOrder.length > 0) {
      const order = settings.groupOrder;
      this.groups.sort((a, b) => {
        const ai = order.indexOf(a.id);
        const bi = order.indexOf(b.id);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      });
    }

    try {
      // Load data for all groups in parallel
      const promises = this.groups.map(async (group) => {
        const data = await infoRegistry.getGroupData(group.id);
        this.groupData.set(group.id, data);
      });

      await Promise.all(promises);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }

    this.loading = false;
  }

  /**
   * Handle keyboard input.
   */
  handleInput(data: string): void {
    if (this.loading) return;

    // Arrow keys for tab navigation
    if (data === "\x1b[C" || data === "l") {
      // Right arrow - switch tab
      this.activeTabIndex = (this.activeTabIndex + 1) % this.groups.length;
      this.scrollOffset = 0; // Reset scroll on tab switch
      this.ensureTabVisible();
    } else if (data === "\x1b[D" || data === "h") {
      // Left arrow - switch tab
      this.activeTabIndex = (this.activeTabIndex - 1 + this.groups.length) % this.groups.length;
      this.scrollOffset = 0; // Reset scroll on tab switch
      this.ensureTabVisible();
    } else if (data === "\x1b[B" || data === "j") {
      // Down arrow - scroll down
      this.scrollOffset++;
    } else if (data === "\x1b[A" || data === "k") {
      // Up arrow - scroll up
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    } else if (data === "g") {
      // g - go to top
      this.scrollOffset = 0;
    } else if (data === "G") {
      // G - go to bottom (will be clamped in render)
      this.scrollOffset = Infinity;
    } else if (data === "q" || data === "\x1b") {
      // q or Escape - close overlay
      this.onClose?.();
    }
  }

  /**
   * Ensure active tab is visible in the tab bar (horizontal scroll).
   */
  private ensureTabVisible(): void {
    // Tab bar shows ~maxTabsVisible tabs, centered around active
    // This is handled in renderTabBar
  }

  /**
   * Render the component.
   */
  render(width: number): string[] {
    if (this.loading) {
      return this.renderLoading(width);
    }

    if (this.error) {
      return this.renderError(width);
    }

    // Check for new groups (but don't re-trigger loading)
    const allGroups = infoRegistry.getAllGroups();
    const groupIds = allGroups.map(g => g.id).join(",");
    const currentIds = this.groups.map(g => g.id).join(",");
    
    if (groupIds !== currentIds) {
      this.groups = allGroups;
      // Apply saved order
      const settings = getInfoSettings();
      if (settings.groupOrder && settings.groupOrder.length > 0) {
        const order = settings.groupOrder;
        this.groups.sort((a, b) => {
          const ai = order.indexOf(a.id);
          const bi = order.indexOf(b.id);
          return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        });
      }
      // Load data for any new groups (non-blocking)
      this.loadDataForNewGroups(allGroups);
    }

    if (this.groups.length === 0) {
      return this.renderEmpty(width);
    }

    return this.renderDashboard(width);
  }

  /**
   * Load data for groups we don't have data for yet.
   */
  private async loadDataForNewGroups(groups: InfoGroup[]): Promise<void> {
    for (const group of groups) {
      if (!this.groupData.has(group.id)) {
        try {
          const data = await infoRegistry.getGroupData(group.id);
          this.groupData.set(group.id, data);
        } catch {
          // Silently skip groups with errors
        }
      }
    }
  }

  /**
   * Render loading state.
   */
  private renderLoading(width: number): string[] {
    const lines: string[] = [];
    const padding = " ".repeat(Math.max(0, Math.floor((width - 20) / 2)));

    lines.push(`${padding}${ansi.cyan}${ansi.bold}📊 UniPi Info Screen${ansi.reset}`);
    lines.push("");
    lines.push(`${padding}${ansi.dim}Loading dashboard...${ansi.reset}`);

    return lines;
  }

  /**
   * Render error state.
   */
  private renderError(width: number): string[] {
    const lines: string[] = [];
    const padding = " ".repeat(Math.max(0, Math.floor((width - 20) / 2)));

    lines.push(`${padding}${ansi.yellow}${ansi.bold}⚠️ Error${ansi.reset}`);
    lines.push(`${padding}${ansi.dim}${this.error ?? "Unknown error"}${ansi.reset}`);

    return lines;
  }

  /**
   * Render empty state.
   */
  private renderEmpty(width: number): string[] {
    const lines: string[] = [];
    const padding = " ".repeat(Math.max(0, Math.floor((width - 30) / 2)));

    lines.push(`${padding}${ansi.cyan}${ansi.bold}📊 UniPi Info Screen${ansi.reset}`);
    lines.push("");
    lines.push(`${padding}${ansi.dim}No groups registered.${ansi.reset}`);
    lines.push(`${padding}${ansi.dim}Modules will register groups on startup.${ansi.reset}`);

    return lines;
  }

  /**
   * Pad a line to fill a target visual width with background.
   */
  private padToWidth(line: string, targetWidth: number, bg?: string): string {
    const visLen = visibleWidth(line);
    const pad = Math.max(0, targetWidth - visLen);
    if (bg) {
      return bg + line + " ".repeat(pad) + ansi.reset;
    }
    return line + " ".repeat(pad);
  }

  /**
   * Render the full dashboard.
   */
  private renderDashboard(width: number): string[] {
    const lines: string[] = [];
    const group = this.groups[this.activeTabIndex];
    const data = this.groupData.get(group.id) ?? {};
    // Inner width for content (subtract 2 for left+right borders)
    const innerWidth = width - 2;

    // Background colors
    const bgHeader = ansi.bgDarkGray;
    const bgContent = ansi.bgDarkerGray;

    // Top border
    lines.push(`${ansi.dim}╭${"─".repeat(innerWidth)}╮${ansi.reset}`);

    // Header with background
    lines.push(`${ansi.dim}│${ansi.reset}${this.padToWidth(this.renderHeader(innerWidth, group), innerWidth, bgHeader)}${ansi.dim}│${ansi.reset}`);
    lines.push(`${ansi.dim}├${"─".repeat(innerWidth)}┤${ansi.reset}`);

    // Tab bar with horizontal scrolling
    lines.push(`${ansi.dim}│${ansi.reset}${this.padToWidth(this.renderTabBar(innerWidth), innerWidth, bgHeader)}${ansi.dim}│${ansi.reset}`);
    lines.push(`${ansi.dim}├${"─".repeat(innerWidth)}┤${ansi.reset}`);

    // Content with scrolling
    const contentLines = this.renderGroupContent(innerWidth, group, data);
    const maxVisibleLines = 15; // Max content lines visible
    
    // Clamp scroll offset
    const maxScroll = Math.max(0, contentLines.length - maxVisibleLines);
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
    
    // Get visible slice
    const visibleContent = contentLines.slice(this.scrollOffset, this.scrollOffset + maxVisibleLines);
    
    for (const line of visibleContent) {
      lines.push(`${ansi.dim}│${ansi.reset}${this.padToWidth(line, innerWidth, bgContent)}${ansi.dim}│${ansi.reset}`);
    }
    
    // Show scroll indicator if needed
    if (contentLines.length > maxVisibleLines) {
      const scrollInfo = ` ${this.scrollOffset + 1}-${Math.min(this.scrollOffset + maxVisibleLines, contentLines.length)}/${contentLines.length} `;
      lines.push(`${ansi.dim}│${ansi.reset}${this.padToWidth(scrollInfo, innerWidth, bgContent)}${ansi.dim}│${ansi.reset}`);
    }

    // Footer
    const hasScroll = contentLines.length > maxVisibleLines;
    lines.push(`${ansi.dim}├${"─".repeat(innerWidth)}┤${ansi.reset}`);
    lines.push(`${ansi.dim}│${ansi.reset}${this.padToWidth(this.renderFooter(innerWidth, hasScroll), innerWidth, bgHeader)}${ansi.dim}│${ansi.reset}`);
    lines.push(`${ansi.dim}╰${"─".repeat(innerWidth)}╯${ansi.reset}`);

    return lines;
  }

  /**
   * Render header with title and group info.
   */
  private renderHeader(width: number, group: InfoGroup): string {
    const title = `${group.icon} ${group.name}`;
    const paddedTitle = ` ${title} `;
    const visLen = visibleWidth(paddedTitle);

    if (visLen >= width - 4) {
      return ansi.bold + truncateToWidth(paddedTitle, width - 4) + ansi.reset;
    }

    // Center the title
    const leftPad = Math.floor((width - visLen) / 2);

    return " ".repeat(leftPad) + ansi.bold + paddedTitle + ansi.reset;
  }

  /**
   * Render tab bar with horizontal scrolling.
   * When tabs overflow, slides to keep active tab visible.
   */
  private renderTabBar(width: number): string {
    if (this.groups.length === 0) return "";

    // Calculate tab widths
    const tabWidths = this.groups.map(g => visibleWidth(` ${g.icon} ${g.name} `));
    const separatorWidth = visibleWidth(`${ansi.dim}│${ansi.reset}`);
    
    // Find how many tabs fit
    let maxTabs = 0;
    let totalWidth = 0;
    for (let i = 0; i < this.groups.length; i++) {
      const tabW = tabWidths[i]!;
      const sepW = i > 0 ? separatorWidth : 0;
      if (totalWidth + sepW + tabW > width - 2) break;
      totalWidth += sepW + tabW;
      maxTabs = i + 1;
    }

    // If all tabs fit, show all
    if (maxTabs >= this.groups.length) {
      return this.renderAllTabs(width);
    }

    // Calculate scroll offset to keep active tab visible
    // Center the active tab in the visible window
    const halfVisible = Math.floor(maxTabs / 2);
    let startIdx = this.activeTabIndex - halfVisible;
    startIdx = Math.max(0, Math.min(startIdx, this.groups.length - maxTabs));
    
    // Build visible tabs
    const tabs: string[] = [];
    for (let i = startIdx; i < startIdx + maxTabs && i < this.groups.length; i++) {
      const group = this.groups[i]!;
      const isActive = i === this.activeTabIndex;
      const color = TAB_COLORS[i % TAB_COLORS.length]!;

      if (isActive) {
        tabs.push(`${color}${ansi.bold} ${group.icon} ${group.name} ${ansi.reset}`);
      } else {
        tabs.push(`${ansi.dim} ${group.icon} ${group.name} ${ansi.reset}`);
      }
    }

    const tabStr = tabs.join(`${ansi.dim}│${ansi.reset}`);
    
    // Add scroll indicators
    const hasLeft = startIdx > 0;
    const hasRight = startIdx + maxTabs < this.groups.length;
    
    if (hasLeft) {
      return `${ansi.dim}◀${ansi.reset} ${tabStr}`;
    }
    if (hasRight) {
      return `${tabStr} ${ansi.dim}▶${ansi.reset}`;
    }
    
    return tabStr;
  }

  /**
   * Render all tabs (when they all fit).
   */
  private renderAllTabs(width: number): string {
    const tabs: string[] = [];

    for (let i = 0; i < this.groups.length; i++) {
      const group = this.groups[i]!;
      const isActive = i === this.activeTabIndex;
      const color = TAB_COLORS[i % TAB_COLORS.length]!;

      if (isActive) {
        tabs.push(`${color}${ansi.bold} ${group.icon} ${group.name} ${ansi.reset}`);
      } else {
        tabs.push(`${ansi.dim} ${group.icon} ${group.name} ${ansi.reset}`);
      }
    }

    const tabStr = tabs.join(`${ansi.dim}│${ansi.reset}`);
    const visLen = visibleWidth(tabStr);

    // Truncate if too wide (shouldn't happen if maxTabs calculation is correct)
    if (visLen > width - 2) {
      return truncateToWidth(tabStr, width - 2);
    }

    return tabStr;
  }

  /**
   * Render group content.
   */
  private renderGroupContent(width: number, group: InfoGroup, data: GroupData): string[] {
    const lines: string[] = [];
    const visibleStats = infoRegistry.getVisibleStats(group.id);

    if (visibleStats.length === 0) {
      lines.push(`  ${ansi.dim}No stats configured for this group.${ansi.reset}`);
      return lines;
    }

    // Calculate label width for alignment
    const maxLabelLen = Math.max(...visibleStats.map((s) => s.label.length));

    for (const stat of visibleStats) {
      const statData = data[stat.id];
      const value = statData?.value ?? "—";
      const detail = statData?.detail;

      const label = `${stat.label}:`.padEnd(maxLabelLen + 1);
      let line = `  ${ansi.dim}${label}${ansi.reset} ${ansi.bold}${value}${ansi.reset}`;

      // Handle multi-line detail
      if (detail) {
        const detailLines = detail.split("\n");
        if (detailLines.length === 1) {
          // Single line detail - show inline
          line += ` ${ansi.dim}(${detail})${ansi.reset}`;
        } else {
          // Multiple lines - show value on first line, details indented below
          lines.push(line);
          for (const dLine of detailLines) {
            const indent = " ".repeat(maxLabelLen + 4);
            let detailLine = `${indent}${dLine}`;
            if (visibleWidth(detailLine) > width - 2) {
              detailLine = truncateToWidth(detailLine, width - 2);
            }
            lines.push(detailLine);
          }
          continue;
        }
      }

      // Truncate if too wide
      if (visibleWidth(line) > width - 2) {
        line = truncateToWidth(line, width - 2);
      }

      lines.push(line);
    }

    return lines;
  }

  /**
   * Render footer with navigation hints.
   */
  private renderFooter(width: number, _hasScroll?: boolean): string {
    const hints = [
      `${ansi.cyan}←/→${ansi.reset} tabs`,
    ];
    
    hints.push(`${ansi.green}↑/↓${ansi.reset} scroll`);
    hints.push(`${ansi.yellow}g/G${ansi.reset} top/bottom`);
    hints.push(`${ansi.red}q/Esc${ansi.reset} close`);

    const hintStr = hints.join(`  ${ansi.dim}•${ansi.reset}  `);
    const visLen = visibleWidth(hintStr);

    if (visLen >= width - 4) {
      return truncateToWidth(hintStr, width - 4);
    }

    const leftPad = Math.floor((width - visLen) / 2);

    return " ".repeat(leftPad) + hintStr;
  }
}
