/**
 * @pi-unipi/info-screen — Type definitions
 */

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
}

/** Data returned by a group's data provider */
export type GroupData = Record<string, StatData>;

/** Registration for an info group */
export interface InfoGroup {
  /** Unique group identifier */
  id: string;
  /** Display name */
  name: string;
  /** Icon emoji */
  icon: string;
  /** Priority for tab ordering (lower = earlier) */
  priority: number;
  /** Group configuration */
  config: GroupConfig;
  /** Async data provider */
  dataProvider: () => Promise<GroupData>;
}

/** How the dashboard behaves at startup. */
export type BootMode = "on" | "off" | "auto-close";

/** All valid boot modes, in the order the settings UI cycles them. */
export const BOOT_MODES: BootMode[] = ["on", "auto-close", "off"];

/** Settings for info-screen in settings.json */
export interface InfoScreenSettings {
  /**
   * What the dashboard does at startup:
   *  - "on":         show it and leave it up until dismissed (q/Esc)
   *  - "off":        do not show it at all (no data is fetched)
   *  - "auto-close": show it, then close after `bootTimeoutMs`
   */
  bootMode: BootMode;
  /**
   * How long the boot dashboard stays up in "auto-close" mode, in ms.
   * Any keypress cancels the timer and keeps the overlay open.
   * Does not apply to the overlay opened via /unipi:info.
   */
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
  bootTimeoutMs: 2000,
  groups: {},
  groupOrder: [],
};
