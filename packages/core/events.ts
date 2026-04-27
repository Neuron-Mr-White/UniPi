/**
 * @unipi/core — Event type definitions for inter-module communication
 *
 * Modules announce presence via pi.events. Other modules listen and
 * enable integration features when peers are detected.
 */

/** Event names emitted by unipi modules */
export const UNIPI_EVENTS = {
  /** Module loaded and ready */
  MODULE_READY: "unipi:module:ready",
  /** Module unloading */
  MODULE_GONE: "unipi:module:gone",

  /** Workflow command started */
  WORKFLOW_START: "unipi:workflow:start",
  /** Workflow command ended */
  WORKFLOW_END: "unipi:workflow:end",

  /** Ralph loop started */
  RALPH_LOOP_START: "unipi:ralph:loop:start",
  /** Ralph loop ended */
  RALPH_LOOP_END: "unipi:ralph:loop:end",
  /** Ralph loop iteration completed */
  RALPH_ITERATION_DONE: "unipi:ralph:iteration:done",

  /** Request module status (for info-screen) */
  MODULE_STATUS_REQUEST: "unipi:module:status:request",
  /** Module status response */
  MODULE_STATUS_RESPONSE: "unipi:module:status:response",

  /** Info screen group registered */
  INFO_GROUP_REGISTERED: "unipi:info:group:registered",
  /** Info screen data updated */
  INFO_DATA_UPDATED: "unipi:info:data:updated",

  /** Memory stored/updated */
  MEMORY_STORED: "unipi:memory:stored",
  /** Memory deleted */
  MEMORY_DELETED: "unipi:memory:deleted",
  /** Memory search performed */
  MEMORY_SEARCHED: "unipi:memory:searched",
  /** Memory consolidation completed */
  MEMORY_CONSOLIDATED: "unipi:memory:consolidated",

  /** MCP server started */
  MCP_SERVER_STARTED: "unipi:mcp:server:started",
  /** MCP server stopped */
  MCP_SERVER_STOPPED: "unipi:mcp:server:stopped",
  /** MCP server error */
  MCP_SERVER_ERROR: "unipi:mcp:server:error",
  /** MCP tools registered */
  MCP_TOOLS_REGISTERED: "unipi:mcp:tools:registered",
  /** MCP tools unregistered */
  MCP_TOOLS_UNREGISTERED: "unipi:mcp:tools:unregistered",
  /** MCP catalog synced */
  MCP_CATALOG_SYNCED: "unipi:mcp:catalog:synced",

  /** Compactor: compaction completed */
  COMPACTOR_COMPACTED: "unipi:compactor:compacted",
  /** Compactor: stats updated */
  COMPACTOR_STATS_UPDATED: "unipi:compactor:stats:updated",
} as const;

/** Payload for MODULE_READY / MODULE_GONE */
export interface UnipiModuleEvent {
  /** Module name, e.g. "@unipi/workflow" */
  name: string;
  /** Module version */
  version: string;
  /** Commands registered by this module */
  commands: string[];
  /** Tools registered by this module */
  tools: string[];
}

/** Payload for WORKFLOW_START / WORKFLOW_END */
export interface UnipiWorkflowEvent {
  /** Command name, e.g. "brainstorm" */
  command: string;
  /** Full command with prefix, e.g. "/unipi:brainstorm" */
  fullCommand: string;
  /** Arguments passed to command */
  args: string;
  /** For WORKFLOW_END: whether it succeeded */
  success?: boolean;
  /** For WORKFLOW_END: duration in ms */
  durationMs?: number;
}

/** Payload for RALPH_LOOP_START / RALPH_LOOP_END */
export interface UnipiRalphLoopEvent {
  /** Loop name */
  name: string;
  /** Current iteration */
  iteration: number;
  /** Max iterations (0 = unlimited) */
  maxIterations: number;
  /** Loop status */
  status: "active" | "paused" | "completed";
  /** For RALPH_LOOP_END: reason */
  reason?: "completed" | "max_reached" | "cancelled" | "error";
}

/** Payload for RALPH_ITERATION_DONE */
export interface UnipiRalphIterationEvent {
  /** Loop name */
  name: string;
  /** Iteration that just completed */
  iteration: number;
  /** Next iteration number */
  nextIteration: number;
}

/** Payload for MODULE_STATUS_REQUEST */
export interface UnipiStatusRequestEvent {
  /** Request ID for correlation */
  requestId: string;
}

/** Payload for MODULE_STATUS_RESPONSE */
export interface UnipiStatusResponseEvent {
  /** Request ID this responds to */
  requestId: string;
  /** Module name */
  name: string;
  /** Module status data */
  status: Record<string, unknown>;
}

/** Payload for MEMORY_STORED */
export interface UnipiMemoryStoredEvent {
  /** Memory ID */
  id: string;
  /** Memory title */
  title: string;
  /** Memory type */
  type: string;
  /** Project name */
  project: string;
  /** Whether this was an update or create */
  action: "created" | "updated";
}

/** Payload for MEMORY_DELETED */
export interface UnipiMemoryDeletedEvent {
  /** Memory ID */
  id: string;
  /** Memory title */
  title: string;
  /** Project name */
  project: string;
}

/** Payload for MEMORY_SEARCHED */
export interface UnipiMemorySearchedEvent {
  /** Search query */
  query: string;
  /** Number of results */
  resultCount: number;
  /** Project scope */
  project: string;
}

/** Payload for MEMORY_CONSOLIDATED */
export interface UnipiMemoryConsolidatedEvent {
  /** Number of memories extracted */
  count: number;
  /** Project name */
  projectName: string;
}

/** Payload for INFO_GROUP_REGISTERED */
export interface UnipiInfoGroupEvent {
  /** Group id */
  groupId: string;
  /** Group display name */
  groupName: string;
  /** Module that registered the group */
  module: string;
}

/** Payload for INFO_DATA_UPDATED */
export interface UnipiInfoDataEvent {
  /** Group id */
  groupId: string;
  /** Updated data keys */
  keys: string[];
}

/** Payload for MCP_SERVER_STARTED / MCP_SERVER_STOPPED */
export interface UnipiMcpServerEvent {
  /** Server name */
  name: string;
  /** Number of tools (for started) */
  toolCount?: number;
  /** Error message (for error) */
  error?: string;
  /** Process ID */
  pid?: number;
}

/** Payload for MCP_TOOLS_REGISTERED / MCP_TOOLS_UNREGISTERED */
export interface UnipiMcpToolsEvent {
  /** Server name */
  serverName: string;
  /** Tool names */
  toolNames: string[];
}

/** Payload for MCP_CATALOG_SYNCED */
export interface UnipiMcpCatalogSyncedEvent {
  /** Total servers in catalog */
  totalServers: number;
  /** Source of sync */
  source: string;
}

/** Payload for COMPACTOR compaction completed */
export interface UnipiCompactionEvent {
  /** Session ID */
  sessionId: string;
  /** Messages summarized */
  summarized: number;
  /** Messages kept */
  kept: number;
  /** Estimated tokens saved */
  tokensSaved: number;
  /** Compression ratio string, e.g. "56:1" */
  compressionRatio: string;
}

/** Payload for COMPACTOR stats update */
export interface UnipiCompactorStatsEvent {
  /** Session events count */
  sessionEvents: number;
  /** Compactions count */
  compactions: number;
  /** Tokens saved total */
  tokensSaved: number;
  /** Indexed documents count */
  indexedDocs: number;
  /** Sandbox executions count */
  sandboxRuns: number;
  /** Search queries count */
  searchQueries: number;
}

/** Union of all unipi event payloads */
export type UnipiEventPayload =
  | UnipiModuleEvent
  | UnipiWorkflowEvent
  | UnipiRalphLoopEvent
  | UnipiRalphIterationEvent
  | UnipiStatusRequestEvent
  | UnipiStatusResponseEvent
  | UnipiMemoryStoredEvent
  | UnipiMemoryDeletedEvent
  | UnipiMemorySearchedEvent
  | UnipiMemoryConsolidatedEvent
  | UnipiInfoGroupEvent
  | UnipiInfoDataEvent
  | UnipiMcpServerEvent
  | UnipiMcpToolsEvent
  | UnipiMcpCatalogSyncedEvent
  | UnipiCompactionEvent
  | UnipiCompactorStatsEvent;
