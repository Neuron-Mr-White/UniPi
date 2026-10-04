/**
 * @pi-unipi/info-screen — Type definitions
 */

import type { Paint, RGB } from "@pi-unipi/core";

/** A single stat within a group */
export interface InfoStat {
  /** Stat identifier */
  id: string;
  /** Display label */
  label: string;
  /** Whether to show by default */
  show: boolean;
}

/** Configuration for a group's display */
export interface GroupConfig {
  /** Whether group is shown by default */
  showByDefault: boolean;
  /** Stats within this group */
  stats: InfoStat[];
}

/** Data for a single stat */
export interface StatData {
  /** Display value */
  value: string;
  /** Optional detail text */
  detail?: string;
  /**
   * Structured payload for custom page renderers (series, lists, …).
   * Must stay JSON-serializable: page data is persisted for instant reopen.
   */
  raw?: unknown;
}

/** Everything a page renderer gets. Lines it returns are fitted to `width`. */
export interface PageContext {
  data: GroupData;
  /** Content width in cells (frame padding already removed). */
  width: number;
  /** Rows the page may use without scrolling. */
  height: number;
  /** Theme-aware painter (truecolor or 256-colour). */
  paint: Paint;
  /** The page's accent colour. */
  accent: RGB;
  /** True while the first fetch is still in flight. */
  loading: boolean;
  now: number;
}

/** Data returned by a group's data provider */
export type GroupData = Record<string, StatData>;

/** Registration for an info group */
export interface InfoGroup {
  /** Unique group identifier */
  id: string;
  /** Display name */
  name: string;
  /** Legacy icon (no longer drawn — the tab strip is text + colour). */
  icon: string;
  /** Short tab label (defaults to `name`). */
  short?: string;
  /** Page accent colour (defaults to a colour derived from the id). */
  accent?: RGB;
  /**
   * Optional custom renderer. Without one the page renders its visible
   * stats as a styled key/value list.
   */
  render?: (ctx: PageContext) => string[];
  /** Priority for tab ordering (lower = earlier) */
  priority: number;
  /** Group configuration */
  config: GroupConfig;
  /** Async data provider */
  dataProvider: () => Promise<GroupData>;
}

/** How the Unicrab startup splash behaves. */
export type BootMode = "on" | "off" | "auto-close";

/** All valid boot modes, in the order the settings UI cycles them. */
export const BOOT_MODES: BootMode[] = ["on", "auto-close", "off"];

/** Settings for info-screen in settings.json */
export interface InfoScreenSettings {
  /**
   * What the Unicrab startup splash does (the /unipi:info dashboard never
   * opens on its own):
   *  - "on":         show it and leave it up until dismissed (q/Esc)
   *  - "off":        do not show it at all
   *  - "auto-close": show it, then close after `bootTimeoutMs`
   */
  bootMode: BootMode;
  /** How long the splash stays up in "auto-close" mode, in ms. */
  bootTimeoutMs: number;
  /** Per-group settings */
  groups: Record<string, GroupSettings>;
  /** Group display order (array of group ids) */
  groupOrder?: string[];
}

/** Settings for a single group */
export interface GroupSettings {
  /** Whether group is visible */
  show: boolean;
  /** Per-stat visibility overrides */
  stats?: Record<string, boolean>;
}

/** Default settings */
export const DEFAULT_SETTINGS: InfoScreenSettings = {
  bootMode: "auto-close",
  bootTimeoutMs: 2500,
  groups: {},
  groupOrder: [],
};
