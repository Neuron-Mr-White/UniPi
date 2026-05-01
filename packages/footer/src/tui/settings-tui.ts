/**
 * @pi-unipi/footer — Settings TUI
 *
 * Unified settings overlay with 3 categories:
 * - Appearance: preset, separator, icon style, full labels
 * - Segments: group → segment drill-down
 * - Labels & Help: label mode, zone headers
 *
 * Uses pi-tui SettingsList for vim/arrow keybinding support.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SettingsList, type SettingItem, type SettingsListTheme } from "@mariozechner/pi-tui";
import { loadFooterSettings, saveFooterSettings } from "../config.js";
import { PRESET_NAMES } from "../presets.js";
import { setIconStyle } from "../rendering/icons.js";
import type { FooterGroup, FooterSettings, SeparatorStyle, IconStyle } from "../types.js";

// ─── Section types ─────────────────────────────────────────────────────

type Section = "appearance" | "segments" | "labels";
const SECTIONS: Section[] = ["appearance", "segments", "labels"];
const SECTION_LABELS: Record<Section, string> = {
  appearance: "Appearance",
  segments: "Segments",
  labels: "Labels & Help",
};

// ─── Valid option values ───────────────────────────────────────────────

const SEPARATOR_STYLES: SeparatorStyle[] = ["powerline", "powerline-thin", "slash", "pipe", "dot", "ascii"];
const ICON_STYLES: IconStyle[] = ["nerd", "emoji", "text"];

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

class FooterSettingsOverlay {
  private settings: FooterSettings;
  private groups: FooterGroup[];
  private section: Section = "appearance";
  private selectedGroupId: string | null = null;
  onClose?: () => void;

  // Per-section SettingsList instances
  private appearanceList!: SettingsList;
  private groupList!: SettingsList;
  private segmentList: SettingsList | null = null;
  private labelsList!: SettingsList;

  constructor(groups: FooterGroup[]) {
    this.settings = loadFooterSettings();
    this.groups = groups;
    this.buildAppearanceList();
    this.buildGroupList();
    this.buildLabelsList();
  }

  invalidate(): void {
    this.appearanceList?.invalidate();
    this.groupList?.invalidate();
    this.segmentList?.invalidate();
    this.labelsList?.invalidate();
  }

  handleInput(data: string): void {
    // Tab cycles sections
    if (data === "\t" || data === "\x1b[Z") {
      const idx = SECTIONS.indexOf(this.section);
      if (data === "\t") {
        this.section = SECTIONS[(idx + 1) % SECTIONS.length];
      } else {
        this.section = SECTIONS[(idx - 1 + SECTIONS.length) % SECTIONS.length];
      }
      // If leaving segments drill-down, go back to groups
      if (this.section !== "segments") {
        this.selectedGroupId = null;
        this.segmentList = null;
      }
      return;
    }

    // Escape / q — close
    if (data === "\x1b" || data === "q") {
      this.onClose?.();
      return;
    }

    // Enter in segments/groups mode — enter segments for the focused group
    if (data === "\r" && this.section === "segments" && !this.selectedGroupId) {
      const focusedId = this.getFocusedGroupId();
      if (focusedId) {
        this.enterSegmentsMode(focusedId);
      }
      return;
    }

    // Left arrow / backspace in segment drill-down — back to groups
    if (this.section === "segments" && this.selectedGroupId && (data === "\x1b[D" || data === "h" || data === "\x7f")) {
      this.backToGroups();
      return;
    }

    // Delegate to current SettingsList
    this.currentList?.handleInput(data);
  }

  private get currentList(): SettingsList | null {
    switch (this.section) {
      case "appearance": return this.appearanceList;
      case "segments":
        return this.segmentList ?? this.groupList;
      case "labels": return this.labelsList;
    }
  }

  // ─── Build SettingsList instances ──────────────────────────────────

  private buildAppearanceList(): void {
    const items: SettingItem[] = [
      {
        id: "preset",
        label: "Preset",
        description: "Footer layout preset",
        currentValue: this.settings.preset,
        values: PRESET_NAMES,
      },
      {
        id: "separator",
        label: "Separator",
        description: "Segment divider style",
        currentValue: this.settings.separator,
        values: SEPARATOR_STYLES,
      },
      {
        id: "iconStyle",
        label: "Icon Style",
        description: "Icon glyph set (nerd requires Nerd Font)",
        currentValue: this.settings.iconStyle,
        values: ICON_STYLES,
      },
      {
        id: "showFullLabels",
        label: "Full Labels",
        description: "Show descriptive labels instead of abbreviations",
        currentValue: this.settings.showFullLabels ? "on" : "off",
        values: ["on", "off"],
      },
    ];

    this.appearanceList = new SettingsList(
      items,
      Math.min(items.length + 2, 12),
      THEME,
      (id, newValue) => this.onAppearanceChange(id, newValue),
      () => this.onClose?.(),
      { enableSearch: false },
    );
  }

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
        description: `${enabledCount}/${segCount} segments · Enter to drill down`,
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
        label: `${seg.shortLabel}  ${seg.label}`,
        description: seg.description,
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

  private buildLabelsList(): void {
    const items: SettingItem[] = [
      {
        id: "showFullLabelsAlways",
        label: "Full Labels",
        description: "Always show descriptive labels instead of abbreviations",
        currentValue: this.settings.showFullLabels ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "showZoneHeaders",
        label: "Zone Headers",
        description: "Show zone labels (Identity / Metrics / Time)",
        currentValue: "off", // TODO: implement zone headers
        values: ["on", "off"],
      },
    ];

    this.labelsList = new SettingsList(
      items,
      Math.min(items.length + 2, 12),
      THEME,
      (id, newValue) => this.onLabelsChange(id, newValue),
      () => this.onClose?.(),
      { enableSearch: false },
    );
  }

  // ─── Change handlers ───────────────────────────────────────────────

  private onAppearanceChange(id: string, newValue: string): void {
    switch (id) {
      case "preset":
        this.settings.preset = newValue;
        break;
      case "separator":
        this.settings.separator = newValue as SeparatorStyle;
        break;
      case "iconStyle":
        this.settings.iconStyle = newValue as IconStyle;
        setIconStyle(newValue as IconStyle);
        break;
      case "showFullLabels":
        this.settings.showFullLabels = newValue === "on";
        // Sync with labels section
        this.labelsList.updateValue("showFullLabelsAlways", newValue);
        break;
    }
    saveFooterSettings(this.settings);
    this.appearanceList.updateValue(id, newValue);
  }

  private onGroupChange(groupId: string, newValue: string): void {
    const groupSettings = this.settings.groups[groupId] ?? { show: true, segments: {} };
    groupSettings.show = newValue === "on";
    this.settings.groups[groupId] = groupSettings;
    saveFooterSettings(this.settings);
    this.groupList.updateValue(groupId, newValue);
  }

  private onSegmentChange(groupId: string, segmentId: string, newValue: string): void {
    const groupSettings = this.settings.groups[groupId] ?? { show: true, segments: {} };
    if (!groupSettings.segments) groupSettings.segments = {};
    groupSettings.segments[segmentId] = newValue === "on";
    this.settings.groups[groupId] = groupSettings;
    saveFooterSettings(this.settings);
    this.segmentList?.updateValue(segmentId, newValue);
  }

  private onLabelsChange(id: string, newValue: string): void {
    switch (id) {
      case "showFullLabelsAlways":
        this.settings.showFullLabels = newValue === "on";
        // Sync with appearance section
        this.appearanceList.updateValue("showFullLabels", newValue);
        break;
      case "showZoneHeaders":
        // TODO: implement zone headers setting
        break;
    }
    saveFooterSettings(this.settings);
    this.labelsList.updateValue(id, newValue);
  }

  // ─── Section navigation ────────────────────────────────────────────

  private getFocusedGroupId(): string | null {
    return this.selectedGroupId ?? this.groups[0]?.id ?? null;
  }

  private enterSegmentsMode(groupId: string): void {
    this.selectedGroupId = groupId;
    this.buildSegmentList(groupId);
  }

  private backToGroups(): void {
    this.selectedGroupId = null;
    this.segmentList = null;
    // Rebuild group list to reflect segment changes
    this.buildGroupList();
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
      const label = SECTION_LABELS[s];
      if (s === this.section) {
        return `\x1b[1m\x1b[36m[${label}]\x1b[0m`;
      }
      return `\x1b[2m${label}\x1b[0m`;
    });
    lines.push(frameLine(`  ${tabParts.join("  ")}`, innerWidth));
    lines.push(ruleLine(innerWidth));

    // Section content
    const activeList = this.currentList;
    if (activeList) {
      const contentLines = activeList.render(innerWidth - 2);
      for (const line of contentLines) {
        lines.push(frameLine(` ${line}`, innerWidth));
      }
    }

    // Footer hints
    lines.push(ruleLine(innerWidth));

    let hints: string;
    if (this.section === "segments" && this.selectedGroupId) {
      hints = "↑↓ navigate · Space toggle · ← back · / search · q close";
    } else if (this.section === "segments") {
      hints = "↑↓ navigate · Space toggle · Enter segments · / search · q close";
    } else {
      hints = "↑↓ navigate · Space/Enter change · Tab section · q close";
    }
    lines.push(frameLine(`\x1b[2m${hints}\x1b[0m`, innerWidth));
    lines.push(borderLine(innerWidth, "bottom"));

    return lines;
  }
}
