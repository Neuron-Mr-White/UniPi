/**
 * @pi-unipi/utility — Settings TUI Overlay
 *
 * Single TUI overlay for badge settings.
 */

import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ansi, TOGGLE_ON, TOGGLE_OFF } from "@pi-unipi/core";
import type { CachedModel } from "@pi-unipi/core";
import { readModelCache, boxInnerWidth } from "@pi-unipi/core";
import {
  readUtilSettings,
  writeUtilSettings,
  type UtilSettings,
} from "../settings.js";

/** ANSI escape codes */

/** Toggle symbols */

/** Active mode */
type Mode = "settings" | "model-picker";

/** Setting row types */
interface BooleanSetting {
  type: "boolean";
  key: string;
  label: string;
  description: string;
  getValue: (s: UtilSettings) => boolean;
}

interface PickerSetting {
  type: "picker";
  key: string;
  label: string;
  description: string;
  pickerType: "model";
  getValue: (s: UtilSettings) => string;
}

interface SectionHeader {
  type: "section";
  label: string;
}

type SettingItem = BooleanSetting | PickerSetting | SectionHeader;

/** All settings items */
const SETTINGS: SettingItem[] = [
  { type: "section", label: "Badge" },
  {
    type: "boolean",
    key: "autoGen",
    label: "Auto generate",
    description: "Generate session name on first user message",
    getValue: (s) => s.badge.autoGen,
  },
  {
    type: "boolean",
    key: "badgeEnabled",
    label: "Badge enabled",
    description: "Show the name badge overlay",
    getValue: (s) => s.badge.badgeEnabled,
  },
  {
    type: "boolean",
    key: "agentTool",
    label: "Agent tool",
    description: "Allow agents to call set_session_name",
    getValue: (s) => s.badge.agentTool,
  },
  {
    type: "picker",
    key: "generationModel",
    label: "Generation model",
    description: "Model for badge name generation",
    pickerType: "model",
    getValue: (s) => s.badge.generationModel,
  },
];

/**
 * Settings TUI overlay for badge configuration.
 */
export class UtilSettingsTui implements Component {
  private settings: UtilSettings;
  private mode: Mode = "settings";
  private selectedIndex = 0;
  private scrollOffset = 0;
  private models: CachedModel[] = [];

  onClose?: () => void;
  requestRender?: () => void;

  constructor() {
    this.settings = readUtilSettings();
    this.models = readModelCache();
  }

  invalidate(): void {}

  handleInput(data: string): void {
    switch (this.mode) {
      case "settings":
        this.handleSettingsInput(data);
        break;
      case "model-picker":
        this.handlePickerInput(data, this.getModelList(), "model");
        break;
    }
  }

  private handleSettingsInput(data: string): void {
    const navItems = SETTINGS.filter((s) => s.type !== "section");

    if (matchesKey(data, Key.up) || data === "k") {
      this.selectedIndex = (this.selectedIndex - 1 + navItems.length) % navItems.length;
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.selectedIndex = (this.selectedIndex + 1) % navItems.length;
    } else if (matchesKey(data, Key.space)) {
      this.toggleCurrentSetting();
    } else if (matchesKey(data, Key.enter)) {
      if (navItems[this.selectedIndex]?.type === "picker") {
        this.enterPicker(navItems[this.selectedIndex] as PickerSetting);
      } else {
        this.toggleCurrentSetting();
      }
    } else if (matchesKey(data, Key.escape)) {
      this.save();
      this.onClose?.();
    }
  }

  private handlePickerInput(data: string, items: Array<{ id: string; label: string }>, pickerType: string): void {
    if (matchesKey(data, Key.up) || data === "k") {
      this.scrollOffset = (this.scrollOffset - 1 + items.length) % items.length;
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.scrollOffset = (this.scrollOffset + 1) % items.length;
    } else if (matchesKey(data, Key.enter)) {
      this.selectPickerItem(items[this.scrollOffset], pickerType);
    } else if (matchesKey(data, Key.escape)) {
      this.mode = "settings";
    }
  }

  private toggleCurrentSetting(): void {
    const navItems = SETTINGS.filter((s) => s.type !== "section");
    const item = navItems[this.selectedIndex];
    if (!item || item.type !== "boolean") return;

    const current = item.getValue(this.settings);
    (this.settings.badge as any)[item.key] = !current;
    this.save();
  }

  private enterPicker(item: PickerSetting): void {
    switch (item.pickerType) {
      case "model":
        this.mode = "model-picker";
        this.scrollOffset = this.getModelList().findIndex((m) => m.id === this.settings.badge.generationModel);
        if (this.scrollOffset < 0) this.scrollOffset = 0;
        break;
    }
  }

  private selectPickerItem(item: { id: string; label: string }, pickerType: string): void {
    switch (pickerType) {
      case "model":
        this.settings.badge.generationModel = item.id;
        break;
    }
    this.mode = "settings";
    this.save();
  }

  private getModelList(): Array<{ id: string; label: string }> {
    const list: Array<{ id: string; label: string }> = [
      { id: "inherit", label: "inherit (use parent model)" },
    ];
    for (const m of this.models) {
      const fullId = `${m.provider}/${m.id}`;
      list.push({
        id: fullId,
        label: m.name ? `${fullId} (${m.name})` : fullId,
      });
    }
    return list;
  }

  private save(): void {
    writeUtilSettings(this.settings);
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const innerWidth = boxInnerWidth(width);

    const padVisible = (content: string, targetWidth: number): string => {
      const vw = visibleWidth(content);
      const pad = Math.max(0, targetWidth - vw);
      return content + " ".repeat(pad);
    };

    const add = (s: string) =>
      lines.push(
        `${ansi.cyan}│${ansi.reset}` +
          padVisible(truncateToWidth(s, innerWidth), innerWidth) +
          `${ansi.cyan}│${ansi.reset}`,
      );

    const addEmpty = () =>
      lines.push(
        `${ansi.cyan}│${ansi.reset}` +
          " ".repeat(innerWidth) +
          `${ansi.cyan}│${ansi.reset}`,
      );

    lines.push(`${ansi.cyan}╭${"─".repeat(innerWidth)}╮${ansi.reset}`);

    add(`${ansi.bold}${ansi.cyan}⚙ Utility Settings${ansi.reset}`);
    add(`${ansi.dim}Configure badge${ansi.reset}`);
    addEmpty();

    const navItems = SETTINGS.filter((s) => s.type !== "section");
    let navIndex = 0;

    for (const item of SETTINGS) {
      if (item.type === "section") {
        addEmpty();
        add(`${ansi.bold}${ansi.blue}── ${item.label} ──${ansi.reset}`);
        continue;
      }

      const isSelected = navIndex === this.selectedIndex && this.mode === "settings";
      const selector = isSelected ? `${ansi.cyan}▸${ansi.reset}` : " ";
      const labelColor = isSelected ? ansi.bold : ansi.dim;

      if (item.type === "boolean") {
        const value = item.getValue(this.settings);
        const toggle = value ? TOGGLE_ON : TOGGLE_OFF;
        add(`${selector} ${toggle} ${labelColor}${item.label}${ansi.reset}`);
        add(`   ${ansi.gray}${item.description}${ansi.reset}`);
      } else if (item.type === "picker") {
        const value = item.getValue(this.settings);
        add(
          `${selector} ${ansi.yellow}⚙${ansi.reset} ${labelColor}${item.label}${ansi.reset}: ${ansi.white}${value}${ansi.reset}`,
        );
        add(`   ${ansi.gray}${item.description}${ansi.reset}`);
        if (isSelected) {
          add(`   ${ansi.dim}Enter to select${ansi.reset}`);
        }
      }

      navIndex++;
    }

    if (this.mode !== "settings") {
      addEmpty();
      let items: Array<{ id: string; label: string }> = [];
      let title = "";

      switch (this.mode) {
        case "model-picker":
          items = this.getModelList();
          title = "Available Models";
          break;
      }

      add(`${ansi.bold}${ansi.cyan}── ${title} ──${ansi.reset}`);

      const visibleLines = 10;
      const start = Math.max(0, Math.min(this.scrollOffset, items.length - visibleLines));
      const end = Math.min(start + visibleLines, items.length);

      if (start > 0) {
        add(`  ${ansi.dim}▲ ${start} more above${ansi.reset}`);
      }

      for (let i = start; i < end; i++) {
        const m = items[i];
        const isItemSelected = i === this.scrollOffset;
        const itemSelector = isItemSelected ? `${ansi.cyan}▸${ansi.reset}` : " ";
        const itemLabelColor = isItemSelected ? ansi.bold + ansi.white : ansi.dim;

        add(`${itemSelector} ${itemLabelColor}${m.label}${ansi.reset}`);
      }

      if (end < items.length) {
        add(`  ${ansi.dim}▼ ${items.length - end} more below${ansi.reset}`);
      }
    }

    addEmpty();

    if (this.mode === "settings") {
      add(`${ansi.dim}↑↓ navigate • Space toggle • Enter select • Esc save+close${ansi.reset}`);
      add(`${ansi.dim}Config: .unipi/config/util-settings.json${ansi.reset}`);
    } else {
      add(`${ansi.dim}↑↓ navigate • Enter select • Esc cancel${ansi.reset}`);
    }

    lines.push(`${ansi.cyan}╰${"─".repeat(innerWidth)}╯${ansi.reset}`);

    return lines;
  }
}
