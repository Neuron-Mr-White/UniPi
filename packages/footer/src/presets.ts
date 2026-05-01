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
    "model", "api_state", "tool_count", "git", "context_pct", "cost",
  ],
  rightSegments: [
    "compactions", "tokens_saved", "project_count", "loop_status",
  ],
  secondarySegments: [
    "current_command", "session_events",
  ],
  separator: "powerline-thin",
  colors: getDefaultColors(),
};

/** Minimal preset — just the essentials */
const MINIMAL_PRESET: PresetDef = {
  leftSegments: [
    "git", "context_pct",
  ],
  rightSegments: [],
  secondarySegments: [],
  separator: "pipe",
  colors: getDefaultColors(),
};

/** Compact preset — core + key stats */
const COMPACT_PRESET: PresetDef = {
  leftSegments: [
    "model", "git", "cost", "context_pct",
  ],
  rightSegments: [
    "compactions", "total_count",
  ],
  secondarySegments: [],
  separator: "dot",
  colors: getDefaultColors(),
};

/** Full preset — everything */
const FULL_PRESET: PresetDef = {
  leftSegments: [
    "model", "api_state", "tool_count", "git", "context_pct", "cost",
    "tokens_total", "tokens_in", "tokens_out",
  ],
  rightSegments: [
    "session_events", "compactions", "tokens_saved", "compression_ratio",
    "indexed_docs", "sandbox_runs", "search_queries",
    "project_count", "total_count", "consolidations",
    "servers_total", "servers_active", "tools_total", "servers_failed",
    "active_loops", "total_iterations", "loop_status",
    "current_command", "command_duration",
    "docs_count", "tasks_done", "tasks_total", "task_pct",
    "extension_statuses",
  ],
  secondarySegments: [
    "platforms_enabled", "last_sent",
  ],
  separator: "powerline-thin",
  colors: getDefaultColors(),
};

/** Nerd preset — maximum detail for Nerd Font users */
const NERD_PRESET: PresetDef = {
  leftSegments: [
    "model", "api_state", "tool_count", "git", "context_pct", "cost",
    "tokens_total",
  ],
  rightSegments: [
    "session_events", "compactions", "tokens_saved",
    "project_count", "total_count",
    "servers_total", "servers_active", "tools_total",
    "active_loops", "loop_status",
    "current_command",
    "docs_count", "tasks_done", "tasks_total", "task_pct",
    "extension_statuses",
  ],
  secondarySegments: [
    "compression_ratio", "indexed_docs",
    "platforms_enabled", "last_sent",
  ],
  separator: "powerline",
  colors: getDefaultColors(),
};

/** ASCII preset — safe for any terminal */
const ASCII_PRESET: PresetDef = {
  leftSegments: [
    "model", "git", "context_pct", "cost",
  ],
  rightSegments: [
    "compactions", "tokens_saved", "project_count",
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
