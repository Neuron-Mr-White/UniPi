/**
 * @pi-unipi/notify — Project-level ntfy configuration
 *
 * Loads, saves, and resolves ntfy config from dedicated ntfy.json files
 * at global (~/.unipi/config/notify/ntfy.json) and project
 * (<cwd>/.unipi/config/notify/ntfy.json) scope.
 *
 * Resolution: project → global → defaults.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import type { NtfyConfig } from "./types.js";

/** Default ntfy configuration */
const DEFAULT_NTFY_CONFIG: NtfyConfig = {
  enabled: false,
  serverUrl: "https://ntfy.sh",
  priority: 3,
};

/** Global ntfy.json path: ~/.unipi/config/notify/ntfy.json */
function getGlobalNtfyPath(): string {
  return join(homedir(), ".unipi", "config", "notify", "ntfy.json");
}

/** Project ntfy.json path: <cwd>/.unipi/config/notify/ntfy.json */
function getProjectNtfyPath(cwd: string): string {
  return join(cwd, ".unipi", "config", "notify", "ntfy.json");
}

/**
 * Read and parse a ntfy.json file.
 * Returns null if file doesn't exist (ENOENT).
 * Returns null and logs warning on parse error.
 */
function readNtfyJson(filePath: string): NtfyConfig | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<NtfyConfig>;
    return { ...DEFAULT_NTFY_CONFIG, ...parsed };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    console.warn(`[notify] Failed to parse ${filePath}: ${(err as Error).message}. Falling back.`);
    return null;
  }
}

/**
 * Resolve ntfy config with project → global → defaults priority.
 *
 * 1. If project ntfy.json exists → use it
 * 2. If only global ntfy.json exists → use it
 * 3. If neither exists → return defaults (ntfy disabled)
 *
 * Runs legacy migration once if global ntfy.json is missing.
 */
export function loadNtfyConfig(cwd: string): NtfyConfig {
  // Attempt migration from legacy config.json if global ntfy.json doesn't exist
  migrateFromLegacyConfig();

  // Try project-level first
  const projectConfig = readNtfyJson(getProjectNtfyPath(cwd));
  if (projectConfig !== null) {
    return projectConfig;
  }

  // Try global level
  const globalConfig = readNtfyJson(getGlobalNtfyPath());
  if (globalConfig !== null) {
    return globalConfig;
  }

  // Neither exists — return defaults
  return { ...DEFAULT_NTFY_CONFIG };
}

/**
 * Save ntfy config to the chosen scope.
 * Creates parent directory if needed.
 */
export function saveNtfyConfig(
  scope: "project" | "global",
  cwd: string,
  config: NtfyConfig
): void {
  const filePath =
    scope === "project" ? getProjectNtfyPath(cwd) : getGlobalNtfyPath();
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Detect which scope is currently active for ntfy config.
 *
 * - "project" if project ntfy.json exists
 * - "global" if global ntfy.json exists (and no project override)
 * - "none" if neither exists
 */
export function getNtfyConfigScope(
  cwd: string
): "project" | "global" | "none" {
  if (existsSync(getProjectNtfyPath(cwd))) {
    return "project";
  }
  if (existsSync(getGlobalNtfyPath())) {
    return "global";
  }
  return "none";
}

/**
 * One-time migration from legacy config.json ntfy section to ntfy.json.
 *
 * Trigger conditions:
 * - Global ntfy.json does NOT exist
 * - config.json has non-default ntfy settings (enabled or topic/serverUrl set)
 *
 * After migration, config.json ntfy section is left untouched.
 * Future reads use ntfy.json exclusively.
 */
export function migrateFromLegacyConfig(): void {
  const globalNtfyPath = getGlobalNtfyPath();

  // Only migrate if global ntfy.json doesn't exist yet
  if (existsSync(globalNtfyPath)) {
    return;
  }

  // Try to read legacy config.json
  const legacyConfigPath = join(
    homedir(),
    ".unipi",
    "config",
    "notify",
    "config.json"
  );

  try {
    if (!existsSync(legacyConfigPath)) return;
    const raw = readFileSync(legacyConfigPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const ntfySection = parsed.ntfy as Partial<NtfyConfig> | undefined;

    if (!ntfySection) return;

    // Only migrate if there's something meaningful to migrate
    const hasCustomConfig =
      ntfySection.enabled === true ||
      (ntfySection.serverUrl && ntfySection.serverUrl !== "https://ntfy.sh") ||
      ntfySection.topic;

    if (!hasCustomConfig) return;

    // Write ntfy.json from legacy config
    const migratedConfig: NtfyConfig = {
      enabled: ntfySection.enabled ?? false,
      serverUrl: ntfySection.serverUrl ?? "https://ntfy.sh",
      topic: ntfySection.topic,
      token: ntfySection.token,
      priority: ntfySection.priority ?? 3,
    };

    const dir = dirname(globalNtfyPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      globalNtfyPath,
      JSON.stringify(migratedConfig, null, 2) + "\n",
      "utf-8"
    );
  } catch {
    // Migration failure is non-fatal — silently continue
  }
}
