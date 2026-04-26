/**
 * Test: Config auto-generation and corruption recovery
 *
 * Verifies:
 * - Missing config → auto-generated with defaults
 * - Corrupted config → renamed to .json.bak, fresh generated
 * - Workspace config overrides global config
 * - Atomic writes prevent corruption
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Inline config implementation for testing
const DEFAULT_CONFIG = {
  maxConcurrent: 4,
  enabled: true,
  types: {
    explore: { enabled: true },
    work: { enabled: true },
  },
};

interface SubagentsConfig {
  maxConcurrent: number;
  enabled: boolean;
  types: Record<string, { enabled?: boolean }>;
}

function loadConfigFromPath(filePath: string): SubagentsConfig | null {
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as SubagentsConfig;
  } catch {
    return null;
  }
}

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

function writeConfigAtomic(filePath: string, config: SubagentsConfig): void {
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
  renameSync(tmpPath, filePath);
}

function initConfig(globalDir: string, workspaceDir: string): SubagentsConfig {
  const globalPath = join(globalDir, "subagents.json");
  const workspacePath = join(workspaceDir, "subagents.json");

  // Load or create global config
  let globalConfig = loadConfigFromPath(globalPath);
  if (globalConfig === null) {
    globalConfig = repairCorrupted(globalPath);
  }

  // Load workspace override if exists
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

describe("Config Management", () => {
  let testDir: string;
  let globalDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    // Create temp directories for testing
    testDir = join(tmpdir(), `subagents-test-${Date.now()}`);
    globalDir = join(testDir, "global");
    workspaceDir = join(testDir, "workspace");
    mkdirSync(globalDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    // Cleanup
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("Missing config", () => {
    it("should auto-generate with defaults when no config exists", () => {
      const config = initConfig(globalDir, workspaceDir);

      assert.deepEqual(config, DEFAULT_CONFIG);
      assert.equal(existsSync(join(globalDir, "subagents.json")), true);

      // Verify the generated file
      const content = readFileSync(join(globalDir, "subagents.json"), "utf-8");
      const parsed = JSON.parse(content);
      assert.deepEqual(parsed, DEFAULT_CONFIG);
    });

    it("should create global config even if workspace exists", () => {
      // Write workspace config only
      const workspaceConfig = { maxConcurrent: 8, enabled: true, types: {} };
      writeFileSync(join(workspaceDir, "subagents.json"), JSON.stringify(workspaceConfig));

      const config = initConfig(globalDir, workspaceDir);

      // Global should be created
      assert.equal(existsSync(join(globalDir, "subagents.json")), true);
      // Config should merge
      assert.equal(config.maxConcurrent, 8); // workspace overrides
    });
  });

  describe("Corrupted config", () => {
    it("should backup corrupted config and generate fresh", () => {
      const configPath = join(globalDir, "subagents.json");
      const backupPath = configPath + ".bak";

      // Write corrupted JSON
      writeFileSync(configPath, "{ invalid json !!!");

      const config = initConfig(globalDir, workspaceDir);

      // Should have created backup
      assert.equal(existsSync(backupPath), true, "Backup should exist");
      // Backup should contain corrupted content
      assert.equal(readFileSync(backupPath, "utf-8"), "{ invalid json !!!");
      // New config should be defaults
      assert.deepEqual(config, DEFAULT_CONFIG);
      // New file should be valid JSON
      const content = readFileSync(configPath, "utf-8");
      assert.deepEqual(JSON.parse(content), DEFAULT_CONFIG);
    });

    it("should handle completely empty file", () => {
      const configPath = join(globalDir, "subagents.json");
      writeFileSync(configPath, "");

      const config = initConfig(globalDir, workspaceDir);

      assert.deepEqual(config, DEFAULT_CONFIG);
      assert.equal(existsSync(configPath + ".bak"), true);
    });

    it("should handle non-object JSON", () => {
      const configPath = join(globalDir, "subagents.json");
      writeFileSync(configPath, '"just a string"');

      const config = initConfig(globalDir, workspaceDir);

      // JSON.parse succeeds but returns string, not object
      // loadConfigFromPath checks typeof === "object"
      assert.deepEqual(config, DEFAULT_CONFIG);
    });
  });

  describe("Workspace override", () => {
    it("should merge workspace config with global", () => {
      const globalConfig = { maxConcurrent: 4, enabled: true, types: { explore: { enabled: true } } };
      const workspaceConfig = { maxConcurrent: 8, types: { work: { enabled: false } } };

      writeFileSync(join(globalDir, "subagents.json"), JSON.stringify(globalConfig));
      writeFileSync(join(workspaceDir, "subagents.json"), JSON.stringify(workspaceConfig));

      const config = initConfig(globalDir, workspaceDir);

      assert.equal(config.maxConcurrent, 8); // workspace overrides
      assert.equal(config.enabled, true); // global preserved
      assert.deepEqual(config.types.explore, { enabled: true }); // global preserved
      assert.deepEqual(config.types.work, { enabled: false }); // workspace added
    });

    it("should override specific fields only", () => {
      const globalConfig = {
        maxConcurrent: 4,
        enabled: true,
        types: { explore: { enabled: true }, work: { enabled: true } },
      };
      const workspaceConfig = { enabled: false };

      writeFileSync(join(globalDir, "subagents.json"), JSON.stringify(globalConfig));
      writeFileSync(join(workspaceDir, "subagents.json"), JSON.stringify(workspaceConfig));

      const config = initConfig(globalDir, workspaceDir);

      assert.equal(config.maxConcurrent, 4); // global preserved
      assert.equal(config.enabled, false); // workspace overrides
      assert.deepEqual(config.types, { explore: { enabled: true }, work: { enabled: true } }); // global preserved
    });

    it("should handle empty workspace config", () => {
      const globalConfig = { maxConcurrent: 4, enabled: true, types: {} };
      writeFileSync(join(globalDir, "subagents.json"), JSON.stringify(globalConfig));
      writeFileSync(join(workspaceDir, "subagents.json"), "{}");

      const config = initConfig(globalDir, workspaceDir);

      assert.deepEqual(config, globalConfig);
    });
  });

  describe("Atomic writes", () => {
    it("should write config atomically", () => {
      const configPath = join(globalDir, "subagents.json");
      const config = { maxConcurrent: 8, enabled: false, types: {} };

      writeConfigAtomic(configPath, config);

      // Should have main file
      assert.equal(existsSync(configPath), true);
      // Should not have temp file
      assert.equal(existsSync(configPath + ".tmp"), false);
      // Content should be valid
      const content = readFileSync(configPath, "utf-8");
      assert.deepEqual(JSON.parse(content), config);
    });
  });
});
