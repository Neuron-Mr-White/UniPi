/**
 * Shared type definitions for input-shortcuts package.
 */

export interface RegisterData {
  stash: string;
}

export interface InputShortcutsConfig {
  chordKey: string;
  tabInsertKey: string;
}

export type ChordAction =
  | "stash"
  | "redo"
  | "undo"
  | "appendStash"
  | "copyLastResponse"
  | "kanboard"
  | "tab";

/** The overlay shows only the root menu; Esc/unknown key closes silently. */
export type ChordState = "idle" | "chord_root";

export const DEFAULT_CONFIG: InputShortcutsConfig = {
  chordKey: "alt+s",
  tabInsertKey: "alt+i",
};

// ─── Constants ──────────────────────────────────────────────────────────────

export const STATUS_SUCCESS_MS = 2000;
export const STATUS_ERROR_MS = 3000;
export const REGISTERS_FILE = ".unipi/config/input-shortcuts.json";
export const CONFIG_FILE = ".unipi/config/input-shortcuts-config.json";
