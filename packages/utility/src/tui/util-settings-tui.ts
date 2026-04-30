/**
 * @pi-unipi/utility — Unified Settings TUI Overlay
 *
 * Single TUI overlay with two navigable sections:
 * - Badge: autoGen, badgeEnabled, agentTool, generationModel
 * - Diff Rendering: enabled, theme preset, shikiTheme
 *
 * Replaces badge-settings-tui.ts as the primary settings interface.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { CachedModel } from "@pi-unipi/core";
import { readModelCache } from "@pi-unipi/core";
import {
  readUtilSettings,
  writeUtilSettings,
  type UtilSettings,
  type BadgeSettingsSection,
  type DiffSettings,
} from "../diff/settings.js";
import { getAllPresets } from "../diff/theme.js";

/** ANSI escape codes */
const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  white: "\x1b[37m",
  blue: "\x1b[34m",
};

/** Toggle symbols */
const TOGGLE_ON = `${ansi.green}●${ansi.reset}`;
const TOGGLE_OFF = `${ansi.dim}○${ansi.reset}`;

/** Active mode */
type Mode = "settings" | "model-picker" | "theme-picker" | "shiki-picker";

/** Setting row types */
interface BooleanSetting {
  type: "boolean";
  section: "badge" | "diff";
  key: string;
  label: string;
  description: string;
  getValue: (s: UtilSettings) => boolean;
}

interface PickerSetting {
  type: "picker";
  section: "badge" | "diff";
  key: string;
  label: string;
  description: string;
  pickerType: "model" | "theme" | "shiki";
  getValue: (s: UtilSettings) => string;
}

interface SectionHeader {
  type: "section";
  label: string;
}

type SettingItem = BooleanSetting | PickerSetting | SectionHeader;

/** All settings items */
const SETTINGS: SettingItem[] = [
  // Badge section
  { type: "section", label: "Badge" },
  {
    type: "boolean",
    section: "badge",
    key: "autoGen",
    label: "Auto generate",
    description: "Generate session name on first user message",
    getValue: (s) => s.badge.autoGen,
  },
  {
    type: "boolean",
    section: "badge",
    key: "badgeEnabled",
    label: "Badge enabled",
    description: "Show the name badge overlay",
    getValue: (s) => s.badge.badgeEnabled,
  },
  {
    type: "boolean",
    section: "badge",
    key: "agentTool",
    label: "Agent tool",
    description: "Allow agents to call set_session_name",
    getValue: (s) => s.badge.agentTool,
  },
  {
    type: "picker",
    section: "badge",
    key: "generationModel",
    label: "Generation model",
    description: "Model for badge name generation",
    pickerType: "model",
    getValue: (s) => s.badge.generationModel,
  },
  // Diff Rendering section
  { type: "section", label: "Diff Rendering" },
  {
    type: "boolean",
    section: "diff",
    key: "enabled",
    label: "Enabled",
    description: "Shiki-powered syntax-highlighted diffs",
    getValue: (s) => s.diff.enabled,
  },
  {
    type: "picker",
    section: "diff",
    key: "theme",
    label: "Theme",
    description: "Diff color preset",
    pickerType: "theme",
    getValue: (s) => s.diff.theme,
  },
  {
    type: "picker",
    section: "diff",
    key: "shikiTheme",
    label: "Shiki theme",
    description: "Syntax highlighting grammar",
    pickerType: "shiki",
    getValue: (s) => s.diff.shikiTheme,
  },
];

/** List of known Shiki themes */
const SHIKI_THEMES = [
  "github-dark",
  "github-light",
  "dracula",
  "one-dark-pro",
  "catppuccin-mocha",
  "catppuccin-latte",
  "nord",
  "tokyo-night",
  "tokyo-night-storm",
  "night-owl",
  "material-theme",
  "material-theme-palenight",
  "monokai",
  "solarized-dark",
  "solarized-light",
  "vitesse-dark",
  "vitesse-light",
  "ayu-dark",
  "ayu-mirage",
  "slack-dark",
  "slack-ochin",
];

/**
 * Unified Settings TUI overlay.
 * Combines badge and diff settings in a single navigable interface.
 */
export class UtilSettingsTui implements Component {
  private settings: UtilSettings;
  private mode: Mode = "settings";
  private selectedIndex = 0;
  private scrollOffset = 0;
  private models: CachedModel[] = [];

  /** Callback when overlay should close */
  onClose?: () => void;

  /** Callback to request a re-render */
  requestRender?: () => void;

  constructor() {
    this.settings = readUtilSettings();
    this.models = readModelCache();
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
    switch (this.mode) {
      case "settings":
        this.handleSettingsInput(data);
        break;
      case "model-picker":
        this.handlePickerInput(data, this.getModelList(), "model");
        break;
      case "theme-picker":
        this.handlePickerInput(data, this.getThemeList(), "theme");
        break;
      case "shiki-picker":
        this.handlePickerInput(data, this.getShikiList(), "shiki");
        break;
    }
  }

  /**
   * Handle input in settings mode.
   */
  private handleSettingsInput(data: string): void {
    // Get navigable items (skip section headers)
    const navItems = SETTINGS.filter((s) => s.type !== "section");

    switch (data) {
      case "\x1b[A": // Up arrow
      case "k":
        this.selectedIndex = (this.selectedIndex - 1 + navItems.length) % navItems.length;
        break;
      case "\x1b[B": // Down arrow
      case "j":
        this.selectedIndex = (this.selectedIndex + 1) % navItems.length;
        break;
      case " ": // Space — toggle boolean settings
        this.toggleCurrentSetting();
        break;
      case "\r": // Enter — open picker or toggle
        if (navItems[this.selectedIndex]?.type === "picker") {
          this.enterPicker(navItems[this.selectedIndex] as PickerSetting);
        } else {
          this.toggleCurrentSetting();
        }
        break;
      case "\x1b": // Escape — save and close
        this.save();
        this.onClose?.();
        break;
    }
  }

  /**
   * Handle input in picker mode.
   */
  private handlePickerInput(data: string, items: Array<{ id: string; label: string }>, pickerType: string): void {
    switch (data) {
      case "\x1b[A": // Up arrow
      case "k":
        this.scrollOffset = (this.scrollOffset - 1 + items.length) % items.length;
        break;
      case "\x1b[B": // Down arrow
      case "j":
        this.scrollOffset = (this.scrollOffset + 1) % items.length;
        break;
      case "\r": // Enter — select
        this.selectPickerItem(items[this.scrollOffset], pickerType);
        break;
      case "\x1b": // Escape — cancel
        this.mode = "settings";
        break;
    }
  }

  /**
   * Toggle the currently selected boolean setting.
   */
  private toggleCurrentSetting(): void {
    const navItems = SETTINGS.filter((s) => s.type !== "section");
    const item = navItems[this.selectedIndex];
    if (!item || item.type !== "boolean") return;

    const current = item.getValue(this.settings);
    if (item.section === "badge") {
      (this.settings.badge as any)[item.key] = !current;
    } else {
      (this.settings.diff as any)[item.key] = !current;
    }
    this.save();
  }

  /**
   * Enter picker mode for a setting.
   */
  private enterPicker(item: PickerSetting): void {
    switch (item.pickerType) {
      case "model":
        this.mode = "model-picker";
        this.scrollOffset = this.getModelList().findIndex((m) => m.id === this.settings.badge.generationModel);
        if (this.scrollOffset < 0) this.scrollOffset = 0;
        break;
      case "theme":
        this.mode = "theme-picker";
        this.scrollOffset = getAllPresets().findIndex((p) => p.name === this.settings.diff.theme);
        if (this.scrollOffset < 0) this.scrollOffset = 0;
        break;
      case "shiki":
        this.mode = "shiki-picker";
        this.scrollOffset = SHIKI_THEMES.indexOf(this.settings.diff.shikiTheme);
        if (this.scrollOffset < 0) this.scrollOffset = 0;
        break;
    }
  }

  /**
   * Select an item in a picker.
   */
  private selectPickerItem(item: { id: string; label: string }, pickerType: string): void {
    switch (pickerType) {
      case "model":
        this.settings.badge.generationModel = item.id;
        break;
      case "theme":
        this.settings.diff.theme = item.id;
        break;
      case "shiki":
        this.settings.diff.shikiTheme = item.id;
        break;
    }
    this.mode = "settings";
    this.save();
  }

  /**
   * Get model list with "inherit" as first entry.
   */
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

  /**
   * Get diff theme preset list.
   */
  private getThemeList(): Array<{ id: string; label: string }> {
    return getAllPresets().map((p) => ({
      id: p.name,
      label: `${p.name} — ${p.description}`,
    }));
  }

  /**
   * Get Shiki theme list.
   */
  private getShikiList(): Array<{ id: string; label: string }> {
    return SHIKI_THEMES.map((t) => ({ id: t, label: t }));
  }

  /**
   * Save settings to disk.
   */
  private save(): void {
    writeUtilSettings(this.settings);
  }

  /**
   * Render the overlay.
   */
  render(width: number): string[] {
    const lines: string[] = [];
    const innerWidth = Math.max(52, width - 2);

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

    // Top border
    lines.push(`${ansi.cyan}╭${"─".repeat(innerWidth)}╮${ansi.reset}`);

    // Header
    add(`${ansi.bold}${ansi.cyan}⚙ Utility Settings${ansi.reset}`);
    add(`${ansi.dim}Configure badge and diff rendering${ansi.reset}`);
    addEmpty();

    // Settings list
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
        const icon = item.pickerType === "model" ? "⚙" : "🎨";
        add(
          `${selector} ${ansi.yellow}${icon}${ansi.reset} ${labelColor}${item.label}${ansi.reset}: ${ansi.white}${value}${ansi.reset}`,
        );
        add(`   ${ansi.gray}${item.description}${ansi.reset}`);
        if (isSelected) {
          add(`   ${ansi.dim}Enter to select${ansi.reset}`);
        }
      }

      navIndex++;
    }

    // Picker overlay (inline)
    if (this.mode !== "settings") {
      addEmpty();
      let items: Array<{ id: string; label: string }> = [];
      let title = "";

      switch (this.mode) {
        case "model-picker":
          items = this.getModelList();
          title = "Available Models";
          break;
        case "theme-picker":
          items = this.getThemeList();
          title = "Diff Theme Presets";
          break;
        case "shiki-picker":
          items = this.getShikiList();
          title = "Shiki Themes";
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

    // Footer
    addEmpty();

    if (this.mode === "settings") {
      add(`${ansi.dim}↑↓ navigate • Space toggle • Enter select • Esc save+close${ansi.reset}`);
      add(`${ansi.dim}Config: .unipi/config/util-settings.json${ansi.reset}`);
    } else {
      add(`${ansi.dim}↑↓ navigate • Enter select • Esc cancel${ansi.reset}`);
    }

    // Bottom border
    lines.push(`${ansi.cyan}╰${"─".repeat(innerWidth)}╯${ansi.reset}`);

    return lines;
  }
}
