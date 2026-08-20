/**
 * @pi-unipi/subagents — Agent manager
 *
 * Tracks agents, manages concurrency queue, handles spawn/resume/abort.
 * Background agents subject to concurrency limit. Foreground bypass queue.
 */

import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runAgent, type ToolActivity } from "./agent-runner.js";
import { resolveModel, type ModelRegistry } from "./model-resolver.js";
import type { AgentRecord, AgentConfig, AgentType, ThinkingLevel, SubagentsConfig } from "./types.js";
import { BUILTIN_CONFIGS } from "./types.js";
import { loadCustomAgents } from "./custom-agents.js";

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

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
  private typeSettings: SubagentsConfig["types"];

  /** Queue of background agents waiting to start. */
  private queue: { id: string; args: SpawnArgs }[] = [];
  /** Number of currently running background agents. */
  private runningBackground = 0;

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    typeSettings: SubagentsConfig["types"] = {},
    agentsCwd = process.cwd(),
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.maxConcurrent = maxConcurrent;
    this.typeSettings = typeSettings;
    this.customAgents = loadCustomAgents(agentsCwd);
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
  }

  /** Get resolved agent config for a type. */
  getAgentConfig(type: AgentType): AgentConfig | undefined {
    return this.customAgents.get(type) ?? BUILTIN_CONFIGS[type];
  }

  /** Public agent types known from built-ins, custom files, or JSON config. */
  getKnownTypes(): string[] {
    return [...new Set([
      ...Object.keys(BUILTIN_CONFIGS).filter((type) => type !== "name-gen"),
      ...this.customAgents.keys(),
      ...Object.keys(this.typeSettings),
    ])].sort(compareCodeUnits);
  }

  /** A type is enabled only when both JSON config and agent frontmatter allow it. */
  isTypeEnabled(type: AgentType): boolean {
    const agentConfig = this.getAgentConfig(type);
    return this.typeSettings[type]?.enabled !== false && agentConfig?.enabled !== false;
  }

  private assertTypeEnabled(type: AgentType): void {
    if (!this.isTypeEnabled(type)) {
      throw new Error(`Agent type "${type}" is disabled by configuration.`);
    }
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
    // Reject before allocating a record or queue entry. This applies equally to
    // foreground and background spawns and avoids ghost disabled agents.
    this.assertTypeEnabled(type);

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

    const agentConfig = this.getAgentConfig(type);

    // Resolve model: explicit input > per-agent config > parent model.
    let model = options.model;
    const modelInput = options.modelInput ?? agentConfig?.model;
    if (!model && modelInput && options.modelRegistry) {
      const resolved = resolveModel(modelInput, options.modelRegistry);
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

    const promise = runAgent(ctx, type, prompt, {
      pi,
      model,
      agentConfig,
      maxTurns: options.maxTurns ?? agentConfig?.maxTurns,
      isolated: options.isolated ?? agentConfig?.isolated,
      thinkingLevel: options.thinkingLevel ?? agentConfig?.thinking,
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
    return count;
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
