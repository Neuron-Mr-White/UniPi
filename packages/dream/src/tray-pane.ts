/**
 * @pi-unipi/dream — the work tray's Dream tab (same list/detail kit as the
 * Background tasks and Subagents tabs, core/src/work/pane-kit.ts).
 *
 *   list    `❭  RUN   Dream 14:02  manual ······ ⠋ 1m10s · 6 sessions · 2 pending`
 *           keys `↑↓ navigate · ↵ view · o report · s stop · r run now · a/x approve/reject · d dismiss · ←→ tabs · esc close`
 *   detail  `── ⠋ Dream › 14:02 ─────────── 1m10s · 6 sessions ──`, a meta
 *           line, report summary + proposals (1–9 pick one), the child's
 *           live trajectory (its own session JSONL) and the log tail;
 *           `o` swaps the body for the full DREAM_REPORT.md.
 *
 * a / x ask for a second press (the tray's confirm convention, like bg `x`).
 * A dream never wakes the agent, so it is NOT a wait source: no "Working…".
 */

import { Key, matchesKey, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import {
  renderTrayDetail,
  renderTrayList,
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
import type { DreamActionResult, DreamRunDetail } from "./controller.ts";
import { summarizeReport as summarize, type DreamRun } from "./runs.ts";
import type { Proposal } from "./report.ts";

export const DREAM_LIST_HINT = "↑↓ navigate · ↵ view · o report · s stop · r run now · a/x approve/reject · d dismiss · ←→ tabs · esc close";
export const DREAM_VIEW_HINT = "↑↓ scroll · 1-9 pick · a/x approve/reject · o report · s stop · r run now · d dismiss · ←/esc back";

export interface DreamPaneActions {
  runs(): DreamRun[];
  detail(id: string): DreamRunDetail | undefined;
  enabled(): boolean;
  run(): DreamActionResult;
  stop(id: string): DreamActionResult;
  approve(runId: string, proposalId: string): DreamActionResult;
  reject(runId: string, proposalId: string): DreamActionResult;
  dismiss(runId: string): DreamActionResult;
}

export function runState(run: Pick<DreamRun, "status">): RunState {
  if (run.status === "running") return "running";
  if (run.status === "finished") return "completed";
  if (run.status === "stopped") return "cancelled";
  return "failed";
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function day(ms: number, now: number): string {
  const d = new Date(ms);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return clock(ms);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${clock(ms)}`;
}

export function runTags(run: DreamRun, now = Date.now()): string[] {
  const tags = [trayElapsed((run.endedAt ?? now) - run.startedAt), trayPlural(run.sessions, "session")];
  if (run.pending > 0) tags.push(`${String(run.pending)} pending`);
  else if (run.proposals.length > 0) tags.push(trayPlural(run.proposals.length, "proposal"));
  if (run.error) tags.push(run.error);
  return tags;
}

export function runRow(run: DreamRun, now = Date.now()): TrayRow {
  return {
    id: run.id,
    state: runState(run),
    kind: "Dream",
    title: day(run.startedAt, now),
    detail: run.manual ? "manual" : "scheduled",
    tags: runTags(run, now),
    keepTags: 3,
  };
}

const DECISION_COLOR = { pending: "warning", approved: "success", rejected: "dim" } as const;

export class DreamPane implements Component {
  private readonly list = new TrayListState();
  private viewId: string | undefined;
  private readonly scroll = new TrayScroll();
  private flash: string | undefined;
  private armed: { key: "a" | "x"; id: string } | undefined;
  private reportMode = false;
  /** Index into the viewed run's proposals. */
  private pick = 0;
  private detail: DreamRunDetail | undefined;
  private lastRead = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: { requestRender(): void },
    private readonly theme: KitTheme,
    private readonly actions: DreamPaneActions,
    private readonly done: () => void,
    initialId?: string,
  ) {
    const runs = this.actions.runs();
    if (initialId !== undefined && runs.some((r) => r.id === initialId)) this.openView(initialId);
    else this.list.selectId(runs.map((r) => runRow(r)), undefined);
    this.timer = setInterval(() => {
      const running = this.actions.runs().some((r) => r.status === "running");
      if (this.viewId !== undefined && Date.now() - this.lastRead >= 1000 && this.viewRun()?.status === "running") this.readDetail();
      if (running) this.tui.requestRender();
    }, SPINNER_MS * 4);
    this.timer.unref?.();
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.timer);
  }

  capturesArrows(): boolean {
    return this.viewId !== undefined;
  }

  private viewRun(): DreamRun | undefined {
    return this.viewId !== undefined ? this.actions.runs().find((r) => r.id === this.viewId) : undefined;
  }

  private current(): DreamRun | undefined {
    return this.viewRun() ?? this.list.current(this.actions.runs());
  }

  private readDetail(): void {
    if (this.viewId === undefined) return;
    if (this.detail?.id === this.viewId && !this.scroll.follow) return; // frozen while scrolled up
    this.lastRead = Date.now();
    try {
      this.detail = this.actions.detail(this.viewId);
    } catch {
      this.detail = undefined;
    }
  }

  private openView(id: string, report = false): void {
    this.viewId = id;
    this.reportMode = report;
    this.scroll.reset();
    if (report) this.scroll.home();
    this.detail = undefined;
    const run = this.viewRun();
    this.pick = Math.max(0, run?.proposals.findIndex((p) => p.decision === "pending") ?? 0);
    this.readDetail();
  }

  render(width: number): string[] {
    const w = Math.max(30, width);
    if (this.viewId !== undefined) {
      const run = this.viewRun();
      if (run) return this.renderView(run, w);
      this.viewId = undefined;
    }
    const now = Date.now();
    const runs = this.actions.runs();
    return renderTrayList(this.theme, {
      rows: runs.map((r) => runRow(r, now)),
      state: this.list,
      width: w,
      empty: this.actions.enabled() ? "No dreams yet — one starts on its own when enough new sessions pile up. r runs one now." : "Background dreaming is off (turn it on in /unipi:settings → Dream). r runs one now.",
      hint: DREAM_LIST_HINT,
      flash: this.flash,
      now,
    });
  }

  private renderView(run: DreamRun, w: number): string[] {
    const t = this.theme;
    const now = Date.now();
    const state = runState(run);
    const title = `${stateGlyph(t, state, now)} ${t.fg("muted", "Dream")} ${t.fg("dim", "›")} ${t.bold(day(run.startedAt, now))}`;
    const right = `${trayElapsed((run.endedAt ?? now) - run.startedAt)} · ${trayPlural(run.sessions, "session")}`;
    const meta = [run.id];
    if (run.pid > 0) meta.push(`pid ${String(run.pid)}`);
    meta.push(run.status === "running" ? "running · never wakes the agent" : t.fg(STATE_COLOR[state], run.status));
    meta.push(run.manual ? "manual" : "scheduled");
    if (this.reportMode) meta.push("report");
    if (this.detail?.id !== run.id) this.readDetail();
    return renderTrayDetail(t, {
      width: w,
      title,
      right,
      meta,
      body: this.reportMode ? this.reportBody(run, w) : this.viewBody(run, w),
      scroll: this.scroll,
      hint: DREAM_VIEW_HINT,
      flash: this.flash,
    });
  }

  private reportBody(run: DreamRun, w: number): string[] {
    const t = this.theme;
    const text = this.detail?.id === run.id ? this.detail.report : "";
    if (!text) return [t.fg("dim", run.status === "running" ? "  The report is written at the end of the dream." : "  This dream left no report.")];
    const out: string[] = [];
    for (const line of text.replace(/\r/g, "").split("\n")) {
      const styled = /^#{1,6}\s/.test(line) ? t.bold(line.replace(/^#+\s*/, "")) : line;
      out.push(...wrapTextWithAnsi(styled, w - 2).map((x) => `  ${x}`));
    }
    return out;
  }

  private viewBody(run: DreamRun, w: number): string[] {
    const t = this.theme;
    const out: string[] = [];
    const wrap = (text: string, color: Parameters<KitTheme["fg"]>[0] = "muted") => {
      for (const l of wrapTextWithAnsi(t.fg(color, text), w - 4)) out.push(`  ${l}`);
    };
    out.push(t.fg("dim", "Report"));
    if (run.hasReport) {
      const sum = this.detail?.id === run.id ? summarize(this.detail.report) : [];
      wrap(sum.length ? sum.join(" · ") : "ready — o to read it");
    } else wrap(run.status === "running" ? "not yet — written at the end" : "none", "dim");
    out.push("");
    out.push(t.fg("dim", `Proposals${run.proposals.length ? ` (${String(run.pending)} pending)` : ""}`));
    if (run.proposals.length === 0) wrap(run.status === "running" ? "none yet" : "none — memory edits apply on their own", "dim");
    run.proposals.forEach((p: Proposal, i: number) => {
      const sel = i === this.pick;
      const mark = sel ? t.fg("accent", "❭") : " ";
      const label = `${String(i + 1)}. [${p.kind}] ${p.name}`;
      out.push(`${mark} ${sel ? t.fg("accent", label) : label}  ${t.fg(DECISION_COLOR[p.decision], p.decision)}`);
    });
    out.push("");
    out.push(t.fg("dim", "Trajectory"));
    const d = this.detail?.id === run.id ? this.detail : undefined;
    if (!d) out.push(t.fg("dim", "  reading…"));
    else if (d.steps.length === 0) out.push(t.fg("dim", run.status === "running" ? "  starting…" : "  no steps recorded"));
    else
      for (const s of d.steps) {
        const color = s.kind === "error" ? "error" : s.kind === "tool" ? "toolOutput" : s.kind === "text" ? "text" : "dim";
        const glyph = s.kind === "tool" ? "▸" : s.kind === "error" ? "✗" : s.kind === "text" ? "·" : "›";
        out.push(`  ${t.fg(color as never, `${glyph} ${s.text}`)}`);
      }
    if (d && d.log.length > 0) {
      out.push("");
      out.push(t.fg("dim", "Log"));
      for (const l of d.log.slice(-20)) out.push(`  ${t.fg("toolOutput", l)}`);
    }
    if (run.status !== "running") {
      out.push("");
      if (run.status === "finished") out.push(t.fg("success", "✓ Finished"));
      else if (run.status === "stopped") out.push(t.fg("warning", "⊘ Stopped"));
      else out.push(t.fg("error", `✗ Failed${run.error ? ` · ${run.error}` : ""}`));
    }
    return out;
  }

  private say(message: string | undefined): void {
    this.flash = message;
    this.tui.requestRender();
  }

  private result(r: DreamActionResult): void {
    this.say(r.message.split("\n")[0]);
  }

  /** The proposal a/x act on: the picked one in the detail view, else the first pending one. */
  private target(run: DreamRun): Proposal | undefined {
    if (this.viewId !== undefined) return run.proposals[this.pick];
    return run.proposals.find((p) => p.decision === "pending");
  }

  handleInput(data: string): void {
    const run = this.current();
    const armed = this.armed;
    this.armed = undefined;
    this.flash = undefined;
    if (matchesKey(data, Key.escape) || data === "q" || (this.viewId !== undefined && matchesKey(data, Key.left))) {
      if (this.viewId !== undefined) {
        this.viewId = undefined;
        this.tui.requestRender();
      } else this.done();
      return;
    }
    if (data === "r") {
      const r = this.actions.run();
      this.result(r);
      if (r.ok) {
        const newest = this.actions.runs()[0];
        if (newest && this.viewId !== undefined) this.openView(newest.id);
        else if (newest) this.list.selectId(this.actions.runs().map((x) => runRow(x)), newest.id);
      }
      return;
    }
    if (data === "s" && run) {
      if (run.status !== "running") return this.say("That dream already ended.");
      return this.result(this.actions.stop(run.id));
    }
    if ((data === "a" || data === "x") && run) {
      const p = this.target(run);
      if (!p) return this.say(run.status === "running" ? "No proposals yet." : "No pending proposals.");
      if (p.decision !== "pending") return this.say(`${p.name} is already ${p.decision}.`);
      if (armed?.key !== data || armed.id !== p.id) {
        this.armed = { key: data, id: p.id };
        return this.say(data === "a" ? `Press a again to approve ${p.kind} ${p.name}${p.kind === "skill" ? " (copied into the skills dir + checked)" : ""}.` : `Press x again to reject ${p.kind} ${p.name}.`);
      }
      return this.result(data === "a" ? this.actions.approve(run.id, p.id) : this.actions.reject(run.id, p.id));
    }
    if (data === "d" && run) {
      const r = this.actions.dismiss(run.id);
      if (r.ok) this.viewId = undefined;
      return this.result(r);
    }
    if (data === "o" && run) {
      if (this.viewId === undefined) this.openView(run.id, true);
      else {
        this.reportMode = !this.reportMode;
        this.scroll.reset();
        if (this.reportMode) this.scroll.home();
        this.readDetail();
      }
      this.tui.requestRender();
      return;
    }
    if (this.viewId === undefined) {
      const n = this.actions.runs().length;
      if (matchesKey(data, Key.up) || data === "k") this.list.move(-1, n);
      else if (matchesKey(data, Key.down) || data === "j") this.list.move(1, n);
      else if (matchesKey(data, Key.pageUp)) this.list.move(-10, n);
      else if (matchesKey(data, Key.pageDown)) this.list.move(10, n);
      else if ((matchesKey(data, Key.enter) || data === "\r") && run) this.openView(run.id);
      this.tui.requestRender();
      return;
    }
    if (/^[1-9]$/.test(data) && run) {
      const i = Number(data) - 1;
      if (i < run.proposals.length) this.pick = i;
      this.tui.requestRender();
      return;
    }
    const page = trayPage();
    if (matchesKey(data, Key.up) || data === "k") this.scroll.by(-1);
    else if (matchesKey(data, Key.down) || data === "j") this.scroll.by(1);
    else if (matchesKey(data, Key.pageUp)) this.scroll.by(-page);
    else if (matchesKey(data, Key.pageDown) || data === " ") this.scroll.by(page);
    else if (data === "g") this.scroll.home();
    else if (data === "G") {
      this.scroll.end();
      this.readDetail();
    }
    this.tui.requestRender();
  }
}
