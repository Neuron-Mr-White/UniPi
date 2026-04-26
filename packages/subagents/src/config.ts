/**
 * @pi-unipi/subagents — Config management
 *
 * Loads config from ~/.unipi/config/subagents.json (global)
 * and <workspace>/.unipi/config/subagents.json (override).
 * Auto-generates on first run. Repairs corrupted files.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SubagentsConfig } from "./types.js";

const DEFAULT_CONFIG: SubagentsConfig = {
  maxConcurrent: 4,
  enabled: true,
  types: {
    explore: { enabled: true },
    work: { enabled: true },
  },
};

/** Get global config path: ~/.unipi/config/subagents.json */
function getGlobalConfigPath(): string {
  return join(homedir(), ".unipi", "config", "subagents.json");
}

/** Get workspace config path: <cwd>/.unipi/config/subagents.json */
function getWorkspaceConfigPath(cwd: string): string {
  return join(cwd, ".unipi", "config", "subagents.json");
}

/** Ensure directory exists. */
function ensureDir(filePath: string): void {
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Ensure a directory exists (not a file path). */
function ensureDirExists(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/** Write config atomically (write then rename). */
function writeConfigAtomic(filePath: string, config: SubagentsConfig): void {
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
  renameSync(tmpPath, filePath);
}

/** Load and parse config from a path. Returns null on failure. */
function loadConfigFromPath(filePath: string): SubagentsConfig | null {
  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);
    // Basic validation
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as SubagentsConfig;
  } catch {
    return null;
  }
}

/** Repair corrupted config: rename to .bak and generate fresh. */
function repairCorrupted(filePath: string): SubagentsConfig {
  const backupPath = filePath + ".bak";
  try {
    renameSync(filePath, backupPath);
  } catch {
    // If rename fails, just overwrite
  }
  writeConfigAtomic(filePath, DEFAULT_CONFIG);
  return DEFAULT_CONFIG;
}

/**
 * Initialize config on extension start.
 * - If missing: generate with defaults
 * - If corrupted: rename to .bak, generate fresh
 * - If valid: load
 */
export function initConfig(cwd: string): SubagentsConfig {
  const globalPath = getGlobalConfigPath();
  const globalDir = join(homedir(), ".unipi", "config");
  const globalAgentsDir = join(homedir(), ".unipi", "config", "agents");

  // Ensure directories exist
  ensureDirExists(globalDir);
  ensureDirExists(globalAgentsDir);

  // Load or create global config
  let globalConfig = loadConfigFromPath(globalPath);
  if (globalConfig === null) {
    globalConfig = repairCorrupted(globalPath);
  }

  // Ensure workspace directories exist if workspace exists
  const workspaceDir = join(cwd, ".unipi", "config");
  const workspaceAgentsDir = join(cwd, ".unipi", "config", "agents");
  if (cwd && !cwd.startsWith(homedir())) {
    // Only create workspace dirs if not in home directory
    ensureDirExists(workspaceDir);
    ensureDirExists(workspaceAgentsDir);
  }

  // Load workspace override if exists
  const workspacePath = getWorkspaceConfigPath(cwd);
  const workspaceConfig = loadConfigFromPath(workspacePath);

  if (workspaceConfig) {
    // Merge: workspace overrides global on any field present
    return {
      ...globalConfig,
      ...workspaceConfig,
      types: {
        ...globalConfig.types,
        ...workspaceConfig.types,
      },
    };
  }

  return globalConfig;
}

/**
 * Save global config.
 */
export function saveGlobalConfig(config: SubagentsConfig): void {
  const globalPath = getGlobalConfigPath();
  ensureDir(globalPath);
  writeConfigAtomic(globalPath, config);
}

/**
 * Save workspace config.
 */
export function saveWorkspaceConfig(cwd: string, config: SubagentsConfig): void {
  const workspacePath = getWorkspaceConfigPath(cwd);
  ensureDir(workspacePath);
  writeConfigAtomic(workspacePath, config);
}
