import { spawn as defaultSpawn, type ChildProcess } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getPiSpawnCommand } from "@pi-unipi/subagents/src/pi-spawn.js";
import type { EffortLevel, ModelKey } from "./preset.js";

export interface SidekickSpawnConfig {
  cwd: string;
  model: ModelKey;
  thinking: EffortLevel;
  sessionFile: string;
  systemPrompt: string;
  spawn?: typeof defaultSpawn;
  command?: { command: string; args: string[] };
  onProgress?: () => void;
  settleGraceMs?: number;
}

export interface SidekickUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export type SidekickEvent =
  | { kind: "text"; text: string; open: boolean }
  | { kind: "tool"; toolCallId: string; name: string; args: Record<string, unknown> | undefined; output: string; isError: boolean; done: boolean; startedAt: number; endedAt?: number };

export const MAX_EVENTS = 300;
export const MAX_TOOL_OUTPUT = 4000;

export interface HandoffProgress {
  toolCalls: number;
  recentTools: string[];
  textTail: string;
  startedAt: number;
  events: SidekickEvent[];
  droppedEvents: number;
}

export interface HandoffReport {
  id: string;
  status: "completed" | "aborted" | "error" | "interrupted";
  text: string;
  usage: SidekickUsage;
  toolCalls: number;
  durationMs: number;
  events: SidekickEvent[];
  error?: string;
}

interface PendingHandoff {
  id: string;
  message: string;
  startedAt: number;
  usage: SidekickUsage;
  progress: HandoffProgress;
  retriedPrompt: boolean;
  openBgTasks: number;
  settled: boolean;
  settleTimer?: NodeJS.Timeout;
  resolve: (report: HandoffReport) => void;
}

const emptyUsage = (): SidekickUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

export class SidekickRuntime {
  private readonly cfg: SidekickSpawnConfig;
  private child: ChildProcess | undefined;
  private promptPath: string | undefined;
  private pending: PendingHandoff | undefined;
  private latestHandoff: { id: string; done: Promise<HandoffReport>; report?: HandoffReport } | undefined;
  private responseText: ((text: string) => void) | undefined;
  private responseError: ((error: Error) => void) | undefined;
  private stderrTail = "";
  private inputBuffer = "";
  private abortRequested = false;
  private pendingError: string | undefined;
  readonly reports = new Map<string, HandoffReport>();
  readonly usage = emptyUsage();

  constructor(cfg: SidekickSpawnConfig) {
    this.cfg = cfg;
  }

  isAlive(): boolean {
    return this.child !== undefined && (this.child.exitCode === null || this.child.exitCode === undefined) && !this.child.killed;
  }

  isBusy(): boolean {
    return this.pending !== undefined;
  }

  totalToolCalls(): number {
    let total = this.pending?.progress.toolCalls ?? 0;
    for (const report of this.reports.values()) total += report.toolCalls;
    return total;
  }

  private notifyProgress(): void {
    try {
      this.cfg.onProgress?.();
    } catch {
      // Progress updates must not affect the handoff.
    }
  }

  private appendEvent(event: SidekickEvent): void {
    const progress = this.pending?.progress;
    if (!progress) return;
    progress.events.push(event);
    if (progress.events.length > MAX_EVENTS) {
      progress.events.shift();
      progress.droppedEvents += 1;
    }
  }

  private closeOpenText(): void {
    const events = this.pending?.progress.events;
    const last = events?.at(-1);
    if (last?.kind === "text" && last.open) last.open = false;
  }

  private toolOutput(result: unknown): string {
    if (typeof result === "object" && result !== null && Array.isArray((result as { content?: unknown }).content)) {
      return ((result as { content: unknown[] }).content)
        .map((part) => typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : typeof part === "string" ? part : "")
        .filter(Boolean)
        .join("\n")
        .slice(-MAX_TOOL_OUTPUT);
    }
    return String(result ?? "").slice(-MAX_TOOL_OUTPUT);
  }

  private send(value: Record<string, unknown>): void {
    if (!this.child?.stdin?.writable) throw new Error("Sidekick process is not writable");
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private cleanupPrompt(): void {
    if (!this.promptPath) return;
    try {
      unlinkSync(this.promptPath);
    } catch {
      /* already removed */
    }
    this.promptPath = undefined;
  }

  private spawn(): void {
    mkdirSync(dirname(this.cfg.sessionFile), { recursive: true });
    this.promptPath = join(tmpdir(), `unipi-fusion-${randomUUID()}.txt`);
    writeFileSync(this.promptPath, this.cfg.systemPrompt, "utf8");
    const command = this.cfg.command ?? getPiSpawnCommand([
      "--mode", "rpc",
      "--session", this.cfg.sessionFile,
      "--model", this.cfg.model,
      "--thinking", this.cfg.thinking,
      "--append-system-prompt", this.promptPath,
      "--no-skills",
    ]);
    const spawn = this.cfg.spawn ?? defaultSpawn;
    const child = spawn(command.command, command.args, {
      cwd: this.cfg.cwd,
      env: { ...process.env, UNIPI_FUSION_CHILD: "1", UNIPI_SUBAGENT_CHILD: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout?.on("data", (data: Buffer | string) => this.readStdout(String(data)));
    child.stderr?.on("data", (data: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${String(data)}`.slice(-2048);
    });
    child.on("close", () => {
      this.cleanupPrompt();
      if (this.pending !== undefined) this.finish("error", undefined, this.stderrTail || "Sidekick process exited");
    });
    child.on("error", (error) => {
      if (this.pending !== undefined) this.finish("error", undefined, error.message);
    });
  }

  private readStdout(data: string): void {
    this.inputBuffer += data;
    const lines = this.inputBuffer.split("\n");
    this.inputBuffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line.length === 0) continue;
      try {
        this.handleMessage(JSON.parse(line) as Record<string, unknown>);
      } catch {
        continue;
      }
    }
  }

  private requestLastAssistantText(): void {
    const current = this.pending;
    if (current === undefined) return;
    this.responseText = (text) => this.finish(this.abortRequested ? "aborted" : this.pendingError === undefined ? "completed" : "error", text, this.pendingError);
    this.responseError = (error) => this.finish("error", undefined, error.message);
    try {
      this.send({ type: "get_last_assistant_text" });
    } catch (error) {
      this.finish("error", undefined, error instanceof Error ? error.message : String(error));
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (message.type === "response") {
      const command = message.command;
      if (command === "prompt" && message.success === false) {
        const errorText = String(message.error ?? "Sidekick prompt rejected");
        const current = this.pending;
        if (current === undefined) return;
        if (/already processing/i.test(errorText) && !current.retriedPrompt) {
          current.retriedPrompt = true;
          try {
            this.send({ id: current.id, type: "prompt", message: current.message, streamingBehavior: "followUp" });
          } catch (error) {
            this.finish("error", undefined, error instanceof Error ? error.message : String(error));
          }
        } else {
          this.finish("error", undefined, errorText);
        }
      } else if (command === "get_last_assistant_text") {
        const data = message.data as Record<string, unknown> | undefined;
        const text = typeof data?.text === "string" ? data.text : this.pending?.progress.textTail ?? "";
        this.responseText?.(text);
        this.responseText = undefined;
        this.responseError = undefined;
      }
      return;
    }
    if (message.type === "extension_ui_request") {
      const method = message.method;
      if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
        this.send({ type: "extension_ui_response", id: message.id, cancelled: true });
      }
      return;
    }
    if (this.pending === undefined) return;
    if (message.type === "tool_execution_start") {
      this.closeOpenText();
      this.pending.progress.toolCalls += 1;
      const args = message.args !== undefined && typeof message.args === "object" && message.args !== null ? message.args as Record<string, unknown> : undefined;
      if (message.toolName === "bg_run" && args?.notifyOnCompletion !== false && args?.triggerOnCompletion !== false) this.pending.openBgTasks += 1;
      const argsText = args === undefined ? "" : JSON.stringify(args).replace(/\s+/gu, " ");
      const summary = `${String(message.toolName ?? "tool")}(${argsText})`.slice(0, 40);
      this.pending.progress.recentTools = [...this.pending.progress.recentTools, summary].slice(-6);
      this.appendEvent({ kind: "tool", toolCallId: String(message.toolCallId ?? ""), name: String(message.toolName ?? "tool"), args, output: "", isError: false, done: false, startedAt: Date.now() });
      this.notifyProgress();
    } else if (message.type === "tool_execution_end") {
      const toolCallId = String(message.toolCallId ?? "");
      const event = [...this.pending.progress.events].reverse().find((entry): entry is Extract<SidekickEvent, { kind: "tool" }> => entry.kind === "tool" && entry.toolCallId === toolCallId);
      if (event) {
        event.done = true;
        event.endedAt = Date.now();
        event.isError = message.isError === true;
        event.output = this.toolOutput(message.result);
        if (event.name === "bg_run" && event.isError) this.pending.openBgTasks = Math.max(0, this.pending.openBgTasks - 1);
      }
      this.notifyProgress();
    } else if (message.type === "message_update") {
      const streamEvent = (message.assistantMessageEvent ?? message) as Record<string, unknown>;
      if (streamEvent.type === "text_delta") {
        const delta = typeof streamEvent.delta === "string" ? streamEvent.delta : typeof streamEvent.text === "string" ? streamEvent.text : "";
        this.pending.progress.textTail = `${this.pending.progress.textTail}${delta}`.slice(-400);
        const last = this.pending.progress.events.at(-1);
        if (last?.kind === "text" && last.open) last.text += delta;
        else this.appendEvent({ kind: "text", text: delta, open: true });
        this.notifyProgress();
      }
    } else if (message.type === "message_end") {
      const msg = message.message as Record<string, unknown> | undefined;
      if (msg?.role === "custom" && msg.customType === "background-task-notification") {
        this.pending.openBgTasks = Math.max(0, this.pending.openBgTasks - 1);
        if (this.pending.openBgTasks === 0 && this.pending.settled) {
          clearTimeout(this.pending.settleTimer);
          this.pending.settleTimer = setTimeout(() => {
            const current = this.pending;
            if (current === undefined || !current.settled || current.openBgTasks > 0) return;
            this.requestLastAssistantText();
          }, this.cfg.settleGraceMs ?? 3000);
          this.pending.settleTimer.unref();
        }
        this.notifyProgress();
      } else if (msg?.role === "assistant") {
        this.closeOpenText();
        this.notifyProgress();
        if (msg.stopReason === "error" && typeof msg.errorMessage === "string") this.pendingError = msg.errorMessage;
        const usage = msg.usage as Record<string, unknown> | undefined;
        if (usage) {
          const cost = usage.cost as Record<string, unknown> | undefined;
          this.addUsage(this.pending.usage, {
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            cost: cost?.total,
          });
        }
      }
    } else if (message.type === "agent_start") {
      clearTimeout(this.pending.settleTimer);
      this.pending.settleTimer = undefined;
      this.pending.settled = false;
      this.notifyProgress();
    } else if (message.type === "agent_settled") {
      this.pending.settled = true;
      if (this.pending.openBgTasks > 0) {
        this.notifyProgress();
        return;
      }
      this.requestLastAssistantText();
    }
  }

  private addUsage(target: SidekickUsage, raw: Record<string, unknown>): void {
    const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    target.input += number(raw.input);
    target.output += number(raw.output);
    target.cacheRead += number(raw.cacheRead);
    target.cacheWrite += number(raw.cacheWrite);
    target.cost += number(raw.cost);
    if (target !== this.usage) this.addUsage(this.usage, raw);
  }

  private finish(status: HandoffReport["status"], text?: string, error?: string): void {
    const current = this.pending;
    if (current === undefined) return;
    clearTimeout(current.settleTimer);
    current.settleTimer = undefined;
    this.pending = undefined;
    this.responseText = undefined;
    this.responseError = undefined;
    const report: HandoffReport = {
      id: current.id,
      status,
      text: text ?? current.progress.textTail,
      usage: { ...current.usage },
      toolCalls: current.progress.toolCalls,
      durationMs: Date.now() - current.startedAt,
      events: current.progress.events.map((event) => ({ ...event })),
      ...(error === undefined ? {} : { error }),
    };
    this.reports.set(report.id, report);
    if (this.latestHandoff?.id === report.id) this.latestHandoff.report = report;
    current.resolve(report);
    this.notifyProgress();
    this.abortRequested = false;
    this.pendingError = undefined;
  }

  handoff(message: string): { id: string; done: Promise<HandoffReport> } {
    if (this.pending !== undefined) {
      this.send({ type: "steer", message });
      return { id: this.pending.id, done: this.latestHandoff?.done ?? Promise.reject(new Error("Missing handoff")) };
    }
    if (!this.isAlive()) this.spawn();
    const id = randomUUID();
    const startedAt = Date.now();
    let resolve!: (report: HandoffReport) => void;
    const done = new Promise<HandoffReport>((res) => {
      resolve = res;
    });
    this.pendingError = undefined;
    this.pending = {
      id,
      message,
      startedAt,
      usage: emptyUsage(),
      progress: { toolCalls: 0, recentTools: [], textTail: "", startedAt, events: [], droppedEvents: 0 },
      retriedPrompt: false,
      openBgTasks: 0,
      settled: false,
      resolve,
    };
    this.latestHandoff = { id, done };
    try {
      this.send({ id, type: "prompt", message });
    } catch (error) {
      this.finish("error", undefined, error instanceof Error ? error.message : String(error));
    }
    return { id, done };
  }

  progress(id?: string): HandoffProgress | undefined {
    if (this.pending !== undefined && (id === undefined || id === this.pending.id)) {
      return { ...this.pending.progress, recentTools: [...this.pending.progress.recentTools], events: this.pending.progress.events.map((event) => ({ ...event })) };
    }
    return undefined;
  }

  latest(): { id: string; done: Promise<HandoffReport>; report?: HandoffReport } | undefined {
    return this.latestHandoff;
  }

  async abort(): Promise<void> {
    if (!this.pending) return;
    this.abortRequested = true;
    this.send({ type: "abort" });
  }

  kill(): void {
    const child = this.child;
    if (!child) return;
    this.cleanupPrompt();
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (child.exitCode === null || child.exitCode === undefined) child.kill("SIGKILL");
    }, 2000);
    timer.unref();
    this.child = undefined;
  }
}
