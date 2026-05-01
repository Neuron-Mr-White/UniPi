/**
 * @pi-unipi/footer — Settings TUI
 *
 * Interactive settings overlay for toggling groups and individual segments.
 * Uses pi-tui SettingsList for proper vim/arrow keybinding support and search.
 * Modeled after the compactor settings overlay pattern.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SettingsList, type SettingItem, type SettingsListTheme } from "@mariozechner/pi-tui";
import { loadFooterSettings, saveFooterSettings } from "../config.js";
import type { FooterGroup, FooterSettings } from "../types.js";

// ─── Section types ─────────────────────────────────────────────────────

type Section = "groups" | "segments";
const SECTIONS: Section[] = ["groups", "segments"];

// ─── Theme for SettingsList ────────────────────────────────────────────

const THEME: SettingsListTheme = {
  label: (text, selected) => selected ? `\x1b[1m${text}\x1b[0m` : `\x1b[2m${text}\x1b[0m`,
  value: (text, selected) => selected ? `\x1b[35m${text}\x1b[0m` : `\x1b[35m${text}\x1b[0m`,
  description: (text) => `\x1b[90m${text}\x1b[0m`,
  cursor: `\x1b[36m▸\x1b[0m`,
  hint: (text) => `\x1b[2m${text}\x1b[0m`,
};

// ─── Helper: frame a line inside box drawing ───────────────────────────

function frameLine(content: string, innerWidth: number): string {
  const visLen = visibleWidth(content);
  const pad = Math.max(0, innerWidth - visLen);
  return `\x1b[90m│\x1b[0m${content}${" ".repeat(pad)}\x1b[90m│\x1b[0m`;
}

function ruleLine(innerWidth: number): string {
  return `\x1b[90m├${"─".repeat(innerWidth)}┤\x1b[0m`;
}

function borderLine(innerWidth: number, edge: "top" | "bottom"): string {
  const left = edge === "top" ? "┌" : "└";
  const right = edge === "top" ? "┐" : "┘";
  return `\x1b[90m${left}${"─".repeat(innerWidth)}${right}\x1b[0m`;
}

// Visible width helper (strip ANSI)
function visibleWidth(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

// ─── Show the footer settings overlay ──────────────────────────────────

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
  ).catch(() => {
    // Silently ignore — overlay errors are non-blocking.
  });
}

// ─── Footer settings overlay component ─────────────────────────────────

/**
 * Footer settings overlay component.
 * Uses SettingsList from pi-tui for proper vim/arrow keybinding support.
 * Two sections: Groups (toggle groups) and Segments (toggle segments within a group).
 */
class FooterSettingsOverlay {
  private settings: FooterSettings;
  private groups: FooterGroup[];
  private section: Section = "groups";
  private selectedGroupId: string | null = null;
  onClose?: () => void;

  // Per-section SettingsList instances
  private groupList!: SettingsList;
  private segmentList: SettingsList | null = null;

  constructor(groups: FooterGroup[]) {
    this.settings = loadFooterSettings();
    this.groups = groups;
    this.buildGroupList();
  }

  invalidate(): void {
    this.groupList?.invalidate();
    this.segmentList?.invalidate();
  }

  handleInput(data: string): void {
    // Tab switches section (only if segments are available)
    if (data === "\t" || data === "\x1b[Z") {
      if (this.section === "groups" && this.selectedGroupId) {
        this.section = "segments";
      } else {
        this.section = "groups";
        this.selectedGroupId = null;
      }
      return;
    }

    // Escape / q — close
    if (data === "\x1b" || data === "q") {
      this.onClose?.();
      return;
    }

    // Enter in groups mode — enter segments for the focused group
    if (data === "\r" && this.section === "groups") {
      const focusedId = this.getFocusedGroupId();
      if (focusedId) {
        this.enterSegmentsMode(focusedId);
      }
      return;
    }

    // Left arrow / backspace in segments — back to groups
    if (this.section === "segments" && (data === "\x1b[D" || data === "h" || data === "\x7f")) {
      this.backToGroups();
      return;
    }

    // Delegate to current SettingsList
    this.currentList?.handleInput(data);
  }

  private get currentList(): SettingsList | null {
    if (this.section === "segments") return this.segmentList;
    return this.groupList;
  }

  // ─── Build SettingsList instances ──────────────────────────────────

  private buildGroupList(): void {
    const items: SettingItem[] = this.groups.map((group) => {
      const groupSettings = this.settings.groups[group.id] ?? { show: group.defaultShow, segments: {} };
      const isEnabled = groupSettings.show;
      const segCount = group.segments.length;
      const enabledCount = group.segments.filter(s => {
        const segOverride = groupSettings.segments?.[s.id];
        return segOverride !== undefined ? segOverride : s.defaultShow;
      }).length;

      return {
        id: group.id,
        label: group.name,
        description: `${enabledCount}/${segCount} segments active`,
        currentValue: isEnabled ? "on" : "off",
        values: ["on", "off"],
      };
    });

    this.groupList = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      THEME,
      (id, newValue) => this.onGroupChange(id, newValue),
      () => this.onClose?.(),
      { enableSearch: true },
    );
  }

  private buildSegmentList(groupId: string): void {
    const group = this.groups.find(g => g.id === groupId);
    if (!group) {
      this.segmentList = null;
      return;
    }

    const groupSettings = this.settings.groups[group.id] ?? { show: group.defaultShow, segments: {} };

    const items: SettingItem[] = group.segments.map((seg) => {
      const isEnabled = groupSettings.segments?.[seg.id] ?? seg.defaultShow;
      return {
        id: seg.id,
        label: seg.label,
        description: "",
        currentValue: isEnabled ? "on" : "off",
        values: ["on", "off"],
      };
    });

    this.segmentList = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      THEME,
      (id, newValue) => this.onSegmentChange(groupId, id, newValue),
      () => this.backToGroups(),
      { enableSearch: true },
    );
  }

  // ─── Change handlers ───────────────────────────────────────────────

  private onGroupChange(groupId: string, newValue: string): void {
    const groupSettings = this.settings.groups[groupId] ?? { show: true, segments: {} };
    groupSettings.show = newValue === "on";
    this.settings.groups[groupId] = groupSettings;
    saveFooterSettings(this.settings);

    // Update display
    this.groupList.updateValue(groupId, newValue);
  }

  private onSegmentChange(groupId: string, segmentId: string, newValue: string): void {
    const groupSettings = this.settings.groups[groupId] ?? { show: true, segments: {} };
    if (!groupSettings.segments) groupSettings.segments = {};
    groupSettings.segments[segmentId] = newValue === "on";
    this.settings.groups[groupId] = groupSettings;
    saveFooterSettings(this.settings);

    // Update the segment list display
    this.segmentList?.updateValue(segmentId, newValue);

    // Update group description (segment count)
    const group = this.groups.find(g => g.id === groupId);
    if (group) {
      const segCount = group.segments.length;
      const enabledCount = group.segments.filter(s => {
        const segOverride = groupSettings.segments?.[s.id];
        return segOverride !== undefined ? segOverride : s.defaultShow;
      }).length;
      this.groupList.updateValue(groupId, groupSettings.show ? "on" : "off");
    }
  }

  // ─── Section navigation ────────────────────────────────────────────

  private getFocusedGroupId(): string | null {
    // Walk the group list items in order; return the first one
    // that matches the focused index. Since SettingsList doesn't
    // expose selectedIndex, we track by the group array order.
    return this.selectedGroupId ?? this.groups[0]?.id ?? null;
  }

  private enterSegmentsMode(groupId: string): void {
    this.selectedGroupId = groupId;
    this.section = "segments";
    this.buildSegmentList(groupId);
  }

  private backToGroups(): void {
    this.section = "groups";
    this.selectedGroupId = null;
    this.segmentList = null;
  }

  // ─── Render ────────────────────────────────────────────────────────

  render(width: number): string[] {
    const innerWidth = Math.max(22, width - 2);
    const lines: string[] = [];

    // Header
    lines.push(borderLine(innerWidth, "top"));
    lines.push(frameLine(`\x1b[1m\x1b[36m⚙  Footer Settings\x1b[0m`, innerWidth));

    // Section tabs
    const tabParts = SECTIONS.map((s) => {
      const label = s.charAt(0).toUpperCase() + s.slice(1);
      if (s === this.section) {
        return `\x1b[1m\x1b[36m[${label}]\x1b[0m`;
      }
      if (s === "segments" && !this.selectedGroupId) {
        return `\x1b[2m${label}\x1b[0m`; // dimmed if no group selected
      }
      return `\x1b[2m${label}\x1b[0m`;
    });
    lines.push(frameLine(`  ${tabParts.join("  ")}`, innerWidth));
    lines.push(ruleLine(innerWidth));

    // Section content (rendered by SettingsList)
    const activeList = this.currentList;
    if (activeList) {
      const contentLines = activeList.render(innerWidth - 2);
      for (const line of contentLines) {
        lines.push(frameLine(` ${line}`, innerWidth));
      }
    }

    // Footer hints
    lines.push(ruleLine(innerWidth));
    const hints = this.section === "groups"
      ? "↑↓ navigate · Space toggle · Enter segments · / search · q close"
      : "↑↓ navigate · Space toggle · ← back · / search · q close";
    lines.push(frameLine(`\x1b[2m${hints}\x1b[0m`, innerWidth));
    lines.push(borderLine(innerWidth, "bottom"));

    return lines;
  }
}
