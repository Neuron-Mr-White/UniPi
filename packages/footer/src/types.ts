/**
 * @pi-unipi/footer — Type definitions
 *
 * All TypeScript types for the footer package: segments, groups, config,
 * presets, separators, theme.
 */

import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";

// ─── Semantic Colors ────────────────────────────────────────────────────────

/** Zone assignment for segment positioning */
export type SegmentZone = "left" | "center" | "right";

/** Semantic color names mapped to segment groups */
export type SemanticColor =
  // ── Model & Identity (Left zone) ──
  | "model"
  | "path"
  | "git"
  | "gitClean"
  | "gitDirty"
  | "session"
  | "worktree"
  // ── Workflow (Left zone) ──
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
  // ── TPS tiers (Center zone) ──
  | "tpsSlow"
  | "tpsModerate"
  | "tpsGood"
  | "tpsFast"
  | "tpsBlazing"
  | "tpsIdle"
  // ── Metrics (Center zone) ──
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
  // ── Time (Right zone) ──
  | "clock"
  | "duration"
  // ── Thinking levels ──
  | "thinking"
  | "thinkingMinimal"
  | "thinkingLow"
  | "thinkingMedium"
  | "thinkingHigh"
  | "thinkingXhigh"
  // ── UI chrome ──
  | "separator"
  | "border";

/** A theme color name or custom hex color */
export type ColorValue = ThemeColor | `#${string}`;

/** Theme-like interface for rendering */
export type ThemeLike = Pick<Theme, "fg">;

/** Mapping of semantic color names to actual colors */
export type ColorScheme = Partial<Record<SemanticColor, ColorValue>>;

// ─── Separators ─────────────────────────────────────────────────────────────

/** Icon style — determines which icon set is used for segments */
export type IconStyle = "nerd" | "emoji" | "text";

/** Separator styles for segment dividers */
export type SeparatorStyle =
  | "powerline"
  | "powerline-thin"
  | "slash"
  | "pipe"
  | "dot"
  | "ascii";

/** Separator definition with left/right glyph strings */
export interface SeparatorDef {
  left: string;
  right: string;
}

// ─── Segments ───────────────────────────────────────────────────────────────

/** Rendered segment output */
export interface RenderedSegment {
  /** The rendered content string (may include ANSI codes) */
  content: string;
  /** Whether this segment is visible */
  visible: boolean;
}

/** Context passed to segment render functions */
export interface FooterSegmentContext {
  /** Pi theme for coloring */
  theme: ThemeLike;
  /** Resolved color scheme */
  colors: ColorScheme;
  /** Data from the registry for this segment's group */
  data: unknown;
  /** Available width for this segment */
  width: number;
  /** Per-segment options from preset */
  options?: Record<string, unknown>;
  /** Full pi context (for core segments that need ctx.sessionManager, etc.) */
  piContext?: unknown;
  /** Footer data provider (for core segments that need git, extension statuses) */
  footerData?: unknown;
  /** Label mode: compact (shortLabel) or labeled (full label) */
  labelMode?: "compact" | "labeled";
}

/** Segment render function type */
export type SegmentRenderFn = (ctx: FooterSegmentContext) => RenderedSegment;

/** A single footer segment definition */
export interface FooterSegment {
  /** Unique segment identifier (e.g., "model", "compactions") */
  id: string;
  /** Display label (full name, used in labeled mode) */
  label: string;
  /** Compact display name (used in compact mode, e.g. "ses", "tps", "ctx") */
  shortLabel: string;
  /** Human-readable description (shown in footer-help overlay) */
  description: string;
  /** Layout zone assignment */
  zone: SegmentZone;
  /** Icon glyph (Nerd Font or ASCII) */
  icon: string;
  /** Render function */
  render: SegmentRenderFn;
  /** Whether this segment is shown by default */
  defaultShow: boolean;
}

// ─── Groups ─────────────────────────────────────────────────────────────────

/** A group of related segments (typically one per package) */
export interface FooterGroup {
  /** Unique group identifier (e.g., "core", "compactor") */
  id: string;
  /** Display name */
  name: string;
  /** Group icon */
  icon: string;
  /** Segments within this group */
  segments: FooterSegment[];
  /** Whether this group is shown by default */
  defaultShow: boolean;
}

// ─── Settings ───────────────────────────────────────────────────────────────

/** Per-group settings */
export interface FooterGroupSettings {
  /** Whether this group is visible */
  show: boolean;
  /** Per-segment visibility overrides */
  segments?: Record<string, boolean>;
}

/** Footer settings stored in settings.json */
export interface FooterSettings {
  /** Whether the footer is enabled */
  enabled: boolean;
  /** Active preset name */
  preset: string;
  /** Separator style */
  separator: SeparatorStyle;
  /** Icon style: nerd (Nerd Font glyphs), emoji (Unicode emoji), text (plain labels) */
  iconStyle: IconStyle;
  /** Zone separator string (between zones, default: "│") */
  zoneSeparator?: string;
  /** Show full labels instead of compact short labels */
  showFullLabels?: boolean;
  /** Per-group settings */
  groups: Record<string, FooterGroupSettings>;
}

/** Full footer config (settings + runtime state) */
export interface FooterConfig {
  settings: FooterSettings;
  /** Runtime: whether footer is currently active */
  active: boolean;
}

// ─── Presets ────────────────────────────────────────────────────────────────

/** Preset definition */
export interface PresetDef {
  /** Segments on the left side of the status bar */
  leftSegments: string[];
  /** Segments on the right side of the status bar */
  rightSegments: string[];
  /** Secondary row segments (shown when terminal is narrow) */
  secondarySegments: string[];
  /** Separator style for this preset */
  separator: SeparatorStyle;
  /** Color scheme for this preset */
  colors?: ColorScheme;
  /** Per-segment options */
  segmentOptions?: Record<string, Record<string, unknown>>;
  /** Zone order (default: left, center, right) */
  zoneOrder?: ("left" | "center" | "right")[];
  /** Zone separator string (between zones) */
  zoneSeparator?: string;
}
