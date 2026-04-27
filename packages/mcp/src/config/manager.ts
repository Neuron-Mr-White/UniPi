/**
 * @pi-unipi/mcp — Config manager
 *
 * Reads, merges, and writes MCP configuration files.
 * Handles global (~/.unipi/config/mcp/) and project (.unipi/config/mcp/) configs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  McpConfig,
  McpMetadata,
  McpAuth,
  ResolvedServer,
  ServerSource,
} from "../types.js";
import {
  DEFAULT_MCP_CONFIG,
  DEFAULT_METADATA,
  validateMcpConfig,
} from "./schema.js";

// ── Path helpers ──────────────────────────────────────────────────

/** Expand ~ to home directory */
function expandHome(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/** Get global config directory path */
export function getGlobalConfigDir(): string {
  return expandHome("~/.unipi/config/mcp");
}

/** Get project config directory path */
export function getProjectConfigDir(cwd: string): string {
  return path.join(cwd, ".unipi", "config", "mcp");
}

/** Ensure directory exists */
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ── File I/O helpers ──────────────────────────────────────────────

/**
 * Read and parse a JSON file. Returns null if file doesn't exist.
 * Throws on parse errors (corrupt JSON).
 */
function readJsonFile<T>(filePath: string): T | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new Error(`Failed to read ${filePath}: ${(err as Error).message}`);
  }
}

/**
 * Write JSON to file with optional chmod.
 * Creates parent directories if needed.
 */
function writeJsonFile(
  filePath: string,
  data: unknown,
  chmod?: number,
): void {
  ensureDir(path.dirname(filePath));
  const content = JSON.stringify(data, null, 2) + "\n";
  fs.writeFileSync(filePath, content, "utf-8");
  if (chmod !== undefined) {
    try {
      fs.chmodSync(filePath, chmod);
    } catch {
      // chmod may fail on Windows — log but don't fail
    }
  }
}

// ── Config loading ────────────────────────────────────────────────

/**
 * Load MCP config (mcp-config.json) from a directory.
 * Returns defaults if file doesn't exist.
 */
export function loadMcpConfig(dir: string): McpConfig {
  const filePath = path.join(dir, "mcp-config.json");
  const raw = readJsonFile<McpConfig>(filePath);
  if (!raw) return { ...DEFAULT_MCP_CONFIG };

  const validation = validateMcpConfig(raw);
  if (!validation.valid) {
    throw new Error(
      `Invalid MCP config at ${filePath}:\n${validation.errors.join("\n")}`,
    );
  }

  return raw;
}

/**
 * Load metadata (config.json) from a directory.
 * Returns defaults if file doesn't exist.
 */
export function loadMetadata(dir: string): McpMetadata {
  const filePath = path.join(dir, "config.json");
  const raw = readJsonFile<Partial<McpMetadata>>(filePath);
  if (!raw) return { ...DEFAULT_METADATA, servers: {}, sync: { ...DEFAULT_METADATA.sync } };

  return {
    servers: raw.servers ?? {},
    sync: { ...DEFAULT_METADATA.sync, ...raw.sync },
  };
}

/**
 * Load auth data (auth.json) from a directory.
 * Returns empty object if file doesn't exist.
 */
export function loadAuth(dir: string): McpAuth {
  const filePath = path.join(dir, "auth.json");
  return readJsonFile<McpAuth>(filePath) ?? {};
}

// ── Config saving ─────────────────────────────────────────────────

/**
 * Save MCP config (mcp-config.json) with chmod 600.
 */
export function saveMcpConfig(dir: string, config: McpConfig): void {
  const filePath = path.join(dir, "mcp-config.json");
  writeJsonFile(filePath, config, 0o600);
}

/**
 * Save metadata (config.json).
 */
export function saveMetadata(dir: string, meta: McpMetadata): void {
  const filePath = path.join(dir, "config.json");
  writeJsonFile(filePath, meta);
}

/**
 * Save auth data (auth.json) with chmod 600.
 */
export function saveAuth(dir: string, auth: McpAuth): void {
  const filePath = path.join(dir, "auth.json");
  writeJsonFile(filePath, auth, 0o600);
}

// ── Config merging ────────────────────────────────────────────────

/**
 * Merge global and project MCP configs into a resolved server list.
 *
 * Rules:
 * 1. Server only in global → loaded normally (source: "global")
 * 2. Server only in project → loaded normally (source: "project")
 * 3. Server in both → project wins entirely (source: "project-override")
 * 4. Server has enabled: false in project metadata → disabled even if defined globally
 */
export function resolveServers(
  globalConfig: McpConfig,
  globalMeta: McpMetadata,
  projectConfig: McpConfig | null,
  projectMeta: McpMetadata | null,
): ResolvedServer[] {
  const merged = new Map<
    string,
    { def: McpConfig["mcpServers"][string]; source: ServerSource; enabled: boolean }
  >();

  // Start with all global servers
  for (const [name, def] of Object.entries(globalConfig.mcpServers)) {
    const meta = globalMeta.servers[name];
    merged.set(name, {
      def,
      source: "global",
      enabled: meta?.enabled ?? true,
    });
  }

  // Project overrides: merge or add
  if (projectConfig) {
    for (const [name, def] of Object.entries(projectConfig.mcpServers)) {
      const existing = merged.get(name);
      merged.set(name, {
        def,
        source: existing ? "project-override" : "project",
        enabled: true, // will be refined by metadata below
      });
    }
  }

  // Apply enabled/disabled from project metadata
  if (projectMeta) {
    for (const [name, meta] of Object.entries(projectMeta.servers)) {
      const existing = merged.get(name);
      if (existing) {
        existing.enabled = meta.enabled;
      }
    }
  }

  return Array.from(merged.entries()).map(([name, entry]) => ({
    name,
    def: entry.def,
    source: entry.source,
    enabled: entry.enabled,
  }));
}

/**
 * Merge auth.json env vars into a server definition at spawn time.
 * Auth env vars are added to the server's env, but don't override
 * explicitly set values in mcp-config.json.
 */
export function mergeEnvWithAuth(
  serverDef: McpConfig["mcpServers"][string],
  auth: Record<string, string>,
): McpConfig["mcpServers"][string] {
  if (Object.keys(auth).length === 0) return serverDef;

  return {
    ...serverDef,
    env: {
      ...auth,
      ...(serverDef.env ?? {}),
    },
  };
}

/**
 * Load both global and project configs and resolve servers.
 * Convenience wrapper around the individual load + resolve functions.
 */
export function loadAndResolve(
  cwd: string,
): { servers: ResolvedServer[]; globalDir: string; projectDir: string } {
  const globalDir = getGlobalConfigDir();
  const projectDir = getProjectConfigDir(cwd);

  const globalConfig = loadMcpConfig(globalDir);
  const globalMeta = loadMetadata(globalDir);

  // Project config is optional
  const projectConfigExists =
    fs.existsSync(path.join(projectDir, "mcp-config.json")) ||
    fs.existsSync(path.join(projectDir, "config.json"));

  const projectConfig = projectConfigExists ? loadMcpConfig(projectDir) : null;
  const projectMeta = projectConfigExists ? loadMetadata(projectDir) : null;

  const servers = resolveServers(globalConfig, globalMeta, projectConfig, projectMeta);

  return { servers, globalDir, projectDir };
}
