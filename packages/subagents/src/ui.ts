/**
 * @pi-unipi/subagents — TUI: strip, dock (list + transcript view), live tail.
 *
 * Devin layout, UniPi styling. ↓ + the tab strip are the shared
 * work tray's (core/src/work/tray.ts, UNI-126); this module supplies:
 *   dock (Subagents tab)  rows `❭ DONE Explore title ····· 7s · 1 tool · model`
 *                          keys `↑↓ navigate · ↵ view · f foreground · x cancel · esc close`
 *   view                  `── ◔ Explore › title ── 2m49s · 8 tools ──`, model line, task, live steps
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import {
  badge, formatTokens, groupRows, renderTrayDetail, renderTrayList, settledGlyph, spinner, SPINNER_MS, STATE_BADGE, STATE_COLOR, stateGlyph,
  trayElapsed, trayPage, trayPlural, TrayListState, TrayScroll, type TrayRow,
} from "@pi-unipi/core";
import type { SidekickUsage } from "@pi-unipi/core/child-agent.js";
import type { SubagentRecord, SubagentStatus } from "./manager.js";
import type { TranscriptItem } from "./transcript.js";

export type ThemeLike = Pick<Theme, "fg" | "bold">;

const SPIN_MS = SPINNER_MS;

/** Shared with the Background tasks tab (core pane-kit). */
export const elapsed = trayElapsed;
export const plural = trayPlural;

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

/** Crafted spinner while running, else ✓ ✗ ⊘ padded to the spinner's width. */
export function statusGlyph(status: SubagentStatus, theme: ThemeLike, now = Date.now()): string {
  return stateGlyph(theme, status, now);
}

export function statusColor(status: SubagentStatus): ThemeColor {
  return STATE_COLOR[status];
}

/** Inverse chip for a state: RUN / DONE / FAIL / STOP. */
export function statusBadge(status: SubagentStatus, theme: ThemeLike): string {
  return badge(theme, STATE_COLOR[status], STATE_BADGE[status]);
}

function durationOf(rec: Pick<SubagentRecord, "startedAt" | "endedAt">, now = Date.now()): number {
  return (rec.endedAt ?? now) - rec.startedAt;
}

/** `10k in · 0.2k out · $0.11` — omit zero token counts and unknown cost ($0). */
export function usageTail(usage: SidekickUsage | undefined): string {
  if (usage === undefined) return "";
  const parts: string[] = [];
  if (usage.input > 0 || usage.output > 0) parts.push(`${formatTokens(usage.input)} in`, `${formatTokens(usage.output)} out`);
  if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(2)}`);
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

/**
 * The live stats line for one agent:
 * `Explore · ds/flash · 32s · 20 tool calls · 10k in · 0.2k out · $0.11`.
 */
export function statLine(
  rec: Pick<SubagentRecord, "profile" | "model" | "startedAt" | "endedAt">,
  toolCalls: number,
  usage: SidekickUsage | undefined,
  now = Date.now(),
): string {
  return `${profileLabel(rec.profile)} · ${rec.model} · ${elapsed(durationOf(rec, now))} · ${plural(toolCalls, "tool call")}${usageTail(usage)}`;
}

function spinFrame(): number {
  return Date.now();
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
      const glyph = item.running ? spinner(theme, undefined, opts.frame) : theme.fg(item.isError ? "error" : "accent", settledGlyph(item.isError ? "✗" : "●"));
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
    const glyph = item.running ? spinner(theme, undefined, frame) : theme.fg(item.isError ? "error" : "dim", settledGlyph(item.isError ? "✗" : "●"));
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
  usage?: (rec: SubagentRecord) => SidekickUsage | undefined;
  subscribe: (listener: () => void) => () => void;
  foreground: (id: string) => string | undefined;
  cancel: (id: string) => string | undefined;
}

const LIST_HINT = "↑↓ navigate · ↵ view · f foreground · x cancel · ←→ tabs · esc close";
const VIEW_HINT = "↑↓ scroll · g/G top/end · o output · f foreground · x cancel · ←/esc back";

/** One list row of the Subagents tab (shared layout: core pane-kit). */
export function subagentRow(rec: SubagentRecord, toolCalls: number, usage: SidekickUsage | undefined, now = Date.now()): TrayRow {
  const tags = [elapsed(durationOf(rec, now)), plural(toolCalls, "tool")];
  if (rec.status === "running" && rec.background) tags.push("bg");
  tags.push(rec.model);
  const tok = usageTail(usage);
  if (tok) tags.push(tok.slice(3));
  return { id: rec.id, state: rec.status, kind: profileLabel(rec.profile), title: rec.title, tags };
}

/** The work tray's Subagents tab (replaces the editor like /unipi:btw). */
export class SubagentDock implements Component {
  private readonly list = new TrayListState();
  private viewId: string | undefined;
  private readonly scroll = new TrayScroll();
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
    this.list.selectId(this.rows(), initialId);
    this.unsubscribe = actions.subscribe(() => this.tui.requestRender());
    this.timer = setInterval(() => {
      if (this.actions.records().some((r) => r.status === "running")) this.tui.requestRender();
    }, SPIN_MS);
    this.timer.unref?.();
  }

  /** Running first, then recent; newest first within each. */
  private ordered(): SubagentRecord[] {
    return groupRows([...this.actions.records()].sort((a, b) => b.startedAt - a.startedAt).map((r) => ({ r, state: r.status }))).map((x) => x.r);
  }

  private rows(now = Date.now()): TrayRow[] {
    return this.ordered().map((rec) => subagentRow(rec, this.actions.toolCalls(rec), this.actions.usage?.(rec), now));
  }

  private current(): SubagentRecord | undefined {
    const recs = this.ordered();
    if (this.viewId !== undefined) return recs.find((r) => r.id === this.viewId);
    return this.list.current(recs);
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.timer);
    this.unsubscribe();
  }

  /** Work tray: the transcript view keeps ←/→; the list leaves them to the
   *  tray's tab switching. */
  capturesArrows(): boolean {
    return this.viewId !== undefined;
  }

  render(width: number): string[] {
    const w = Math.max(30, width);
    return this.viewId !== undefined ? this.renderView(w) : this.renderList(w);
  }

  private renderList(w: number): string[] {
    // The tray's tab strip above already shows "Subagents (N · k running)".
    const now = spinFrame();
    return renderTrayList(this.theme, { rows: this.rows(now), state: this.list, width: w, empty: "No subagents in this session yet.", hint: LIST_HINT, flash: this.flash, now });
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
    const meta = [`Model: ${rec.model}${rec.thinking ? ` · ${rec.thinking}` : ""}`, `id ${rec.id}`, rec.status === "running" ? (rec.background ? "background" : "foreground") : t.fg(statusColor(rec.status), STATUS_LABEL[rec.status])];
    const tok = usageTail(this.actions.usage?.(rec));
    if (tok) meta.push(tok.slice(3));
    const body = renderItems(this.actions.transcript(rec), w - 1, t, { fullOutput: this.fullOutput, frame });
    if (rec.status !== "running") {
      if (rec.error) body.push("", t.fg(rec.status === "cancelled" ? "warning" : "error", `${rec.status === "cancelled" ? "⊘" : "✗"} ${rec.error}`));
      else if (rec.status === "cancelled") body.push("", t.fg("warning", `⊘ Cancelled${rec.cancelledBy === "user" ? " by you" : ""}`));
    }
    return renderTrayDetail(t, {
      width: w,
      title: `${statusGlyph(rec.status, t, frame)} ${t.fg("muted", profileLabel(rec.profile))} ${t.fg("dim", "›")} ${t.bold(rec.title)}`,
      right: `${elapsed(durationOf(rec))} · ${plural(calls, "tool")}`,
      meta,
      body,
      scroll: this.scroll,
      hint: VIEW_HINT,
      flash: this.flash,
    });
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
    if (matchesKey(data, Key.escape) || data === "q" || (this.viewId !== undefined && matchesKey(data, Key.left))) {
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
      if (matchesKey(data, Key.up) || data === "k") this.list.move(-1, n);
      else if (matchesKey(data, Key.down) || data === "j") this.list.move(1, n);
      else if ((matchesKey(data, Key.enter) || data === "\r") && rec) {
        this.viewId = rec.id;
        this.scroll.reset();
        this.fullOutput = false;
      }
      this.tui.requestRender();
      return;
    }
    const page = trayPage();
    if (matchesKey(data, Key.up) || data === "k") this.scroll.by(-1);
    else if (matchesKey(data, Key.down) || data === "j") this.scroll.by(1);
    else if (matchesKey(data, Key.pageUp)) this.scroll.by(-page);
    else if (matchesKey(data, Key.pageDown) || data === " ") this.scroll.by(page);
    else if (data === "g") this.scroll.home();
    else if (data === "G") this.scroll.end();
    else if (data === "o") this.fullOutput = !this.fullOutput;
    this.tui.requestRender();
  }
}
