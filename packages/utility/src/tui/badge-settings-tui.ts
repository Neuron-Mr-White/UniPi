/**
 * @pi-unipi/utility — Badge Settings TUI Overlay
 *
 * Interactive settings overlay for badge configuration.
 * Three settings: auto-generate toggle, badge-enabled toggle, generation model selector.
 * Model list loaded from shared model cache (~/.unipi/config/models-cache.json).
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { CachedModel } from "@pi-unipi/core";
import { readModelCache } from "@pi-unipi/core";
import {
  readBadgeSettings,
  writeBadgeSettings,
  type BadgeSettings,
} from "./badge-settings.js";

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
};

/** Toggle symbols */
const TOGGLE_ON = `${ansi.green}●${ansi.reset}`;
const TOGGLE_OFF = `${ansi.dim}○${ansi.reset}`;

/** Active mode */
type Mode = "settings" | "model-picker";

/** Setting row types */
interface BooleanSetting {
  type: "boolean";
  key: keyof BadgeSettings;
  label: string;
  description: string;
  getValue: (s: BadgeSettings) => boolean;
}

interface ModelSetting {
  type: "model";
  key: "generationModel";
  label: string;
  description: string;
}

type SettingItem = BooleanSetting | ModelSetting;

/** Settings list */
const SETTINGS: SettingItem[] = [
  {
    type: "boolean",
    key: "autoGen",
    label: "Auto generate",
    description: "Generate session name on first user message",
    getValue: (s) => s.autoGen,
  },
  {
    type: "boolean",
    key: "badgeEnabled",
    label: "Badge enabled",
    description: "Show the name badge overlay",
    getValue: (s) => s.badgeEnabled,
  },
  {
    type: "model",
    key: "generationModel",
    label: "Generation model",
    description: "Model to use for badge name generation",
  },
];

/**
 * Badge Settings TUI overlay.
 * Implements the Component interface for use with ctx.ui.custom().
 */
export class BadgeSettingsTui implements Component {
  private settings: BadgeSettings;
  private mode: Mode = "settings";
  private selectedIndex = 0;
  private modelScrollOffset = 0;
  private models: CachedModel[] = [];

  /** Theme reference for rendering (set externally) */
  private _theme: any = null;

  /** Callback when overlay should close */
  onClose?: () => void;

  /** Callback to request a re-render */
  requestRender?: () => void;

  constructor() {
    this.settings = readBadgeSettings();
    this.models = readModelCache();
  }

  /**
   * Set the pi-tui theme for styled rendering.
   */
  setTheme(theme: any): void {
    this._theme = theme;
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
    if (this.mode === "settings") {
      this.handleSettingsInput(data);
    } else {
      this.handleModelPickerInput(data);
    }
  }

  /**
   * Handle input in settings mode.
   */
  private handleSettingsInput(data: string): void {
    switch (data) {
      case "\x1b[A": // Up arrow
      case "k":
        this.selectedIndex =
          (this.selectedIndex - 1 + SETTINGS.length) % SETTINGS.length;
        break;
      case "\x1b[B": // Down arrow
      case "j":
        this.selectedIndex = (this.selectedIndex + 1) % SETTINGS.length;
        break;
      case " ": // Space — toggle boolean settings
        this.toggleCurrentSetting();
        break;
      case "\r": // Enter — open model picker or toggle
        if (SETTINGS[this.selectedIndex].type === "model") {
          this.enterModelPicker();
        } else {
          this.toggleCurrentSetting();
        }
        break;
      case "\x1b": // Escape — close and save
        this.save();
        this.onClose?.();
        break;
    }
  }

  /**
   * Handle input in model picker mode.
   */
  private handleModelPickerInput(data: string): void {
    const allModels = this.getModelList();

    switch (data) {
      case "\x1b[A": // Up arrow
      case "k":
        this.selectedIndex =
          (this.selectedIndex - 1 + allModels.length) % allModels.length;
        this.adjustModelScroll(allModels.length);
        break;
      case "\x1b[B": // Down arrow
      case "j":
        this.selectedIndex = (this.selectedIndex + 1) % allModels.length;
        this.adjustModelScroll(allModels.length);
        break;
      case "\r": // Enter — select model
        this.selectModel();
        break;
      case "\x1b": // Escape — cancel picker
        this.mode = "settings";
        this.selectedIndex = SETTINGS.findIndex(
          (s) => s.key === "generationModel",
        );
        break;
    }
  }

  /**
   * Toggle the currently selected boolean setting.
   */
  private toggleCurrentSetting(): void {
    const item = SETTINGS[this.selectedIndex];
    if (item.type !== "boolean") return;

    const current = item.getValue(this.settings);
    (this.settings as any)[item.key] = !current;
    this.save();
  }

  /**
   * Enter model picker mode.
   */
  private enterModelPicker(): void {
    this.mode = "model-picker";
    const allModels = this.getModelList();
    const currentModel = this.settings.generationModel;
    this.selectedIndex = allModels.findIndex((m) => m.id === currentModel);
    if (this.selectedIndex < 0) this.selectedIndex = 0;
    this.modelScrollOffset = 0;
    this.adjustModelScroll(allModels.length);
  }

  /**
   * Select the current model in the picker.
   */
  private selectModel(): void {
    const allModels = this.getModelList();
    const selected = allModels[this.selectedIndex];
    if (selected) {
      this.settings.generationModel = selected.id;
      this.save();
    }
    this.mode = "settings";
    this.selectedIndex = SETTINGS.findIndex((s) => s.key === "generationModel");
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
   * Adjust scroll offset so the selected item is visible.
   */
  private adjustModelScroll(totalItems: number): void {
    // Reserve ~10 lines for visible model list
    const visibleLines = 10;
    if (this.selectedIndex < this.modelScrollOffset) {
      this.modelScrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.modelScrollOffset + visibleLines) {
      this.modelScrollOffset = this.selectedIndex - visibleLines + 1;
    }
    // Clamp
    this.modelScrollOffset = Math.max(
      0,
      Math.min(this.modelScrollOffset, totalItems - visibleLines),
    );
  }

  /**
   * Save settings to disk.
   */
  private save(): void {
    writeBadgeSettings(this.settings);
  }

  /**
   * Render the overlay.
   */
  render(width: number): string[] {
    const lines: string[] = [];
    const innerWidth = Math.max(44, width - 2);

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
    add(`${ansi.bold}${ansi.cyan}Badge Settings${ansi.reset}`);
    add(`${ansi.dim}Configure badge generation behavior${ansi.reset}`);
    addEmpty();

    // Settings list
    for (let i = 0; i < SETTINGS.length; i++) {
      const item = SETTINGS[i];
      const isSelected = i === this.selectedIndex && this.mode === "settings";
      const selector = isSelected ? `${ansi.cyan}▸${ansi.reset}` : " ";

      if (item.type === "boolean") {
        const value = item.getValue(this.settings);
        const toggle = value ? TOGGLE_ON : TOGGLE_OFF;
        const labelColor = isSelected ? ansi.bold : ansi.dim;

        add(
          `${selector} ${toggle} ${labelColor}${item.label}${ansi.reset}`,
        );
        add(`   ${ansi.gray}${item.description}${ansi.reset}`);
      } else if (item.type === "model") {
        const labelColor = isSelected ? ansi.bold : ansi.dim;
        const modelDisplay = this.settings.generationModel;

        add(
          `${selector} ${ansi.yellow}⚙${ansi.reset} ${labelColor}${item.label}${ansi.reset}: ${ansi.white}${modelDisplay}${ansi.reset}`,
        );
        add(`   ${ansi.gray}${item.description}${ansi.reset}`);
        add(`   ${ansi.dim}Enter to select model${ansi.reset}`);
      }
    }

    // Model picker (inline)
    if (this.mode === "model-picker") {
      addEmpty();
      add(`${ansi.bold}${ansi.cyan}── Available Models ──${ansi.reset}`);

      const allModels = this.getModelList();
      const visibleLines = 10;
      const start = this.modelScrollOffset;
      const end = Math.min(start + visibleLines, allModels.length);

      // Scroll indicator up
      if (start > 0) {
        add(`  ${ansi.dim}▲ ${start} more above${ansi.reset}`);
      }

      for (let i = start; i < end; i++) {
        const m = allModels[i];
        const isSelected = i === this.selectedIndex;
        const selector = isSelected ? `${ansi.cyan}▸${ansi.reset}` : " ";
        const labelColor = isSelected ? ansi.bold + ansi.white : ansi.dim;

        add(
          `${selector} ${labelColor}${m.label}${ansi.reset}`,
        );
      }

      // Scroll indicator down
      if (end < allModels.length) {
        add(
          `  ${ansi.dim}▼ ${allModels.length - end} more below${ansi.reset}`,
        );
      }
    }

    // Footer
    addEmpty();

    if (this.mode === "model-picker") {
      add(
        `${ansi.dim}↑↓ navigate • Enter select • Esc cancel${ansi.reset}`,
      );
    } else {
      add(
        `${ansi.dim}↑↓ navigate • Space toggle • Enter select model • Esc close${ansi.reset}`,
      );
      add(`${ansi.dim}Config: .unipi/config/badge.json${ansi.reset}`);
    }

    // Bottom border
    lines.push(`${ansi.cyan}╰${"─".repeat(innerWidth)}╯${ansi.reset}`);

    return lines;
  }
}
