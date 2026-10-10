/**
 * @pi-unipi/background-tasks — the work tray's Background tasks tab.
 *
 * Same layout as the Subagents tab (core/src/work/pane-kit.ts):
 *   list    `❭  RUN   Shell ticker  for i in … ····· ⠋ 1m10s · 559B · wakes agent`
 *           grouped Running / Recent, keys
 *           `↑↓ navigate · ↵ view · s stop · x kill · d dismiss · R rerun · ←→ tabs · esc close`
 *   detail  `── ⠋ Shell › ticker ──────── 1m10s · 559B ──`, a meta line, the
 *           command/telemetry, then the live log tail (follows the end; ↑
 *           scrolls back, G resumes; l loads the full log).
 *
 * Replaces the old standalone "bg tasks focused" manager (own box, colours,
 * history toggle).
 */

import { existsSync } from "node:fs";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import {
  groupRows,
  renderTrayDetail,
  renderTrayList,
  settledGlyph,
  SPINNER_MS,
  stateGlyph,
  STATE_COLOR,
  trayElapsed,
  trayPage,
  trayPlural,
  TrayListState,
  TrayScroll,
  type KitTheme,
  type RunState,
  type TrayRow,
} from "@pi-unipi/core";
import { boundedRead, compactWhitespace, formatCompactNumber, taskDisplayName, type BgTaskSnapshot } from "./types.js";

export type BackgroundTaskForUi = BgTaskSnapshot & { name: string; outputAbsPath: string };
type Task = BackgroundTaskForUi;

/** Live tail reservoir (UI-only read; thousands of lines of scrollback). */
const TAIL_BYTES = 128 * 1024;
/** `l full log`: read up to this much of the file. */
const FULL_LOG_BYTES = 4 * 1024 * 1024;
const TAIL_REFRESH_MS = 1000;
const DETAIL_COMMAND_MAX = 160;

export const BG_LIST_HINT = "↑↓ navigate · ↵ view · s stop · x kill · d dismiss · R rerun · c path · ←→ tabs · esc close";
export const BG_VIEW_HINT = "↑↓ scroll · g/G top/end · l full log · s stop · x kill · d dismiss · R rerun · c path · ←/esc back";

export interface BgPaneActions {
  tasks: () => Task[];
  /** Graceful stop (SIGTERM, then SIGKILL after the grace period). */
  stop: (task: Task) => Promise<void>;
  /** Kill now (SIGKILL). */
  kill: (task: Task) => Promise<void>;
  stopAll: () => Promise<{ stopped: number; failures: string[] }>;
  rerun: (task: Task) => Promise<Task>;
  /** Forget finished tasks (all finished when `ids` is omitted). */
  dismiss: (ids?: string[]) => number;
  showOutputPath: (task: Task) => void;
}

export function taskState(status: Task["status"]): RunState {
  if (status === "running") return "running";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "cancelled";
}

const durationOf = (task: Task, now = Date.now()) => (task.endTime ?? now) - task.startTime;

/** Shown after the name when it adds something (the name usually derives from it). */
function shortCommand(task: Task): string | undefined {
  const cmd = compactWhitespace(task.command);
  const name = compactWhitespace(taskDisplayName(task));
  if (cmd === name || cmd.length === 0) return undefined;
  return cmd.length > 48 ? `${cmd.slice(0, 47)}…` : cmd;
}

/** Right-hand stats, most important first. */
export function taskTags(task: Task, now = Date.now()): string[] {
  const tags = [trayElapsed(durationOf(task, now)), formatSize(task.bytesWritten)];
  if (task.status === "running" && task.triggerOnCompletion) tags.push("wakes agent");
  if (task.status !== "running" && typeof task.exitCode === "number" && task.exitCode !== 0) tags.push(`exit ${String(task.exitCode)}`);
  if (task.toolUsage && task.toolUsage.total > 0) tags.push(trayPlural(task.toolUsage.total, "tool"));
  if (task.model) tags.push(task.model.slice(task.model.lastIndexOf("/") + 1));
  if (task.tokenUsage && task.tokenUsage.totalTokens > 0) tags.push(`${formatCompactNumber(task.tokenUsage.totalTokens)} tok`);
  if (task.contextUsage?.percent != null) tags.push(`ctx ${task.contextUsage.percent.toFixed(0)}%`);
  return tags;
}

export function taskRow(task: Task, now = Date.now()): TrayRow {
  const detail = shortCommand(task);
  return {
    id: task.id,
    state: taskState(task.status),
    kind: task.isAgent ? "Agent" : "Shell",
    title: taskDisplayName(task),
    ...(detail !== undefined ? { detail } : {}),
    tags: taskTags(task, now),
  };
}

/** Running newest-started first, then finished newest-ended first. */
export function orderTasks(tasks: readonly Task[]): Task[] {
  const sorted = [...tasks].sort((a, b) => (b.endTime ?? b.startTime) - (a.endTime ?? a.startTime));
  return groupRows(sorted.map((t) => ({ t, state: taskState(t.status) }))).map((x) => x.t);
}

function outputLines(content: string): string[] {
  return content
    .replace(/\r/g, "")
    .split("\n")
    .filter((line, index, array) => line.length > 0 || index < array.length - 1);
}

export class BackgroundTasksPane implements Component {
  private readonly list = new TrayListState();
  private viewId: string | undefined;
  private readonly scroll = new TrayScroll();
  private flash: string | undefined;
  /** Id armed by a first `x` (kill) / `a` (stop all) press. */
  private armed: { key: "x" | "a"; id: string } | undefined;
  private fullLog = false;
  private log: { id: string; lines: string[]; truncated: boolean; totalBytes: number; error?: string } | undefined;
  private reading: Promise<void> | undefined;
  private lastRead = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: { requestRender(): void },
    private readonly theme: KitTheme,
    private readonly actions: BgPaneActions,
    private readonly done: () => void,
    initialId?: string,
  ) {
    const tasks = this.ordered();
    if (initialId !== undefined && tasks.some((t) => t.id === initialId)) this.openView(initialId);
    else this.list.selectId(tasks.map((t) => taskRow(t)), undefined);
    // Spinner frames while something runs; the open log refreshes ~1s.
    this.timer = setInterval(() => {
      const running = this.actions.tasks().some((t) => t.status === "running");
      if (this.viewId !== undefined && Date.now() - this.lastRead >= TAIL_REFRESH_MS && this.viewTask()?.status === "running") void this.readLog();
      if (running) this.tui.requestRender();
    }, SPINNER_MS);
    this.timer.unref?.();
  }

  private ordered(): Task[] {
    return orderTasks(this.actions.tasks());
  }

  private viewTask(): Task | undefined {
    return this.viewId !== undefined ? this.actions.tasks().find((t) => t.id === this.viewId) : undefined;
  }

  private current(): Task | undefined {
    return this.viewTask() ?? this.list.current(this.ordered());
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.timer);
  }

  /** The detail view keeps ←/→ (← = back); the list leaves them to the tray's tabs. */
  capturesArrows(): boolean {
    return this.viewId !== undefined;
  }

  render(width: number): string[] {
    const w = Math.max(30, width);
    if (this.viewId !== undefined) {
      const task = this.viewTask();
      if (task) return this.renderView(task, w);
      this.viewId = undefined;
    }
    const now = Date.now();
    return renderTrayList(this.theme, {
      rows: this.ordered().map((t) => taskRow(t, now)),
      state: this.list,
      width: w,
      empty: "No background tasks.",
      hint: BG_LIST_HINT,
      flash: this.flash,
      now,
    });
  }

  private renderView(task: Task, w: number): string[] {
    const t = this.theme;
    const now = Date.now();
    const state = taskState(task.status);
    const kind = task.isAgent ? "Agent" : "Shell";
    const title = `${stateGlyph(t, state, now)} ${t.fg("muted", kind)} ${t.fg("dim", "›")} ${t.bold(taskDisplayName(task))}`;
    const right = `${trayElapsed(durationOf(task, now))} · ${formatSize(task.bytesWritten)}`;
    const meta = [`id ${task.id}`];
    if (typeof task.pid === "number") meta.push(`pid ${String(task.pid)}`);
    meta.push(task.status === "running" ? (task.triggerOnCompletion ? "running · wakes agent" : "running") : t.fg(STATE_COLOR[state], task.status === "killed" ? "stopped" : task.status));
    meta.push(`started ${new Date(task.startTime).toLocaleTimeString()}`);
    if (this.fullLog) meta.push("full log");
    return renderTrayDetail(t, {
      width: w,
      title,
      right,
      meta,
      body: this.viewBody(task, w),
      scroll: this.scroll,
      hint: BG_VIEW_HINT,
      flash: this.flash,
    });
  }

  private viewBody(task: Task, w: number): string[] {
    const t = this.theme;
    const out: string[] = [];
    const section = (label: string, text: string) => {
      out.push(t.fg("dim", label));
      for (const l of text.split("\n")) out.push(...wrapTextWithAnsi(t.fg("muted", l), w - 2).map((x) => `  ${x}`));
    };
    const cmd = task.command.length > DETAIL_COMMAND_MAX * 4 ? `${task.command.slice(0, DETAIL_COMMAND_MAX * 4)}…` : task.command;
    section("Command", cmd);
    if (task.description && compactWhitespace(task.description) !== compactWhitespace(taskDisplayName(task))) section("Description", task.description);
    const info = [`cwd ${task.cwd}`, `log ${task.outputPath}`];
    if (task.model) info.push(`model ${task.model}`);
    if (task.tokenUsage && task.tokenUsage.totalTokens > 0) {
      const u = task.tokenUsage;
      info.push(`tokens ${formatCompactNumber(u.input)} in · ${formatCompactNumber(u.output)} out · ${formatCompactNumber(u.totalTokens)} total`);
    }
    if (task.contextUsage?.contextWindow) {
      const c = task.contextUsage;
      info.push(c.percent != null ? `context ${c.percent.toFixed(1)}% of ${formatCompactNumber(c.contextWindow ?? 0)}` : `context ? of ${formatCompactNumber(c.contextWindow ?? 0)}`);
    }
    if (task.toolUsage && task.toolUsage.total > 0) {
      const top = Object.entries(task.toolUsage.byName).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, c]) => `${n} ${String(c)}`);
      info.push(`tools ${String(task.toolUsage.total)}${task.toolUsage.failed > 0 ? ` (${String(task.toolUsage.failed)} failed)` : ""}${top.length ? ` · ${top.join(" · ")}` : ""}`);
    }
    for (const l of info) out.push(t.fg("dim", `  ${l}`));
    out.push("");
    out.push(t.fg("dim", "Output"));
    const log = this.log?.id === task.id ? this.log : undefined;
    if (log?.error) out.push(t.fg("error", `  ${log.error}`));
    else if (!log) out.push(t.fg("dim", "  reading…"));
    else if (log.lines.length === 0) out.push(t.fg("dim", "  no output yet"));
    else {
      if (log.truncated) out.push(t.fg("dim", `  … earlier output not shown (${formatSize(log.totalBytes)} total${this.fullLog ? "" : " · l full log"})`));
      for (const l of log.lines) out.push(`  ${t.fg("toolOutput", l)}`);
    }
    if (task.status !== "running") {
      out.push("");
      const code = typeof task.exitCode === "number" ? `exit ${String(task.exitCode)}` : task.signal ? `signal ${task.signal}` : "";
      if (task.status === "completed") out.push(t.fg("success", `${settledGlyph("✓").trimEnd()} Completed${code ? ` · ${code}` : ""}`));
      else if (task.status === "killed") out.push(t.fg("warning", `⊘ Stopped${task.error ? ` · ${task.error}` : ""}`));
      else out.push(t.fg("error", `✗ Failed${code ? ` · ${code}` : ""}${task.error ? ` · ${task.error}` : ""}`));
    } else if (task.error) {
      out.push("", t.fg("warning", task.error));
    }
    return out;
  }

  private openView(id: string, fullLog = false): void {
    this.viewId = id;
    this.scroll.reset();
    this.fullLog = fullLog;
    this.log = undefined;
    void this.readLog();
  }

  /** Reads the task's log (tail, or the whole file up to FULL_LOG_BYTES). Frozen while scrolled up. */
  readLog(): Promise<void> {
    const task = this.viewTask();
    if (!task) return Promise.resolve();
    if (this.reading) return this.reading;
    if (this.log?.id === task.id && !this.scroll.follow) return Promise.resolve();
    this.lastRead = Date.now();
    this.reading = this.loadLog(task);
    return this.reading;
  }

  private async loadLog(task: Task): Promise<void> {
    try {
      if (!existsSync(task.outputAbsPath)) {
        this.log = { id: task.id, lines: [], truncated: false, totalBytes: 0, error: `Output file not found: ${task.outputPath}` };
      } else {
        const read = await boundedRead(task.outputAbsPath, this.fullLog ? FULL_LOG_BYTES : TAIL_BYTES, true);
        this.log = { id: task.id, lines: outputLines(read.content), truncated: read.truncated, totalBytes: read.totalBytes };
      }
    } catch (error) {
      this.log = { id: task.id, lines: [], truncated: false, totalBytes: 0, error: `Output read failed: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      this.reading = undefined;
    }
    this.tui.requestRender();
  }

  private say(message: string | undefined): void {
    this.flash = message;
    this.tui.requestRender();
  }

  private async run(label: string, action: () => Promise<string>): Promise<void> {
    this.say(`${label}…`);
    try {
      this.say(await action());
    } catch (error) {
      this.say(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  handleInput(data: string): void {
    const task = this.current();
    const armed = this.armed;
    this.armed = undefined;
    this.flash = undefined;
    if (matchesKey(data, Key.escape) || data === "q" || (this.viewId !== undefined && matchesKey(data, Key.left))) {
      if (this.viewId !== undefined) {
        this.viewId = undefined;
        this.tui.requestRender();
      } else {
        this.done();
      }
      return;
    }
    if (data === "s" && task) {
      if (task.status !== "running") return this.say(`${taskDisplayName(task)} already ended.`);
      void this.run(`Stopping ${taskDisplayName(task)}`, async () => {
        await this.actions.stop(task);
        return `Stopped ${taskDisplayName(task)}.`;
      });
      return;
    }
    if (data === "x" && task) {
      if (task.status !== "running") return this.say(`${taskDisplayName(task)} already ended.`);
      if (armed?.key !== "x" || armed.id !== task.id) {
        this.armed = { key: "x", id: task.id };
        return this.say(`Press x again to kill ${taskDisplayName(task)} now (SIGKILL).`);
      }
      void this.run(`Killing ${taskDisplayName(task)}`, async () => {
        await this.actions.kill(task);
        return `Killed ${taskDisplayName(task)}.`;
      });
      return;
    }
    if (data === "a" || data === "K") {
      const running = this.actions.tasks().filter((t) => t.status === "running").length;
      if (running === 0) return this.say("No running background tasks.");
      if (armed?.key !== "a") {
        this.armed = { key: "a", id: "*" };
        return this.say(`Press ${data} again to stop all ${trayPlural(running, "running task")}.`);
      }
      void this.run(`Stopping ${trayPlural(running, "task")}`, async () => {
        const r = await this.actions.stopAll();
        return r.failures.length > 0 ? `Stopped ${String(r.stopped)}; ${String(r.failures.length)} failed: ${r.failures.join("; ")}` : `Stopped ${trayPlural(r.stopped, "task")}.`;
      });
      return;
    }
    if (data === "d" && task) {
      if (task.status === "running") return this.say(`${taskDisplayName(task)} is still running — s stop first.`);
      this.actions.dismiss([task.id]);
      this.viewId = undefined;
      return this.say(`Dismissed ${taskDisplayName(task)}.`);
    }
    if (data === "D") {
      const n = this.actions.dismiss();
      return this.say(n > 0 ? `Dismissed ${trayPlural(n, "finished task")}.` : "No finished tasks to dismiss.");
    }
    if (data === "R" && task) {
      void this.run(`Rerunning ${taskDisplayName(task)}`, async () => {
        const rerun = await this.actions.rerun(task);
        if (this.viewId !== undefined) this.openView(rerun.id);
        else this.list.selectId(this.ordered().map((t) => taskRow(t)), rerun.id);
        return `Reran as ${rerun.id}.`;
      });
      return;
    }
    if (data === "c" && task) {
      this.actions.showOutputPath(task);
      return this.say(`Log: ${task.outputPath}`);
    }
    if (this.viewId === undefined) {
      const n = this.ordered().length;
      if (matchesKey(data, Key.up) || data === "k") this.list.move(-1, n);
      else if (matchesKey(data, Key.down) || data === "j") this.list.move(1, n);
      else if (matchesKey(data, Key.pageUp)) this.list.move(-10, n);
      else if (matchesKey(data, Key.pageDown)) this.list.move(10, n);
      else if ((matchesKey(data, Key.enter) || data === "\r") && task) this.openView(task.id);
      else if (data === "l" && task) this.openView(task.id, true);
      this.tui.requestRender();
      return;
    }
    const page = trayPage();
    if (matchesKey(data, Key.up) || data === "k") this.scroll.by(-1);
    else if (matchesKey(data, Key.down) || data === "j") this.scroll.by(1);
    else if (matchesKey(data, Key.pageUp)) this.scroll.by(-page);
    else if (matchesKey(data, Key.pageDown) || data === " ") this.scroll.by(page);
    else if (data === "g") this.scroll.home();
    else if (data === "G" || data === "r") {
      this.scroll.end();
      void this.readLog();
    } else if (data === "l") {
      this.fullLog = !this.fullLog;
      this.scroll.end();
      this.log = undefined;
      void this.readLog();
    }
    this.tui.requestRender();
  }
}
