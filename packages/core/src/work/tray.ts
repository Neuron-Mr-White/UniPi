/**
 * Work tray (UNI-126 / UNI-195): ONE bottom pane for background tasks and
 * subagents, opened with ↓ from an empty editor (same trigger the subagent
 * dock used) or Shift+↓ / the /unipi:bg-tasks and /unipi:subagents commands.
 *
 *   ── ▌Background tasks (2 · 1 running)▐  Subagents (3) ───── ←→ tabs · esc close
 *   <the active tab's pane: the bg task list/logs, or the subagent list/transcript>
 *
 * Nothing is drawn while the tray is closed (no strip, no spinners).
 *
 * Owners register a tab (`registerWorkTrayTab`) and supply the pane; this
 * module owns the tab strip, ←/→ switching, the ↓ key and the open/close
 * lifecycle, so there is exactly one place deciding when ↓ is stolen from
 * the editor.
 *
 * ←/→ only reach the tray while it is open and focused (it replaces the
 * editor), and a pane that uses them itself — the detail views, where ←
 * means "back to the list" — claims them via `capturesArrows()`.
 *
 * State is module-level (not globalThis): the bundle (and jiti's uncached
 * dev load) give every pi load its own copy, so a /reload starts clean.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { subscribeWorkChanges } from "./index.js";

export interface WorkTrayCounts {
  total: number;
  running: number;
}

/** A tab's content. Rendered under the tab strip; receives every key the
 *  tray does not keep for itself. */
export interface WorkTrayPane extends Component {
  handleInput(data: string): void;
  /** True while the pane uses ←/→ itself (e.g. a detail view's "← back"). */
  capturesArrows?(): boolean;
  dispose?(): void;
}

export interface WorkTrayPaneContext {
  tui: TUI;
  theme: Theme;
  /** Close the whole tray (a pane's esc/q/close action). */
  close(): void;
  /** Item to open directly (bg task id / subagent id). */
  initialId?: string;
}

export interface WorkTrayTab {
  id: string;
  label: string;
  /** Used when the full labels don't fit (narrow terminals). */
  shortLabel?: string;
  order: number;
  counts(): WorkTrayCounts;
  createPane(ctx: WorkTrayPaneContext): WorkTrayPane;
}

export type TrayTheme = Pick<Theme, "fg" | "bold">;

/** A zero-line widget: only there to learn the TUI (for the ↓ focus check).
 *  The tray draws NOTHING while closed — no strip, no spinners (the user
 *  found the always-on "◆ Background tasks … · ↓ open" + per-agent spinner
 *  lines messy); the footer's single "Working… · ↓ open" line is the only
 *  hint that wake-capable work is pending. */
const STRIP_KEY = "work-tray-strip";
export const TRAY_HINT = "←→ tabs · esc close";

const tabs = new Map<string, WorkTrayTab>();
/** Per ExtensionAPI: pi re-runs extension factories on /new, /resume and
 *  /reload with a fresh api, so a single module-level flag would leave the
 *  new session without the ↓ hook. Several owners on one api install once;
 *  owners on different apis (per-module proxies) install idempotent
 *  handlers that converge on the same single subscription. */
let installedFor = new WeakSet<object>();
let uiCtx: ExtensionContext | undefined;
let tuiRef: TUI | undefined;
let unsubInput: (() => void) | undefined;
let openTray: WorkTray | undefined;

function sortedTabs(): WorkTrayTab[] {
  return [...tabs.values()].sort((a, b) => a.order - b.order);
}

function safeCounts(tab: WorkTrayTab): WorkTrayCounts {
  try {
    return tab.counts();
  } catch {
    return { total: 0, running: 0 };
  }
}

/** Tab to open on: the requested one, else the first tab (Background tasks)
 *  unless it is empty and a later tab has items. */
export function pickInitialTab(list: readonly WorkTrayTab[], requested?: string): number {
  if (list.length === 0) return 0;
  if (requested !== undefined) {
    const i = list.findIndex((t) => t.id === requested);
    if (i >= 0) return i;
  }
  if (safeCounts(list[0]!).total > 0) return 0;
  const withItems = list.findIndex((t) => safeCounts(t).total > 0);
  return withItems >= 0 ? withItems : 0;
}

/** Label forms, widest first: `Label (N · k running)`, the short label,
 *  then `Short N/k` (k running of N) for very narrow panes. */
function tabText(tab: WorkTrayTab, level: number): string {
  const c = safeCounts(tab);
  const label = level > 0 ? (tab.shortLabel ?? tab.label) : tab.label;
  if (level >= 2) return `${label} ${String(c.total)}${c.running > 0 ? `/${String(c.running)}` : ""}`;
  return `${label} (${String(c.total)}${c.running > 0 ? ` · ${String(c.running)} running` : ""})`;
}

/** The tab strip: active tab inverse+accent, others muted; the key hint on
 *  the right when it fits; short labels, then truncation, when narrow. */
export function renderTabStrip(theme: TrayTheme, list: readonly WorkTrayTab[], active: number, width: number): string {
  const build = (level: number, hint: boolean): string => {
    const parts = list.map((tab, i) => {
      const text = ` ${tabText(tab, level)} `;
      return i === active ? `\x1b[7m${theme.fg("accent", theme.bold(text))}\x1b[27m` : theme.fg("muted", text);
    });
    const left = `${theme.fg("borderMuted", "─")} ${parts.join(theme.fg("borderMuted", "│"))} `;
    if (!hint) return left;
    const right = ` ${TRAY_HINT} `;
    const fill = width - visibleWidth(left) - visibleWidth(right);
    if (fill < 2) return "";
    return `${left}${theme.fg("borderMuted", "─".repeat(fill))}${theme.fg("dim", right)}`;
  };
  const withHint = build(0, true);
  if (withHint !== "") return withHint;
  for (const level of [0, 1, 2]) {
    const line = build(level, false);
    if (visibleWidth(line) <= width) return `${line}${theme.fg("borderMuted", "─".repeat(Math.max(0, width - visibleWidth(line))))}`;
  }
  return truncateToWidth(build(2, false), width);
}

/** The pane: tab strip + the active tab's pane. Panes are created on first
 *  visit and kept until close, so switching back keeps their selection. */
export class WorkTray implements Component {
  private active: number;
  private readonly panes = new Map<string, WorkTrayPane>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly list: readonly WorkTrayTab[],
    private readonly done: () => void,
    initial: { tab?: string; initialId?: string } = {},
  ) {
    this.active = pickInitialTab(list, initial.tab);
    this.pendingInitialId = initial.initialId;
    let unsub: () => void = () => {};
    try {
      unsub = subscribeWorkChanges(() => this.tui.requestRender());
    } catch {
      /* counts still refresh with the panes' own timers */
    }
    this.unsubscribe = unsub;
  }

  private pendingInitialId: string | undefined;

  activeTabId(): string | undefined {
    return this.list[this.active]?.id;
  }

  /** Switch to a tab (and optionally an item): re-creates that tab's pane
   *  when an item is requested so it opens on it. */
  select(id: string, initialId?: string): void {
    const i = this.list.findIndex((t) => t.id === id);
    if (i < 0) return;
    this.active = i;
    if (initialId !== undefined) {
      this.panes.get(id)?.dispose?.();
      this.panes.delete(id);
      this.pendingInitialId = initialId;
    }
    this.tui.requestRender();
  }

  private pane(): WorkTrayPane | undefined {
    const tab = this.list[this.active];
    if (!tab) return undefined;
    let pane = this.panes.get(tab.id);
    if (!pane) {
      const initialId = this.pendingInitialId;
      this.pendingInitialId = undefined;
      pane = tab.createPane({ tui: this.tui, theme: this.theme, close: () => this.close(), ...(initialId !== undefined ? { initialId } : {}) });
      this.panes.set(tab.id, pane);
    }
    return pane;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.done();
  }

  invalidate(): void {
    for (const p of this.panes.values()) p.invalidate();
  }

  dispose(): void {
    this.unsubscribe();
    for (const p of this.panes.values()) {
      try {
        p.dispose?.();
      } catch {
        /* a pane's cleanup must not break the others */
      }
    }
    this.panes.clear();
  }

  handleInput(data: string): void {
    const pane = this.pane();
    const arrows = pane?.capturesArrows?.() === true;
    if (!arrows && this.list.length > 0) {
      if (matchesKey(data, Key.left)) {
        this.active = (this.active - 1 + this.list.length) % this.list.length;
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.right)) {
        this.active = (this.active + 1) % this.list.length;
        this.tui.requestRender();
        return;
      }
    }
    if (!pane) {
      if (matchesKey(data, Key.escape)) this.close();
      return;
    }
    pane.handleInput(data);
  }

  render(width: number): string[] {
    const w = Math.max(20, width);
    const header = renderTabStrip(this.theme, this.list, this.active, w);
    const pane = this.pane();
    const body = pane ? pane.render(w) : [this.theme.fg("dim", "  Nothing to show.")];
    return [header, ...body.map((l) => truncateToWidth(l, w))];
  }
}

// ── registration + lifecycle ────────────────────────────────────────────────

/** True while the tray is open. */
export function isWorkTrayOpen(): boolean {
  return openTray !== undefined;
}

/** Total items across every registered tab (↓ only opens when > 0). */
export function workTrayItemCount(): number {
  let n = 0;
  for (const tab of tabs.values()) n += safeCounts(tab).total;
  return n;
}

/** The editor is focused, empty and not autocompleting — the only state in
 *  which ↓ may open the tray (onTerminalInput fires regardless of focus). */
export function editorIdleFor(tui: unknown): boolean {
  const t = tui as { getFocusedComponent?: () => unknown } | undefined;
  const f = t?.getFocusedComponent?.() as { getText?: () => string; isShowingAutocomplete?: () => boolean } | null | undefined;
  if (!f || typeof f.getText !== "function" || typeof f.isShowingAutocomplete !== "function") return false;
  return f.getText() === "" && !f.isShowingAutocomplete();
}

function onTerminalInput(data: string): { consume?: boolean } | undefined {
  if (openTray !== undefined || uiCtx === undefined) return undefined;
  if (!matchesKey(data, Key.down)) return undefined;
  if (!editorIdleFor(tuiRef) || workTrayItemCount() === 0) return undefined;
  void openWorkTray(uiCtx);
  return { consume: true };
}

function ensureWorkTray(pi: ExtensionAPI): void {
  if (installedFor.has(pi)) return;
  installedFor.add(pi);
  pi.on("session_start", (_event, ctx) => {
    try {
      uiCtx = ctx;
      unsubInput?.();
      unsubInput = undefined;
      if (!ctx.hasUI) return;
      // Zero-line widget: only captures the TUI ref for the ↓ focus check.
      ctx.ui.setWidget(STRIP_KEY, (tui) => {
        tuiRef = tui;
        return { render: () => [], invalidate() {} };
      }, { placement: "belowEditor" });
      unsubInput = ctx.ui.onTerminalInput(onTerminalInput);
    } catch {
      /* the tray is optional UI; never break session start */
    }
  });
  pi.on("session_shutdown", () => {
    unsubInput?.();
    unsubInput = undefined;
    uiCtx = undefined;
    tuiRef = undefined;
  });
}

/** Register (or replace) a tray tab. The first registration installs the ↓
 *  key handler. Returns an unregister function. */
export function registerWorkTrayTab(pi: ExtensionAPI, tab: WorkTrayTab): () => void {
  tabs.set(tab.id, tab);
  ensureWorkTray(pi);
  return () => {
    if (tabs.get(tab.id) === tab) tabs.delete(tab.id);
  };
}

/** Open the tray (or, when already open, switch it to `tab`/`initialId`). */
export async function openWorkTray(ctx: ExtensionContext, opts: { tab?: string; initialId?: string } = {}): Promise<void> {
  if (!ctx.hasUI) return;
  if (openTray !== undefined) {
    if (opts.tab !== undefined) openTray.select(opts.tab, opts.initialId);
    return;
  }
  const list = sortedTabs();
  if (list.length === 0) return;
  let tray: WorkTray | undefined;
  try {
    await ctx.ui.custom<void>((tui, theme, _kb, done) => {
      tuiRef ??= tui;
      tray = new WorkTray(tui, theme, list, () => done(), opts);
      openTray = tray;
      return tray;
    });
  } finally {
    if (openTray === tray) openTray = undefined;
  }
}

/** Test hook: forget tabs, install state and any open tray. */
export function resetWorkTrayForTests(): void {
  tabs.clear();
  installedFor = new WeakSet<object>();
  uiCtx = undefined;
  tuiRef = undefined;
  unsubInput = undefined;
  openTray = undefined;
}

/** Test hook: drive the ↓ handler without a pi session. */
export function workTrayInputForTests(data: string, ctx: ExtensionContext, tui: unknown): { consume?: boolean } | undefined {
  uiCtx = ctx;
  tuiRef = tui as TUI;
  return onTerminalInput(data);
}
