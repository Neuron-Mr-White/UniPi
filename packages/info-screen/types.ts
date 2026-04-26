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

/** Settings for info-screen in settings.json */
export interface InfoScreenSettings {
  /** Whether to show dashboard on boot */
  showOnBoot: boolean;
  /** Timeout in ms waiting for modules at boot */
  bootTimeoutMs: number;
  /** Per-group settings */
  groups: Record<string, GroupSettings>;
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
  showOnBoot: true,
  bootTimeoutMs: 2000,
  groups: {},
};
