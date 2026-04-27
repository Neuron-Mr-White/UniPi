/**
 * @pi-unipi/mcp — MCP JSON-RPC Client
 *
 * Spawns an MCP server as a child process, performs the JSON-RPC initialize
 * handshake, and provides listTools/callTool/disconnect methods via stdio.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { McpTool, McpToolResult } from "../types.js";
import { MCP_DEFAULTS } from "@pi-unipi/core";

/** JSON-RPC request */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC response */
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** JSON-RPC notification (no id) */
interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

/** Pending request handler */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Options for McpClient */
export interface McpClientOptions {
  /** Per-request timeout in ms (default: MCP_DEFAULTS.STARTUP_TIMEOUT_MS) */
  timeoutMs?: number;
  /** Working directory for the spawned process */
  cwd?: string;
}

/**
 * MCP JSON-RPC client over stdio transport.
 *
 * Spawns a child process, sends JSON-RPC messages to stdin,
 * reads responses from stdout, and correlates by request ID.
 */
export class McpClient {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = "";
  private connected = false;
  private stderrBuffer = "";
  private readonly timeoutMs: number;
  private readonly cwd?: string;

  constructor(options?: McpClientOptions) {
    this.timeoutMs = options?.timeoutMs ?? MCP_DEFAULTS.STARTUP_TIMEOUT_MS;
    this.cwd = options?.cwd;
  }

  /**
   * Spawn the MCP server process and perform the initialize handshake.
   */
  async connect(
    command: string,
    args: string[],
    env?: Record<string, string>,
  ): Promise<void> {
    if (this.connected) {
      throw new Error("McpClient is already connected");
    }

    return new Promise<void>((resolve, reject) => {
      try {
        const mergedEnv = { ...process.env, ...env };

        this.process = spawn(command, args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: mergedEnv,
          cwd: this.cwd,
        });

        this.process.on("error", (err) => {
          this.cleanup();
          reject(new Error(`Failed to spawn MCP server: ${err.message}`));
        });

        this.process.on("exit", (code, signal) => {
          if (!this.connected) {
            this.cleanup();
            reject(
              new Error(
                `MCP server exited during startup: code=${code}, signal=${signal}\nStderr: ${this.stderrBuffer}`,
              ),
            );
            return;
          }
          // Unexpected exit after connection
          this.connected = false;
          this.rejectAllPending(
            new Error(
              `MCP server exited unexpectedly: code=${code}, signal=${signal}`,
            ),
          );
        });

        // Set up stdout reading
        this.process.stdout!.on("data", (chunk: Buffer) => {
          this.handleStdoutData(chunk);
        });

        // Capture stderr for error reporting
        this.process.stderr!.on("data", (chunk: Buffer) => {
          this.stderrBuffer += chunk.toString();
          // Keep stderr buffer manageable
          if (this.stderrBuffer.length > 10000) {
            this.stderrBuffer = this.stderrBuffer.slice(-5000);
          }
        });

        // Perform initialize handshake
        this.sendRequest("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: "@pi-unipi/mcp",
            version: "0.1.0",
          },
        })
          .then(() => {
            // Send initialized notification
            this.sendNotification("notifications/initialized", {});
            this.connected = true;
            resolve();
          })
          .catch((err) => {
            this.cleanup();
            reject(
              new Error(
                `MCP initialize handshake failed: ${(err as Error).message}\nStderr: ${this.stderrBuffer}`,
              ),
            );
          });
      } catch (err) {
        this.cleanup();
        reject(err);
      }
    });
  }

  /**
   * Query available tools from the MCP server.
   */
  async listTools(): Promise<McpTool[]> {
    this.ensureConnected();
    const result = (await this.sendRequest("tools/list", {})) as {
      tools: McpTool[];
    };
    return result.tools ?? [];
  }

  /**
   * Execute a tool call on the MCP server.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    this.ensureConnected();
    const result = (await this.sendRequest("tools/call", {
      name,
      arguments: args,
    })) as McpToolResult;
    return result;
  }

  /**
   * Gracefully disconnect from the MCP server.
   */
  async disconnect(): Promise<void> {
    if (!this.process) return;

    try {
      // Send shutdown notification
      this.sendNotification("shutdown", {});
    } catch {
      // Ignore errors during shutdown
    }

    // Give the process a moment to clean up
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 500);

      this.process!.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });

      // Send SIGTERM
      try {
        this.process!.kill("SIGTERM");
      } catch {
        resolve();
      }
    });

    // Force kill if still running
    if (this.process && !this.process.killed) {
      try {
        this.process.kill("SIGKILL");
      } catch {
        // Already dead
      }
    }

    this.cleanup();
  }

  /** Whether the client is currently connected */
  get isConnected(): boolean {
    return this.connected;
  }

  /** Process ID of the spawned MCP server, or undefined if not connected */
  get pid(): number | undefined {
    return this.process?.pid;
  }

  /** Captured stderr output */
  get stderr(): string {
    return this.stderrBuffer;
  }

  // ── Internal methods ────────────────────────────────────────────

  private ensureConnected(): void {
    if (!this.connected || !this.process) {
      throw new Error("McpClient is not connected");
    }
  }

  private sendRequest(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error("MCP server process not available"));
        return;
      }

      const id = this.nextId++;
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `MCP request timed out after ${this.timeoutMs}ms: ${method}`,
          ),
        );
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      const message = JSON.stringify(request) + "\n";
      this.process.stdin.write(message);
    });
  }

  private sendNotification(
    method: string,
    params?: Record<string, unknown>,
  ): void {
    if (!this.process?.stdin) return;

    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };

    const message = JSON.stringify(notification) + "\n";
    this.process.stdin.write(message);
  }

  private handleStdoutData(chunk: Buffer): void {
    this.buffer += chunk.toString();

    // Process complete lines
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const message = JSON.parse(line) as
          | JsonRpcResponse
          | JsonRpcNotification;

        if ("id" in message && message.id !== undefined) {
          // This is a response
          this.handleResponse(message as JsonRpcResponse);
        }
        // Notifications are ignored for now
      } catch {
        // Skip malformed JSON lines
      }
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;

    this.pending.delete(response.id);
    clearTimeout(pending.timer);

    if (response.error) {
      pending.reject(
        new Error(
          `MCP error ${response.error.code}: ${response.error.message}`,
        ),
      );
    } else {
      pending.resolve(response.result);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private cleanup(): void {
    this.connected = false;
    this.rejectAllPending(new Error("McpClient disconnected"));
    this.process = null;
    this.buffer = "";
  }
}
