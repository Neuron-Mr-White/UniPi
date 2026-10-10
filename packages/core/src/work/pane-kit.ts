/**
 * Work tray pane kit: the shared list + detail layout of every work tray tab
 * (Background tasks, Subagents), so both tabs look and behave the same.
 *
 *   list    `❭  RUN   Shell ticker  for i in … ······ ⠋ 1m10s · 559B · wakes agent`
 *           grouped Running / Recent (headers only when both exist), at most
 *           TRAY_LIST_ROWS rows with `↑ N more` / `↓ N more`, then a rule and
 *           the key hint (a flash message in front of it after an action).
 *   detail  `── ⠋ Shell › ticker ─────────────── 1m10s · 559B ──`
 *           one dim meta line (+ `12/80` scroll position), a blank line, the
 *           scrollable body (follows the end until you scroll up), rule, hint.
 *
 * Pure rendering + small state holders; the panes own their data and keys.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { badge, leader, spinner, STATE_BADGE, STATE_COLOR, type KitTheme, type RunState } from "../tui/kit.js";

export const TRAY_LIST_ROWS = 10;
/** The title keeps at least this many columns before tags are squeezed. */
const MIN_TITLE = 24;

/** `7s`, `2m49s`, `1h05m`. */
export function trayElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m${String(s % 60).padStart(2, "0")}s`;
  return `${String(Math.floor(m / 60))}h${String(m % 60).padStart(2, "0")}m`;
}

export function trayPlural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? "" : "s"}`;
}

/** Inverse state chip: RUN / DONE / FAIL / STOP. */
export function trayBadge(t: KitTheme, state: RunState): string {
  return badge(t, STATE_COLOR[state], STATE_BADGE[state]);
}

/** `── left ────────── right ──` */
export function trayRule(t: KitTheme, left: string, right: string, width: number): string {
  const l = `── ${left} `;
  const r = right ? ` ${right} ──` : "";
  const fill = Math.max(2, width - visibleWidth(l) - visibleWidth(r));
  return truncateToWidth(`${t.fg("borderMuted", "── ")}${left} ${t.fg("borderMuted", "─".repeat(fill))}${r ? t.fg("dim", r) : ""}`, width);
}

/** The bottom key hint, with an action's flash message in front of it. */
export function trayHintLine(t: KitTheme, hint: string, flash: string | undefined, width: number): string {
  return truncateToWidth(flash !== undefined ? `${t.fg("warning", flash)}  ${t.fg("dim", hint)}` : t.fg("dim", hint), width);
}

export interface TrayRow {
  id: string;
  state: RunState;
  /** Bold kind label after the chip: `Explore`, `Shell`, `Agent`. */
  kind: string;
  title: string;
  /** Dim text after the title (e.g. the short command); squeezed first. */
  detail?: string;
  /** Right-aligned stats, most important first; dropped from the end when narrow. */
  tags: string[];
  /** Tags that always stay (default 2). */
  keepTags?: number;
}

/** One list row: `❭  RUN   Kind title detail ····· ⠋ tag · tag · tag`. */
export function trayRow(t: KitTheme, row: TrayRow, selected: boolean, width: number, now = Date.now()): string {
  const detail = row.detail ? ` ${t.fg("dim", row.detail)}` : "";
  const left = `${selected ? t.fg("accent", "❭") : " "} ${trayBadge(t, row.state)} ${t.bold(row.kind)} ${selected ? t.fg("accent", row.title) : row.title}${detail}`;
  const live = row.state === "running" ? `${spinner(t, undefined, now)} ` : "";
  const keep = row.keepTags ?? 2;
  // Narrow panes: the title keeps ≥ MIN_TITLE columns (the detail goes
  // first); tags drop from the end before the title is squeezed.
  const minLeft = Math.min(visibleWidth(left), visibleWidth(left) - visibleWidth(row.title) - visibleWidth(detail) + MIN_TITLE);
  const rightOf = (n: number) => `${live}${t.fg("dim", row.tags.slice(0, n).join(" · "))}`;
  let shown = row.tags.length;
  while (shown > keep && visibleWidth(rightOf(shown)) + minLeft + 4 > width) shown--;
  const right = rightOf(shown);
  return visibleWidth(right) + 16 < width ? leader(t, truncateToWidth(left, width - visibleWidth(right) - 4), right, width) : truncateToWidth(left, width);
}

/** Running first, then recent; within a group the given order is kept. */
export function groupRows<T extends { state: RunState }>(rows: readonly T[]): T[] {
  return [...rows.filter((r) => r.state === "running"), ...rows.filter((r) => r.state !== "running")];
}

/** List selection + window. Rows are addressed by index in the grouped order. */
export class TrayListState {
  selected = 0;
  top = 0;

  /** Select the row with `id` (or the first running row) — returns whether found. */
  selectId(rows: readonly TrayRow[], id: string | undefined): boolean {
    const i = id !== undefined ? rows.findIndex((r) => r.id === id) : rows.findIndex((r) => r.state === "running");
    if (i >= 0) this.selected = i;
    return i >= 0;
  }

  move(delta: number, count: number): void {
    this.selected = Math.max(0, Math.min(Math.max(0, count - 1), this.selected + delta));
  }

  current<T>(rows: readonly T[]): T | undefined {
    return rows[Math.max(0, Math.min(this.selected, rows.length - 1))];
  }
}

export interface TrayListOptions {
  rows: readonly TrayRow[];
  state: TrayListState;
  width: number;
  empty: string;
  hint: string;
  flash?: string | undefined;
  now?: number;
  maxRows?: number;
}

/** The list body: grouped rows (Running / Recent headers when both exist), `↑/↓ N more`, rule, hint. */
export function renderTrayList(t: KitTheme, o: TrayListOptions): string[] {
  const { rows, state, width: w } = o;
  const max = o.maxRows ?? TRAY_LIST_ROWS;
  const now = o.now ?? Date.now();
  const out: string[] = [];
  if (rows.length === 0) out.push(t.fg("dim", `  ${o.empty}`));
  state.selected = Math.max(0, Math.min(state.selected, rows.length - 1));
  if (state.selected < state.top) state.top = state.selected;
  if (state.selected >= state.top + max) state.top = state.selected - max + 1;
  state.top = Math.max(0, Math.min(state.top, Math.max(0, rows.length - max)));
  const grouped = rows.some((r) => r.state === "running") && rows.some((r) => r.state !== "running");
  if (state.top > 0) out.push(t.fg("dim", `  ↑ ${String(state.top)} more`));
  let lastGroup: boolean | undefined;
  for (let i = state.top; i < Math.min(rows.length, state.top + max); i++) {
    const row = rows[i]!;
    const running = row.state === "running";
    if (grouped && running !== lastGroup) {
      out.push(t.fg("muted", t.bold(`  ${running ? "Running" : "Recent"}`)));
      lastGroup = running;
    }
    out.push(trayRow(t, row, i === state.selected, w, now));
  }
  const below = rows.length - (state.top + max);
  if (below > 0) out.push(t.fg("dim", `  ↓ ${String(below)} more`));
  out.push(t.fg("borderMuted", "─".repeat(w)));
  out.push(trayHintLine(t, o.hint, o.flash, w));
  return out;
}

/** Detail-view scroll state: follows the end until scrolled up; reaching the end resumes following. */
export class TrayScroll {
  scroll = 0;
  follow = true;

  reset(): void {
    this.scroll = 0;
    this.follow = true;
  }

  by(delta: number): void {
    this.follow = false;
    this.scroll = Math.max(0, this.scroll + delta);
  }

  home(): void {
    this.follow = false;
    this.scroll = 0;
  }

  end(): void {
    this.follow = true;
  }

  /** Clamp to the body; returns the first visible line. */
  fit(bodyLength: number, viewport: number): number {
    const maxScroll = Math.max(0, bodyLength - viewport);
    if (this.follow) this.scroll = maxScroll;
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    if (this.scroll >= maxScroll) this.follow = true;
    return this.scroll;
  }
}

/** Body rows that fit under the tray's chrome on this terminal. */
export function trayViewport(): number {
  return Math.max(5, (process.stdout.rows ?? 30) - 12);
}

/** Page size for PgUp/PgDn/space in the detail view. */
export function trayPage(): number {
  return Math.max(1, (process.stdout.rows ?? 30) - 14);
}

export interface TrayDetailOptions {
  width: number;
  /** Rule title (already themed): `⠋ Shell › ticker`. */
  title: string;
  /** Rule right side: `1m10s · 559B`. */
  right: string;
  meta: string[];
  body: readonly string[];
  scroll: TrayScroll;
  hint: string;
  flash?: string | undefined;
  viewport?: number;
}

/** The detail view: rule header, dim meta line (+ position), blank, scrolled body, rule, hint. */
export function renderTrayDetail(t: KitTheme, o: TrayDetailOptions): string[] {
  const w = o.width;
  const viewport = o.viewport ?? trayViewport();
  const start = o.scroll.fit(o.body.length, viewport);
  const visible = o.body.slice(start, start + viewport);
  const pos = o.body.length > viewport ? t.fg("dim", ` ${String(start + visible.length)}/${String(o.body.length)}`) : "";
  return [
    trayRule(t, o.title, o.right, w),
    truncateToWidth(t.fg("dim", o.meta.join(" · ")) + pos, w),
    "",
    ...visible.map((l) => truncateToWidth(l, w)),
    t.fg("borderMuted", "─".repeat(w)),
    trayHintLine(t, o.hint, o.flash, w),
  ];
}
