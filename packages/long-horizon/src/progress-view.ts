/**
 * `/unipi:visualize-progress` renderer (UNI-222) — pure: (theme, snapshot,
 * size, now) → lines. Live-panel method (ythx-101/live-panel-skill,
 * references/motion-grammar.md), re-done for a terminal:
 *
 *   - Fixed layout: the frame is always `height` lines; zones (header, body,
 *     log, footer) never move. The body is laid out from the snapshot's
 *     STRUCTURE only (items, waves, deps), never from time, so boxes stay put
 *     while their states change. Frame 0 is complete.
 *   - Three tempos: fast = spinners on running items (shared 90 ms tick);
 *     medium = the log (newest bright, older dim) and the bars; slow = state
 *     transitions (a box that just changed state flashes its title for
 *     FLASH_MS).
 *   - One truth: log lines, box states, counts and bars all come from the
 *     same LH_PROGRESS snapshot (the log is diffed from it, never authored).
 */

import type { LhProgressEvent, LhProgressItem, LhProgressLogLine, LhProgressRun } from "@pi-unipi/core";
import { progressBar, spinnerFrame, SPINNER_MS, type KitTheme } from "@pi-unipi/core";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

export const FLASH_MS = 2400;
export const LOG_ROWS = 6;

const MODE_TITLE: Record<LhProgressRun["mode"], string> = { goal: "Goal", ralph: "Ralph", swarm: "Swarm", graph: "Graph" };
const MODE_ICON: Record<LhProgressRun["mode"], string> = { goal: "◎", ralph: "↻", swarm: "⁂", graph: "⋔" };

export const ITEM_COLOR: Record<LhProgressItem["status"], ThemeColor> = {
  queued: "dim",
  ready: "text",
  running: "accent",
  done: "success",
  failed: "error",
  aborted: "warning",
};
const ITEM_GLYPH: Record<Exclude<LhProgressItem["status"], "running">, string> = {
  queued: "·",
  ready: "○",
  done: "✓",
  failed: "✗",
  aborted: "⊘",
};
const RUN_COLOR: Record<LhProgressRun["status"], ThemeColor> = {
  running: "accent",
  paused: "warning",
  done: "success",
  failed: "error",
  stopped: "muted",
};

// ── canvas ──────────────────────────────────────────────────────────────────

interface Cell {
  ch: string;
  color?: ThemeColor;
  bold?: boolean;
  /** Pre-rendered (already coloured) text covering `w` cells. */
  raw?: string;
  w?: number;
  /** Covered by a raw cell to the left. */
  skip?: boolean;
  /** Box-drawing connection mask (U1 D2 L4 R8) for line merging. */
  mask?: number;
}

const MASK_GLYPH: Record<number, string> = {
  1: "│", 2: "│", 3: "│", 4: "─", 8: "─", 12: "─",
  5: "┘", 6: "┐", 9: "└", 10: "┌", 7: "┤", 11: "├", 13: "┴", 14: "┬", 15: "┼",
};

/** One display cell per char: wide/zero-width glyphs (CJK, emoji, combining) become `·`. */
export function cellSafe(text: string): string {
  let out = "";
  for (const ch of text.replace(/[\u0000-\u001f\u007f]/g, " ")) out += visibleWidth(ch) === 1 ? ch : "·";
  return out;
}

class Canvas {
  readonly rows: Cell[][];
  constructor(readonly width: number, readonly height: number) {
    this.rows = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ ch: " " })));
  }
  put(x: number, y: number, text: string, color?: ThemeColor, bold?: boolean): void {
    if (y < 0 || y >= this.height) return;
    let i = 0;
    for (const ch of cellSafe(text)) {
      const cx = x + i++;
      if (cx < 0) continue;
      if (cx >= this.width) break;
      this.rows[y]![cx] = { ch, ...(color ? { color } : {}), ...(bold ? { bold } : {}) };
    }
  }
  raw(x: number, y: number, raw: string, w: number): void {
    if (y < 0 || y >= this.height || x < 0 || x + w > this.width) return;
    this.rows[y]![x] = { ch: "", raw, w };
    for (let k = 1; k < w; k++) this.rows[y]![x + k] = { ch: "", skip: true };
  }
  line(x: number, y: number, bits: number, color: ThemeColor): void {
    if (y < 0 || y >= this.height || x < 0 || x >= this.width) return;
    const cell = this.rows[y]![x]!;
    if (cell.raw || cell.skip || (cell.ch !== " " && cell.mask === undefined)) return;
    const mask = (cell.mask ?? 0) | bits;
    // The livelier colour wins where lines merge.
    const rank = (c?: ThemeColor) => (c === "accent" ? 3 : c === "success" ? 2 : c === "error" ? 2 : c ? 1 : 0);
    this.rows[y]![x] = { ch: MASK_GLYPH[mask] ?? "┼", mask, color: rank(color) >= rank(cell.color) ? color : cell.color };
  }
  serialize(t: KitTheme): string[] {
    return this.rows.map((row) => {
      let out = "";
      let run = "";
      let runColor: ThemeColor | undefined;
      let runBold = false;
      const flush = () => {
        if (!run) return;
        let s = runColor ? t.fg(runColor, run) : run;
        if (runBold) s = t.bold(s);
        out += s;
        run = "";
      };
      for (const cell of row) {
        if (cell.skip) continue;
        if (cell.raw !== undefined) {
          flush();
          out += cell.raw;
          continue;
        }
        if (cell.color !== runColor || !!cell.bold !== runBold) {
          flush();
          runColor = cell.color;
          runBold = !!cell.bold;
        }
        run += cell.ch;
      }
      flush();
      return out;
    });
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const safe = cellSafe(text);
  return safe.length > width ? `${safe.slice(0, Math.max(0, width - 1))}…` : safe;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function clock(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Spinner frame for an item: each id gets its own phase so they never tick in sync. */
function itemSpinner(t: KitTheme, id: string, now: number): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return spinnerFrame(t, "orbit", Math.floor(now / SPINNER_MS) + (h % 12));
}

/** Item id → when its state last changed (from the shared log — one truth). */
function changedAt(log: readonly LhProgressLogLine[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const line of log) if (line.item) m.set(line.item, line.at);
  return m;
}

// ── body renderers ──────────────────────────────────────────────────────────

interface BodyCtx {
  t: KitTheme;
  c: Canvas;
  x: number;
  y: number;
  w: number;
  h: number;
  now: number;
  live: boolean;
  flashes: Map<string, number>;
}

/** A 4-row status box at (x, y) of width w: title row = id, row 1 = glyph + status, row 2 = label. Returns its port row. */
function drawBox(b: BodyCtx, item: LhProgressItem, x: number, y: number, w: number, rows: 3 | 4): number {
  const { c, t } = b;
  const color = ITEM_COLOR[item.status];
  const flash = b.now - (b.flashes.get(item.id) ?? -Infinity) < FLASH_MS;
  const border: ThemeColor = item.status === "queued" ? "borderMuted" : color;
  const inner = w - 2;
  const title = fit(` ${item.id} `, Math.max(0, inner - 1));
  c.put(x, y, "┌", border);
  c.put(x + 1, y, "─", border);
  c.put(x + 2, y, title, flash ? color : border === "borderMuted" ? "muted" : color, true);
  for (let k = 2 + title.length; k < w - 1; k++) c.put(x + k, y, "─", border);
  c.put(x + w - 1, y, "┐", border);
  const statusRow = y + 1;
  c.put(x, statusRow, "│", border);
  c.put(x + w - 1, statusRow, "│", border);
  if (item.status === "running" && b.live) c.raw(x + 1, statusRow, itemSpinner(t, item.id, b.now), 2);
  else c.put(x + 1, statusRow, `${item.status === "running" ? "◌" : ITEM_GLYPH[item.status as Exclude<LhProgressItem["status"], "running">]} `, color, true);
  const word = item.status + ((item.attempts ?? 0) > 1 ? ` ×${item.attempts}` : "") + (flash ? " ◂" : "");
  c.put(x + 4, statusRow, fit(word, inner - 3), color, flash);
  if (rows === 4) {
    c.put(x, y + 2, "│", border);
    c.put(x + w - 1, y + 2, "│", border);
    c.put(x + 2, y + 2, fit(item.label, inner - 2), item.status === "queued" ? "dim" : "muted");
  }
  const bottom = y + rows - 1;
  c.put(x, bottom, "└", border);
  for (let k = 1; k < w - 1; k++) c.put(x + k, bottom, "─", border);
  c.put(x + w - 1, bottom, "┘", border);
  return statusRow;
}

function renderGraph(b: BodyCtx, run: LhProgressRun): void {
  const { c } = b;
  const byWave = new Map<number, LhProgressItem[]>();
  for (const item of run.items) {
    const wave = item.wave ?? 0;
    const list = byWave.get(wave) ?? [];
    list.push(item);
    byWave.set(wave, list);
  }
  const waves = [...byWave.keys()].sort((a, z) => a - z);
  const gutterFor = (nSources: number) => 3 + Math.min(4, Math.max(1, nSources));
  // Column width: fit every wave if possible (min 12), max 26; hidden waves reserve a 14-col note.
  const maxGutter = 7;
  const widthFor = (n: number) => {
    const room = b.w - (n < waves.length ? 15 : 0) - (n - 1) * maxGutter;
    return Math.min(26, Math.floor(room / Math.max(1, n)));
  };
  let shown = waves.length;
  let boxW = widthFor(shown);
  while (boxW < 12 && shown > 1) {
    shown -= 1;
    boxW = widthFor(shown);
  }
  boxW = Math.max(8, boxW);
  const tallest = Math.max(1, ...waves.slice(0, shown).map((w) => byWave.get(w)!.length));
  // Box rows: 4 with a label when they fit, else 3; one gap row between boxes when room allows.
  const avail = b.h - 1; // row 0 = wave headers
  let rows: 3 | 4 = 4;
  let gap = 1;
  if (tallest * 5 - 1 > avail) gap = 0;
  if (tallest * (4 + gap) - gap > avail) rows = 3;
  const per = rows + gap;
  const capacity = Math.max(1, Math.floor((avail + gap) / per));

  const ports = new Map<string, { col: number; row: number; x: number }>();
  let x = b.x;
  const colX: number[] = [];
  for (let col = 0; col < shown; col++) {
    const wave = waves[col]!;
    const items = byWave.get(wave)!;
    colX.push(x);
    const done = items.filter((i) => i.status === "done").length;
    c.put(x, b.y, fit(`wave ${wave + 1}  ${done}/${items.length}`, boxW), done === items.length ? "success" : "muted", true);
    const visible = items.length > capacity ? items.slice(0, capacity - 1) : items;
    visible.forEach((item, k) => {
      const y = b.y + 1 + k * per;
      const port = drawBox(b, item, x, y, boxW, rows);
      ports.set(item.id, { col, row: port, x });
    });
    if (visible.length < items.length) {
      const rest = items.slice(visible.length);
      const y = b.y + 1 + visible.length * per;
      const running = rest.filter((i) => i.status === "running").length;
      c.put(x, y + 1, fit(`  +${rest.length} more${running ? ` · ${running}◌` : ""}`, boxW - 1), "muted");
      for (const item of rest) ports.set(item.id, { col, row: y + 1, x });
    }
    // Gutter to the next column.
    if (col < shown - 1) {
      const next = byWave.get(waves[col + 1]!)!;
      const sources = [...new Set(next.flatMap((i) => i.deps).filter((d) => ports.get(d)?.col === col))];
      x += boxW + gutterFor(sources.length);
    }
  }
  // Edges between adjacent columns (longer edges are named in the box's dep line below the graph).
  for (let col = 0; col < shown - 1; col++) {
    const gx = colX[col]! + boxW;
    const nextX = colX[col + 1]!;
    const next = byWave.get(waves[col + 1]!)!;
    const sources = [...new Set(next.flatMap((i) => i.deps).filter((d) => ports.get(d)?.col === col))];
    sources.forEach((src, lane) => {
      const from = ports.get(src)!;
      const srcItem = run.items.find((i) => i.id === src)!;
      const color: ThemeColor = srcItem.status === "done" ? "success" : srcItem.status === "running" ? "accent" : srcItem.status === "failed" ? "error" : "borderMuted";
      const lx = gx + 1 + Math.min(lane, 3);
      for (let k = gx; k < lx; k++) c.line(k, from.row, 12, color);
      const dests = next.filter((i) => i.deps.includes(src)).map((i) => ports.get(i.id)!).filter((p) => p && p.col === col + 1);
      const ys = [from.row, ...dests.map((d) => d.row)];
      const top = Math.min(...ys);
      const bot = Math.max(...ys);
      c.line(lx, from.row, 4, color);
      for (let yy = top; yy <= bot; yy++) {
        let bits = 0;
        if (yy > top) bits |= 1;
        if (yy < bot) bits |= 2;
        if (bits) c.line(lx, yy, bits, color);
      }
      for (const d of dests) {
        c.line(lx, d.row, 8, color);
        for (let k = lx + 1; k < nextX - 1; k++) c.line(k, d.row, 12, color);
        c.put(nextX - 1, d.row, "▶", color);
      }
    });
  }
  if (shown < waves.length) {
    const hidden = waves.slice(shown).reduce((n, w) => n + byWave.get(w)!.length, 0);
    c.put(b.x + b.w - 14, b.y, fit(`→ +${waves.length - shown} wave${waves.length - shown === 1 ? "" : "s"}`, 14), "muted");
    c.put(b.x + b.w - 14, b.y + 1, fit(`  ${hidden} item${hidden === 1 ? "" : "s"}`, 14), "dim");
  }
}

function renderSwarm(b: BodyCtx, run: LhProgressRun): void {
  const boxW = Math.max(14, Math.min(28, Math.floor((b.w + 2) / Math.max(1, Math.min(run.items.length, Math.floor((b.w + 2) / 18))))) - 2);
  const cols = Math.max(1, Math.floor((b.w + 2) / (boxW + 2)));
  const gridRows = Math.ceil(run.items.length / cols);
  let rows: 3 | 4 = 4;
  if (gridRows * 4 > b.h) rows = 3;
  const capacity = Math.max(1, Math.floor(b.h / rows)) * cols;
  const visible = run.items.length > capacity ? run.items.slice(0, capacity - 1) : run.items;
  visible.forEach((item, k) => {
    const col = k % cols;
    const row = Math.floor(k / cols);
    drawBox(b, item, b.x + col * (boxW + 2), b.y + row * rows, boxW, rows);
  });
  if (visible.length < run.items.length) {
    const k = visible.length;
    const rest = run.items.slice(k);
    b.c.put(b.x + (k % cols) * (boxW + 2), b.y + Math.floor(k / cols) * rows + 1, fit(`  +${rest.length} more`, boxW), "muted");
  }
}

function renderRalph(b: BodyCtx, run: LhProgressRun): void {
  const { c, t } = b;
  const r = run.ralph;
  let y = b.y;
  if (r) {
    const max = r.maxIterations > 0 ? r.maxIterations : Math.max(r.iteration, 1);
    const barW = Math.max(10, Math.min(30, b.w - 34));
    c.put(b.x, y, "iteration", "muted");
    c.raw(b.x + 10, y, progressBar(t, r.iteration - (b.live ? 1 : 0), b.live ? 1 : 0, max, barW, RUN_COLOR[run.status]), barW);
    c.put(b.x + 11 + barW, y, `${r.iteration}${r.maxIterations > 0 ? `/${r.maxIterations}` : ""}`, "text", true);
    y += 2;
  }
  const rows = b.h - (y - b.y);
  const items = run.items;
  // Keep the working rows in view: start the window just above the first unchecked row.
  const firstOpen = Math.max(0, items.findIndex((i) => i.status !== "done"));
  const start = items.length > rows ? Math.min(Math.max(0, firstOpen - 2), items.length - rows) : 0;
  items.slice(start, start + rows).forEach((item, k) => {
    const yy = y + k;
    const flash = b.now - (b.flashes.get(item.id) ?? -Infinity) < FLASH_MS;
    if (item.status === "running" && b.live) c.raw(b.x, yy, itemSpinner(t, item.id, b.now), 2);
    else c.put(b.x, yy, item.status === "done" ? "✓" : item.status === "running" ? "◌" : "☐", ITEM_COLOR[item.status], true);
    c.put(b.x + 3, yy, fit(item.label, b.w - 6), item.status === "done" ? "dim" : item.status === "running" ? "text" : "muted", flash || item.status === "running");
    if (flash) c.put(b.x + b.w - 2, yy, "◂", ITEM_COLOR[item.status]);
  });
  if (start > 0) c.put(b.x + b.w - 12, y, fit(`↑ ${start} more`, 12), "dim");
  if (start + rows < items.length) c.put(b.x + b.w - 12, y + rows - 1, fit(`↓ ${items.length - start - rows} more`, 12), "dim");
}

function wrap(text: string, width: number, maxLines: number): string[] {
  const words = cellSafe(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= width) cur += ` ${word}`;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = fit(`${kept[maxLines - 1]} …`, width);
    return kept;
  }
  return lines.map((l) => fit(l, width));
}

function renderGoal(b: BodyCtx, run: LhProgressRun): void {
  const { c, t } = b;
  const g = run.goal;
  let y = b.y;
  c.put(b.x, y, "objective", "muted");
  y += 1;
  for (const line of wrap(g?.objective ?? run.title, b.w - 2, 3)) c.put(b.x + 2, y++, line, "text");
  y += 1;
  if (g) {
    const barW = Math.max(10, Math.min(40, b.w - 22));
    const pct = g.percent;
    c.put(b.x, y, "progress", "muted");
    if (pct === undefined) {
      c.raw(b.x + 10, y, progressBar(t, 0, b.live ? 1 : 0, 100, barW), barW);
      c.put(b.x + 11 + barW, y, "estimating…", "dim");
    } else {
      c.raw(b.x + 10, y, progressBar(t, pct, b.live ? Math.max(1, Math.min(10, 100 - pct)) : 0, 100, barW, RUN_COLOR[run.status]), barW);
      c.put(b.x + 11 + barW, y, `${g.status === "complete" ? "" : "~"}${pct}%`, "text", true);
    }
    y += 1;
    const turnW = Math.max(10, Math.min(40, b.w - 22));
    c.put(b.x, y, "turns", "muted");
    c.raw(b.x + 10, y, progressBar(t, g.turn, 0, Math.max(1, g.maxTurns), turnW, "muted"), turnW);
    c.put(b.x + 11 + turnW, y, `${g.turn}/${g.maxTurns}`, "text");
    y += 2;
    if (g.summary) {
      c.put(b.x, y, `latest estimate${g.estimatedAt !== undefined ? ` · ${ago(b.now - g.estimatedAt)}` : ""}`, "muted");
      y += 1;
      for (const line of wrap(g.summary, b.w - 2, Math.max(1, b.h - (y - b.y)))) c.put(b.x + 2, y++, line, "text");
    } else {
      c.put(b.x, y, "No estimate yet — /unipi:goal status asks for one.", "dim");
    }
  }
}

function renderRunBody(b: BodyCtx, run: LhProgressRun): void {
  if (run.mode === "graph" && run.items.length) renderGraph(b, run);
  else if (run.mode === "swarm" && run.items.length) renderSwarm(b, run);
  else if (run.mode === "ralph") renderRalph(b, run);
  else if (run.mode === "goal") renderGoal(b, run);
  else if (!b.live) b.c.put(b.x, b.y, "No item details kept for this run.", "dim");
  else b.c.put(b.x, b.y, run.mode === "graph" ? "Graph not declared yet — waiting for update_agent_graph." : "No items declared yet — waiting for the plan.", "dim");
}

// ── frame ───────────────────────────────────────────────────────────────────

/** Body rows a run wants, from its STRUCTURE only (item count, waves) — never from state, so the frame doesn't jump while it runs. */
function bodyRows(run: LhProgressRun | undefined, inner: number): number {
  if (!run) return 3;
  if (run.mode === "graph" && run.items.length) {
    const perWave = new Map<number, number>();
    for (const item of run.items) perWave.set(item.wave ?? 0, (perWave.get(item.wave ?? 0) ?? 0) + 1);
    return 1 + Math.max(1, ...perWave.values()) * 5;
  }
  if (run.mode === "swarm" && run.items.length) {
    const boxW = Math.max(14, Math.min(28, Math.floor((inner + 2) / Math.max(1, Math.min(run.items.length, Math.floor((inner + 2) / 18))))) - 2);
    const cols = Math.max(1, Math.floor((inner + 2) / (boxW + 2)));
    return Math.ceil(run.items.length / cols) * 4;
  }
  if (run.mode === "ralph") return 2 + Math.max(1, run.items.length);
  if (run.mode === "goal") return 12;
  return 2;
}

/** Frame height for this snapshot within `maxHeight` rows. */
export function progressViewHeight(progress: LhProgressEvent | undefined, width: number, maxHeight: number): number {
  const run = progress?.current ?? progress?.last;
  const W = Math.max(30, width);
  // border 2 + header (title, counts, gap; +1 idle line) + body + log sep + log + footer
  const header = run ? (progress?.current ? 3 : 4) : 0;
  const want = run ? 2 + header + bodyRows(run, W - 4) + 1 + LOG_ROWS + 1 : 6;
  return Math.max(Math.min(8, maxHeight), Math.min(maxHeight, want));
}

/**
 * The whole view, exactly `height` lines of exactly `width` cells (inside its
 * own rounded border). `progress` undefined = nothing published yet.
 */
export function renderProgressView(t: KitTheme, progress: LhProgressEvent | undefined, width: number, height: number, now: number): string[] {
  const W = Math.max(30, width);
  const H = Math.max(8, height);
  const c = new Canvas(W, H);
  const run = progress?.current ?? progress?.last;
  const live = !!progress?.current && progress.current.status === "running";
  const inner = W - 4;

  // Border.
  const frameColor: ThemeColor = live ? "borderAccent" : "borderMuted";
  c.put(0, 0, "╭", frameColor);
  for (let k = 1; k < W - 1; k++) c.put(k, 0, "─", frameColor);
  c.put(W - 1, 0, "╮", frameColor);
  for (let y = 1; y < H - 1; y++) {
    c.put(0, y, "│", frameColor);
    c.put(W - 1, y, "│", frameColor);
  }
  c.put(0, H - 1, "╰", frameColor);
  for (let k = 1; k < W - 1; k++) c.put(k, H - 1, "─", frameColor);
  c.put(W - 1, H - 1, "╯", frameColor);
  c.put(2, 0, " ◆ Long-horizon progress ", "accent", true);
  if (run) {
    const tag = ` ${MODE_ICON[run.mode]} ${MODE_TITLE[run.mode]} · ${progress?.current ? run.status : `last run · ${run.status}`} `;
    c.put(W - 2 - tag.length, 0, tag, RUN_COLOR[run.status], true);
  }

  const x = 2;
  const logTop = H - 2 - LOG_ROWS - 1; // separator row
  const footer = H - 2;

  if (!run) {
    c.put(x, 2, "No long-horizon mode active", "text", true);
    c.put(x, 3, fit("Start one with /unipi:goal, /unipi:ralph, /unipi:swarm or /unipi:graph — this view follows it live.", inner), "muted");
    c.put(x, footer, fit("Esc / q close", inner), "dim");
    return c.serialize(t);
  }

  // Header rows: title, counts bar.
  let y = 1;
  if (!progress?.current) {
    c.put(x, y, "No long-horizon mode active", "text", true);
    const when = run.endedAt !== undefined ? ` · ended ${ago(now - run.endedAt)}` : "";
    c.put(x + 29, y, fit(`last run${when}${run.reason ? ` · ${run.reason}` : ""}`, inner - 29), "muted");
    y += 1;
  }
  c.put(x, y, fit(run.title, inner), "text", true);
  y += 1;
  const k = run.counts;
  if (k.total > 0) {
    const barW = Math.max(10, Math.min(36, inner - 46));
    c.raw(x, y, progressBar(t, k.done, live ? k.running : 0, k.total, barW, RUN_COLOR[run.status]), barW);
    let cx = x + barW + 2;
    const seg = (text: string, color: ThemeColor, bold = false) => {
      c.put(cx, y, text, color, bold);
      cx += text.length;
    };
    seg(`${k.done}/${k.total} done`, "text", true);
    if (k.running) seg(` · ${k.running} running`, "accent");
    if (k.failed) seg(` · ${k.failed} failed`, "error");
    if (k.queued) seg(` · ${k.queued} waiting`, "dim");
  } else if (run.mode === "goal" && run.goal) {
    c.put(x, y, fit(`${run.goal.status} · turn ${run.goal.turn}/${run.goal.maxTurns}`, inner), "muted");
  }
  y += 2;

  // Body.
  const flashes = changedAt(progress?.log ?? []);
  renderRunBody({ t, c, x, y, w: inner, h: logTop - y, now, live, flashes }, run);

  // Log (medium tempo): newest bright, older dim.
  c.put(x, logTop, "log ", "muted", true);
  for (let kk = x + 4; kk < W - 2; kk++) c.put(kk, logTop, "─", "borderMuted");
  const log = (progress?.log ?? []).slice(-LOG_ROWS);
  log.forEach((line, i) => {
    const newest = i === log.length - 1;
    const yy = logTop + 1 + (LOG_ROWS - log.length) + i;
    c.put(x, yy, clock(line.at), newest ? "muted" : "dim");
    const color: ThemeColor = !newest ? "dim" : line.status && line.status in ITEM_COLOR ? ITEM_COLOR[line.status as LhProgressItem["status"]] : line.status ? RUN_COLOR[line.status as LhProgressRun["status"]] : "text";
    c.put(x + 9, yy, fit(line.text, inner - 9), color, newest);
  });
  if (!log.length) c.put(x, logTop + LOG_ROWS, "waiting for the first state change…", "dim");

  const updated = progress ? `updated ${ago(now - progress.updatedAt)}` : "";
  c.put(x, footer, "Esc / q close", "dim");
  c.put(W - 2 - updated.length, footer, updated, "dim");
  if (live) c.put(x + 15, footer, "● live", "accent");
  return c.serialize(t);
}

/** Lines are exactly `width` cells (tests). */
export function frameWidthOk(lines: readonly string[], width: number): boolean {
  return lines.every((line) => visibleWidth(line) === width);
}
