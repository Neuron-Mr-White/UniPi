/**
 * @pi-unipi/mcp — Server registry
 *
 * Manages MCP server lifecycle: start, stop, restart, status tracking.
 * Coordinates McpClient instances and tool registration with pi.
 */

import { UNIPI_EVENTS, MCP_DEFAULTS } from "@pi-unipi/core";
import type {
  ResolvedServer,
  ServerState,
  ServerStatus,
  McpTool,
  McpRegistryEntry,
} from "../types.js";
import { McpClient } from "./client.js";
import { translateMcpTool, type PiExternalTool } from "./translator.js";

/** Callback for emitting events */
export type EventEmitFn = (
  event: string,
  payload: Record<string, unknown>,
) => void;

/** Callback for registering a tool with pi */
export type RegisterToolFn = (tool: PiExternalTool) => void;

/** Callback for unregistering a tool with pi */
export type UnregisterToolFn = (toolName: string) => void;

/** Options for ServerRegistry */
export interface ServerRegistryOptions {
  /** Function to emit events via pi.events */
  emitEvent: EventEmitFn;
  /** Function to register a tool with pi */
  registerTool: RegisterToolFn;
  /** Function to unregister a tool from pi */
  unregisterTool: UnregisterToolFn;
  /** Per-server startup timeout in ms */
  timeoutMs?: number;
}

/**
 * Server registry — tracks all MCP server connections and their tools.
 */
export class ServerRegistry {
  private entries = new Map<string, McpRegistryEntry>();
  private readonly emitEvent: EventEmitFn;
  private readonly registerTool: RegisterToolFn;
  private readonly unregisterTool: UnregisterToolFn;
  private readonly timeoutMs: number;

  constructor(options: ServerRegistryOptions) {
    this.emitEvent = options.emitEvent;
    this.registerTool = options.registerTool;
    this.unregisterTool = options.unregisterTool;
    this.timeoutMs = options.timeoutMs ?? MCP_DEFAULTS.STARTUP_TIMEOUT_MS;
  }

  /**
   * Start an MCP server: spawn process, initialize, discover tools, register.
   */
  async startServer(resolved: ResolvedServer): Promise<void> {
    const { name, def } = resolved;

    // Check max servers limit
    if (this.entries.size >= MCP_DEFAULTS.MAX_SERVERS) {
      throw new Error(
        `Maximum number of MCP servers (${MCP_DEFAULTS.MAX_SERVERS}) reached. ` +
          `Stop a server before starting a new one.`,
      );
    }

    // Stop existing server with same name if running
    if (this.entries.has(name)) {
      await this.stopServer(name);
    }

    const state: ServerState = {
      name,
      status: "starting",
      toolCount: 0,
      startedAt: new Date().toISOString(),
    };

    const entry: McpRegistryEntry = {
      name,
      resolved,
      state,
      client: null,
      toolNames: [],
    };

    this.entries.set(name, entry);

    try {
      // Defensive: ensure server definition has correct types before passing
      // to the client. Catches rare serialization bugs where env/args become
      // strings instead of objects/arrays.
      const safeCommand = typeof def.command === "string" ? def.command : String(def.command);
      const safeArgs = Array.isArray(def.args) ? def.args : [];
      let safeEnv: Record<string, string> | undefined;
      if (def.env !== undefined && def.env !== null) {
        if (typeof def.env === "object" && !Array.isArray(def.env)) {
          safeEnv = {};
          for (const [k, v] of Object.entries(def.env)) {
            safeEnv[k] = typeof v === "string" ? v : String(v);
          }
        } else {
          console.error(
            `[MCP] Server '${name}': env is not an object (${typeof def.env}), skipping env vars`,
          );
        }
      }

      // Create and connect client
      const client = new McpClient({ timeoutMs: this.timeoutMs });
      await client.connect(safeCommand, safeArgs, safeEnv);

      entry.client = client;

      // Discover tools
      const mcpTools = await client.listTools();

      // Translate and register tools
      const toolNames: string[] = [];
      for (const mcpTool of mcpTools) {
        const piTool = translateMcpTool(mcpTool, name, client);
        this.registerTool(piTool);
        toolNames.push(piTool.name);
      }

      // Update state
      entry.state = {
        ...state,
        status: "running",
        pid: client.pid,
        toolCount: toolNames.length,
      };
      entry.toolNames = toolNames;

      // Emit events
      this.emitEvent(UNIPI_EVENTS.MCP_SERVER_STARTED, {
        name,
        toolCount: toolNames.length,
      });

      if (toolNames.length > 0) {
        this.emitEvent(UNIPI_EVENTS.MCP_TOOLS_REGISTERED, {
          serverName: name,
          toolNames,
        });
      }
    } catch (err) {
      const error =
        err instanceof Error ? err.message : String(err);

      entry.state = {
        ...state,
        status: "error",
        error,
      };

      // Clean up client if partially connected
      if (entry.client) {
        try {
          await (entry.client as McpClient).disconnect();
        } catch {
          // Ignore cleanup errors
        }
        entry.client = null;
      }

      this.emitEvent(UNIPI_EVENTS.MCP_SERVER_ERROR, {
        name,
        error,
      });

      throw err;
    }
  }

  /**
   * Stop an MCP server: unregister tools, disconnect client.
   */
  async stopServer(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) return;

    // Unregister tools
    for (const toolName of entry.toolNames) {
      this.unregisterTool(toolName);
    }

    if (entry.toolNames.length > 0) {
      this.emitEvent(UNIPI_EVENTS.MCP_TOOLS_UNREGISTERED, {
        serverName: name,
        toolNames: entry.toolNames,
      });
    }

    // Disconnect client
    if (entry.client) {
      try {
        await (entry.client as McpClient).disconnect();
      } catch {
        // Ignore disconnect errors
      }
      entry.client = null;
    }

    // Update state
    entry.state = {
      ...entry.state,
      status: "stopped",
      toolCount: 0,
    };
    entry.toolNames = [];

    this.emitEvent(UNIPI_EVENTS.MCP_SERVER_STOPPED, { name });
  }

  /**
   * Restart an MCP server: stop then start.
   */
  async restartServer(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) {
      throw new Error(`Server '${name}' not found in registry`);
    }

    const resolved = entry.resolved;
    await this.stopServer(name);
    await this.startServer(resolved);
  }

  /**
   * Stop all running servers.
   */
  async stopAll(): Promise<void> {
    const names = Array.from(this.entries.keys());
    await Promise.allSettled(names.map((name) => this.stopServer(name)));
  }

  /**
   * Get all registered server states.
   */
  getAll(): ServerState[] {
    return Array.from(this.entries.values()).map((e) => e.state);
  }

  /**
   * Get states of running servers.
   */
  getActive(): ServerState[] {
    return this.getAll().filter((s) => s.status === "running");
  }

  /**
   * Get states of servers in error state.
   */
  getFailed(): ServerState[] {
    return this.getAll().filter((s) => s.status === "error");
  }

  /**
   * Get total number of tools across all active servers.
   */
  getTotalToolCount(): number {
    return this.getActive().reduce((sum, s) => sum + s.toolCount, 0);
  }

  /**
   * Get the state of a specific server.
   */
  getServerState(name: string): ServerState | null {
    return this.entries.get(name)?.state ?? null;
  }

  /**
   * Get the full registry entry for a server.
   */
  getEntry(name: string): McpRegistryEntry | null {
    return this.entries.get(name) ?? null;
  }

  /**
   * Check if a server exists in the registry.
   */
  hasServer(name: string): boolean {
    return this.entries.has(name);
  }

  /**
   * Get the number of registered servers.
   */
  get size(): number {
    return this.entries.size;
  }
}
