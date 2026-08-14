/**
 * @pi-unipi/mcp — Server registry
 *
 * Manages MCP server lifecycle: start, stop, restart, status tracking.
 * Coordinates McpClient instances and deterministic tool registration with pi.
 */

import { UNIPI_EVENTS, MCP_DEFAULTS } from "@pi-unipi/core";
import type {
  ResolvedServer,
  ServerState,
  McpRegistryEntry,
} from "../types.js";
import { McpClient } from "./client.js";
import {
  compareCodeUnits,
  translateMcpTool,
  type PiExternalTool,
} from "./translator.js";

/** Callback for emitting events */
export type EventEmitFn = (
  event: string,
  payload: Record<string, unknown>,
) => void;

/** Callback for registering a tool with pi */
export type RegisterToolFn = (tool: PiExternalTool) => void;

/** Callback for unregistering a tool with pi */
export type UnregisterToolFn = (toolName: string) => void;

/** Minimal client surface used by the registry. */
export type RegistryClient = Pick<
  McpClient,
  "connect" | "disconnect" | "listTools" | "callTool" | "pid"
>;

/** Options for ServerRegistry */
export interface ServerRegistryOptions {
  /** Function to emit events via pi.events */
  emitEvent: EventEmitFn;
  /** Function to register a tool with pi */
  registerTool: RegisterToolFn;
  /** Function to unregister a tool from pi */
  unregisterTool: UnregisterToolFn;
  /** Whether the host can actually remove dynamically registered tools. */
  canUnregisterTools?: boolean;
  /** Per-server startup timeout in ms */
  timeoutMs?: number;
  /** Client factory, primarily for tests. */
  createClient?: () => RegistryClient;
}

interface PreparedServer {
  entry: McpRegistryEntry;
  client: RegistryClient;
  tools: PiExternalTool[];
}

/** Server registry — tracks all MCP server connections and their tools. */
export class ServerRegistry {
  private entries = new Map<string, McpRegistryEntry>();
  private readonly emitEvent: EventEmitFn;
  private readonly registerTool: RegisterToolFn;
  private readonly unregisterTool: UnregisterToolFn;
  private readonly canUnregisterTools: boolean;
  private readonly timeoutMs: number;
  private readonly createClient: () => RegistryClient;

  constructor(options: ServerRegistryOptions) {
    this.emitEvent = options.emitEvent;
    this.registerTool = options.registerTool;
    this.unregisterTool = options.unregisterTool;
    this.canUnregisterTools = options.canUnregisterTools ?? true;
    this.timeoutMs = options.timeoutMs ?? MCP_DEFAULTS.STARTUP_TIMEOUT_MS;
    this.createClient = options.createClient ?? (() => new McpClient({ timeoutMs: this.timeoutMs }));
  }

  /**
   * Start one MCP server. Discovery completes before its tools are registered,
   * and registration always follows final Pi tool-name order.
   */
  async startServer(resolved: ResolvedServer): Promise<void> {
    await this.startServers([resolved]);
    const state = this.getServerState(resolved.name);
    if (state?.status === "error") {
      throw new Error(state.error ?? `MCP server "${resolved.name}" failed to start`);
    }
  }

  /**
   * Start MCP servers behind a discovery barrier.
   *
   * Connections and tool discovery run in parallel. Once every server has
   * either prepared or failed, tools from all successful servers are checked
   * for duplicate final names, sorted, and only then registered with Pi.
   * Individual connection failures remain represented by error registry
   * entries and do not prevent tools from other servers being registered.
   */
  async startServers(resolvedServers: ResolvedServer[]): Promise<void> {
    if (resolvedServers.length === 0) return;

    const names = new Set<string>();
    for (const { name } of resolvedServers) {
      if (names.has(name)) {
        throw new Error(`Duplicate MCP server name in startup batch: "${name}"`);
      }
      names.add(name);
    }

    const replacementCount = [...names].filter((name) => this.entries.has(name)).length;
    if (this.entries.size - replacementCount + resolvedServers.length > MCP_DEFAULTS.MAX_SERVERS) {
      throw new Error(
        `Maximum number of MCP servers (${MCP_DEFAULTS.MAX_SERVERS}) reached. ` +
          `Stop a server before starting a new one.`,
      );
    }

    // Existing instances must release their names before replacements prepare.
    await Promise.all(
      [...names]
        .filter((name) => this.entries.has(name))
        .map((name) => this.stopServer(name)),
    );

    const settled = await Promise.allSettled(
      resolvedServers.map((resolved) => this.prepareServer(resolved)),
    );
    const prepared = settled
      .filter((result): result is PromiseFulfilledResult<PreparedServer> => result.status === "fulfilled")
      .map((result) => result.value);

    if (prepared.length === 0) return;

    const registrations = prepared
      .flatMap(({ entry, tools }) => tools.map((tool) => ({ entry, tool })))
      .sort((left, right) => compareCodeUnits(left.tool.name, right.tool.name));

    try {
      this.assertUniqueFinalToolNames(registrations.map(({ tool }) => tool.name));
    } catch (error) {
      await this.failPreparedServers(prepared, error);
      throw error;
    }

    const registeredNames: string[] = [];
    try {
      for (const { tool } of registrations) {
        this.registerTool(tool);
        registeredNames.push(tool.name);
      }
    } catch (error) {
      if (this.canUnregisterTools) {
        for (const toolName of registeredNames.reverse()) {
          try {
            this.unregisterTool(toolName);
          } catch {
            // Preserve the original registration error.
          }
        }
        await this.failPreparedServers(prepared, error);
      } else {
        // Pi 0.80 cannot roll back dynamic registration. Keep the successfully
        // registered subset and its clients alive, and report the partial set
        // truthfully instead of pretending it was removed.
        const message = `${error instanceof Error ? error.message : String(error)}; ` +
          "some MCP tools remain registered until Pi restarts";
        for (const { entry, client, tools } of prepared) {
          const toolNames = tools
            .map((tool) => tool.name)
            .filter((name) => registeredNames.includes(name))
            .sort(compareCodeUnits);
          entry.toolNames = toolNames;
          entry.state = {
            ...entry.state,
            status: "error",
            pid: client.pid,
            toolCount: toolNames.length,
            error: message,
          };
          this.emitEvent(UNIPI_EVENTS.MCP_SERVER_ERROR, {
            name: entry.name,
            error: message,
          });
        }
      }
      throw error;
    }

    // State and success events are published only after every registration
    // succeeds. Server event order is deterministic as well.
    for (const { entry, client, tools } of [...prepared].sort((left, right) =>
      compareCodeUnits(left.entry.name, right.entry.name))) {
      const toolNames = tools.map((tool) => tool.name).sort(compareCodeUnits);
      entry.toolNames = toolNames;
      entry.state = {
        ...entry.state,
        status: "running",
        pid: client.pid,
        toolCount: toolNames.length,
      };

      this.emitEvent(UNIPI_EVENTS.MCP_SERVER_STARTED, {
        name: entry.name,
        toolCount: toolNames.length,
      });
      if (toolNames.length > 0) {
        this.emitEvent(UNIPI_EVENTS.MCP_TOOLS_REGISTERED, {
          serverName: entry.name,
          toolNames,
        });
      }
    }
  }

  private async prepareServer(resolved: ResolvedServer): Promise<PreparedServer> {
    const { name, def } = resolved;
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

    let client: RegistryClient | null = null;
    try {
      const safeCommand = typeof def.command === "string" ? def.command : String(def.command);
      const safeArgs = Array.isArray(def.args) ? def.args : [];
      let safeEnv: Record<string, string> | undefined;
      if (def.env !== undefined && def.env !== null && typeof def.env === "object" && !Array.isArray(def.env)) {
        safeEnv = {};
        for (const [key, value] of Object.entries(def.env)) {
          safeEnv[key] = typeof value === "string" ? value : String(value);
        }
      }

      client = this.createClient();
      const connectedClient = client;
      await connectedClient.connect(safeCommand, safeArgs, safeEnv);
      entry.client = connectedClient;

      const mcpTools = await connectedClient.listTools();
      const tools = mcpTools
        .map((tool) => translateMcpTool(tool, name, connectedClient))
        .sort((left, right) => compareCodeUnits(left.name, right.name));
      return { entry, client: connectedClient, tools };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entry.state = { ...state, status: "error", error: message };
      if (client) {
        try {
          await client.disconnect();
        } catch {
          // Ignore cleanup errors.
        }
      }
      entry.client = null;
      this.emitEvent(UNIPI_EVENTS.MCP_SERVER_ERROR, { name, error: message });
      throw error;
    }
  }

  private assertUniqueFinalToolNames(newNames: string[]): void {
    const existingNames = this.getActive().flatMap((state) =>
      this.entries.get(state.name)?.toolNames ?? []);
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const name of [...existingNames, ...newNames]) {
      if (seen.has(name)) duplicates.add(name);
      seen.add(name);
    }
    if (duplicates.size > 0) {
      throw new Error(
        `Duplicate final MCP tool name(s): ${[...duplicates].sort(compareCodeUnits).join(", ")}`,
      );
    }
  }

  private async failPreparedServers(prepared: PreparedServer[], error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await Promise.all(prepared.map(async ({ entry, client }) => {
      entry.state = { ...entry.state, status: "error", toolCount: 0, error: message };
      entry.toolNames = [];
      try {
        await client.disconnect();
      } catch {
        // Ignore cleanup errors.
      }
      entry.client = null;
      this.emitEvent(UNIPI_EVENTS.MCP_SERVER_ERROR, { name: entry.name, error: message });
    }));
  }

  /** Stop an MCP server: unregister tools, disconnect client. */
  async stopServer(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) return;

    if (entry.toolNames.length > 0 && !this.canUnregisterTools) {
      throw new Error(
        "This Pi version cannot remove MCP tools at runtime; restart Pi to change the MCP tool set.",
      );
    }

    for (const toolName of entry.toolNames) {
      this.unregisterTool(toolName);
    }

    if (entry.toolNames.length > 0) {
      this.emitEvent(UNIPI_EVENTS.MCP_TOOLS_UNREGISTERED, {
        serverName: name,
        toolNames: entry.toolNames,
      });
    }

    if (entry.client) {
      try {
        await (entry.client as RegistryClient).disconnect();
      } catch {
        // Ignore disconnect errors.
      }
      entry.client = null;
    }

    entry.state = { ...entry.state, status: "stopped", toolCount: 0 };
    entry.toolNames = [];
    this.emitEvent(UNIPI_EVENTS.MCP_SERVER_STOPPED, { name });
  }

  /** Restart an MCP server: stop then start. */
  async restartServer(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Server '${name}' not found in registry`);
    const resolved = entry.resolved;
    await this.stopServer(name);
    await this.startServer(resolved);
  }

  /** Stop all running servers when runtime unregistration is supported. */
  async stopAll(): Promise<void> {
    const names = Array.from(this.entries.keys());
    await Promise.allSettled(names.map((name) => this.stopServer(name)));
  }

  /** Disconnect clients during extension shutdown without claiming tools were removed. */
  async disconnectAll(): Promise<void> {
    await Promise.allSettled([...this.entries.values()].map(async (entry) => {
      if (!entry.client) return;
      try {
        await (entry.client as RegistryClient).disconnect();
      } finally {
        entry.client = null;
      }
    }));
  }

  /** Get all registered server states. */
  getAll(): ServerState[] {
    return Array.from(this.entries.values()).map((entry) => entry.state);
  }

  /** Get states of running servers. */
  getActive(): ServerState[] {
    return this.getAll().filter((state) => state.status === "running");
  }

  /** Get states of servers in error state. */
  getFailed(): ServerState[] {
    return this.getAll().filter((state) => state.status === "error");
  }

  /** Get total number of tools across all active servers. */
  getTotalToolCount(): number {
    return this.getActive().reduce((sum, state) => sum + state.toolCount, 0);
  }

  /** Get the state of a specific server. */
  getServerState(name: string): ServerState | null {
    return this.entries.get(name)?.state ?? null;
  }

  /** Get the full registry entry for a server. */
  getEntry(name: string): McpRegistryEntry | null {
    return this.entries.get(name) ?? null;
  }

  /** Check if a server exists in the registry. */
  hasServer(name: string): boolean {
    return this.entries.has(name);
  }

  /** Get the number of registered servers. */
  get size(): number {
    return this.entries.size;
  }
}
