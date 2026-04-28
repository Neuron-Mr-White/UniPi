/**
 * @pi-unipi/ask-user — Settings TUI Component
 *
 * Interactive settings editor for ask_user tool.
 * Allows enabling/disabling the tool and configuring allowed question formats.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { getAskUserSettings, saveAskUserSettings, type AskUserSettings } from "./config.js";

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

/** Setting items */
interface SettingItem {
  key: string;
  label: string;
  description: string;
  getValue: (settings: AskUserSettings) => boolean;
  setValue: (settings: AskUserSettings, value: boolean) => void;
}

/** List of configurable settings */
const SETTINGS: SettingItem[] = [
  {
    key: "enabled",
    label: "Enable ask_user tool",
    description: "Allow the agent to ask structured questions",
    getValue: (s) => s.enabled,
    setValue: (s, v) => (s.enabled = v),
  },
  {
    key: "singleSelect",
    label: "Allow single-select",
    description: "Questions with one correct answer",
    getValue: (s) => s.allowedFormats.singleSelect,
    setValue: (s, v) => (s.allowedFormats.singleSelect = v),
  },
  {
    key: "multiSelect",
    label: "Allow multi-select",
    description: "Questions with multiple correct answers",
    getValue: (s) => s.allowedFormats.multiSelect,
    setValue: (s, v) => (s.allowedFormats.multiSelect = v),
  },
  {
    key: "freeform",
    label: "Allow freeform text",
    description: "Open-ended questions with text input",
    getValue: (s) => s.allowedFormats.freeform,
    setValue: (s, v) => (s.allowedFormats.freeform = v),
  },
];

/**
 * Settings overlay component.
 */
export class AskUserSettingsOverlay implements Component {
  private settings: AskUserSettings;
  private selectedIndex = 0;
  /** Callback when overlay should close */
  onClose?: () => void;

  constructor() {
    this.settings = getAskUserSettings();
  }

  /**
   * Invalidate cached render state.
   */
  invalidate(): void {
    // No cached state
  }

  /**
   * Handle keyboard input.
   */
  handleInput(data: string): void {
    switch (data) {
      case "\x1b[A": // Up
      case "k":
        this.selectedIndex = (this.selectedIndex - 1 + SETTINGS.length) % SETTINGS.length;
        break;
      case "\x1b[B": // Down
      case "j":
        this.selectedIndex = (this.selectedIndex + 1) % SETTINGS.length;
        break;
      case " ": // Space - toggle
        this.toggleSetting(SETTINGS[this.selectedIndex].key);
        break;
      case "\r": // Enter - save and close
        this.save();
        this.onClose?.();
        break;
      case "\x1b": // Escape - close without saving
        this.onClose?.();
        break;
    }
  }

  /**
   * Toggle a setting by key.
   */
  private toggleSetting(key: string): void {
    const item = SETTINGS.find((s) => s.key === key);
    if (!item) return;
    const current = item.getValue(this.settings);
    item.setValue(this.settings, !current);
  }

  /**
   * Save settings to disk.
   */
  private save(): void {
    saveAskUserSettings(this.settings);
  }

  /**
   * Render the overlay.
   */
  render(width: number): string[] {
    const lines: string[] = [];
    const innerWidth = Math.max(40, width - 2);

    function padVisible(content: string, targetWidth: number): string {
      const vw = visibleWidth(content);
      const pad = Math.max(0, targetWidth - vw);
      return content + " ".repeat(pad);
    }

    const add = (s: string) => lines.push(`${ansi.cyan}│${ansi.reset}` + padVisible(truncateToWidth(s, innerWidth), innerWidth) + `${ansi.cyan}│${ansi.reset}`);
    const addEmpty = () => lines.push(`${ansi.cyan}│${ansi.reset}` + " ".repeat(innerWidth) + `${ansi.cyan}│${ansi.reset}`);

    // Top border
    lines.push(`${ansi.cyan}╭${"─".repeat(innerWidth)}╮${ansi.reset}`);

    // Header
    add(`${ansi.bold}${ansi.cyan}Ask User Settings${ansi.reset}`);
    add(`${ansi.dim}Configure how the agent can ask you questions${ansi.reset}`);
    addEmpty();

    // Settings list
    for (let i = 0; i < SETTINGS.length; i++) {
      const item = SETTINGS[i];
      const isSelected = i === this.selectedIndex;
      const value = item.getValue(this.settings);
      const toggle = value ? TOGGLE_ON : TOGGLE_OFF;
      const labelColor = isSelected ? ansi.bold : ansi.dim;
      const descColor = ansi.gray;

      add(`${isSelected ? ansi.cyan + "▸" + ansi.reset : " "} ${toggle} ${labelColor}${item.label}${ansi.reset}`);
      add(`   ${descColor}${item.description}${ansi.reset}`);
    }

    // Footer
    addEmpty();
    add(`${ansi.dim}↑↓ navigate • Space toggle • Enter save • Esc cancel${ansi.reset}`);

    // Bottom border
    lines.push(`${ansi.cyan}╰${"─".repeat(innerWidth)}╯${ansi.reset}`);

    return lines;
  }
}