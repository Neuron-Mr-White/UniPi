/**
 * @pi-unipi/updater — Type definitions
 *
 * All interfaces for the updater, changelog browser, and readme browser.
 */

/** Configuration for the updater module */
export interface UpdaterConfig {
  /** Check interval in milliseconds (default: 3600000 = 1 hour) */
  checkIntervalMs: number;
  /** Auto-update mode */
  autoUpdate: "disabled" | "notify" | "auto";
}

/** Cache entry written after each update check */
export interface LastCheckCache {
  /** ISO timestamp of last check */
  lastCheck: string;
  /** Latest version found on npm */
  latestVersion: string;
  /** Version the user chose to skip */
  skippedVersion?: string;
}

/** A parsed changelog version entry */
export interface ChangelogEntry {
  /** Version string, e.g. "0.1.15" */
  version: string;
  /** Date string, e.g. "2026-04-30" (empty for Unreleased) */
  date: string;
  /** Sections: key = section name (Added, Fixed, etc.), value = list items */
  sections: Record<string, string[]>;
  /** Raw body text (for rendering) */
  body: string;
}

/** A discovered README entry */
export interface ReadmeEntry {
  /** Short package name, e.g. "workflow" */
  name: string;
  /** Full npm package name, e.g. "@pi-unipi/workflow" */
  packageName: string;
  /** Installed version */
  version: string;
  /** Absolute path to README.md */
  path: string;
}

/** Result of an update check */
export interface UpdateCheckResult {
  /** Whether an update is available */
  updateAvailable: boolean;
  /** Latest version on npm (empty if check failed) */
  latestVersion: string;
  /** Currently installed version */
  currentVersion: string;
  /** Error message if check failed */
  error?: string;
}

/** Result of an install attempt */
export interface InstallResult {
  /** Whether install succeeded */
  success: boolean;
  /** New version after install */
  version?: string;
  /** Error message if install failed */
  error?: string;
}
