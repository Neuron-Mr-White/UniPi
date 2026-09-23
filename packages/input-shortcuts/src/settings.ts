/**
 * @pi-unipi/input-shortcuts — Settings
 *
 * Keybinding config (chordKey/tabInsertKey) registered with the unified
 * settings hub; the engine's migration imports the legacy
 * <cwd>/.unipi/config/input-shortcuts-config.json once on first read.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InputShortcutsConfig } from "./types.ts";
import { CONFIG_FILE, DEFAULT_CONFIG } from "./types.ts";
import { getSettings, registerSettings, setSettings, settingsLayers } from "@pi-unipi/core";

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

// ─── Keybinding id grammar (matches pi-tui keys.js parseKeyId/matchesKey) ────
// pi-tui parses ids as: lowercase, split on "+", last part = key, modifiers
// detected by membership (ctrl/alt/shift/super, any order, combinable).
// Valid keys: a-z, 0-9, ASCII symbols (SYMBOL_KEYS), f1-f12, and named keys
// (escape/esc, enter/return, tab, space, backspace, delete, insert, clear,
// home, end, pageup, pagedown, up, down, left, right).

const KEYBINDING_HINT =
  "format mod+key — mods: ctrl alt shift super (combine: ctrl+shift+x) · keys: a-z 0-9 f1-f12 space tab enter escape up down left right home end pageup pagedown";

const KEYBINDING_MODS = new Set(["ctrl", "alt", "shift", "super"]);
const KEYBINDING_SYMBOLS = new Set([
  "`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/",
  "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "+",
  "|", "~", "{", "}", ":", "<", ">", "?",
]);
const KEYBINDING_KEYS = new Set([
  "escape", "esc", "enter", "return", "tab", "space", "backspace", "delete",
  "insert", "clear", "home", "end", "pageup", "pagedown",
  "up", "down", "left", "right",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

/** Validate a pi-tui keybinding id ("mod+key"); returns an error or null. */
export function validateKeybinding(raw: string): string | null {
  const parts = raw.toLowerCase().split("+");
  const key = parts[parts.length - 1]!;
  const mods = parts.slice(0, -1);
  if (mods.length === 0 || key === "") {
    return `invalid key "${raw}" — expected mod+key like alt+s`;
  }
  if (!mods.every((m) => KEYBINDING_MODS.has(m)) || new Set(mods).size !== mods.length) {
    return `invalid key "${raw}" — mods: ctrl alt shift super`;
  }
  const single = key.length === 1 && ((key >= "a" && key <= "z") || (key >= "0" && key <= "9"));
  if (!single && !KEYBINDING_KEYS.has(key) && !KEYBINDING_SYMBOLS.has(key)) {
    return `invalid key "${raw}" — keys: a-z 0-9 f1-f12 or a named key (space, enter, escape, …)`;
  }
  return null;
}

// ─── Config persistence ─────────────────────────────────────────────────────

// Registered with the unified settings hub. Input-shortcuts config is
// project-scoped; the legacy <cwd>/.unipi/config/input-shortcuts-config.json
// is imported once on first read.
registerSettings({
  namespace: "input-shortcuts",
  label: "Input Shortcuts",
  defaults: { ...DEFAULT_CONFIG },
  schema: [
    {
      title: "Keys",
      description: "Key names as pi keybinding ids (e.g. alt+s)",
      fields: [
        {
          key: "chordKey",
          type: "enum",
          label: "Chord key",
          options: ["alt+s", "alt+d", "alt+x"],
          allowCustom: true,
          hint: KEYBINDING_HINT,
          validate: validateKeybinding,
        },
        {
          key: "tabInsertKey",
          type: "enum",
          label: "Tab-insert key",
          options: ["alt+i", "alt+o", "alt+p"],
          allowCustom: true,
          hint: KEYBINDING_HINT,
          validate: validateKeybinding,
        },
      ],
    },
  ],
});

/** One-time legacy import. */
function importLegacyInputShortcuts(): void {
  const layers = settingsLayers("input-shortcuts", process.cwd());
  if (layers.global || layers.project) return;
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    setSettings("input-shortcuts", JSON.parse(raw) as Record<string, unknown>, "project", process.cwd());
  } catch {
    // No legacy config — defaults apply.
  }
}

/** Load config (engine-layered), returns defaults if missing. */
export function loadConfig(baseDir?: string): InputShortcutsConfig {
  // Explicit baseDir (tests/registers) keeps reading the file directly.
  if (baseDir) {
    const filePath = join(baseDir, CONFIG_FILE);
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
  try {
    importLegacyInputShortcuts();
    const parsed = getSettings("input-shortcuts", process.cwd()) as Partial<InputShortcutsConfig>;
    return {
      chordKey: typeof parsed.chordKey === "string" ? parsed.chordKey : DEFAULT_CONFIG.chordKey,
      tabInsertKey: typeof parsed.tabInsertKey === "string" ? parsed.tabInsertKey : DEFAULT_CONFIG.tabInsertKey,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Save config (engine project scope; direct file when baseDir given). */
export function saveConfig(config: InputShortcutsConfig, baseDir?: string): void {
  if (!baseDir) {
    setSettings("input-shortcuts", { ...config }, "project", process.cwd());
    return;
  }
  const filePath = join(baseDir, CONFIG_FILE);
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
