/**
 * @pi-unipi/utility — Terminal Capabilities Detection
 *
 * Detect terminal features for optimal rendering:
 * - Color support (basic, 256, truecolor)
 * - Nerd Font detection
 * - Unicode support
 * - Terminal dimensions
 */

import type { TerminalCapabilities } from "../types.js";

/** Cached capabilities per process */
let cachedCapabilities: TerminalCapabilities | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5000; // Re-detect every 5s

/** Detect color support level */
function detectColorSupport(): { color: boolean; truecolor: boolean } {
  const env = process.env;

  // No color
  if (env.NO_COLOR || env.NODE_DISABLE_COLORS) {
    return { color: false, truecolor: false };
  }

  // Force color
  if (env.FORCE_COLOR) {
    const level = parseInt(env.FORCE_COLOR, 10);
    return {
      color: level >= 1,
      truecolor: level >= 3,
    };
  }

  // CI environments typically support colors
  if (env.CI) {
    return { color: true, truecolor: false };
  }

  // Terminal emulator detection
  const term = env.TERM || "";
  const termProgram = env.TERM_PROGRAM || "";

  // Truecolor support
  const truecolorTerms = [
    "truecolor",
    "24bit",
    "xterm-256color",
    "screen-256color",
    "tmux-256color",
    "alacritty",
    "kitty",
    "wezterm",
    "iTerm",
    "ghostty",
  ];

  const hasTruecolor =
    env.COLORTERM === "truecolor" ||
    env.COLORTERM === "24bit" ||
    truecolorTerms.some((t) => term.includes(t) || termProgram.includes(t));

  // Basic color support
  const hasColor =
    hasTruecolor ||
    term.includes("color") ||
    term.includes("ansi") ||
    term.includes("xterm") ||
    term.includes("screen") ||
    term.includes("tmux") ||
    termProgram.length > 0;

  return { color: hasColor, truecolor: hasTruecolor };
}

/** Detect Nerd Font support */
function detectNerdFont(): boolean {
  const env = process.env;

  // Explicit override
  if (env.NERD_FONT === "1" || env.NERD_FONT === "true") {
    return true;
  }
  if (env.NERD_FONT === "0" || env.NERD_FONT === "false") {
    return false;
  }

  // Terminal emulator hints
  const termProgram = env.TERM_PROGRAM || "";
  const knownNerdFontTerminals = [
    "iTerm.app",
    "WezTerm",
    "Alacritty",
    "Kitty",
    "Ghostty",
    "Warp",
  ];

  if (knownNerdFontTerminals.some((t) => termProgram.includes(t))) {
    return true;
  }

  // Default to false for safety
  return false;
}

/** Detect Unicode support level */
function detectUnicode(): "none" | "basic" | "full" {
  const env = process.env;

  // Explicit override
  if (env.UNICODE === "0" || env.NO_UNICODE) {
    return "none";
  }

  // LANG/LC_ALL hints
  const locale = env.LANG || env.LC_ALL || env.LC_CTYPE || "";
  if (locale.includes("UTF-8") || locale.includes("utf8")) {
    return "full";
  }

  // Windows CMD typically has limited Unicode
  if (process.platform === "win32" && !env.WT_SESSION) {
    return "basic";
  }

  // Default to basic (safe middle ground)
  return "basic";
}

/** Get terminal dimensions */
function getTerminalSize(): { width: number; height: number } {
  const stdout = process.stdout;
  if (stdout && stdout.isTTY) {
    const cols = stdout.columns || 80;
    const rows = stdout.rows || 24;
    return { width: cols, height: rows };
  }
  return { width: 80, height: 24 };
}

/**
 * Detect terminal capabilities.
 * Results are cached for CACHE_TTL_MS to avoid repeated detection.
 */
export function detectCapabilities(): TerminalCapabilities {
  const now = Date.now();
  if (cachedCapabilities && now - cacheTimestamp < CACHE_TTL_MS) {
    // Update dimensions even when cached (they change on resize)
    const size = getTerminalSize();
    return {
      ...cachedCapabilities,
      width: size.width,
      height: size.height,
    };
  }

  const colorSupport = detectColorSupport();
  const size = getTerminalSize();

  cachedCapabilities = {
    color: colorSupport.color,
    truecolor: colorSupport.truecolor,
    nerdFont: detectNerdFont(),
    unicode: detectUnicode(),
    width: size.width,
    height: size.height,
  };

  cacheTimestamp = now;
  return cachedCapabilities;
}

/** Force re-detection of capabilities */
export function refreshCapabilities(): TerminalCapabilities {
  cachedCapabilities = null;
  cacheTimestamp = 0;
  return detectCapabilities();
}

/** Check if a specific capability is available */
export function hasCapability(
  cap: keyof TerminalCapabilities,
): boolean {
  const caps = detectCapabilities();
  const value = caps[cap];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value !== "none";
  }
  return false;
}

/** Get safe icon based on Nerd Font availability */
export function getIcon(nerdFont: string, fallback: string): string {
  return detectCapabilities().nerdFont ? nerdFont : fallback;
}
