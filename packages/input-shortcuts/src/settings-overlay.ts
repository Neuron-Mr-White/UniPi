/**
 * Settings TUI overlay for customizing shortcut keybindings.
 * Uses SettingsList from pi-tui following compactor pattern.
 * Persists config to .unipi/config/input-shortcuts-config.json.
 */

import type { Component } from "@mariozechner/pi-tui";
import { SettingsList, type SettingItem, type SettingsListTheme } from "@mariozechner/pi-tui";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InputShortcutsConfig } from "./types.ts";
import { CONFIG_FILE, DEFAULT_CONFIG } from "./types.ts";

// ─── Available ALT key options ───────────────────────────────────────────────

const ALT_KEY_OPTIONS = [
  "alt+a", "alt+b", "alt+c", "alt+d", "alt+e", "alt+f", "alt+g",
  "alt+h", "alt+i", "alt+j", "alt+k", "alt+l", "alt+m", "alt+n",
  "alt+o", "alt+p", "alt+q", "alt+r", "alt+s", "alt+t", "alt+u",
  "alt+v", "alt+w", "alt+x", "alt+y", "alt+z",
];

// Known conflicts — exclude from options
const CONFLICTS = new Set(["alt+e"]); // alt+e = cursorWordRight

const FREE_ALT_KEYS = ALT_KEY_OPTIONS.filter((k) => !CONFLICTS.has(k));

// ─── Config persistence ─────────────────────────────────────────────────────

/** Load config from disk, returns defaults if missing. */
export function loadConfig(baseDir?: string): InputShortcutsConfig {
  const filePath = baseDir ? join(baseDir, CONFIG_FILE) : CONFIG_FILE;
  try {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<InputShortcutsConfig>;
      return {
        chordKey: typeof parsed.chordKey === "string" ? parsed.chordKey : DEFAULT_CONFIG.chordKey,
        tabInsertKey: typeof parsed.tabInsertKey === "string" ? parsed.tabInsertKey : DEFAULT_CONFIG.tabInsertKey,
      };
    }
  } catch {
    // Fall through to defaults
  }
  return { ...DEFAULT_CONFIG };
}

/** Save config to disk with atomic write. */
export function saveConfig(config: InputShortcutsConfig, baseDir?: string): void {
  const filePath = baseDir ? join(baseDir, CONFIG_FILE) : CONFIG_FILE;
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmpPath = filePath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
    renameSync(tmpPath, filePath);
  } catch {
    // Silent fail — config persistence is best-effort
  }
}

// ─── SettingsOverlay Component ──────────────────────────────────────────────

const THEME: SettingsListTheme = {
  label: (text, selected) => (selected ? `\x1b[1;36m${text}\x1b[0m` : text),
  value: (text, selected) => (selected ? `\x1b[1;33m${text}\x1b[0m` : `\x1b[33m${text}\x1b[0m`),
  description: (text) => `\x1b[2m${text}\x1b[0m`,
  cursor: "▸ ",
  hint: (text) => `\x1b[2m${text}\x1b[0m`,
};

export class SettingsOverlay implements Component {
  private list: SettingsList;
  private config: InputShortcutsConfig;
  private baseDir?: string;
  private onSaved?: (config: InputShortcutsConfig) => void;

  constructor(
    done: () => void,
    baseDir?: string,
    onSaved?: (config: InputShortcutsConfig) => void,
  ) {
    this.baseDir = baseDir;
    this.onSaved = onSaved;
    this.config = loadConfig(baseDir);

    const items = this.buildItems();
    this.list = new SettingsList(
      items,
      10,
      THEME,
      (id, newValue) => this.handleChange(id, newValue),
      () => {
        saveConfig(this.config, this.baseDir);
        this.onSaved?.(this.config);
        done();
      },
    );
  }

  private buildItems(): SettingItem[] {
    return [
      {
        id: "chordKey",
        label: "Chord trigger key",
        description: "Key to open the input shortcuts overlay",
        currentValue: this.config.chordKey,
        values: FREE_ALT_KEYS,
      },
      {
        id: "tabInsertKey",
        label: "Tab insert key",
        description: "Key to insert a literal tab character",
        currentValue: this.config.tabInsertKey,
        values: FREE_ALT_KEYS,
      },
    ];
  }

  private handleChange(id: string, newValue: string): void {
    if (id === "chordKey") {
      this.config.chordKey = newValue;
    } else if (id === "tabInsertKey") {
      this.config.tabInsertKey = newValue;
    }
    this.list.updateValue(id, newValue);
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    return this.list.render(width);
  }
}
