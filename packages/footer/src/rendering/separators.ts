/**
 * @pi-unipi/footer — Separator rendering
 *
 * Provides separator glyphs for all supported styles.
 * Uses Nerd Font characters when available, ASCII fallbacks otherwise.
 */

import type { SeparatorDef, SeparatorStyle } from "../types.js";

// ─── Nerd Font separator glyphs ─────────────────────────────────────────────

const NERD_SEPARATORS = {
  powerlineLeft: "\uE0B0",     // 
  powerlineRight: "\uE0B2",    // 
  powerlineThinLeft: "\uE0B1", // 
  powerlineThinRight: "\uE0B3", // 
  slash: "/",
  pipe: "|",
  dot: "\u00B7",               // ·
  asciiLeft: ">",
  asciiRight: "<",
} as const;

// ─── ASCII fallback separator glyphs ────────────────────────────────────────

const ASCII_SEPARATORS = {
  powerlineLeft: ">",
  powerlineRight: "<",
  powerlineThinLeft: "|",
  powerlineThinRight: "|",
  slash: "/",
  pipe: "|",
  dot: ".",
  asciiLeft: ">",
  asciiRight: "<",
} as const;

// ─── Nerd Font detection ────────────────────────────────────────────────────

/**
 * Detect whether the current terminal likely supports Nerd Font glyphs.
 * Checks TERM_PROGRAM for known terminals and optional env override.
 */
export function detectNerdFontSupport(): boolean {
  // Explicit overrides
  if (process.env.POWERLINE_NERD_FONTS === "1") return true;
  if (process.env.POWERLINE_NERD_FONTS === "0") return false;

  // Ghostty exposes GHOSTTY_RESOURCES_DIR even inside tmux
  if (process.env.GHOSTTY_RESOURCES_DIR) return true;

  // Check common terminals known to ship/bundle Nerd Fonts
  const term = (process.env.TERM_PROGRAM || "").toLowerCase();
  const nerdTerms = ["iterm", "wezterm", "kitty", "ghostty", "alacritty"];
  return nerdTerms.some(t => term.includes(t));
}

/**
 * Get the separator character set based on terminal capabilities.
 */
function getSeparatorChars() {
  return detectNerdFontSupport() ? NERD_SEPARATORS : ASCII_SEPARATORS;
}

// ─── Separator map ──────────────────────────────────────────────────────────

/**
 * Get separator definition for the given style.
 * Returns left and right glyph strings.
 */
export function getSeparator(style: SeparatorStyle): SeparatorDef {
  const chars = getSeparatorChars();

  switch (style) {
    case "powerline":
      return {
        left: chars.powerlineLeft,
        right: chars.powerlineRight,
      };

    case "powerline-thin":
      return {
        left: chars.powerlineThinLeft,
        right: chars.powerlineThinRight,
      };

    case "slash":
      return { left: ` ${chars.slash} `, right: ` ${chars.slash} ` };

    case "pipe":
      return { left: ` ${chars.pipe} `, right: ` ${chars.pipe} ` };

    case "dot":
      return { left: ` ${chars.dot} `, right: ` ${chars.dot} ` };

    case "ascii":
      return { left: ` ${chars.asciiLeft} `, right: ` ${chars.asciiRight} ` };

    default:
      return getSeparator("powerline-thin");
  }
}

/**
 * Get the visible width of a separator (ANSI-stripped length).
 */
export function separatorVisibleWidth(style: SeparatorStyle): number {
  const sep = getSeparator(style);
  // Strip ANSI codes and measure
  const stripped = sep.left.replace(/\x1b\[[0-9;]*m/g, "");
  return stripped.length;
}
