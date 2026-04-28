/**
 * @pi-unipi/kanboard — Settings TUI Component
 *
 * Interactive settings editor for kanboard module.
 * Allows configuring auto badge generation and other kanboard behaviors.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

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

/** Settings path */
const SETTINGS_PATH = path.join(homedir(), ".pi", "agent", "settings.json");

/** Kanboard settings interface */
interface KanboardSettings {
  autoBadgeGen: boolean;
}

/** Default settings */
const DEFAULT_SETTINGS: KanboardSettings = {
  autoBadgeGen: true,
};

/** Setting items */
interface SettingItem {
  key: string;
  label: string;
  description: string;
  getValue: (settings: KanboardSettings) => boolean;
  setValue: (settings: KanboardSettings, value: boolean) => void;
}

/** List of configurable settings */
const SETTINGS: SettingItem[] = [
  {
    key: "autoBadgeGen",
    label: "Auto badge generation",
    description: "Generate session name badge on first user message",
    getValue: (s) => s.autoBadgeGen,
    setValue: (s, v) => (s.autoBadgeGen = v),
  },
];

/**
 * Read kanboard settings from disk.
 */
function readSettings(): KanboardSettings {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    const kanboard = parsed?.unipi?.kanboard;
    if (kanboard && typeof kanboard === "object") {
      return {
        autoBadgeGen: typeof kanboard.autoBadgeGen === "boolean"
          ? kanboard.autoBadgeGen
          : DEFAULT_SETTINGS.autoBadgeGen,
      };
    }
    return { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Write kanboard settings to disk.
 */
function saveSettings(settings: KanboardSettings): void {
  try {
    let parsed: Record<string, unknown> = {};
    if (fs.existsSync(SETTINGS_PATH)) {
      parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    }
    if (!parsed.unipi || typeof parsed.unipi !== "object") {
      parsed.unipi = {};
    }
    (parsed.unipi as Record<string, unknown>).kanboard = settings;
    const dir = path.dirname(SETTINGS_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
  } catch {
    // Best effort
  }
}

/**
 * Settings overlay component for kanboard.
 */
export class KanboardSettingsOverlay implements Component {
  private settings: KanboardSettings;
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
    add(`${ansi.bold}${ansi.cyan}Kanboard Settings${ansi.reset}`);
    add(`${ansi.dim}Configure kanboard module behavior${ansi.reset}`);
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
