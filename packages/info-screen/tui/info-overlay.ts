/**
 * @pi-unipi/info-screen — TUI Overlay Component
 *
 * Main dashboard overlay with tabbed navigation.
 * Displays registered groups as tabs with their stats.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { infoRegistry } from "../registry.js";
import type { InfoGroup, GroupData, StatData } from "../types.js";

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
  gray: "\x1b[90m",
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
    this.groups = infoRegistry.getGroups();

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
      // Right arrow
      this.activeTabIndex = (this.activeTabIndex + 1) % this.groups.length;
    } else if (data === "\x1b[D" || data === "h") {
      // Left arrow
      this.activeTabIndex = (this.activeTabIndex - 1 + this.groups.length) % this.groups.length;
    } else if (data === "q" || data === "\x1b") {
      // q or Escape - handled by caller
    }
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

    if (this.groups.length === 0) {
      return this.renderEmpty(width);
    }

    return this.renderDashboard(width);
  }

  /**
   * Render loading state.
   */
  private renderLoading(width: number): string[] {
    const lines: string[] = [];
    const padding = " ".repeat(Math.max(0, Math.floor((width - 20) / 2)));

    lines.push("");
    lines.push(`${padding}${ansi.cyan}${ansi.bold}📊 UniPi Info Screen${ansi.reset}`);
    lines.push("");
    lines.push(`${padding}${ansi.dim}Loading dashboard...${ansi.reset}`);
    lines.push("");

    return lines;
  }

  /**
   * Render error state.
   */
  private renderError(width: number): string[] {
    const lines: string[] = [];
    const padding = " ".repeat(Math.max(0, Math.floor((width - 20) / 2)));

    lines.push("");
    lines.push(`${padding}${ansi.yellow}${ansi.bold}⚠️ Error${ansi.reset}`);
    lines.push(`${padding}${ansi.dim}${this.error ?? "Unknown error"}${ansi.reset}`);
    lines.push("");

    return lines;
  }

  /**
   * Render empty state.
   */
  private renderEmpty(width: number): string[] {
    const lines: string[] = [];
    const padding = " ".repeat(Math.max(0, Math.floor((width - 30) / 2)));

    lines.push("");
    lines.push(`${padding}${ansi.cyan}${ansi.bold}📊 UniPi Info Screen${ansi.reset}`);
    lines.push("");
    lines.push(`${padding}${ansi.dim}No groups registered.${ansi.reset}`);
    lines.push(`${padding}${ansi.dim}Modules will register groups on startup.${ansi.reset}`);
    lines.push("");

    return lines;
  }

  /**
   * Pad a line to fill a target visual width.
   */
  private padToWidth(line: string, targetWidth: number): string {
    const visLen = visibleWidth(line);
    const pad = Math.max(0, targetWidth - visLen);
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
    // Subtract extra 1 to prevent right border clipping on some terminals
    const innerWidth = width - 3;

    // Top border
    lines.push(`${ansi.dim}╭${"─".repeat(innerWidth + 1)}╮${ansi.reset}`);

    // Header
    lines.push(`${ansi.dim}│${ansi.reset}${this.padToWidth(this.renderHeader(innerWidth, group), innerWidth)}${ansi.dim} │${ansi.reset}`);
    lines.push(`${ansi.dim}├${"─".repeat(innerWidth + 1)}┤${ansi.reset}`);

    // Tab bar
    lines.push(`${ansi.dim}│${ansi.reset}${this.padToWidth(this.renderTabBar(innerWidth), innerWidth)}${ansi.dim} │${ansi.reset}`);
    lines.push(`${ansi.dim}├${"─".repeat(innerWidth + 1)}┤${ansi.reset}`);

    // Content
    const contentLines = this.renderGroupContent(innerWidth, group, data);
    for (const line of contentLines) {
      lines.push(`${ansi.dim}│${ansi.reset}${this.padToWidth(line, innerWidth)}${ansi.dim} │${ansi.reset}`);
    }

    // Footer
    lines.push(`${ansi.dim}├${"─".repeat(innerWidth + 1)}┤${ansi.reset}`);
    lines.push(`${ansi.dim}│${ansi.reset}${this.padToWidth(this.renderFooter(innerWidth), innerWidth)}${ansi.dim} │${ansi.reset}`);
    lines.push(`${ansi.dim}╰${"─".repeat(innerWidth + 1)}╯${ansi.reset}`);

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
   * Render tab bar.
   */
  private renderTabBar(width: number): string {
    const tabs: string[] = [];

    for (let i = 0; i < this.groups.length; i++) {
      const group = this.groups[i];
      const isActive = i === this.activeTabIndex;
      const color = TAB_COLORS[i % TAB_COLORS.length];

      if (isActive) {
        tabs.push(`${color}${ansi.bold} ${group.icon} ${group.name} ${ansi.reset}`);
      } else {
        tabs.push(`${ansi.dim} ${group.icon} ${group.name} ${ansi.reset}`);
      }
    }

    const tabStr = tabs.join(`${ansi.dim}│${ansi.reset}`);
    const visLen = visibleWidth(tabStr);

    // Truncate if too wide
    if (visLen > width - 2) {
      return truncateToWidth(tabStr, width - 2);
    }

    return tabStr;
  }

  /**
   * Render a separator line.
   */
  private renderSeparator(width: number): string {
    return ansi.dim + "─".repeat(width) + ansi.reset;
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
        // First line with value
        if (detailLines.length === 1) {
          line += ` ${ansi.dim}(${detail})${ansi.reset}`;
        } else {
          // Multiple lines - show first line inline, rest indented
          lines.push(line);
          for (const dLine of detailLines) {
            const indent = " ".repeat(maxLabelLen + 4);
            let detailLine = `${indent}${ansi.dim}${dLine}${ansi.reset}`;
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
  private renderFooter(width: number): string {
    const hints = [
      `${ansi.dim}←/→${ansi.reset} tabs`,
      `${ansi.dim}q/Esc${ansi.reset} close`,
    ];

    const hintStr = hints.join(`  ${ansi.dim}•${ansi.reset}  `);
    const visLen = visibleWidth(hintStr);

    if (visLen >= width - 4) {
      return ansi.dim + truncateToWidth(hintStr, width - 4) + ansi.reset;
    }

    const leftPad = Math.floor((width - visLen) / 2);

    return " ".repeat(leftPad) + hintStr;
  }
}
