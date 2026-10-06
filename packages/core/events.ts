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

  /** Workflow command ended */
  WORKFLOW_END: "unipi:workflow:end",

  /** Permission mode changed (ask | auto | full) */
  PERMISSION_MODE_CHANGED: "unipi:permission:mode:changed",
  /** Plan mode toggled on/off */
  PLAN_MODE_CHANGED: "unipi:plan:mode:changed",

  /** Ralph loop ended */
  RALPH_LOOP_END: "unipi:ralph:loop:end",
  /** Ralph loop iteration completed */
  RALPH_ITERATION_DONE: "unipi:ralph:iteration:done",

  /** Long-horizon mode resolved for the current turn */
  LONG_HORIZON_MODE_RESOLVED: "unipi:long-horizon:mode:resolved",
  /** Long-horizon automation owner lifecycle changed */
  LONG_HORIZON_OWNER_CHANGED: "unipi:long-horizon:owner:changed",

  /** Memory stored/updated */
  MEMORY_STORED: "unipi:memory:stored",
  /** Memory deleted */
  MEMORY_DELETED: "unipi:memory:deleted",
  /** Memory consolidation completed */
  MEMORY_CONSOLIDATED: "unipi:memory:consolidated",

  /** MCP server started */
  MCP_SERVER_STARTED: "unipi:mcp:server:started",
  /** MCP server error */
  MCP_SERVER_ERROR: "unipi:mcp:server:error",
  /** MCP tools registered */
  MCP_TOOLS_REGISTERED: "unipi:mcp:tools:registered",

  /** Compactor: compaction completed */
  COMPACTOR_COMPACTED: "unipi:compactor:compacted",

  /** Notification sent */
  NOTIFICATION_SENT: "unipi:notify:sent",

  /** Agent asked user a question (ask_user tool invoked) */
  ASK_USER_PROMPT: "unipi:ask-user:prompt",

  /** Update check performed */
  UPDATE_CHECK: "unipi:update:check",
  /** Update available */
  UPDATE_AVAILABLE: "unipi:update:available",
  /** Update applied */
  UPDATE_APPLIED: "unipi:update:applied",
  /** Update error */
  UPDATE_ERROR: "unipi:update:error",

  /** Long-horizon footer state (sticky; replayed to late subscribers by the bus) */
  LH_STATE: "unipi:long-horizon:state",
  /** Kanboard claims/autowork status (sticky) */
  KANBOARD_STATUS: "unipi:kanboard:status",
  /** Fusion lead/sidekick display status (sticky; undefined = cleared) */
  FUSION_STATUS: "unipi:fusion:status",
  /** Workflow plan/permission mode (sticky) */
  WORKFLOW_STATUS: "unipi:workflow:status",

  /** Reveal hidden skills by name (one-shot; previously used as a literal string) */
  SKILLS_REVEAL: "unipi:skills:reveal",

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
  /** Load time in milliseconds (optional) */
  loadTimeMs?: number;
}

/** Payload for WORKFLOW_END */
export interface UnipiWorkflowEvent {
  /** Command name, e.g. "brainstorm" */
  command: string;
  /** Full command with prefix, e.g. "/unipi:plan" */
  fullCommand: string;
  /** Arguments passed to command */
  args: string;
  /** For WORKFLOW_END: whether it succeeded */
  success?: boolean;
  /** For WORKFLOW_END: duration in ms */
  durationMs?: number;
}

/** Payload for PERMISSION_MODE_CHANGED */
export interface UnipiPermissionModeEvent {
  /** The new permission mode (ask | auto | full) */
  mode: string;
}

/** Payload for PLAN_MODE_CHANGED */
export interface UnipiPlanModeEvent {
  /** Plan mode is now on/off */
  active: boolean;
  /** Plan file path (display form) */
  planFile: string;
  /** Why plan mode ended (toggled | approved | discarded) */
  reason?: string;
}

/** Payload for RALPH_LOOP_END */
export interface UnipiRalphLoopEvent {
  /** Loop name */
  name: string;
  /** Terminal reason */
  reason: string;
  /** Iterations completed */
  iterations: number;
}

/** Payload for RALPH_ITERATION_DONE */
export interface UnipiRalphIterationEvent {
  /** Loop name */
  name: string;
  /** Iteration that just completed */
  iteration: number;
  /** Iterations remaining (budget minus done) */
  remaining: number;
}

/** Payload for LONG_HORIZON_MODE_RESOLVED */
export interface UnipiLhModeResolvedEvent {
  /** Resolved mode id */
  mode: string;
  /** Resolution source (explicit | owner | judge | default | …) */
  source: string;
  /** Judge confidence, when judged */
  confidence?: number;
}

/** Payload for LONG_HORIZON_OWNER_CHANGED */
export interface UnipiLhOwnerChangedEvent {
  /** Transition type (activated | suspended | resumed | finished | cleared | restored) */
  event: string;
  /** Owner id, when the transition names one */
  ownerId?: string;
  /** Owner kind, when present */
  kind?: string;
  /** Owner status, when present */
  status?: string;
  /** Terminal/pause reason for finished/suspended */
  reason?: string;
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


/** Payload for MEMORY_CONSOLIDATED */
export interface UnipiMemoryConsolidatedEvent {
  /** Number of memories extracted */
  count: number;
  /** Project name */
  projectName: string;
}


/** Payload for MCP_SERVER_STARTED / MCP_SERVER_ERROR */
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

/** Payload for MCP_TOOLS_REGISTERED */
export interface UnipiMcpToolsEvent {
  /** Server name */
  serverName: string;
  /** Tool names */
  toolNames: string[];
}

/** Payload for COMPACTOR compaction completed */
export interface UnipiCompactionEvent {
  /** Compaction method (boundary | percentage | …) */
  method: string;
  /** Messages summarized */
  summarized: number;
  /** Messages kept */
  kept: number;
  /** Tokens before compaction */
  tokensBefore: number;
  /** Tokens after compaction */
  tokensAfter: number;
  /** Estimated tokens saved */
  tokensSaved: number;
}





/** Payload for ASK_USER_PROMPT */
export interface UnipiAskUserPromptEvent {
  /** Question being asked */
  question: string;
  /** Additional context */
  context?: string;
  /** Number of options provided */
  optionCount?: number;
  /** Whether multi-select mode */
  allowMultiple?: boolean;
  /** Whether freeform input allowed */
  allowFreeform?: boolean;
}

/** Payload for UPDATE_CHECK */
export interface UnipiUpdateCheckEvent {
  /** Current installed version */
  currentVersion: string;
  /** Latest version found on npm */
  latestVersion: string;
  /** Whether an update is available */
  updateAvailable: boolean;
  /** Error if check failed */
  error?: string;
}

/** Payload for UPDATE_AVAILABLE */
export interface UnipiUpdateAvailableEvent {
  /** Current installed version */
  currentVersion: string;
  /** Latest version available */
  latestVersion: string;
}

/** Payload for UPDATE_APPLIED */
export interface UnipiUpdateAppliedEvent {
  /** Previous version */
  previousVersion: string;
  /** New version after update */
  newVersion: string;
}

/** Payload for UPDATE_ERROR */
export interface UnipiUpdateErrorEvent {
  /** Error message */
  error: string;
  /** Whether the error was from check or install */
  phase: "check" | "install";
}




/** Payload for NOTIFICATION_SENT */
export interface UnipiNotificationSentEvent {
  /** Event type that triggered notification */
  eventType: string;
  /** Platforms sent to */
  platforms: string[];
  /** Whether all platforms succeeded */
  success: boolean;
  /** Platforms where notification was suppressed (e.g. window focused) */
  suppressedPlatforms?: string[];
  /** ISO timestamp */
  timestamp: string;
}

/** Union of all unipi event payloads */
export type UnipiEventPayload =
  | UnipiModuleEvent
  | UnipiWorkflowEvent
  | UnipiPermissionModeEvent
  | UnipiPlanModeEvent
  | UnipiRalphLoopEvent
  | UnipiRalphIterationEvent
  | UnipiLhModeResolvedEvent
  | UnipiLhOwnerChangedEvent
  | UnipiMemoryStoredEvent
  | UnipiMemoryDeletedEvent
  | UnipiMemoryConsolidatedEvent
  | UnipiMcpServerEvent
  | UnipiMcpToolsEvent
  | UnipiCompactionEvent
  | UnipiNotificationSentEvent
  | UnipiAskUserPromptEvent
  | UnipiUpdateCheckEvent
  | UnipiUpdateAvailableEvent
  | UnipiUpdateAppliedEvent
  | UnipiUpdateErrorEvent;
