/**
 * @pi-unipi/mcp — Config schema defaults and validation
 */

import type { McpConfig, McpMetadata, SyncConfig } from "../types.js";

/** Default empty MCP config */
export const DEFAULT_MCP_CONFIG: McpConfig = {
  mcpServers: {},
};

/** Default sync configuration */
export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  enabled: true,
  lastSyncAt: null,
  syncIntervalMs: 86400000, // 24 hours
};

/** Default metadata config */
export const DEFAULT_METADATA: McpMetadata = {
  servers: {},
  sync: DEFAULT_SYNC_CONFIG,
};

/** Validation result */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate an MCP config structure.
 * Checks that each server has required fields (command, args).
 */
export function validateMcpConfig(config: unknown): ValidationResult {
  const errors: string[] = [];

  if (!config || typeof config !== "object") {
    return { valid: false, errors: ["Config must be a non-null object"] };
  }

  const obj = config as Record<string, unknown>;

  if (!obj.mcpServers || typeof obj.mcpServers !== "object") {
    return { valid: false, errors: ["Missing or invalid 'mcpServers' field"] };
  }

  const servers = obj.mcpServers as Record<string, unknown>;

  for (const [name, server] of Object.entries(servers)) {
    if (!server || typeof server !== "object") {
      errors.push(`Server '${name}': must be a non-null object`);
      continue;
    }

    const s = server as Record<string, unknown>;

    if (typeof s.command !== "string" || s.command.trim() === "") {
      errors.push(`Server '${name}': 'command' must be a non-empty string`);
    }

    if (!Array.isArray(s.args)) {
      errors.push(`Server '${name}': 'args' must be an array`);
    } else {
      for (let i = 0; i < s.args.length; i++) {
        if (typeof s.args[i] !== "string") {
          errors.push(`Server '${name}': args[${i}] must be a string`);
        }
      }
    }

    if (s.env !== undefined) {
      if (typeof s.env !== "object" || s.env === null) {
        errors.push(`Server '${name}': 'env' must be an object if present`);
      } else {
        const env = s.env as Record<string, unknown>;
        for (const [key, val] of Object.entries(env)) {
          if (typeof val !== "string") {
            errors.push(`Server '${name}': env.${key} must be a string`);
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Create a minimal server definition template for a new server.
 */
export function createServerTemplate(
  name: string,
  command: string,
  args: string[],
  envVars?: string[],
): McpConfig {
  const env: Record<string, string> = {};
  if (envVars) {
    for (const v of envVars) {
      env[v] = "";
    }
  }

  return {
    mcpServers: {
      [name]: {
        command,
        args,
        env: Object.keys(env).length > 0 ? env : undefined,
      },
    },
  };
}
