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
