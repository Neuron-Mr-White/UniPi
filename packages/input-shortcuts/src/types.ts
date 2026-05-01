/**
 * Shared type definitions for input-shortcuts package.
 */

export interface TextSnapshot {
  text: string;
  timestamp: number;
}

export interface RegisterData {
  stash: string;
  registers: string[];
}

export interface InputShortcutsConfig {
  chordKey: string;
  tabInsertKey: string;
}

export type ChordAction =
  | "stash"
  | "redo"
  | "undo"
  | "appendRegister"
  | "appendStash"
  | "copy"
  | "cut"
  | "toggleThinking"
  | "tab";

export type ChordState = "idle" | "chord_root" | "chord_reg";

export const DEFAULT_CONFIG: InputShortcutsConfig = {
  chordKey: "alt+s",
  tabInsertKey: "alt+i",
};

// ─── Constants ──────────────────────────────────────────────────────────────

export const UNDO_DEBOUNCE_MS = 500;
export const MAX_UNDO_SNAPSHOTS = 50;
export const STATUS_SUCCESS_MS = 2000;
export const STATUS_ERROR_MS = 3000;
export const REGISTERS_FILE = ".unipi/config/input-shortcuts.json";
export const CONFIG_FILE = ".unipi/config/input-shortcuts-config.json";

// Thinking level cycle for toggle action
export const THINKING_CYCLE = ["off", "low", "medium", "high", "xhigh"] as const;
