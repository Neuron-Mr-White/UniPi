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

/**
 * Validate parity keys. Follows the reference behavior: invalid values for
 * strict keys (toolTimeoutMs, budgets, concurrency caps) are rejected with a
 * visible error rather than silently ignored. Best-effort keys (placement,
 * logging mode) fall back to defaults like the reference does.
 *
 * Returns a list of validation problems; empty means valid.
 */
export function validateParityConfig(config: SubagentsConfig): string[] {
  const problems: string[] = [];
  const positiveInt = (label: string, value: unknown): void => {
    if (value === undefined) return;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 2147483647) {
      problems.push(`${label} must be a positive integer no greater than 2147483647 (got ${JSON.stringify(value)})`);
    }
  };

  positiveInt("timeoutMs", config.timeoutMs);
  positiveInt("toolTimeoutMs", config.toolTimeoutMs);
  positiveInt("globalConcurrencyLimit", config.globalConcurrencyLimit);
  if (config.maxSubagentSpawnsPerSession !== undefined && config.maxSubagentSpawnsPerSession !== 0) {
    positiveInt("maxSubagentSpawnsPerSession", config.maxSubagentSpawnsPerSession);
  }
  if (config.maxSubagentSpawnsPerRun !== undefined && config.maxSubagentSpawnsPerRun !== 0) {
    positiveInt("maxSubagentSpawnsPerRun", config.maxSubagentSpawnsPerRun);
  }
  if (config.maxActiveAsyncRunsPerSession !== undefined && config.maxActiveAsyncRunsPerSession !== 0) {
    positiveInt("maxActiveAsyncRunsPerSession", config.maxActiveAsyncRunsPerSession);
  }
  if (config.maxSubagentDepth !== undefined) positiveInt("maxSubagentDepth", config.maxSubagentDepth);

  if (config.defaultSubagentContext !== undefined && !['"fresh"', '"fork"'].includes(JSON.stringify(config.defaultSubagentContext))) {
    problems.push(`defaultSubagentContext must be "fresh" or "fork" (got ${JSON.stringify(config.defaultSubagentContext)})`);
  }
  if (config.fleetViewPlacement !== undefined && !['"belowEditor"', '"aboveEditor"'].includes(JSON.stringify(config.fleetViewPlacement))) {
    problems.push(`fleetViewPlacement must be "belowEditor" or "aboveEditor" (got ${JSON.stringify(config.fleetViewPlacement)}); falling back to "belowEditor"`);
  }
  if (
    config.resultScanLogging !== undefined &&
    !["all", "activity", "off"].includes(config.resultScanLogging)
  ) {
    problems.push(`resultScanLogging must be "all", "activity", or "off" (got ${JSON.stringify(config.resultScanLogging)})`);
  }
  if (config.inlineToolDisplay !== undefined && !["rich", "summary"].includes(config.inlineToolDisplay)) {
    problems.push(`inlineToolDisplay must be "rich" or "summary" (got ${JSON.stringify(config.inlineToolDisplay)})`);
  }
  if (config.parallel) {
    positiveInt("parallel.maxTasks", config.parallel.maxTasks);
    positiveInt("parallel.concurrency", config.parallel.concurrency);
  }
  if (config.maxOutput) {
    positiveInt("maxOutput.bytes", config.maxOutput.bytes);
    positiveInt("maxOutput.lines", config.maxOutput.lines);
  }

  return problems;
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
    const merged: SubagentsConfig = {
      ...globalConfig,
      ...workspaceConfig,
      types: {
        ...globalConfig.types,
        ...workspaceConfig.types,
      },
    };
    reportConfigProblems(merged);
    return merged;
  }

  reportConfigProblems(globalConfig);
  return globalConfig;
}

/** Surface config validation problems visibly (non-fatal, reference behavior). */
function reportConfigProblems(config: SubagentsConfig): void {
  const problems = validateParityConfig(config);
  for (const problem of problems) {
    console.error(`[unipi/subagents] config: ${problem}`);
  }
}

/** Load the RAW parsed global config (for parity settings extraction). */
export function loadRawGlobalConfig(): Record<string, unknown> | null {
  return loadConfigFromPath(getGlobalConfigPath()) as Record<string, unknown> | null;
}

/** Load the RAW parsed workspace config (for parity settings extraction). */
export function loadRawWorkspaceConfig(cwd: string): Record<string, unknown> | null {
  return loadConfigFromPath(getWorkspaceConfigPath(cwd)) as Record<string, unknown> | null;
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
