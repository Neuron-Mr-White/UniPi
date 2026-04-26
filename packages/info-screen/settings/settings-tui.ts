/**
 * @pi-unipi/info-screen — Settings TUI Component
 *
 * Interactive settings editor for group and stat visibility.
 * Displays all groups with toggle switches.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { infoRegistry } from "../registry.js";
import { getInfoSettings, saveInfoSettings, getGroupSettings, setGroupSettings } from "../config.js";
import type { InfoScreenSettings, GroupSettings } from "../types.js";

/** ANSI escape codes */
const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  // Colors
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

/** Toggle symbols */
const TOGGLE_ON = `${ansi.green}●${ansi.reset}`;
const TOGGLE_OFF = `${ansi.dim}○${ansi.reset}`;

/**
 * Settings overlay component.
 */
export class SettingsOverlay implements Component {
  private settings: InfoScreenSettings;
  private groups: Array<{ id: string; name: string; icon: string }>;
  private selectedIndex = 0;
  private mode: "groups" | "stats" = "groups";
  private selectedGroupId: string | null = null;

  constructor() {
    this.settings = getInfoSettings();
    this.groups = infoRegistry.getAllGroups().map((g) => ({
      id: g.id,
      name: g.name,
      icon: g.icon,
    }));
  }

  /**
   * Invalidate cached render state.
   */
  invalidate(): void {
    // No cached state to invalidate
  }

  /**
   * Handle keyboard input.
   */
  handleInput(data: string): void {
    if (this.mode === "groups") {
      this.handleGroupsInput(data);
    } else {
      this.handleStatsInput(data);
    }
  }

  /**
   * Handle input in groups mode.
   */
  private handleGroupsInput(data: string): void {
    switch (data) {
      case "\x1b[A": // Up
      case "k":
        this.selectedIndex = (this.selectedIndex - 1 + this.groups.length) % this.groups.length;
        break;
      case "\x1b[B": // Down
      case "j":
        this.selectedIndex = (this.selectedIndex + 1) % this.groups.length;
        break;
      case " ": // Space - toggle visibility
      case "\r": // Enter - toggle visibility
        this.toggleGroupVisibility(this.groups[this.selectedIndex].id);
        break;
      case "\x1b[C": // Right - enter stats mode
      case "l":
        this.enterStatsMode(this.groups[this.selectedIndex].id);
        break;
      case "q": // Quit
      case "\x1b": // Escape
        // Handled by caller
        break;
    }
  }

  /**
   * Handle input in stats mode.
   */
  private handleStatsInput(data: string): void {
    if (!this.selectedGroupId) return;

    const group = infoRegistry.getGroup(this.selectedGroupId);
    if (!group) return;

    switch (data) {
      case "\x1b[A": // Up
      case "k":
        this.selectedIndex = (this.selectedIndex - 1 + group.config.stats.length) % group.config.stats.length;
        break;
      case "\x1b[B": // Down
      case "j":
        this.selectedIndex = (this.selectedIndex + 1) % group.config.stats.length;
        break;
      case " ": // Space - toggle stat
      case "\r": // Enter - toggle stat
        this.toggleStatVisibility(this.selectedGroupId, group.config.stats[this.selectedIndex].id);
        break;
      case "\x1b[D": // Left - back to groups
      case "h":
      case "q":
        this.mode = "groups";
        this.selectedGroupId = null;
        this.selectedIndex = this.groups.findIndex((g) => g.id === this.selectedGroupId) ?? 0;
        break;
    }
  }

  /**
   * Toggle group visibility.
   */
  private toggleGroupVisibility(groupId: string): void {
    const groupSettings = getGroupSettings(groupId);
    groupSettings.show = !groupSettings.show;
    setGroupSettings(groupId, groupSettings);

    // Update local settings
    this.settings.groups[groupId] = groupSettings;
  }

  /**
   * Toggle stat visibility.
   */
  private toggleStatVisibility(groupId: string, statId: string): void {
    const groupSettings = getGroupSettings(groupId);
    if (!groupSettings.stats) {
      groupSettings.stats = {};
    }
    groupSettings.stats[statId] = !(groupSettings.stats[statId] ?? true);
    setGroupSettings(groupId, groupSettings);

    // Update local settings
    this.settings.groups[groupId] = groupSettings;
  }

  /**
   * Enter stats editing mode for a group.
   */
  private enterStatsMode(groupId: string): void {
    this.mode = "stats";
    this.selectedGroupId = groupId;
    this.selectedIndex = 0;
  }

  /**
   * Render the component.
   */
  render(width: number): string[] {
    if (this.mode === "groups") {
      return this.renderGroupsMode(width);
    } else {
      return this.renderStatsMode(width);
    }
  }

  /**
   * Render groups mode.
   */
  private renderGroupsMode(width: number): string[] {
    const lines: string[] = [];

    // Header
    lines.push("");
    lines.push(this.renderCentered(`${ansi.bold}⚙️  Info Screen Settings${ansi.reset}`, width));
    lines.push("");

    // Separator
    lines.push(ansi.dim + "─".repeat(width) + ansi.reset);
    lines.push("");

    // Group list
    for (let i = 0; i < this.groups.length; i++) {
      const group = this.groups[i];
      const isSelected = i === this.selectedIndex;
      const groupSettings = getGroupSettings(group.id);
      const isEnabled = groupSettings.show;

      const toggle = isEnabled ? TOGGLE_ON : TOGGLE_OFF;
      const indicator = isSelected ? `${ansi.cyan}▸${ansi.reset}` : " ";

      let line = `  ${indicator} ${toggle} ${group.icon} ${group.name}`;

      if (isSelected) {
        line += `  ${ansi.dim}→ stats${ansi.reset}`;
      }

      if (visibleWidth(line) > width - 2) {
        line = truncateToWidth(line, width - 2);
      }

      lines.push(line);
    }

    // Footer
    lines.push("");
    lines.push(ansi.dim + "─".repeat(width) + ansi.reset);
    lines.push(this.renderCentered(`${ansi.dim}↑↓ select  Space toggle  → stats  q close${ansi.reset}`, width));
    lines.push("");

    return lines;
  }

  /**
   * Render stats mode.
   */
  private renderStatsMode(width: number): string[] {
    const lines: string[] = [];
    const group = this.selectedGroupId ? infoRegistry.getGroup(this.selectedGroupId) : null;

    if (!group) {
      lines.push(`${ansi.red}Group not found${ansi.reset}`);
      return lines;
    }

    const groupSettings = getGroupSettings(group.id);

    // Header
    lines.push("");
    lines.push(this.renderCentered(`${group.icon} ${group.name} Stats`, width));
    lines.push("");

    // Separator
    lines.push(ansi.dim + "─".repeat(width) + ansi.reset);
    lines.push("");

    // Stats list
    for (let i = 0; i < group.config.stats.length; i++) {
      const stat = group.config.stats[i];
      const isSelected = i === this.selectedIndex;
      const isEnabled = groupSettings.stats?.[stat.id] ?? stat.show;

      const toggle = isEnabled ? TOGGLE_ON : TOGGLE_OFF;
      const indicator = isSelected ? `${ansi.cyan}▸${ansi.reset}` : " ";

      let line = `  ${indicator} ${toggle} ${stat.label}`;

      if (visibleWidth(line) > width - 2) {
        line = truncateToWidth(line, width - 2);
      }

      lines.push(line);
    }

    // Footer
    lines.push("");
    lines.push(ansi.dim + "─".repeat(width) + ansi.reset);
    lines.push(this.renderCentered(`${ansi.dim}↑↓ select  Space toggle  ← back  q close${ansi.reset}`, width));
    lines.push("");

    return lines;
  }

  /**
   * Center text within width.
   */
  private renderCentered(text: string, width: number): string {
    const visLen = visibleWidth(text);
    if (visLen >= width) return text;

    const leftPad = Math.floor((width - visLen) / 2);
    return " ".repeat(leftPad) + text;
  }
}
