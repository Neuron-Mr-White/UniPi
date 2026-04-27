/**
 * @pi-unipi/mcp — Type definitions
 *
 * All interfaces for MCP server configuration, catalog, tools, and state.
 */

/** MCP server definition — standard format compatible with Claude Desktop, Cursor, etc. */
export interface McpServerDef {
  /** Command to spawn the server (e.g. "npx", "docker", "node") */
  command: string;
  /** Arguments passed to the command */
  args: string[];
  /** Environment variables for the server process */
  env?: Record<string, string>;
}

/** MCP configuration file format (mcp-config.json) */
export interface McpConfig {
  /** Map of server name → server definition */
  mcpServers: Record<string, McpServerDef>;
}

/** Per-server metadata (config.json) */
export interface ServerMeta {
  /** Whether this server is enabled */
  enabled: boolean;
  /** ISO timestamp when server was added */
  addedAt: string;
}

/** Sync configuration */
export interface SyncConfig {
  /** Whether auto-sync is enabled */
  enabled: boolean;
  /** ISO timestamp of last successful sync */
  lastSyncAt: string | null;
  /** Sync interval in milliseconds */
  syncIntervalMs: number;
}

/** Full metadata config (config.json) */
export interface McpMetadata {
  /** Per-server metadata */
  servers: Record<string, ServerMeta>;
  /** Sync configuration */
  sync: SyncConfig;
}

/** Per-server auth data (auth.json) */
export interface McpAuth {
  /** Map of server name → environment variable key-value pairs */
  [serverName: string]: Record<string, string>;
}

/** Single entry from the MCP server catalog */
export interface CatalogEntry {
  /** Unique identifier (e.g. "github/github-mcp-server") */
  id: string;
  /** Display name */
  name: string;
  /** Short description */
  description: string;
  /** GitHub repository URL */
  github: string;
  /** Categories/tags */
  categories: string[];
  /** Primary language */
  language: string;
  /** Scope: "cloud" or "local" */
  scope: "cloud" | "local";
  /** Whether this is an official/verified server */
  official: boolean;
  /** Pre-filled install configuration */
  install?: {
    command: string;
    args: string[];
    envVars?: string[];
  };
}

/** Cached catalog data (servers.json) */
export interface CatalogData {
  /** ISO timestamp of last update */
  lastUpdated: string;
  /** Source identifier */
  source: string;
  /** Total number of servers */
  totalServers: number;
  /** Server entries */
  servers: CatalogEntry[];
}

/** MCP tool definition (from tools/list response) */
export interface McpTool {
  /** Tool name */
  name: string;
  /** Tool description */
  description: string;
  /** JSON Schema for tool input parameters */
  inputSchema: Record<string, unknown>;
}

/** MCP tool call result */
export interface McpToolResult {
  /** Content blocks returned by the tool */
  content: Array<{
    type: "text" | "image" | "resource";
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  /** Whether this result is an error */
  isError?: boolean;
}

/** Source of a resolved server */
export type ServerSource = "global" | "project" | "project-override";

/** A resolved server with merge metadata */
export interface ResolvedServer {
  /** Server name */
  name: string;
  /** Server definition */
  def: McpServerDef;
  /** Where this server config came from */
  source: ServerSource;
  /** Whether the server is enabled */
  enabled: boolean;
}

/** Server runtime state */
export type ServerStatus = "starting" | "running" | "error" | "stopped";

/** Runtime state of a connected server */
export interface ServerState {
  /** Server name */
  name: string;
  /** Current status */
  status: ServerStatus;
  /** Process ID (if running) */
  pid?: number;
  /** Number of tools registered */
  toolCount: number;
  /** Error message (if status is "error") */
  error?: string;
  /** When the server was started */
  startedAt?: string;
}

/** Entry in the server registry */
export interface McpRegistryEntry {
  /** Server name */
  name: string;
  /** Resolved server config */
  resolved: ResolvedServer;
  /** Current state */
  state: ServerState;
  /** MCP client instance (if connected) */
  client: unknown | null;
  /** Registered tool names */
  toolNames: string[];
}
