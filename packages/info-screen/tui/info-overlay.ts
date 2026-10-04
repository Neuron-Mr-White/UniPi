/**
 * @pi-unipi/info-screen — the /unipi:info dashboard.
 *
 *   ╭─ ◆ UNIPI  info ───────────────────────────── Session · live ─╮
 *   │  ▐Session▌  Usage  Tools  Skills  Modules  MCP  …          › │
 *   │ ━━━━━━━━━━──────────────────────────────────────────────────  │
 *   │  page body (fixed height for every page — no jumping)        │
 *   │ ● ○ ○ ○ ○ ○  2s ago          ←→ page  ↑↓ scroll  r  q        │
 *   ╰──────────────────────────────────────────────────────────────╯
 *
 * Cache-first: opens on whatever the registry has (memory or the on-disk
 * snapshot), fetches the visible page right away and warms the rest on idle.
 * Rendered page bodies are memoised per (page, data version, size), so a
 * redraw that changes nothing costs a map lookup.
 */

import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CRAB, Paint, fitTo, gradient, ramp, type RGB } from "@pi-unipi/core";
import { infoRegistry } from "../registry.js";
import { getInfoSettings } from "../config.js";
import type { InfoGroup, GroupData, PageContext } from "../types.js";
import { PAGE_STYLES, PANEL_BG, accentFor, shade } from "../palette.js";
import { genericPage, scopeLegend, skeleton } from "./page-kit.js";

/** Pages that render data from another page (compactor → usage history). */
const PAGE_DEPS: Record<string, string[]> = { compactor: ["usage"] };

/** Delay before warming the non-visible pages (after first paint). */
const PREFETCH_DELAY_MS = 600;

/** Rows taken by chrome: top border, tabs, underline, footer, bottom border. */
const CHROME_ROWS = 5;
const MIN_BODY = 8;
const MAX_BODY = 24;

function humanizeAge(ms: number): string {
  if (ms <= 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 5) return "live";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export class InfoOverlay implements Component {
  private groups: InfoGroup[] = [];
  private active = 0;
  private scroll = 0;
  private tabScroll = 0;
  private unsubscribers: Array<() => void> = [];
  private destroyed = false;
  private fetched = new Set<string>();
  private loading = new Set<string>();
  private prefetchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Data version per group — bumps on every update; keys the body memo. */
  private version = new Map<string, number>();
  private memo = new Map<string, string[]>();
  private paint = new Paint(undefined, true);

  onClose?: () => void;
  requestRender?: () => void;
  /** Terminal rows (set by index.ts from the TUI) — sizes the body. */
  terminalRows?: () => number;

  setTheme(theme: Theme): void {
    this.paint = new Paint(theme as never);
    this.memo.clear();
  }

  constructor(initialPage?: string) {
    getInfoSettings(true);
    this.groups = this.orderedGroups();
    if (initialPage) {
      const i = this.groups.findIndex((g) => g.id === initialPage);
      if (i >= 0) this.active = i;
    }
    for (const g of this.groups) {
      if (!infoRegistry.getCachedData(g.id)) this.loading.add(g.id);
    }

    this.unsubscribers.push(
      infoRegistry.subscribeAll((groupId, data) => {
        if (this.destroyed) return;
        if (Object.keys(data).length > 0) {
          this.loading.delete(groupId);
          this.version.set(groupId, (this.version.get(groupId) ?? 0) + 1);
        }
        this.requestRender?.();
      }),
    );

    this.fetchActive();
    this.schedulePrefetch();
  }

  // ─── data ──────────────────────────────────────────────────────────────

  private orderedGroups(): InfoGroup[] {
    const settings = getInfoSettings();
    const hidden = (id: string): boolean => settings.groups[id]?.show === false;
    const list = infoRegistry.getAllGroups().filter((g) => !hidden(g.id));
    const order = settings.groupOrder ?? [];
    if (order.length > 0) {
      list.sort((a, b) => {
        const ai = order.indexOf(a.id);
        const bi = order.indexOf(b.id);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || a.priority - b.priority;
      });
    }
    return list;
  }

  private fetchGroup(id: string, force = false): void {
    if (this.destroyed) return;
    if (!force && this.fetched.has(id)) return;
    this.fetched.add(id);
    const p = force ? infoRegistry.forceRefresh(id) : infoRegistry.getGroupData(id);
    p.finally(() => {
      this.loading.delete(id);
      this.requestRender?.();
    }).catch(() => {});
  }

  /** Deferred a macrotask so a provider's sync prefix never runs inside render/open. */
  private fetchActive(): void {
    const g = this.groups[this.active];
    if (!g) return;
    setTimeout(() => {
      this.fetchGroup(g.id);
      // Pages that borrow another page's data pull it along.
      for (const dep of PAGE_DEPS[g.id] ?? []) {
        if (!this.fetched.has(dep)) {
          this.fetched.add(dep);
          void infoRegistry.getGroupData(dep).then(() => {
            this.version.set(g.id, (this.version.get(g.id) ?? 0) + 1);
            this.requestRender?.();
          });
        }
      }
    }, 0);
  }

  private schedulePrefetch(): void {
    if (this.prefetchTimer) return;
    this.prefetchTimer = setTimeout(() => {
      this.prefetchTimer = null;
      if (this.destroyed) return;
      for (const g of this.groups) this.fetchGroup(g.id);
    }, PREFETCH_DELAY_MS);
    this.prefetchTimer.unref?.();
  }

  private syncGroups(): void {
    const all = infoRegistry.getAllGroups();
    const known = new Set(this.groups.map((g) => g.id));
    if (all.some((g) => !known.has(g.id))) {
      const current = this.groups[this.active]?.id;
      this.groups = this.orderedGroups();
      const i = this.groups.findIndex((g) => g.id === current);
      this.active = i >= 0 ? i : 0;
      this.fetchActive();
      this.schedulePrefetch();
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.prefetchTimer) clearTimeout(this.prefetchTimer);
    this.prefetchTimer = null;
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }

  invalidate(): void {
    this.memo.clear();
  }

  // ─── input ─────────────────────────────────────────────────────────────

  private go(delta: number): void {
    if (this.groups.length === 0) return;
    this.active = (this.active + delta + this.groups.length) % this.groups.length;
    this.scroll = 0;
    this.fetchActive();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.right) || data === "l" || matchesKey(data, Key.tab)) this.go(1);
    else if (matchesKey(data, Key.left) || data === "h" || matchesKey(data, Key.shift("tab"))) this.go(-1);
    else if (matchesKey(data, Key.down) || data === "j") this.scroll++;
    else if (matchesKey(data, Key.up) || data === "k") this.scroll = Math.max(0, this.scroll - 1);
    else if (data === "g" || matchesKey(data, Key.home)) this.scroll = 0;
    else if (data === "G" || matchesKey(data, Key.end)) this.scroll = Number.MAX_SAFE_INTEGER;
    else if (/^[1-9]$/.test(data)) {
      const i = Number(data) - 1;
      if (i < this.groups.length) {
        this.active = i;
        this.scroll = 0;
        this.fetchActive();
      }
    } else if (data === "r") {
      const g = this.groups[this.active];
      if (g) {
        this.loading.add(g.id);
        this.fetchGroup(g.id, true);
      }
    } else if (data === "R") {
      for (const g of this.groups) {
        this.loading.add(g.id);
        this.fetchGroup(g.id, true);
      }
    } else if (data === "q" || matchesKey(data, Key.escape)) {
      this.destroy();
      this.onClose?.();
    }
  }

  // ─── render ────────────────────────────────────────────────────────────

  private accentOf(g: InfoGroup): RGB {
    return g.accent ?? accentFor(g.id);
  }

  private shortOf(g: InfoGroup): string {
    return g.short ?? PAGE_STYLES[g.id]?.short ?? g.name;
  }

  private bodyHeight(): number {
    const rows = this.terminalRows?.() ?? 40;
    return Math.max(MIN_BODY, Math.min(MAX_BODY, Math.floor(rows * 0.85) - CHROME_ROWS));
  }

  render(width: number): string[] {
    this.syncGroups();
    const p = this.paint;
    const W = Math.max(20, Math.floor(width));
    const inner = W - 2;
    const content = Math.max(10, inner - 2);
    const H = this.bodyHeight();
    const g = this.groups[this.active];
    const accent = g ? this.accentOf(g) : CRAB.orange;
    const bgOpen = p.bgOpen(PANEL_BG);
    const border = (s: string): string => p.rgb(shade(accent, -0.25), s);

    // Repaint the panel bg after any inner bg/full reset so the row is opaque.
    const opaque = (s: string): string => bgOpen + s.replace(/\x1b\[(?:0|49)m/g, (m) => m + bgOpen) + "\x1b[49m";
    const row = (s: string): string => opaque(`${border("│")}${fitTo(s, inner)}${border("│")}`);

    const lines: string[] = [];

    // Top border with brand + page title.
    const brand = ` ${p.rgb(CRAB.orange, "◆")} ${gradient(p, "UNIPI", [CRAB.gold, CRAB.orange, CRAB.red], true)} ${p.fg("dim", "info")} `;
    const isLoading = g ? this.loading.has(g.id) : false;
    const age = g ? infoRegistry.getLastUpdated(g.id) : 0;
    const status = isLoading && age === 0 ? p.rgb(CRAB.gold, "loading") : p.fg("dim", humanizeAge(Date.now() - age));
    let title = g ? ` ${p.bold(p.rgb(accent, g.name))} ${p.fg("borderMuted", "·")} ${status} ` : "";
    // Narrow: drop the status, then cut the name — the edge must stay exact.
    const room = inner - 2 - visibleWidth(brand);
    if (g && visibleWidth(title) > room) title = ` ${p.bold(p.rgb(accent, g.name))} `;
    if (visibleWidth(title) > room) title = room > 2 ? ` ${fitTo(p.bold(p.rgb(accent, g?.name ?? "")), room - 2)} ` : "";
    const fill = Math.max(0, inner - 1 - visibleWidth(brand) - visibleWidth(title));
    lines.push(opaque(border("╭─") + brand + border("─".repeat(fill)) + title + border("╮")));

    if (!g) {
      for (let i = 0; i < H + 3; i++) lines.push(row(i === 2 ? `  ${p.fg("dim", "No pages registered yet.")}` : ""));
      lines.push(opaque(border(`╰${"─".repeat(inner)}╯`)));
      return lines;
    }

    // Tab strip + underline.
    const [tabs, underline] = this.renderTabs(content);
    lines.push(row(` ${tabs} `));
    lines.push(row(` ${underline} `));

    // Body.
    const body = this.pageBody(g, content, H);
    const maxScroll = Math.max(0, body.length - H);
    this.scroll = Math.min(this.scroll, maxScroll);
    const view = body.slice(this.scroll, this.scroll + H);
    for (let i = 0; i < H; i++) {
      let l = view[i] ?? "";
      // Scroll cues on the right edge.
      if (maxScroll > 0 && i === 0 && this.scroll > 0) l = fitTo(l, content - 2) + p.fg("dim", " ▲");
      if (maxScroll > 0 && i === H - 1 && this.scroll < maxScroll) l = fitTo(l, content - 2) + p.fg("dim", " ▼");
      lines.push(row(` ${fitTo(l, content)} `));
    }

    // Footer: page dots + keys.
    lines.push(row(` ${this.renderFooter(content, body.length > H)} `));
    lines.push(opaque(border(`╰${"─".repeat(inner)}╯`)));
    return lines;
  }

  private pageBody(g: InfoGroup, width: number, height: number): string[] {
    const ver = this.version.get(g.id) ?? 0;
    const cached = infoRegistry.getCachedData(g.id);
    const loading = this.loading.has(g.id) && !cached;
    // Session data is time-sensitive (durations); others only change on new data.
    const tick = g.id === "session" ? Math.floor(Date.now() / 1000) : 0;
    const key = `${g.id}|${ver}|${cached ? 1 : 0}|${width}|${height}|${loading ? 1 : 0}|${tick}`;
    const hit = this.memo.get(key);
    if (hit) return hit;

    const data: GroupData = cached ?? {};
    const pc: PageContext = { data, width, height, paint: this.paint, accent: this.accentOf(g), loading, now: Date.now() };
    let out: string[];
    try {
      if (loading && Object.keys(data).length === 0) out = skeleton(pc, Math.min(6, height));
      else {
        out = g.render ? g.render(pc) : [];
        if (out.length === 0) out = genericPage(pc, infoRegistry.getVisibleStats(g.id), data);
      }
    } catch (err) {
      out = [this.paint.rgb([230, 90, 80], `page failed: ${(err as Error).message ?? String(err)}`)];
    }
    out = out.map((l) => fitTo(l, width));
    // Bounded memo: drop everything for this group before storing.
    for (const k of this.memo.keys()) if (k.startsWith(`${g.id}|`)) this.memo.delete(k);
    this.memo.set(key, out);
    return out;
  }

  private renderTabs(width: number): [string, string] {
    const p = this.paint;
    const labels = this.groups.map((g) => this.shortOf(g));
    const cellW = labels.map((l) => visibleWidth(l) + 2);
    const gap = 1;
    // Keep the active tab in view; reserve 2 cells for ‹ › cues.
    const avail = width - 4;
    if (this.active < this.tabScroll) this.tabScroll = this.active;
    const span = (from: number, to: number): number => cellW.slice(from, to + 1).reduce((a, b) => a + b + gap, 0) - gap;
    while (span(this.tabScroll, this.active) > avail && this.tabScroll < this.active) this.tabScroll++;
    let last = this.tabScroll;
    while (last + 1 < labels.length && span(this.tabScroll, last + 1) <= avail) last++;

    let tabs = "";
    let under = "";
    for (let i = this.tabScroll; i <= last; i++) {
      const g = this.groups[i]!;
      const a = this.accentOf(g);
      const label = ` ${labels[i]} `;
      const isActive = i === this.active;
      const busy = this.loading.has(g.id) && this.fetched.has(g.id);
      if (isActive) tabs += p.on([18, 18, 22], a, p.bold(label));
      else tabs += busy ? p.rgb(shade(a, -0.2), label) : p.fg("muted", label);
      under += isActive ? p.rgb(a, "━".repeat(cellW[i]!)) : p.fg("borderMuted", "─".repeat(cellW[i]!));
      if (i < last) {
        tabs += " ".repeat(gap);
        under += p.fg("borderMuted", "─".repeat(gap));
      }
    }
    const left = this.tabScroll > 0 ? p.fg("dim", "‹ ") : "  ";
    const right = last < labels.length - 1 ? p.fg("dim", " ›") : "  ";
    const used = visibleWidth(tabs);
    const pad = Math.max(0, avail - used);
    return [
      fitTo(left + tabs + " ".repeat(pad) + right, width),
      fitTo(p.fg("borderMuted", "──") + under + p.fg("borderMuted", "─".repeat(Math.max(0, width - 2 - used))), width),
    ];
  }

  private renderFooter(width: number, scrollable: boolean): string {
    const p = this.paint;
    const dots = this.groups
      .map((g, i) => (i === this.active ? p.rgb(this.accentOf(g), "●") : p.rgb(shade(this.accentOf(g), -0.55), "•")))
      .join("");
    const pos = p.fg("dim", ` ${this.active + 1}/${this.groups.length}`);
    const key = (k: string, what: string): string => `${p.fg("muted", k)} ${p.fg("dim", what)}`;
    const legendStr = width >= 96 ? `   ${scopeLegend(p)}` : "";
    const left = (width >= 70 ? dots + pos : pos.trimStart()) + legendStr;
    const full = [key("←→", "page"), scrollable ? key("↑↓", "scroll") : "", key("r", "refresh"), key("q", "close")].filter(Boolean);
    const terse = [`${p.fg("muted", "←→")}`, scrollable ? p.fg("muted", "↑↓") : "", p.fg("muted", "r"), p.fg("muted", "q")].filter(Boolean);
    let keys = full.join(p.fg("borderMuted", "  ·  "));
    if (visibleWidth(left) + visibleWidth(keys) + 2 > width) keys = full.join(" ");
    if (visibleWidth(left) + visibleWidth(keys) + 2 > width) keys = terse.join(" ");
    const gap = width - visibleWidth(left) - visibleWidth(keys);
    if (gap < 2) return fitTo(gap < -20 ? left : `${left}  ${keys}`, width);
    return left + " ".repeat(gap) + keys;
  }
}

/** Exposed for tests and the preview script. */
export const _internals = { humanizeAge, ramp };
