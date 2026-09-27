/**
 * @pi-unipi/subagents — TUI: strip, dock (list + transcript view), live tail.
 *
 * Devin layout, UniPi styling:
 *   strip (below editor)  `2 subagents (1 running) · ↓ select`
 *   dock (replaces editor) `── Subagents ──` rows `❭ ✓ Explore › title  7s · 1 tool · Completed · model`
 *                          keys `↑↓ navigate · ↵ view · f foreground · x cancel · esc close`
 *   view                  `── ◔ Explore › title ── 2m49s · 8 tools ──`, model line, task, live steps
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { SubagentRecord, SubagentStatus } from "./manager.js";
import type { TranscriptItem } from "./transcript.js";

export type ThemeLike = Pick<Theme, "fg" | "bold">;

export const SPINNER = ["◐", "◓", "◑", "◒"] as const;
const SPIN_MS = 150;

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m${String(s % 60).padStart(2, "0")}s`;
  return `${String(Math.floor(m / 60))}h${String(m % 60).padStart(2, "0")}m`;
}

export function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? "" : "s"}`;
}

/** subagent_explore → Explore; custom ids keep their name. */
export function profileLabel(profile: string): string {
  const base = profile.startsWith("subagent_") ? profile.slice("subagent_".length) : profile;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export const STATUS_LABEL: Record<SubagentStatus, string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function statusGlyph(status: SubagentStatus, theme: ThemeLike, frame = 0): string {
  switch (status) {
    case "running":
      return theme.fg("accent", SPINNER[frame % SPINNER.length]!);
    case "completed":
      return theme.fg("success", "✓");
    case "failed":
      return theme.fg("error", "✗");
    case "cancelled":
      return theme.fg("warning", "⊘");
  }
}

export function statusColor(status: SubagentStatus): ThemeColor {
  return status === "completed" ? "success" : status === "failed" ? "error" : status === "cancelled" ? "warning" : "accent";
}

function durationOf(rec: SubagentRecord, now = Date.now()): number {
  return (rec.endedAt ?? now) - rec.startedAt;
}

/** `2 subagents (1 running) · ↓ select` — undefined when there are none. */
export function stripText(records: readonly SubagentRecord[], theme: ThemeLike): string | undefined {
  if (records.length === 0) return undefined;
  const running = records.filter((r) => r.status === "running").length;
  const count = plural(records.length, "subagent");
  const run = running > 0 ? ` ${theme.fg("accent", `(${String(running)} running)`)}` : "";
  return `${theme.fg("dim", count)}${run}${theme.fg("dim", " · ↓ select")}`;
}

function spinFrame(): number {
  return Math.floor(Date.now() / SPIN_MS);
}

/** Persistent strip under the editor. Re-renders on registry changes and
 *  animates nothing (Devin's strip is static text). */
export class SubagentStrip implements Component {
  constructor(private readonly theme: ThemeLike, private readonly getRecords: () => readonly SubagentRecord[]) {}
  invalidate(): void {}
  render(width: number): string[] {
    const text = stripText(this.getRecords(), this.theme);
    return text === undefined ? [] : [truncateToWidth(text, width)];
  }
}

// ── transcript rendering ────────────────────────────────────────────────────

const TOOL_OUTPUT_LINES = 3;

/** Render transcript items as chat-like lines (tools `●`, text markdown). */
export function renderItems(items: readonly TranscriptItem[], width: number, theme: ThemeLike, opts: { fullOutput?: boolean; frame?: number } = {}): string[] {
  const w = Math.max(10, width);
  const out: string[] = [];
  for (const item of items) {
    if (item.kind === "task") {
      out.push(theme.fg("dim", "Task"));
      for (const l of item.text.split("\n")) {
        out.push(...wrapTextWithAnsi(theme.fg("muted", l), w - 2).map((x) => `  ${x}`));
      }
      out.push("");
    } else if (item.kind === "text") {
      const md = new Markdown(item.text, 0, 0, getMarkdownTheme()).render(w);
      out.push(...md, "");
    } else {
      const glyph = item.running ? theme.fg("accent", SPINNER[(opts.frame ?? 0) % SPINNER.length]!) : item.isError ? theme.fg("error", "✗") : theme.fg("accent", "●");
      const dur = item.durationMs !== undefined && item.durationMs >= 1000 ? theme.fg("dim", ` ${elapsed(item.durationMs)}`) : "";
      out.push(truncateToWidth(`${glyph} ${theme.fg("toolTitle", theme.bold(item.name))}${item.arg ? ` ${theme.fg("accent", item.arg)}` : ""}${dur}`, w));
      const lines = item.output.replace(/\s+$/u, "").split("\n").filter((l, i, a) => l.length > 0 || i < a.length - 1);
      if (lines.length > 0 && lines[0] !== "") {
        const shown = opts.fullOutput ? lines : lines.slice(-TOOL_OUTPUT_LINES);
        if (shown.length < lines.length) out.push(theme.fg("dim", `  … ${String(lines.length - shown.length)} earlier lines`));
        for (const l of shown) out.push(truncateToWidth(`  ${theme.fg(item.isError ? "error" : "toolOutput", l)}`, w));
      }
    }
  }
  while (out.at(-1) === "") out.pop();
  return out;
}

/** Last few tool/text lines — the live tail on foreground cards/widgets. */
export function tailLines(items: readonly TranscriptItem[], width: number, theme: ThemeLike, max = 4): string[] {
  const steps = items.filter((i) => i.kind !== "task").slice(-max);
  const frame = spinFrame();
  return steps.flatMap((item) => {
    if (item.kind === "text") return [truncateToWidth(`  ${theme.fg("dim", item.text.replace(/\s+/gu, " ").trim())}`, width)];
    if (item.kind !== "tool") return [];
    const glyph = item.running ? theme.fg("accent", SPINNER[frame % SPINNER.length]!) : item.isError ? theme.fg("error", "✗") : theme.fg("dim", "●");
    const row = truncateToWidth(`  ${glyph} ${theme.fg("muted", item.name)}${item.arg ? ` ${theme.fg("dim", item.arg)}` : ""}`, width);
    // A running tool shows its newest output line (bash streams).
    const latest = item.running ? item.output.trimEnd().split("\n").at(-1) : undefined;
    return latest ? [row, truncateToWidth(`    ${theme.fg("dim", latest)}`, width)] : [row];
  });
}

// ── dock ────────────────────────────────────────────────────────────────────

export interface DockActions {
  records: () => readonly SubagentRecord[];
  transcript: (rec: SubagentRecord) => TranscriptItem[];
  toolCalls: (rec: SubagentRecord) => number;
  subscribe: (listener: () => void) => () => void;
  foreground: (id: string) => string | undefined;
  cancel: (id: string) => string | undefined;
}

const LIST_HINT = "↑↓ navigate · ↵ view · f foreground · x cancel · esc close";
const VIEW_HINT = "↑↓ scroll · g/G top/end · o output · f foreground · x cancel · esc back";
const MAX_LIST_ROWS = 10;

function rule(theme: ThemeLike, left: string, right: string, width: number): string {
  const l = `── ${left} `;
  const r = right ? ` ${right} ──` : "";
  const fill = Math.max(2, width - visibleWidth(l) - visibleWidth(r));
  return truncateToWidth(`${theme.fg("borderMuted", "── ")}${left} ${theme.fg("borderMuted", "─".repeat(fill))}${r ? theme.fg("dim", r) : ""}`, width);
}

/** Inline dock (replaces the editor like /unipi:btw). */
export class SubagentDock implements Component {
  private selected = 0;
  private listTop = 0;
  private viewId: string | undefined;
  private scroll = 0;
  private follow = true;
  private fullOutput = false;
  private flash: string | undefined;
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly actions: DockActions,
    private readonly done: () => void,
    initialId?: string,
  ) {
    const recs = this.ordered();
    const first = initialId !== undefined ? recs.findIndex((r) => r.id === initialId) : recs.findIndex((r) => r.status === "running");
    this.selected = Math.max(0, first);
    this.unsubscribe = actions.subscribe(() => this.tui.requestRender());
    this.timer = setInterval(() => {
      if (this.actions.records().some((r) => r.status === "running")) this.tui.requestRender();
    }, SPIN_MS);
    this.timer.unref?.();
  }

  /** Newest first — what you just started is at the top. */
  private ordered(): SubagentRecord[] {
    return [...this.actions.records()].sort((a, b) => b.startedAt - a.startedAt);
  }

  private current(): SubagentRecord | undefined {
    const recs = this.ordered();
    if (this.viewId !== undefined) return recs.find((r) => r.id === this.viewId);
    return recs[Math.min(this.selected, recs.length - 1)];
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.timer);
    this.unsubscribe();
  }

  render(width: number): string[] {
    const w = Math.max(30, width);
    return this.viewId !== undefined ? this.renderView(w) : this.renderList(w);
  }

  private renderList(w: number): string[] {
    const t = this.theme;
    const recs = this.ordered();
    const running = recs.filter((r) => r.status === "running").length;
    const out = [rule(t, t.fg("accent", t.bold("Subagents")), `${String(recs.length)}${running > 0 ? ` · ${String(running)} running` : ""}`, w)];
    if (recs.length === 0) out.push(t.fg("dim", "  No subagents in this session yet."));
    this.selected = Math.max(0, Math.min(this.selected, recs.length - 1));
    if (this.selected < this.listTop) this.listTop = this.selected;
    if (this.selected >= this.listTop + MAX_LIST_ROWS) this.listTop = this.selected - MAX_LIST_ROWS + 1;
    if (this.listTop > 0) out.push(t.fg("dim", `  ↑ ${String(this.listTop)} more`));
    const frame = spinFrame();
    for (let i = this.listTop; i < Math.min(recs.length, this.listTop + MAX_LIST_ROWS); i++) {
      const rec = recs[i]!;
      const sel = i === this.selected;
      const calls = this.actions.toolCalls(rec);
      const left = `${sel ? t.fg("accent", "❭") : " "} ${statusGlyph(rec.status, t, frame)} ${t.fg("muted", profileLabel(rec.profile))} ${t.fg("dim", "›")} ${sel ? t.bold(rec.title) : rec.title}`;
      const tags = [elapsed(durationOf(rec)), plural(calls, "tool"), t.fg(statusColor(rec.status), STATUS_LABEL[rec.status])];
      if (rec.status === "running" && rec.background) tags.push("bg");
      tags.push(rec.model);
      const right = t.fg("dim", tags.join(" · "));
      const room = w - visibleWidth(right) - 2;
      const leftFit = room > 12 ? truncateToWidth(left, room) : truncateToWidth(left, w);
      const gap = Math.max(1, w - visibleWidth(leftFit) - visibleWidth(right));
      out.push(room > 12 ? `${leftFit}${" ".repeat(gap)}${right}` : leftFit);
    }
    const below = recs.length - (this.listTop + MAX_LIST_ROWS);
    if (below > 0) out.push(t.fg("dim", `  ↓ ${String(below)} more`));
    out.push(t.fg("borderMuted", "─".repeat(w)));
    out.push(truncateToWidth(this.flash !== undefined ? `${t.fg("warning", this.flash)}  ${t.fg("dim", LIST_HINT)}` : t.fg("dim", LIST_HINT), w));
    return out;
  }

  private renderView(w: number): string[] {
    const t = this.theme;
    const rec = this.current();
    if (rec === undefined) {
      this.viewId = undefined;
      return this.renderList(w);
    }
    const frame = spinFrame();
    const calls = this.actions.toolCalls(rec);
    const header = rule(t, `${statusGlyph(rec.status, t, frame)} ${t.fg("muted", profileLabel(rec.profile))} ${t.fg("dim", "›")} ${t.bold(rec.title)}`, `${elapsed(durationOf(rec))} · ${plural(calls, "tool")}`, w);
    const meta = [`Model: ${rec.model}${rec.thinking ? ` · ${rec.thinking}` : ""}`, `id ${rec.id}`, rec.status === "running" ? (rec.background ? "background" : "foreground") : t.fg(statusColor(rec.status), STATUS_LABEL[rec.status])];
    const body = renderItems(this.actions.transcript(rec), w - 1, t, { fullOutput: this.fullOutput, frame });
    if (rec.status !== "running") {
      if (rec.error) body.push("", t.fg(rec.status === "cancelled" ? "warning" : "error", `${rec.status === "cancelled" ? "⊘" : "✗"} ${rec.error}`));
      else if (rec.status === "cancelled") body.push("", t.fg("warning", `⊘ Cancelled${rec.cancelledBy === "user" ? " by you" : ""}`));
    }
    const viewport = Math.max(5, (process.stdout.rows ?? 30) - 12);
    const maxScroll = Math.max(0, body.length - viewport);
    if (this.follow) this.scroll = maxScroll;
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    if (this.scroll >= maxScroll) this.follow = true;
    const visible = body.slice(this.scroll, this.scroll + viewport);
    const pos = body.length > viewport ? t.fg("dim", ` ${String(this.scroll + visible.length)}/${String(body.length)}`) : "";
    return [
      header,
      truncateToWidth(t.fg("dim", meta.join(" · ")) + pos, w),
      "",
      ...visible.map((l) => truncateToWidth(l, w)),
      t.fg("borderMuted", "─".repeat(w)),
      truncateToWidth(this.flash !== undefined ? `${t.fg("warning", this.flash)}  ${t.fg("dim", VIEW_HINT)}` : t.fg("dim", VIEW_HINT), w),
    ];
  }

  private act(result: string | undefined, closeOnSuccess: boolean): void {
    this.flash = result;
    if (result === undefined && closeOnSuccess) {
      this.done();
      return;
    }
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    const rec = this.current();
    this.flash = undefined;
    if (matchesKey(data, Key.escape) || data === "q") {
      if (this.viewId !== undefined) {
        this.viewId = undefined;
        this.tui.requestRender();
      } else {
        this.done();
      }
      return;
    }
    if (data === "f" && rec) return this.act(this.actions.foreground(rec.id), true);
    if (data === "x" && rec) return this.act(this.actions.cancel(rec.id), false);
    if (this.viewId === undefined) {
      const n = this.ordered().length;
      if (matchesKey(data, Key.up) || data === "k") this.selected = Math.max(0, this.selected - 1);
      else if (matchesKey(data, Key.down) || data === "j") this.selected = Math.min(Math.max(0, n - 1), this.selected + 1);
      else if ((matchesKey(data, Key.enter) || data === "\r") && rec) {
        this.viewId = rec.id;
        this.follow = true;
        this.fullOutput = false;
      }
      this.tui.requestRender();
      return;
    }
    const page = Math.max(1, (process.stdout.rows ?? 30) - 14);
    if (matchesKey(data, Key.up) || data === "k") this.scrollBy(-1);
    else if (matchesKey(data, Key.down) || data === "j") this.scrollBy(1);
    else if (matchesKey(data, Key.pageUp)) this.scrollBy(-page);
    else if (matchesKey(data, Key.pageDown) || data === " ") this.scrollBy(page);
    else if (data === "g") {
      this.follow = false;
      this.scroll = 0;
    } else if (data === "G") this.follow = true;
    else if (data === "o") this.fullOutput = !this.fullOutput;
    this.tui.requestRender();
  }

  private scrollBy(delta: number): void {
    this.follow = false;
    this.scroll = Math.max(0, this.scroll + delta);
  }
}
