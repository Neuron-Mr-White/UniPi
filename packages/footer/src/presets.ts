/**
 * @pi-unipi/footer — Presets system
 *
 * Preset definitions: default, minimal, compact, full, nerd, ascii.
 * Each preset defines which segments appear on left, right, and secondary rows,
 * plus separator style and color scheme.
 */

import type { PresetDef, SeparatorStyle, ColorScheme } from "./types.js";
import { getDefaultColors } from "./rendering/theme.js";

/** Default preset — balanced view */
const DEFAULT_PRESET: PresetDef = {
  leftSegments: [
    "model", "api_state", "tool_count", "git",
  ],
  rightSegments: [
    "clock", "duration",
  ],
  secondarySegments: [
    "current_command", "session",
  ],
  separator: "powerline-thin",
  colors: getDefaultColors(),
};

/** Minimal preset — just the essentials */
const MINIMAL_PRESET: PresetDef = {
  leftSegments: [
    "model", "git",
  ],
  rightSegments: [
    "clock",
  ],
  secondarySegments: [],
  separator: "pipe",
  colors: getDefaultColors(),
};

/** Compact preset — core + key stats */
const COMPACT_PRESET: PresetDef = {
  leftSegments: [
    "model", "git",
  ],
  rightSegments: [
    "clock", "duration",
  ],
  secondarySegments: [],
  separator: "dot",
  colors: getDefaultColors(),
};

/** Full preset — everything */
const FULL_PRESET: PresetDef = {
  leftSegments: [
    "model", "api_state", "tool_count", "git", "session",
  ],
  rightSegments: [
    "clock", "duration",
  ],
  secondarySegments: [
    "hostname",
    "platforms_enabled", "last_sent",
    "tokens_in", "tokens_out",
  ],
  separator: "powerline-thin",
  colors: getDefaultColors(),
};

/** Nerd preset — maximum detail for Nerd Font users */
const NERD_PRESET: PresetDef = {
  leftSegments: [
    "model", "api_state", "tool_count", "git", "session",
  ],
  rightSegments: [
    "clock", "duration",
  ],
  secondarySegments: [
    "hostname",
    "compression_ratio", "indexed_docs",
    "platforms_enabled", "last_sent",
    "tokens_in", "tokens_out",
  ],
  separator: "powerline",
  colors: getDefaultColors(),
};

/** ASCII preset — safe for any terminal */
const ASCII_PRESET: PresetDef = {
  leftSegments: [
    "model", "git",
  ],
  rightSegments: [
    "clock", "duration",
  ],
  secondarySegments: [],
  separator: "ascii",
  colors: getDefaultColors(),
};

/** All preset definitions */
export const PRESETS: Record<string, PresetDef> = {
  default: DEFAULT_PRESET,
  minimal: MINIMAL_PRESET,
  compact: COMPACT_PRESET,
  full: FULL_PRESET,
  nerd: NERD_PRESET,
  ascii: ASCII_PRESET,
};

/** Valid preset names */
export const PRESET_NAMES = Object.keys(PRESETS);

/**
 * Get a preset definition by name.
 * Falls back to "default" if the name is not recognized.
 */
export function getPreset(name: string): PresetDef {
  return PRESETS[name] ?? PRESETS.default ?? DEFAULT_PRESET;
}
