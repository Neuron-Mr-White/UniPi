/**
 * @pi-unipi/footer — Presets system
 *
 * Preset definitions: default, minimal, compact, full, nerd, ascii.
 * Each preset defines which segments appear (left/center/right/secondary),
 * plus separator style and color scheme.
 *
 * Segments are grouped by their zone field regardless of which array they're
 * listed in. The arrays define ordering within the preset.
 */

import type { PresetDef, SeparatorStyle, ColorScheme } from "./types.js";
import { getDefaultColors } from "./rendering/theme.js";

/** Default preset — balanced view */
const DEFAULT_PRESET: PresetDef = {
  leftSegments: [
    "model", "api_state", "tool_count", "git",
  ],
  rightSegments: [
    "tps", "context_pct", "cost",
    "compactions", "tokens_saved", "project_count",
    "current_command", "loop_status", "extension_statuses",
    "clock", "duration",
  ],
  secondarySegments: [
    "session",
  ],
  colors: getDefaultColors(),
};

/** Minimal preset — just the essentials */
const MINIMAL_PRESET: PresetDef = {
  leftSegments: [
    "model", "git",
  ],
  rightSegments: [
    "context_pct",
    "clock",
  ],
  secondarySegments: [],
  colors: getDefaultColors(),
};

/** Compact preset — core + key stats */
const COMPACT_PRESET: PresetDef = {
  leftSegments: [
    "model", "git",
  ],
  rightSegments: [
    "tps", "context_pct", "cost",
    "clock", "duration",
  ],
  secondarySegments: [],
  colors: getDefaultColors(),
};

/** Full preset — everything */
const FULL_PRESET: PresetDef = {
  leftSegments: [
    "model", "api_state", "tool_count", "git", "current_command", "session",
  ],
  rightSegments: [
    "tps", "context_pct", "cost", "tokens_total",
    "session_events", "compactions", "tokens_saved",
    "project_count", "total_count",
    "servers_total", "servers_active", "tools_total",
    "active_loops", "loop_status",
    "docs_count", "tasks_done", "task_pct",
    "extension_statuses",
    "clock", "duration",
  ],
  secondarySegments: [
    "hostname",
    "tokens_in", "tokens_out",
    "compression_ratio", "indexed_docs",
    "platforms_enabled", "last_sent",
    "thinking_level",
  ],
  colors: getDefaultColors(),
};

/** Nerd preset — maximum detail for Nerd Font users */
const NERD_PRESET: PresetDef = {
  leftSegments: [
    "model", "api_state", "tool_count", "git", "current_command", "session",
  ],
  rightSegments: [
    "tps", "context_pct", "cost", "tokens_total",
    "session_events", "compactions", "tokens_saved",
    "project_count", "total_count",
    "servers_total", "servers_active", "tools_total",
    "active_loops", "loop_status",
    "docs_count", "tasks_done", "task_pct",
    "extension_statuses",
    "clock", "duration",
  ],
  secondarySegments: [
    "hostname",
    "tokens_in", "tokens_out",
    "compression_ratio", "indexed_docs",
    "platforms_enabled", "last_sent",
    "thinking_level",
  ],
  colors: getDefaultColors(),
};

/** ASCII preset — safe for any terminal */
const ASCII_PRESET: PresetDef = {
  leftSegments: [
    "model", "git",
  ],
  rightSegments: [
    "tps", "context_pct", "cost",
    "clock", "duration",
  ],
  secondarySegments: [],
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
