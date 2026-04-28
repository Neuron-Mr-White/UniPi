/**
 * @pi-unipi/subagents — Agent manager
 *
 * Tracks agents, manages concurrency queue, handles spawn/resume/abort.
 * Background agents subject to concurrency limit. Foreground bypass queue.
 */

import { randomUUID } from "node:crypto";
import type { Model } from "@mariozechner/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { runAgent, type ToolActivity } from "./agent-runner.js";
import { resolveModel, type ModelRegistry } from "./model-resolver.js";
import type { AgentRecord, AgentConfig, AgentType, ThinkingLevel } from "./types.js";
import { BUILTIN_CONFIGS } from "./types.js";
import { loadCustomAgents } from "./custom-agents.js";
import { FileLock } from "./file-lock.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;

/** Default max concurrent background agents. */
const DEFAULT_MAX_CONCURRENT = 4;

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: AgentType;
  prompt: string;
  options: SpawnOptions;
}

interface SpawnOptions {
  description: string;
  model?: Model<any>;
  modelInput?: string;
  modelRegistry?: ModelRegistry;
  thinkingLevel?: ThinkingLevel;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  isBackground?: boolean;
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  onTurnEnd?: (turnCount: number) => void;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private maxConcurrent: number;
  private customAgents: Map<string, AgentConfig>;

  /** Per-file transparent locking for write agents. */
  readonly fileLock = new FileLock();

  /** Queue of background agents waiting to start. */
  private queue: { id: string; args: SpawnArgs }[] = [];
  /** Number of currently running background agents. */
  private runningBackground = 0;

  constructor(onComplete?: OnAgentComplete, maxConcurrent = DEFAULT_MAX_CONCURRENT, onStart?: OnAgentStart) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.maxConcurrent = maxConcurrent;
    this.customAgents = loadCustomAgents(process.cwd());
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
  }

  /** Get resolved agent config for a type. */
  getAgentConfig(type: AgentType): AgentConfig | undefined {
    return this.customAgents.get(type) ?? BUILTIN_CONFIGS[type];
  }

  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /**
   * Spawn an agent. Returns ID immediately for background, waits for foreground.
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: AgentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    const id = randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type,
      description: options.description,
      status: options.isBackground ? "queued" : "running",
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
      lockedFiles: new Set(),
    };
    this.agents.set(id, record);

    const args: SpawnArgs = { pi, ctx, type, prompt, options };

    if (options.isBackground && this.runningBackground >= this.maxConcurrent) {
      this.queue.push({ id, args });
      return id;
    }

    this.startAgent(id, record, args);
    return id;
  }

  /** Actually start an agent. */
  private startAgent(id: string, record: AgentRecord, { pi, ctx, type, prompt, options }: SpawnArgs) {
    record.status = "running";
    record.startedAt = Date.now();
    if (options.isBackground) this.runningBackground++;
    this.onStart?.(record);

    // Resolve model: explicit input > config model > parent model
    let model = options.model;
    if (options.modelInput && options.modelRegistry) {
      const resolved = resolveModel(options.modelInput, options.modelRegistry);
      if (typeof resolved === "string") {
        // Error message — return early with error
        record.status = "error";
        record.error = resolved;
        record.completedAt = Date.now();
        if (options.isBackground) {
          this.runningBackground--;
          this.onComplete?.(record);
        }
        return;
      }
      model = resolved;
    }

    const agentConfig = this.getAgentConfig(type);
    const promise = runAgent(ctx, type, prompt, {
      pi,
      model,
      agentConfig,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      signal: record.abortController!.signal,
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onTurnEnd: options.onTurnEnd,
      onTextDelta: options.onTextDelta,
      onSessionCreated: (session) => {
        record.session = session;
        options.onSessionCreated?.(session);
      },
    })
      .then(({ responseText, session, aborted, steered }) => {
        if (record.status !== "stopped") {
          record.status = aborted ? "aborted" : steered ? "completed" : "completed";
        }
        record.result = responseText;
        record.session = session;
        record.completedAt ??= Date.now();

        // Release any held file locks
        this.fileLock.releaseAll(id);
        record.lockedFiles.clear();

        if (options.isBackground) {
          this.runningBackground--;
          this.onComplete?.(record);
          this.drainQueue();
        }
        return responseText;
      })
      .catch((err) => {
        if (record.status !== "stopped") {
          record.status = "error";
        }
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt ??= Date.now();

        // Release any held file locks
        this.fileLock.releaseAll(id);
        record.lockedFiles.clear();

        if (options.isBackground) {
          this.runningBackground--;
          this.onComplete?.(record);
          this.drainQueue();
        }
        return "";
      });

    record.promise = promise;
  }

  /** Start queued agents up to concurrency limit. */
  private drainQueue() {
    while (this.queue.length > 0 && this.runningBackground < this.maxConcurrent) {
      const next = this.queue.shift()!;
      const record = this.agents.get(next.id);
      if (!record || record.status !== "queued") continue;
      this.startAgent(next.id, record, next.args);
    }
  }

  /**
   * Spawn and wait (foreground).
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: AgentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
  ): Promise<AgentRecord> {
    const id = this.spawn(pi, ctx, type, prompt, { ...options, isBackground: false });
    const record = this.agents.get(id)!;
    await record.promise;
    return record;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    if (record.status === "queued") {
      this.queue = this.queue.filter((q) => q.id !== id);
      record.status = "stopped";
      record.completedAt = Date.now();
      return true;
    }

    if (record.status !== "running") return false;
    record.abortController?.abort();
    record.status = "stopped";
    record.completedAt = Date.now();
    this.fileLock.releaseAll(id);
    record.lockedFiles.clear();
    return true;
  }

  /** Abort all agents (for ESC propagation). */
  abortAll(): number {
    let count = 0;
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      if (record) {
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    this.queue = [];
    for (const record of this.agents.values()) {
      if (record.status === "running") {
        record.abortController?.abort();
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    this.fileLock.clear();
    return count;
  }

  /** Wait for all agents. */
  async waitForAll(): Promise<void> {
    while (true) {
      this.drainQueue();
      const pending = [...this.agents.values()]
        .filter((r) => r.status === "running" || r.status === "queued")
        .map((r) => r.promise)
        .filter(Boolean);
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  /** Whether any agents running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some((r) => r.status === "running" || r.status === "queued");
  }

  /** Remove completed records. */
  clearCompleted(): void {
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      record.session?.dispose?.();
      record.session = undefined;
      this.agents.delete(id);
    }
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      record.session?.dispose?.();
      record.session = undefined;
      this.agents.delete(id);
    }
  }

  dispose() {
    clearInterval(this.cleanupInterval);
    this.queue = [];
    this.abortAll();
    for (const record of this.agents.values()) {
      record.session?.dispose();
    }
    this.agents.clear();
  }
}
