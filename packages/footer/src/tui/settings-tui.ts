/**
 * @pi-unipi/footer — Settings TUI
 *
 * Interactive settings overlay for toggling groups and individual segments.
 * Follows the info-screen SettingsOverlay pattern.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { loadFooterSettings, saveFooterSettings, getGroupSettings } from "../config.js";
import type { FooterGroup, FooterSettings } from "../types.js";

/** ANSI escape codes */
const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
};

const TOGGLE_ON = `${ansi.green}●${ansi.reset}`;
const TOGGLE_OFF = `${ansi.dim}○${ansi.reset}`;

/**
 * Show the footer settings overlay.
 */
export function showFooterSettings(ctx: any, groups: FooterGroup[]): void {
  ctx.ui.custom(
    (tui: any, _theme: any, _keybindings: any, done: (result: void) => void) => {
      const overlay = new FooterSettingsOverlay(groups);

      overlay.onClose = () => done();

      return {
        focused: true,
        invalidate: () => overlay.invalidate(),
        render: (width: number) => overlay.render(width),
        handleInput: (data: string) => {
          overlay.handleInput(data);
          tui.requestRender();
        },
        dispose: () => {},
      };
    },
    {
      overlay: true,
      overlayOptions: () => ({
        verticalAlign: "center",
        horizontalAlign: "center",
      }),
    },
  ).catch((err: unknown) => {
    console.error("[footer] Settings overlay error:", err);
  });
}

/**
 * Footer settings overlay component.
 */
class FooterSettingsOverlay {
  private settings: FooterSettings;
  private groups: FooterGroup[];
  private selectedIndex = 0;
  private savedGroupIndex = 0;
  private mode: "groups" | "segments" = "groups";
  private selectedGroupId: string | null = null;
  onClose?: () => void;

  constructor(groups: FooterGroup[]) {
    this.settings = loadFooterSettings();
    this.groups = groups;
  }

  invalidate(): void {
    // No cached state
  }

  handleInput(data: string): void {
    if (this.mode === "groups") {
      this.handleGroupsInput(data);
    } else {
      this.handleSegmentsInput(data);
    }
  }

  private handleGroupsInput(data: string): void {
    switch (data) {
      case "\x1b[A": case "k":
        this.selectedIndex = (this.selectedIndex - 1 + this.groups.length) % this.groups.length;
        break;
      case "\x1b[B": case "j":
        this.selectedIndex = (this.selectedIndex + 1) % this.groups.length;
        break;
      case " ":
        this.toggleGroup(this.groups[this.selectedIndex].id);
        break;
      case "\r": case "\x1b[C": case "l":
        this.enterSegmentsMode(this.groups[this.selectedIndex].id);
        break;
      case "q": case "\x1b":
        this.onClose?.();
        break;
    }
  }

  private handleSegmentsInput(data: string): void {
    if (!this.selectedGroupId) return;
    const group = this.groups.find(g => g.id === this.selectedGroupId);
    if (!group) return;

    switch (data) {
      case "\x1b[A": case "k":
        this.selectedIndex = (this.selectedIndex - 1 + group.segments.length) % group.segments.length;
        break;
      case "\x1b[B": case "j":
        this.selectedIndex = (this.selectedIndex + 1) % group.segments.length;
        break;
      case " ":
        this.toggleSegment(this.selectedGroupId, group.segments[this.selectedIndex].id);
        break;
      case "\x1b[D": case "h": case "\r":
        this.backToGroups();
        break;
      case "q": case "\x1b":
        this.onClose?.();
        break;
    }
  }

  private toggleGroup(groupId: string): void {
    const groupSettings = this.settings.groups[groupId] ?? { show: true, segments: {} };
    groupSettings.show = !groupSettings.show;
    this.settings.groups[groupId] = groupSettings;
    saveFooterSettings(this.settings);
  }

  private toggleSegment(groupId: string, segmentId: string): void {
    const groupSettings = this.settings.groups[groupId] ?? { show: true, segments: {} };
    if (!groupSettings.segments) groupSettings.segments = {};
    groupSettings.segments[segmentId] = !(groupSettings.segments[segmentId] ?? true);
    this.settings.groups[groupId] = groupSettings;
    saveFooterSettings(this.settings);
  }

  private enterSegmentsMode(groupId: string): void {
    this.savedGroupIndex = this.selectedIndex;
    this.mode = "segments";
    this.selectedGroupId = groupId;
    this.selectedIndex = 0;
  }

  private backToGroups(): void {
    this.mode = "groups";
    this.selectedIndex = this.savedGroupIndex;
    this.selectedGroupId = null;
  }

  render(width: number): string[] {
    if (this.mode === "groups") {
      return this.renderGroupsMode(width);
    } else {
      return this.renderSegmentsMode(width);
    }
  }

  private padToWidth(line: string, targetWidth: number): string {
    const visLen = visibleWidth(line);
    const pad = Math.max(0, targetWidth - visLen);
    return line + " ".repeat(pad);
  }

  private renderCentered(text: string, width: number): string {
    const visLen = visibleWidth(text);
    if (visLen >= width) return text;
    const leftPad = Math.floor((width - visLen) / 2);
    return " ".repeat(leftPad) + text;
  }

  private renderGroupsMode(width: number): string[] {
    const lines: string[] = [];
    const innerWidth = width - 2;

    lines.push(`${ansi.dim}╭${"─".repeat(innerWidth)}╮${ansi.reset}`);
    lines.push(`${ansi.dim}│${ansi.reset}${this.padToWidth(this.renderCentered(`${ansi.bold}⚙  Footer Settings${ansi.reset}`, innerWidth), innerWidth)}${ansi.dim}│${ansi.reset}`);
    lines.push(`${ansi.dim}├${"─".repeat(innerWidth)}┤${ansi.reset}`);

    for (let i = 0; i < this.groups.length; i++) {
      const group = this.groups[i];
      const isSelected = i === this.selectedIndex;
      const groupSettings = this.settings.groups[group.id] ?? { show: group.defaultShow, segments: {} };
      const isEnabled = groupSettings.show;

      const toggle = isEnabled ? TOGGLE_ON : TOGGLE_OFF;
      const indicator = isSelected ? `${ansi.cyan}▸${ansi.reset}` : " ";
      let line = `  ${indicator} ${toggle} ${group.name}`;

      if (isSelected) {
        line += `  ${ansi.dim}→ segments${ansi.reset}`;
      }

      if (visibleWidth(line) > innerWidth - 2) {
        line = truncateToWidth(line, innerWidth - 2);
      }

      lines.push(`${ansi.dim}│${ansi.reset}${this.padToWidth(line, innerWidth)}${ansi.dim}│${ansi.reset}`);
    }

    lines.push(`${ansi.dim}├${"─".repeat(innerWidth)}┤${ansi.reset}`);
    lines.push(`${ansi.dim}│${ansi.reset}${this.padToWidth(this.renderCentered(`${ansi.dim}↑↓ select  Space toggle  Enter/→ segments  q close${ansi.reset}`, innerWidth), innerWidth)}${ansi.dim}│${ansi.reset}`);
    lines.push(`${ansi.dim}╰${"─".repeat(innerWidth)}╯${ansi.reset}`);

    return lines;
  }

  private renderSegmentsMode(width: number): string[] {
    const lines: string[] = [];
    const group = this.groups.find(g => g.id === this.selectedGroupId);
    if (!group) return lines;

    const groupSettings = this.settings.groups[group.id] ?? { show: group.defaultShow, segments: {} };
    const innerWidth = width - 2;

    lines.push(`${ansi.dim}╭${"─".repeat(innerWidth)}╮${ansi.reset}`);
    lines.push(`${ansi.dim}│${ansi.reset}${this.padToWidth(this.renderCentered(`${group.name} Segments`, innerWidth), innerWidth)}${ansi.dim}│${ansi.reset}`);
    lines.push(`${ansi.dim}├${"─".repeat(innerWidth)}┤${ansi.reset}`);

    for (let i = 0; i < group.segments.length; i++) {
      const seg = group.segments[i];
      const isSelected = i === this.selectedIndex;
      const isEnabled = groupSettings.segments?.[seg.id] ?? seg.defaultShow;

      const toggle = isEnabled ? TOGGLE_ON : TOGGLE_OFF;
      const indicator = isSelected ? `${ansi.cyan}▸${ansi.reset}` : " ";
      let line = `  ${indicator} ${toggle} ${seg.label}`;

      if (visibleWidth(line) > innerWidth - 2) {
        line = truncateToWidth(line, innerWidth - 2);
      }

      lines.push(`${ansi.dim}│${ansi.reset}${this.padToWidth(line, innerWidth)}${ansi.dim}│${ansi.reset}`);
    }

    lines.push(`${ansi.dim}├${"─".repeat(innerWidth)}┤${ansi.reset}`);
    lines.push(`${ansi.dim}│${ansi.reset}${this.padToWidth(this.renderCentered(`${ansi.dim}↑↓ select  Space toggle  ←/Enter back  q close${ansi.reset}`, innerWidth), innerWidth)}${ansi.dim}│${ansi.reset}`);
    lines.push(`${ansi.dim}╰${"─".repeat(innerWidth)}╯${ansi.reset}`);

    return lines;
  }
}
