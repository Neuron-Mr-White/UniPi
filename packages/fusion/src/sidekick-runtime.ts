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
}

export interface SidekickUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface HandoffProgress {
  toolCalls: number;
  recentTools: string[];
  textTail: string;
  startedAt: number;
}

export interface HandoffReport {
  id: string;
  status: "completed" | "aborted" | "error" | "interrupted";
  text: string;
  usage: SidekickUsage;
  toolCalls: number;
  durationMs: number;
  error?: string;
}

interface PendingHandoff {
  id: string;
  startedAt: number;
  usage: SidekickUsage;
  progress: HandoffProgress;
  resolve: (report: HandoffReport) => void;
  reject: (error: Error) => void;
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

  private handleMessage(message: Record<string, unknown>): void {
    if (message.type === "response") {
      const command = message.command;
      if (command === "prompt" && message.success === false) {
        const error = new Error(String(message.error ?? "Sidekick prompt rejected"));
        const current = this.pending;
        this.pending = undefined;
        this.responseError = undefined;
        this.responseText = undefined;
        current?.reject(error);
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
      this.pending.progress.toolCalls += 1;
      const args = message.args === undefined ? "" : JSON.stringify(message.args).replace(/\s+/gu, " ");
      const summary = `${String(message.toolName ?? "tool")}(${args})`.slice(0, 40);
      this.pending.progress.recentTools = [...this.pending.progress.recentTools, summary].slice(-6);
    } else if (message.type === "message_update") {
      const event = (message.assistantMessageEvent ?? message) as Record<string, unknown>;
      if (event.type === "text_delta") {
        const delta = typeof event.delta === "string" ? event.delta : typeof event.text === "string" ? event.text : "";
        this.pending.progress.textTail = `${this.pending.progress.textTail}${delta}`.slice(-400);
      }
    } else if (message.type === "message_end") {
      const msg = message.message as Record<string, unknown> | undefined;
      if (msg?.role === "assistant") {
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
    } else if (message.type === "agent_settled") {
      this.responseText = undefined;
      this.responseError = undefined;
      this.responseText = (text) => this.finish(this.abortRequested ? "aborted" : this.pendingError === undefined ? "completed" : "error", text, this.pendingError);
      this.responseError = (error) => this.finish("error", undefined, error.message);
      try {
        this.send({ type: "get_last_assistant_text" });
      } catch (error) {
        this.finish("error", undefined, error instanceof Error ? error.message : String(error));
      }
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
      ...(error === undefined ? {} : { error }),
    };
    this.reports.set(report.id, report);
    if (this.latestHandoff?.id === report.id) this.latestHandoff.report = report;
    current.resolve(report);
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
    let reject!: (error: Error) => void;
    const done = new Promise<HandoffReport>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.pendingError = undefined;
    this.pending = {
      id,
      startedAt,
      usage: emptyUsage(),
      progress: { toolCalls: 0, recentTools: [], textTail: "", startedAt },
      resolve,
      reject,
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
    if (this.pending !== undefined && (id === undefined || id === this.pending.id)) return { ...this.pending.progress, recentTools: [...this.pending.progress.recentTools] };
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
