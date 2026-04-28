/**
 * @pi-unipi/kanboard — Settings TUI Component
 *
 * Interactive settings editor for kanboard module.
 * Badge settings are now managed by utility module via .unipi/config/badge.json.
 * This overlay provides a convenient TUI to edit them.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";

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
};

/** Toggle symbols */
const TOGGLE_ON = `${ansi.green}●${ansi.reset}`;
const TOGGLE_OFF = `${ansi.dim}○${ansi.reset}`;

/** Badge config path (same as utility module) */
const BADGE_CONFIG_PATH = ".unipi/config/badge.json";

/** Badge settings interface (mirrors utility's BadgeSettings) */
interface BadgeSettings {
  autoGen: boolean;
  badgeEnabled: boolean;
  agentTool: boolean;
}

/** Default settings */
const DEFAULT_SETTINGS: BadgeSettings = {
  autoGen: true,
  badgeEnabled: true,
  agentTool: true,
};

/** Setting items */
interface SettingItem {
  key: string;
  label: string;
  description: string;
  getValue: (settings: BadgeSettings) => boolean;
  setValue: (settings: BadgeSettings, value: boolean) => void;
}

/** List of configurable settings */
const SETTINGS: SettingItem[] = [
  {
    key: "autoGen",
    label: "Auto generate",
    description: "Generate session name on first user message",
    getValue: (s) => s.autoGen,
    setValue: (s, v) => (s.autoGen = v),
  },
  {
    key: "badgeEnabled",
    label: "Badge enabled",
    description: "Show the name badge overlay",
    getValue: (s) => s.badgeEnabled,
    setValue: (s, v) => (s.badgeEnabled = v),
  },
  {
    key: "agentTool",
    label: "Agent tool",
    description: "Allow agents to call set_session_name",
    getValue: (s) => s.agentTool,
    setValue: (s, v) => (s.agentTool = v),
  },
];

/**
 * Read badge settings from disk.
 */
function readSettings(): BadgeSettings {
  try {
    const configPath = path.resolve(process.cwd(), BADGE_CONFIG_PATH);
    if (!fs.existsSync(configPath)) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return {
      autoGen: typeof parsed.autoGen === "boolean" ? parsed.autoGen : DEFAULT_SETTINGS.autoGen,
      badgeEnabled: typeof parsed.badgeEnabled === "boolean" ? parsed.badgeEnabled : DEFAULT_SETTINGS.badgeEnabled,
      agentTool: typeof parsed.agentTool === "boolean" ? parsed.agentTool : DEFAULT_SETTINGS.agentTool,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Write badge settings to disk.
 */
function saveSettings(settings: BadgeSettings): void {
  try {
    const configPath = path.resolve(process.cwd(), BADGE_CONFIG_PATH);
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  } catch {
    // Best effort
  }
}

/**
 * Settings overlay component for kanboard.
 * Edits badge settings stored in .unipi/config/badge.json.
 */
export class KanboardSettingsOverlay implements Component {
  private settings: BadgeSettings;
  private selectedIndex = 0;
  /** Callback when overlay should close */
  onClose?: () => void;

  constructor() {
    this.settings = readSettings();
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
    saveSettings(this.settings);
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
    add(`${ansi.bold}${ansi.cyan}Badge Settings${ansi.reset}`);
    add(`${ansi.dim}Configure badge generation behavior${ansi.reset}`);
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
    add(`${ansi.dim}Config: ${BADGE_CONFIG_PATH}${ansi.reset}`);

    // Bottom border
    lines.push(`${ansi.cyan}╰${"─".repeat(innerWidth)}╯${ansi.reset}`);

    return lines;
  }
}
