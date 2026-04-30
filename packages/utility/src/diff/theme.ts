/**
 * @pi-unipi/utility — Diff Theme System
 *
 * Color presets, resolution chain, and hex ↔ ANSI conversion for diff rendering.
 *
 * Resolution chain: env vars → per-color overrides → preset → auto-derive → hardcoded
 */

import { readDiffSettings, type DiffSettings } from "./settings.js";

// ─── Types ──────────────────────────────────────────────────────────────────────

/** Diff color configuration */
export interface DiffColors {
  /** Background for added lines */
  addBg: string;
  /** Foreground for added line content */
  addFg: string;
  /** Background for removed lines */
  remBg: string;
  /** Foreground for removed line content */
  remFg: string;
  /** Background for added word-level highlights */
  addWordBg: string;
  /** Background for removed word-level highlights */
  remWordBg: string;
  /** Hunk header foreground */
  hunkFg: string;
  /** Header info foreground */
  headerFg: string;
}

/** Diff theme preset */
export interface DiffPreset {
  name: string;
  description: string;
  colors: DiffColors;
}

/** An ANSI color code (e.g. "\x1b[38;2;255;0;0m") */
type AnsiColor = string;

// ─── Built-in Presets ───────────────────────────────────────────────────────────

const PRESETS: Record<string, DiffPreset> = {
  default: {
    name: "default",
    description: "Classic green/red diff colors",
    colors: {
      addBg: "#1a3a1a",
      addFg: "#b5e8b5",
      remBg: "#3a1a1a",
      remFg: "#e8b5b5",
      addWordBg: "#2d5a2d",
      remWordBg: "#5a2d2d",
      hunkFg: "#8888ff",
      headerFg: "#888888",
    },
  },
  midnight: {
    name: "midnight",
    description: "Deep blue-tinted diff colors",
    colors: {
      addBg: "#0a2a3a",
      addFg: "#a5d8e8",
      remBg: "#3a0a1a",
      remFg: "#e8a5c5",
      addWordBg: "#1a4a5a",
      remWordBg: "#5a1a3a",
      hunkFg: "#6688cc",
      headerFg: "#666688",
    },
  },
  subtle: {
    name: "subtle",
    description: "Muted, low-contrast diff colors",
    colors: {
      addBg: "#1e2e1e",
      addFg: "#a0b8a0",
      remBg: "#2e1e1e",
      remFg: "#b8a0a0",
      addWordBg: "#2a3a2a",
      remWordBg: "#3a2a2a",
      hunkFg: "#7777aa",
      headerFg: "#777777",
    },
  },
  neon: {
    name: "neon",
    description: "High-contrast vivid diff colors",
    colors: {
      addBg: "#003300",
      addFg: "#66ff66",
      remBg: "#330000",
      remFg: "#ff6666",
      addWordBg: "#005500",
      remWordBg: "#550000",
      hunkFg: "#6666ff",
      headerFg: "#999999",
    },
  },
};

/** Hardcoded fallback colors (last resort) */
const HARDCODED_FALLBACK: DiffColors = PRESETS.default.colors;

// ─── Preset Access ──────────────────────────────────────────────────────────────

/**
 * Get a diff preset by name. Falls back to "default" if not found.
 */
export function getPreset(name: string): DiffPreset {
  return PRESETS[name] ?? PRESETS.default;
}

/**
 * Get all available preset names.
 */
export function getPresetNames(): string[] {
  return Object.keys(PRESETS);
}

/**
 * Get all presets with their metadata.
 */
export function getAllPresets(): DiffPreset[] {
  return Object.values(PRESETS);
}

// ─── Hex ↔ ANSI Conversion ──────────────────────────────────────────────────────

/**
 * Parse a hex color string (#RRGGBB or #RGB) to [r, g, b].
 */
export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace(/^#/, "");
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return [r, g, b];
}

/**
 * Convert [r, g, b] to hex string (#RRGGBB).
 */
export function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Convert a hex color to ANSI 24-bit foreground escape.
 */
export function hexToFgAnsi(hex: string): AnsiColor {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * Convert a hex color to ANSI 24-bit background escape.
 */
export function hexToBgAnsi(hex: string): AnsiColor {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[48;2;${r};${g};${b}m`;
}

/**
 * Extract hex color from an ANSI 24-bit foreground escape sequence.
 * Returns null if not a 24-bit color.
 */
export function ansiFgToHex(ansi: string): string | null {
  const match = ansi.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
  if (!match) return null;
  return rgbToHex(parseInt(match[1]), parseInt(match[2]), parseInt(match[3]));
}

/**
 * Extract hex color from an ANSI 24-bit background escape sequence.
 * Returns null if not a 24-bit color.
 */
export function ansiBgToHex(ansi: string): string | null {
  const match = ansi.match(/\x1b\[48;2;(\d+);(\d+);(\d+)m/);
  if (!match) return null;
  return rgbToHex(parseInt(match[1]), parseInt(match[2]), parseInt(match[3]));
}

// ─── Color Resolution ───────────────────────────────────────────────────────────

/**
 * Load the diff configuration from settings.
 */
export function loadDiffConfig(): DiffSettings {
  return readDiffSettings();
}

/**
 * Mix a foreground color with a background color at a given ratio.
 * Used for auto-deriving diff backgrounds from pi theme accents.
 */
export function mixColors(fg: string, bg: string, ratio: number): string {
  const [fr, fg_, fb] = hexToRgb(fg);
  const [br, bg_, bb] = hexToRgb(bg);
  const r = Math.round(fr * ratio + br * (1 - ratio));
  const g = Math.round(fg_ * ratio + bg_ * (1 - ratio));
  const b = Math.round(fb * ratio + bb * (1 - ratio));
  return rgbToHex(r, g, b);
}

/**
 * Auto-derive diff background colors from a pi theme.
 * Mixes accent/success/error colors with a base background.
 */
export function autoDeriveBgFromTheme(theme: any): DiffColors | null {
  try {
    // Try to get theme colors from pi's Theme object
    const baseBg = theme?.colors?.customMessageBg || theme?.colors?.background || "#1a1a2e";
    const successColor = theme?.colors?.toolSuccess || theme?.colors?.success || "#22c55e";
    const errorColor = theme?.colors?.toolError || theme?.colors?.error || "#ef4444";

    return {
      addBg: mixColors(successColor, baseBg, 0.15),
      addFg: mixColors(successColor, "#ffffff", 0.7),
      remBg: mixColors(errorColor, baseBg, 0.15),
      remFg: mixColors(errorColor, "#ffffff", 0.7),
      addWordBg: mixColors(successColor, baseBg, 0.25),
      remWordBg: mixColors(errorColor, baseBg, 0.25),
      hunkFg: "#8888ff",
      headerFg: "#888888",
    };
  } catch {
    return null;
  }
}

/**
 * Check if a value looks like a hex color.
 */
function isHexColor(v: string): boolean {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);
}

/**
 * Resolve diff colors using the full chain:
 * env vars → per-color overrides → preset → auto-derive → hardcoded
 *
 * @param theme - Optional pi Theme object for auto-derivation
 */
export function resolveDiffColors(theme?: any): DiffColors {
  const config = loadDiffConfig();
  const preset = getPreset(config.theme);

  // Start with preset colors
  let colors = { ...preset.colors };

  // Layer: auto-derive from pi theme (if available)
  if (theme) {
    const derived = autoDeriveBgFromTheme(theme);
    if (derived) {
      // Auto-derived colors fill in where preset has defaults
      colors = {
        addBg: colors.addBg || derived.addBg,
        addFg: colors.addFg || derived.addFg,
        remBg: colors.remBg || derived.remBg,
        remFg: colors.remFg || derived.remFg,
        addWordBg: colors.addWordBg || derived.addWordBg,
        remWordBg: colors.remWordBg || derived.remWordBg,
        hunkFg: colors.hunkFg || derived.hunkFg,
        headerFg: colors.headerFg || derived.headerFg,
      };
    }
  }

  // Layer: environment variable overrides
  const envMap: Record<string, keyof DiffColors> = {
    DIFF_ADD_BG: "addBg",
    DIFF_ADD_FG: "addFg",
    DIFF_REM_BG: "remBg",
    DIFF_REM_FG: "remFg",
    DIFF_ADD_WORD_BG: "addWordBg",
    DIFF_REM_WORD_BG: "remWordBg",
    DIFF_HUNK_FG: "hunkFg",
    DIFF_HEADER_FG: "headerFg",
  };

  for (const [envKey, colorKey] of Object.entries(envMap)) {
    const envVal = process.env[envKey];
    if (envVal && isHexColor(envVal)) {
      colors[colorKey] = envVal;
    }
  }

  // Layer: per-color overrides from settings (if we add diffColors to settings later)
  // Currently deferred — spec says "Out of Scope"

  return colors;
}

/**
 * Apply the diff palette to create ANSI escape functions.
 * Returns an object with helper functions for coloring diff output.
 */
export function applyDiffPalette(theme?: any) {
  const colors = resolveDiffColors(theme);

  return {
    colors,
    addBg: (s: string) => `${hexToBgAnsi(colors.addBg)}${s}\x1b[0m`,
    addFg: (s: string) => `${hexToFgAnsi(colors.addFg)}${s}\x1b[0m`,
    remBg: (s: string) => `${hexToBgAnsi(colors.remBg)}${s}\x1b[0m`,
    remFg: (s: string) => `${hexToFgAnsi(colors.remFg)}${s}\x1b[0m`,
    addWordBg: (s: string) => `${hexToBgAnsi(colors.addWordBg)}${s}\x1b[0m`,
    remWordBg: (s: string) => `${hexToBgAnsi(colors.remWordBg)}${s}\x1b[0m`,
    hunkFg: (s: string) => `${hexToFgAnsi(colors.hunkFg)}${s}\x1b[0m`,
    headerFg: (s: string) => `${hexToFgAnsi(colors.headerFg)}${s}\x1b[0m`,
  };
}
