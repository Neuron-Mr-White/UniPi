import { ansi, TOGGLE_ON, TOGGLE_OFF } from "@pi-unipi/core";
/**
 * @pi-unipi/info-screen — Settings TUI Component
 *
 * Interactive settings editor for group and stat visibility.
 * Displays all groups with toggle switches.
 */

import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { infoRegistry } from "../registry.js";
import { getInfoSettings, saveInfoSettings, getGroupSettings, setGroupSettings } from "../config.js";
import type { InfoScreenSettings, GroupSettings, BootMode } from "../types.js";
import { BOOT_MODES } from "../types.js";

/** ANSI escape codes */

/** Toggle symbols */

/** How each boot mode is presented in the settings list. */
const BOOT_MODE_LABELS: Record<BootMode, string> = {
  "on": `${ansi.green}● On${ansi.reset}`,
  "auto-close": `${ansi.cyan}◐ Auto-close${ansi.reset}`,
  "off": `${ansi.dim}○ Off${ansi.reset}`,
};

/**
 * Settings overlay component.
 */
export class SettingsOverlay implements Component {
  private settings: InfoScreenSettings;
  private groups: Array<{ id: string; name: string; icon: string }>;
  private selectedIndex = 0;
  /** Index of the "Show on boot" toggle row (above the group list). */
  /** Row 0 cycles the boot mode; row 1 edits the auto-close delay. */
  private static readonly BOOT_MODE_INDEX = 0;
  private static readonly BOOT_TIMEOUT_INDEX = 1;
  /** Number of settings rows rendered above the group list. */
  private static readonly HEADER_ROWS = 2;
  private savedGroupIndex = 0; // Saved position before entering stats mode
  private mode: "groups" | "stats" = "groups";
  private selectedGroupId: string | null = null;
  /** Callback when overlay should close */
  onClose?: () => void;

  constructor() {
    this.settings = getInfoSettings();
    this.groups = infoRegistry.getAllGroups().map((g) => ({
      id: g.id,
      name: g.name,
      icon: g.icon,
    }));
    // Apply saved order if exists
    if (this.settings.groupOrder) {
      const order = this.settings.groupOrder;
      this.groups.sort((a, b) => {
        const ai = order.indexOf(a.id);
        const bi = order.indexOf(b.id);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      });
    }
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
    const H = SettingsOverlay.HEADER_ROWS;
    const rowCount = this.groups.length + H; // header rows, then groups
    const onBootMode = this.selectedIndex === SettingsOverlay.BOOT_MODE_INDEX;
    const onBootTimeout = this.selectedIndex === SettingsOverlay.BOOT_TIMEOUT_INDEX;
    switch (data) {
      case "\x1b[A": // Up
      case "k":
        this.selectedIndex = (this.selectedIndex - 1 + rowCount) % rowCount;
        break;
      case "\x1b[B": // Down
      case "j":
        this.selectedIndex = (this.selectedIndex + 1) % rowCount;
        break;
      case " ": // Space - toggle / cycle
        if (onBootMode) {
          this.cycleBootMode();
        } else if (onBootTimeout) {
          this.adjustBootTimeout(500);
        } else {
          this.toggleGroupVisibility(this.groups[this.selectedIndex - H].id);
        }
        break;
      case "\r": // Enter - enter stats mode
      case "\x1b[C": // Right - enter stats mode
      case "l":
        if (onBootMode) {
          this.cycleBootMode();
        } else if (onBootTimeout) {
          this.adjustBootTimeout(500);
        } else {
          this.enterStatsMode(this.groups[this.selectedIndex - H].id);
        }
        break;
      case "\x1b[D": // Left - cycle back / decrease
      case "h":
        if (onBootMode) {
          this.cycleBootMode(-1);
        } else if (onBootTimeout) {
          this.adjustBootTimeout(-500);
        }
        break;
      case "J": // Shift+J - move group down
        if (this.selectedIndex >= H) {
          this.moveGroupDown();
        }
        break;
      case "K": // Shift+K - move group up
        if (this.selectedIndex >= H) {
          this.moveGroupUp();
        }
        break;
      case "q": // Quit
      case "\x1b": // Escape
        this.onClose?.();
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
        this.toggleStatVisibility(this.selectedGroupId, group.config.stats[this.selectedIndex].id);
        break;
      case "\x1b[D": // Left - back to groups
      case "h":
      case "\r": // Enter - also go back
        this.backToGroups();
        break;
      case "q": // Quit from stats mode
      case "\x1b":
        this.onClose?.();
        break;
    }
  }

  /**
   * Return to groups mode, restoring cursor position.
   */
  private backToGroups(): void {
    this.mode = "groups";
    this.selectedIndex = this.savedGroupIndex; // Restore saved position
    this.selectedGroupId = null;
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

  /** Cycle the boot mode: on → auto-close → off → on. */
  private cycleBootMode(step = 1): void {
    const current = BOOT_MODES.indexOf(this.settings.bootMode);
    const next = (current + step + BOOT_MODES.length) % BOOT_MODES.length;
    this.settings.bootMode = BOOT_MODES[next]!;
    saveInfoSettings(this.settings);
  }

  /**
   * Adjust the auto-close delay in 500ms steps.
   *
   * Clamped to a sane range: below 500ms the dashboard would vanish before it
   * could be read, and beyond 30s "auto-close" stops meaning anything.
   */
  private adjustBootTimeout(deltaMs: number): void {
    const next = this.settings.bootTimeoutMs + deltaMs;
    this.settings.bootTimeoutMs = Math.min(30_000, Math.max(500, next));
    saveInfoSettings(this.settings);
  }

  /**
   * Enter stats editing mode for a group.
   */
  private enterStatsMode(groupId: string): void {
    this.savedGroupIndex = this.selectedIndex; // Save position for later
    this.mode = "stats";
    this.selectedGroupId = groupId;
    this.selectedIndex = 0;
  }

  /**
   * Move selected group up in order.
   */
  private moveGroupUp(): void {
    // Already the first group; nothing above it but the settings rows.
    if (this.selectedIndex <= SettingsOverlay.HEADER_ROWS) return;
    const i = this.selectedIndex - SettingsOverlay.HEADER_ROWS;
    // Swap with previous
    const temp = this.groups[i]!;
    this.groups[i] = this.groups[i - 1]!;
    this.groups[i - 1] = temp;
    this.selectedIndex--;
    this.saveGroupOrder();
  }

  /**
   * Move selected group down in order.
   */
  private moveGroupDown(): void {
    // Header rows occupy 0..HEADER_ROWS-1; groups follow.
    if (this.selectedIndex >= this.groups.length + SettingsOverlay.HEADER_ROWS - 1) return;
    const i = this.selectedIndex - SettingsOverlay.HEADER_ROWS;
    // Swap with next
    const temp = this.groups[i]!;
    this.groups[i] = this.groups[i + 1]!;
    this.groups[i + 1] = temp;
    this.selectedIndex++;
    this.saveGroupOrder();
  }

  /**
   * Save group order to settings.
   */
  private saveGroupOrder(): void {
    this.settings.groupOrder = this.groups.map((g) => g.id);
    saveInfoSettings(this.settings);
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
   * Pad a line to fill a target visual width.
   */
  private padToWidth(line: string, targetWidth: number): string {
    const visLen = visibleWidth(line);
    const pad = Math.max(0, targetWidth - visLen);
    return line + " ".repeat(pad);
  }

  /**
   * Render groups mode.
   */
  private renderGroupsMode(width: number): string[] {
    const lines: string[] = [];
    const innerWidth = width - 2; // Subtract border chars

    // Top border
    lines.push(`${ansi.dim}╭${"─".repeat(innerWidth)}╮${ansi.reset}`);

    // Header
    lines.push(`${ansi.dim}│${ansi.reset}${this.padToWidth(this.renderCentered(`${ansi.bold}⚙️  Info Screen Settings${ansi.reset}`, innerWidth), innerWidth)}${ansi.dim}│${ansi.reset}`);
    lines.push(`${ansi.dim}├${"─".repeat(innerWidth)}┤${ansi.reset}`);

    // Boot mode row (index 0)
    {
      const isSelected = SettingsOverlay.BOOT_MODE_INDEX === this.selectedIndex;
      const indicator = isSelected ? `${ansi.cyan}▸${ansi.reset}` : " ";
      const label = BOOT_MODE_LABELS[this.settings.bootMode];
      let line = `  ${indicator} 🚀 Show on boot   ${ansi.bold}${label}${ansi.reset}`;
      if (isSelected) {
        line += `  ${ansi.dim}←/→ change${ansi.reset}`;
      }
      lines.push(`${ansi.dim}│${ansi.reset}${this.padToWidth(line, innerWidth)}${ansi.dim}│${ansi.reset}`);
    }

    // Auto-close delay row (index 1) — only meaningful in auto-close mode.
    {
      const isSelected = SettingsOverlay.BOOT_TIMEOUT_INDEX === this.selectedIndex;
      const active = this.settings.bootMode === "auto-close";
      const indicator = isSelected ? `${ansi.cyan}▸${ansi.reset}` : " ";
      const seconds = `${(this.settings.bootTimeoutMs / 1000).toFixed(1)}s`;
      const value = active ? `${ansi.bold}${seconds}${ansi.reset}` : `${ansi.dim}${seconds}${ansi.reset}`;
      let line = active
        ? `  ${indicator} ⏱️  Auto-close after ${value}`
        : `  ${indicator} ${ansi.dim}⏱️  Auto-close after${ansi.reset} ${value}`;
      if (isSelected && active) {
        line += `  ${ansi.dim}←/→ ±0.5s${ansi.reset}`;
      }
      lines.push(`${ansi.dim}│${ansi.reset}${this.padToWidth(line, innerWidth)}${ansi.dim}│${ansi.reset}`);
    }
    lines.push(`${ansi.dim}├${"─".repeat(innerWidth)}┤${ansi.reset}`);

    for (let i = 0; i < this.groups.length; i++) {
      const group = this.groups[i];
      // Header rows occupy 0..HEADER_ROWS-1; groups follow.
      const rowIndex = i + SettingsOverlay.HEADER_ROWS;
      const isSelected = rowIndex === this.selectedIndex;
      const groupSettings = getGroupSettings(group.id);
      const isEnabled = groupSettings.show;

      const toggle = isEnabled ? TOGGLE_ON : TOGGLE_OFF;
      const indicator = isSelected ? `${ansi.cyan}▸${ansi.reset}` : " ";

      let line = `  ${indicator} ${toggle} ${group.icon} ${group.name}`;

      if (isSelected) {
        line += `  ${ansi.dim}→ stats${ansi.reset}`;
      }

      if (visibleWidth(line) > innerWidth - 2) {
        line = truncateToWidth(line, innerWidth - 2);
      }

      lines.push(`${ansi.dim}│${ansi.reset}${this.padToWidth(line, innerWidth)}${ansi.dim}│${ansi.reset}`);
    }

    // Footer
    lines.push(`${ansi.dim}├${"─".repeat(innerWidth)}┤${ansi.reset}`);
    lines.push(`${ansi.dim}│${ansi.reset}${this.padToWidth(this.renderCentered(`${ansi.dim}↑↓ select  ←→ change  Space toggle  Enter stats  J/K reorder  q close${ansi.reset}`, innerWidth), innerWidth)}${ansi.dim}│${ansi.reset}`);
    lines.push(`${ansi.dim}╰${"─".repeat(innerWidth)}╯${ansi.reset}`);

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
    const innerWidth = width - 2;

    // Top border
    lines.push(`${ansi.dim}╭${"─".repeat(innerWidth)}╮${ansi.reset}`);

    // Header
    lines.push(`${ansi.dim}│${ansi.reset}${this.padToWidth(this.renderCentered(`${group.icon} ${group.name} Stats`, innerWidth), innerWidth)}${ansi.dim}│${ansi.reset}`);
    lines.push(`${ansi.dim}├${"─".repeat(innerWidth)}┤${ansi.reset}`);

    // Stats list
    for (let i = 0; i < group.config.stats.length; i++) {
      const stat = group.config.stats[i];
      const isSelected = i === this.selectedIndex;
      const isEnabled = groupSettings.stats?.[stat.id] ?? stat.show;

      const toggle = isEnabled ? TOGGLE_ON : TOGGLE_OFF;
      const indicator = isSelected ? `${ansi.cyan}▸${ansi.reset}` : " ";

      let line = `  ${indicator} ${toggle} ${stat.label}`;

      if (visibleWidth(line) > innerWidth - 2) {
        line = truncateToWidth(line, innerWidth - 2);
      }

      lines.push(`${ansi.dim}│${ansi.reset}${this.padToWidth(line, innerWidth)}${ansi.dim}│${ansi.reset}`);
    }

    // Footer
    lines.push(`${ansi.dim}├${"─".repeat(innerWidth)}┤${ansi.reset}`);
    lines.push(`${ansi.dim}│${ansi.reset}${this.padToWidth(this.renderCentered(`${ansi.dim}↑↓ select  Space toggle  ←/Enter back  q close${ansi.reset}`, innerWidth), innerWidth)}${ansi.dim}│${ansi.reset}`);
    lines.push(`${ansi.dim}╰${"─".repeat(innerWidth)}╯${ansi.reset}`);

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
