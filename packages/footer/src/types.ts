/**
 * @pi-unipi/footer — Type definitions
 *
 * The footer is the glance frame: a framed input surface with a stats strip
 * below it. These types cover its settings and the theme colors it paints.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

// ─── Theme colors ───────────────────────────────────────────────────────────

/** Semantic color names mapped to colors (frame accents, strip numbers). */
export type SemanticColor =
  | "brand"
  | "model"
  | "directory"
  | "path"
  | "git"
  | "gitClean"
  | "gitDirty"
  | "session"
  | "worktree"
  | "workflow"
  | "workflowNone"
  | "workflowBrainstorm"
  | "workflowPlan"
  | "workflowWork"
  | "workflowReview"
  | "workflowAuto"
  | "workflowDebug"
  | "workflowChoreExec"
  | "workflowOther"
  | "tpsSlow"
  | "tpsModerate"
  | "tpsGood"
  | "tpsFast"
  | "tpsBlazing"
  | "tpsIdle"
  | "compactor"
  | "memory"
  | "mcp"
  | "ralph"
  | "ralphOn"
  | "ralphOff"
  | "kanboard"
  | "notify"
  | "context"
  | "contextWarn"
  | "contextError"
  | "cost"
  | "tokens"
  | "clock"
  | "duration"
  | "thinking"
  | "thinkingMinimal"
  | "thinkingLow"
  | "thinkingMedium"
  | "thinkingHigh"
  | "thinkingXhigh"
  | "separator"
  | "border";

/** A theme color name or custom hex color */
export type ColorValue = ThemeColor | `#${string}`;

/** Theme-like interface for rendering */
export type ThemeLike = Pick<Theme, "fg">;

/** Mapping of semantic color names to actual colors */
export type ColorScheme = Partial<Record<SemanticColor, ColorValue>>;

// ─── Settings ───────────────────────────────────────────────────────────────

/** Icon style: nerd (Nerd Font glyphs), emoji (Unicode emoji), text (plain labels) */
export type IconStyle = "nerd" | "emoji" | "text";

/** Colour-emission mode for terminal output. */
export type ColorMode = "auto" | "truecolor" | "256" | "none";

/** Which frame parts get the animated lolcat rainbow. */
export type RainbowMode = "always" | "brand-only" | "off";

/** Per-part toggles for the session stats strip below the input. */
export interface StripToggles {
  /** Turns/steps counters. */
  turns: boolean;
  /** Wall (model) time + tool time. */
  time: boolean;
  /** Average TTFT + tok/s. */
  speed: boolean;
  /** Input/output token totals. */
  tokens: boolean;
  /** Session cost (or `sub` on subscription models). */
  cost: boolean;
  /** Compaction count, sizes and recency. */
  compactions: boolean;
  /** Cache hit percentage. */
  cache: boolean;
}

/** Frame title/border badge toggles. */
export interface BadgeToggles {
  /** Long-horizon mode label beside the brand. */
  mode: boolean;
  /** PLAN badge + permission mode in the top-right. */
  planPermission: boolean;
  /** Fusion lead/sidekick pair in the bottom border. */
  fusion: boolean;
  /** Kanboard claims label in the top border. */
  kanboard: boolean;
}

/** Footer settings (canonical nested shape, stored under the `footer` namespace). */
export interface FooterSettings {
  /** Whether the footer (frame, strip, process line) renders at all. */
  enabled: boolean;
  /** Icon set for the frame titles. */
  iconStyle: IconStyle;
  /** Terminal colour mode override (legacy `mono` loads as `none`). */
  colorMode: ColorMode;
  /** Which parts get the animated rainbow. */
  rainbow: RainbowMode;
  /** Background-task line above the input. */
  processLine: boolean;
  /** Session stats strip toggles. */
  strip: StripToggles;
  /** Frame badge toggles. */
  badges: BadgeToggles;
}
