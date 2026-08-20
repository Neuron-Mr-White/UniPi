/**
 * @pi-unipi/footer — Theme color resolution
 *
 * Maps semantic color names to pi theme colors. Supports
 * hex overrides via ColorScheme.
 *
 * Color emission is capability-aware: hex values are emitted as 24-bit
 * truecolor on terminals that advertise truecolor (COLORTERM or known
 * truecolor TERM_PROGRAM), and gracefully downgraded to the nearest
 * xterm-256 index on legacy terminals (notably Apple Terminal.app, which
 * silently swallows 24-bit escapes and renders the text uncoloured).
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ColorScheme, SemanticColor, ThemeLike } from "../types.js";

// ─── Color mode detection ──────────────────────────────────────────────────

/**
 * Detected colour-emission mode for the current terminal.
 *  - `truecolor` → emit 24-bit `\x1b[38;2;R;G;Bm`
 *  - `256`       → emit 8-bit  `\x1b[38;5;Nm` (nearest xterm-256 index)
 *  - `none`      → emit no colour codes (plain text)
 */
export type ColorMode = "truecolor" | "256" | "none";

/** Manual override (set via `setColorMode`) — wins over env-based detection. */
let manualMode: ColorMode | null = null;
/** Cached detection result; cleared by `refreshColorMode()`. */
let detectedMode: ColorMode | null = null;

/** Terminals known to honour 24-bit truecolor escapes. */
const TRUECOLOR_TERM_PROGRAMS = [
  "iTerm.app",
  "WezTerm",
  "Alacritty",
  "vscode",
  "Hyper",
  "Warp",
  "ghostty",
  "Ghostty",
  "zed",
  "Zed",
  "cursor",
  "Cursor",
];

/**
 * Detect the colour mode of the current terminal from environment.
 * Respects `NO_COLOR`, `FORCE_COLOR`, then sniffs `COLORTERM` / `TERM_PROGRAM`
 * / `TERM`. Apple Terminal is explicitly capped at 256-colour.
 */
function detectColorMode(): ColorMode {
  const env = process.env;
  if (env.NO_COLOR || env.NODE_DISABLE_COLORS) return "none";
  if (env.FORCE_COLOR) {
    const lvl = parseInt(env.FORCE_COLOR, 10);
    if (Number.isNaN(lvl)) return "truecolor"; // any non-numeric truthy value
    if (lvl >= 3) return "truecolor";
    if (lvl >= 1) return "256";
    return "none";
  }
  const term = env.TERM ?? "";
  const termProgram = env.TERM_PROGRAM ?? "";
  // Apple Terminal.app does NOT support 24-bit colour. Force 256 even if
  // some wrapper leaked COLORTERM into the env.
  if (termProgram === "Apple_Terminal") {
    return "256";
  }
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") {
    return "truecolor";
  }
  if (TRUECOLOR_TERM_PROGRAMS.includes(termProgram)) {
    return "truecolor";
  }
  if (term === "dumb") return "none";
  // Anything that talks ANSI but isn't known-truecolor → 256
  if (term.includes("256color") || term.includes("color") || term.includes("xterm") || term.includes("ansi") || term.includes("screen") || term.includes("tmux")) {
    return "256";
  }
  // Default conservative: 256 colour. Better than dropping colours entirely
  // on unknown terminals that almost certainly understand the 256 palette.
  return "256";
}

/**
 * Get the active colour mode (manual override > cached detection > env probe).
 */
export function getColorMode(): ColorMode {
  if (manualMode) return manualMode;
  if (!detectedMode) detectedMode = detectColorMode();
  return detectedMode;
}

/**
 * Force a specific colour mode (e.g. from user settings). Pass `null` to
 * revert to auto-detection.
 */
export function setColorMode(mode: ColorMode | null): void {
  manualMode = mode;
}

/** Re-run env-based detection (useful after settings or env changes). */
export function refreshColorMode(): ColorMode {
  detectedMode = null;
  return getColorMode();
}

// ─── 24-bit → 256 colour downgrade ─────────────────────────────────────────

/**
 * Map an RGB triple to the nearest xterm-256 index.
 *
 * xterm-256 layout:
 *   0–15   → system / bright colours (skipped; we route through the cube
 *            for predictability)
 *   16–231 → 6×6×6 colour cube
 *   232–255 → 24-step grayscale
 *
 * We pick the better of (cube nearest) and (grayscale nearest) by squared
 * RGB distance, which matches the heuristic used by chalk / ansi-styles.
 */
function rgbTo256(r: number, g: number, b: number): number {
  // Grayscale candidate
  const grayAvg = Math.round((r + g + b) / 3);
  let grayIdx: number;
  let grayR: number;
  if (grayAvg < 8) {
    grayIdx = 16;
    grayR = 0;
  } else if (grayAvg > 248) {
    grayIdx = 231;
    grayR = 255;
  } else {
    const step = Math.round(((grayAvg - 8) / 247) * 24);
    grayIdx = 232 + step;
    grayR = 8 + step * 10;
  }
  const grayDist = sqDist(r, g, b, grayR, grayR, grayR);

  // Cube candidate (6 steps: 0, 95, 135, 175, 215, 255)
  const cubeR = cubeStep(r);
  const cubeG = cubeStep(g);
  const cubeB = cubeStep(b);
  const cubeIdx = 16 + 36 * cubeR.idx + 6 * cubeG.idx + cubeB.idx;
  const cubeDist = sqDist(r, g, b, cubeR.value, cubeG.value, cubeB.value);

  return cubeDist <= grayDist ? cubeIdx : grayIdx;
}

const CUBE_STEPS = [0, 95, 135, 175, 215, 255];
function cubeStep(v: number): { idx: number; value: number } {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < CUBE_STEPS.length; i++) {
    const d = Math.abs(v - CUBE_STEPS[i]);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return { idx: bestIdx, value: CUBE_STEPS[bestIdx] };
}

function sqDist(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return dr * dr + dg * dg + db * db;
}

// ─── Public API ────────────────────────────────────────────────────────────

/** Wrap text in dim ANSI codes for muted placeholder display */
export function mutedPlaceholder(text: string): string {
  return `\x1b[2m${text}\x1b[0m`;
}

/** Default semantic-to-theme-color mapping */
const DEFAULT_COLOR_MAP: Record<SemanticColor, ThemeColor | `#${string}`> = {
  // ── Model & Identity (Left zone) ──
  model: "#c792ea",           // Soft purple — model name
  path: "text",
  git: "#82cc6f",            // Green (clean default)
  gitClean: "#82cc6f",       // Green — clean branch
  gitDirty: "#e5c07b",       // Amber — dirty branch
  session: "#61afef",        // Blue — session name
  worktree: "#61afef",       // Blue — worktree indicator
  // ── Workflow (Left zone) ──
  workflow: "#c792ea",       // Purple (default)
  workflowNone: "#4a6a7a",   // Muted teal — idle
  workflowBrainstorm: "#e06c75", // Red
  workflowPlan: "#d19a66",   // Orange
  workflowWork: "#e5c07b",   // Yellow
  workflowReview: "#82cc6f", // Green
  workflowAuto: "#c792ea",   // Purple
  workflowDebug: "#e06c75",  // Red
  workflowChoreExec: "#d19a66", // Orange
  workflowOther: "#c792ea",  // Purple
  // ── TPS tiers (Center zone) ──
  tpsSlow: "#e06c75",        // Red — < 30 t/s
  tpsModerate: "#e5c07b",    // Amber — 30-50 t/s
  tpsGood: "#56d4bc",        // Teal — 50-100 t/s
  tpsFast: "#82cc6f",        // Green — 100-200 t/s
  tpsBlazing: "#c792ea",     // Purple — > 200 t/s
  tpsIdle: "#4a6a7a",        // Muted teal — session avg when idle
  // ── Metrics (Center zone) ──
  compactor: "#56b6c2",      // Cyan — compaction stats
  memory: "#61afef",         // Blue — memory count
  mcp: "#82cc6f",            // Green — MCP status
  ralph: "#e5c07b",          // Amber — ralph loops
  ralphOn: "#82cc6c",        // Green — ralph active
  ralphOff: "#e06c75",       // Red — ralph inactive
  kanboard: "#c678dd",       // Purple — kanboard
  notify: "#56b6c2",         // Cyan — notifications
  context: "muted",          // Theme token for OK context
  contextWarn: "#e5c07b",    // Amber — context 70-90%
  contextError: "#e06c75",   // Red — context > 90%
  cost: "#d19a66",           // Gold — cost
  tokens: "#abb2bf",         // Silver — token counts
  // ── Time (Right zone) ──
  clock: "#abb2bf",          // Silver — wall clock
  duration: "#61afef",       // Blue — session duration
  // ── Thinking levels ──
  thinking: "#61afef",
  thinkingMinimal: "#56b6c2", // Cyan
  thinkingLow: "#61afef",    // Blue
  thinkingMedium: "#c792ea", // Purple
  thinkingHigh: "#d19a66",   // Gold
  thinkingXhigh: "#e06c75",  // Red
  // ── UI chrome ──
  separator: "dim",
  border: "dim",
};

/**
 * Get the default color scheme mapping semantic names to theme colors.
 */
export function getDefaultColors(): ColorScheme {
  const scheme: ColorScheme = {};
  for (const [key, value] of Object.entries(DEFAULT_COLOR_MAP)) {
    scheme[key as SemanticColor] = value;
  }
  return scheme;
}

/**
 * Wrap `text` in an ANSI escape for the given hex value, chosen to match
 * the active colour mode (truecolor / 256 / none).
 */
function wrapHex(hex: string, text: string): string {
  const mode = getColorMode();
  if (mode === "none") return text;
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return text;
  if (mode === "truecolor") {
    return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
  }
  // 256-color fallback
  const idx = rgbTo256(r, g, b);
  return `\x1b[38;5;${idx}m${text}\x1b[0m`;
}

/**
 * Apply a semantic color to text using the theme.
 * Falls back to the default theme color if no override is provided.
 */
export function applyColor(
  semantic: SemanticColor,
  text: string,
  theme: ThemeLike,
  colors: ColorScheme,
): string {
  const colorValue = colors[semantic];
  if (!colorValue) {
    // Use default from the map
    const defaultColor = DEFAULT_COLOR_MAP[semantic] || "text";
    if (typeof defaultColor === "string" && defaultColor.startsWith("#")) {
      return wrapHex(defaultColor, text);
    }
    return theme.fg(defaultColor as ThemeColor, text);
  }

  if (colorValue.startsWith("#")) {
    return wrapHex(colorValue, text);
  }

  return theme.fg(colorValue as ThemeColor, text);
}
