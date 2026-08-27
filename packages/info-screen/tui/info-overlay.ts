/**
 * @pi-unipi/info-screen — TUI Overlay Component (Cache-First Reactive)
 *
 * Opens immediately with cached data.
 * Each group loads independently in the background.
 * Reactive: re-renders as data arrives.
 * Shows humanized "last updated" timestamps.
 */

import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { infoRegistry } from "../registry.js";
import { getInfoSettings } from "../config.js";
import type { InfoGroup, GroupData } from "../types.js";
import { boxInnerWidth, OverlayTheme } from "@pi-unipi/core";

/**
 * How long to wait before warming the non-visible tabs.
 *
 * Long enough that startup and the first paint finish first, short enough that
 * a tab switch a second later is already warm.
 */
const PREFETCH_DELAY_MS = 1500;

/** Tab color palette */
const TAB_FG: Array<"accent" | "success" | "warning" | "error"> = [
  "accent",
  "success",
  "warning",
  "error",
];

/** Humanize a duration in ms to a short string */
function humanizeAge(ms: number): string {
  if (ms <= 0) return "never";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

/**
 * Info overlay component with cache-first reactive model.
 */
export class InfoOverlay implements Component {
  private groups: InfoGroup[] = [];
  private activeTabIndex = 0;
  private groupData = new Map<string, GroupData>();
  private groupLoading = new Map<string, boolean>();
  private scrollOffset = 0;
  private tabScrollOffset = 0;
  private lastGlobalUpdate = 0;
  private unsubscribers: Array<() => void> = [];
  private _destroyed = false;
  /** Groups whose fetch has already been kicked off (lazy-load bookkeeping). */
  private fetched = new Set<string>();
  private prefetchTimer: ReturnType<typeof setTimeout> | null = null;
  private bootTimer: ReturnType<typeof setTimeout> | null = null;

  onClose?: () => void;
  requestRender?: () => void;
  /**
   * Whether this overlay is the focused (topmost) entry in the TUI overlay
   * stack. The boot auto-close timer only fires while this is true — see
   * `startBootTimer` for why.
   */
  isTopmostOverlay?: () => boolean;
  /**
   * Stack-safe self-removal via the overlay handle (`handle.hide()` splices
   * this entry out of the TUI stack by identity, unlike `done()` which pops
   * whatever is TOPMOST). Set from `onHandle` in index.ts. When available,
   * the boot auto-close timer prefers this over `done()` so a splash that
   * lingers while another overlay opens can never dismiss that overlay
   * instead of itself.
   */
  selfHide?: () => void;
  /**
   * False when running as a non-capturing boot splash (auto-close): the
   * overlay never receives keyboard input, so interactive hints like
   * "q/Esc close" would be misleading and are replaced accordingly.
   */
  interactive = true;

  private overlay = new OverlayTheme();

  setTheme(theme: Theme): void {
    this.overlay.setTheme(theme);
  }

  constructor() {
    // Load groups synchronously (they're already registered)
    this.groups = infoRegistry.getAllGroups();
    this.applyOrder();

    // Seed cache with any existing data (instant display)
    for (const group of this.groups) {
      const cached = infoRegistry.getCachedData(group.id);
      if (cached) {
        this.groupData.set(group.id, cached);
      }
      this.groupLoading.set(group.id, true);
    }

    // Subscribe to per-group updates for reactive rendering
    this.unsubscribers.push(
      infoRegistry.subscribeAll((groupId, data) => {
        if (this._destroyed) return;
        // Skip empty data from registration notifications — syncGroups()
        // will trigger the real fetch.
        if (Object.keys(data).length === 0) {
          this.requestRender?.();
          return;
        }
        this.groupData.set(groupId, data);
        this.groupLoading.set(groupId, false);
        this.lastGlobalUpdate = Date.now();
        this.requestRender?.();
      })
    );

    // Fetch the visible tab now; everything else waits for idle.
    this.fetchActiveGroup();
    this.schedulePrefetch();
  }

  /** Fetch one group, tracking its loading state. Safe to call repeatedly. */
  private fetchGroup(groupId: string): void {
    if (this._destroyed) return;
    if (this.fetched.has(groupId)) return;
    this.fetched.add(groupId);
    infoRegistry.getGroupData(groupId).then(() => {
      this.groupLoading.set(groupId, false);
    }).catch(() => {
      this.groupLoading.set(groupId, false);
    });
  }

  /**
   * Fetch the currently visible group.
   *
   * Deferred to a macrotask because an async dataProvider still runs
   * synchronously up to its first `await`; calling it inline would put that
   * work back on the constructor's caller (session_start).
   */
  private fetchActiveGroup(): void {
    const group = this.groups[this.activeTabIndex];
    if (!group) return;
    setTimeout(() => this.fetchGroup(group.id), 0);
  }

  /**
   * Warm the remaining tabs once the app is idle.
   *
   * Fetching every group up front cost seconds of startup for panels the user
   * may never open. Prefetching after a delay keeps tab switches instant
   * without paying for them before the first prompt is ready.
   */
  private schedulePrefetch(): void {
    if (this.prefetchTimer) return;
    this.prefetchTimer = setTimeout(() => {
      this.prefetchTimer = null;
      if (this._destroyed) return;
      for (const group of this.groups) {
        if (group.id === this.groups[this.activeTabIndex]?.id) continue;
        this.fetchGroup(group.id);
      }
    }, PREFETCH_DELAY_MS);
    // Never hold the process open just to warm a panel.
    this.prefetchTimer.unref?.();
  }

  /**
   * Handle late-arriving groups (e.g., subagents announces after boot).
   */
  private syncGroups(): void {
    const allGroups = infoRegistry.getAllGroups();
    const hadNewGroups = allGroups.length !== this.groups.length;
    if (hadNewGroups) {
      this.groups = allGroups;
      this.applyOrder();
    }

    // Adopt any data the registry already has. Registration notifications
    // inject `{}` to trigger a re-sync; that is not real data and must not be
    // treated as fetched, or the stats render as "—".
    //
    // Groups are NOT fetched here: doing so would defeat lazy loading, since
    // syncGroups() runs on every render. Fetches are driven by tab visibility
    // (fetchActiveGroup) and the idle prefetch instead.
    for (const group of this.groups) {
      const existing = this.groupData.get(group.id);
      const hasRealData = existing && Object.keys(existing).length > 0;
      if (hasRealData) continue;

      const cached = infoRegistry.getCachedData(group.id);
      if (cached && Object.keys(cached).length > 0) {
        this.groupData.set(group.id, cached);
      }
    }

    // A late-arriving group may now be the visible one, and the prefetch pass
    // may have already run — make sure the active tab still gets its data.
    if (hadNewGroups) {
      this.fetchActiveGroup();
      this.schedulePrefetch();
    }
  }

  private applyOrder(): void {
    const settings = getInfoSettings();
    if (settings.groupOrder && settings.groupOrder.length > 0) {
      const order = settings.groupOrder;
      this.groups.sort((a, b) => {
        const ai = order.indexOf(a.id);
        const bi = order.indexOf(b.id);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      });
    }
  }

  /**
   * Cleanup subscriptions.
   */
  destroy(): void {
    this._destroyed = true;
    this.cancelBootTimer();
    if (this.prefetchTimer) {
      clearTimeout(this.prefetchTimer);
      this.prefetchTimer = null;
    }
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }

  /** Stop the boot auto-close timer, if one is pending. */
  private cancelBootTimer(): void {
    if (this.bootTimer) {
      clearTimeout(this.bootTimer);
      this.bootTimer = null;
    }
  }

  /**
   * Auto-close the overlay after `ms`.
   *
   * Used when the overlay is shown as a boot splash: the dashboard is
   * informational, so it should get out of the way on its own rather than
   * requiring a keypress.
   *
   * Dismissal uses `selfHide` (handle.hide() — removes THIS entry from the
   * TUI overlay stack by identity) and only fires while `isTopmostVisible`
   * confirms nothing is stacked above: dismissing a covered overlay breaks
   * the covering one (pi retargets focus and orphans its pending
   * interaction, e.g. a ctx.ui.select promise that never resolves while its
   * overlay vanishes). If covered, the timer re-arms and retries.
   *
   * If `selfHide` is unavailable (older host), falls back to the guarded
   * `onClose` (`done()`) path, which requires focus (topmost) for the same
   * reason.
   */
  startBootTimer(ms: number, isTopmostVisible?: () => boolean): void {
    this.cancelBootTimer();
    if (!Number.isFinite(ms) || ms <= 0) return;
    const arm = (): void => {
      this.bootTimer = setTimeout(() => {
        this.bootTimer = null;
        if (this._destroyed) return;
        if (this.selfHide) {
          if (isTopmostVisible && !isTopmostVisible()) {
            // Something is stacked on top of us — dismissing now would break
            // it (orphaned select promise, focus retarget). Retry shortly;
            // once the stack clears we dismiss as usual.
            arm();
            return;
          }
          this.selfHide();
          this.destroy();
          return;
        }
        if (this.isTopmostOverlay && !this.isTopmostOverlay()) {
          // Fallback (no selfHide available): closing now would pop the
          // covering overlay instead of this dashboard. Retry shortly; once
          // we are topmost the close is safe.
          arm();
          return;
        }
        this.destroy();
        this.onClose?.();
      }, ms);
      this.bootTimer.unref?.();
    };
    arm();
  }

  invalidate(): void {
    this.syncGroups();
  }

  handleInput(data: string): void {
    // Any keypress means the user is driving; stop the boot auto-close.
    this.cancelBootTimer();

    if (matchesKey(data, Key.right) || data === "l") {
      this.activeTabIndex = (this.activeTabIndex + 1) % this.groups.length;
      this.scrollOffset = 0;
      this.fetchActiveGroup();
    } else if (matchesKey(data, Key.left) || data === "h") {
      this.activeTabIndex = (this.activeTabIndex - 1 + this.groups.length) % this.groups.length;
      this.scrollOffset = 0;
      this.fetchActiveGroup();
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.scrollOffset++;
    } else if (matchesKey(data, Key.up) || data === "k") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    } else if (data === "g") {
      this.scrollOffset = 0;
    } else if (data === "G") {
      this.scrollOffset = Infinity;
    } else if (data === "r") {
      // Manual refresh
      this.refreshActiveGroup();
    } else if (data === "R") {
      // Refresh all
      this.refreshAll();
    } else if (data === "q" || matchesKey(data, Key.escape)) {
      this.destroy();
      this.onClose?.();
    }
  }

  private refreshActiveGroup(): void {
    const group = this.groups[this.activeTabIndex];
    if (!group) return;
    this.groupLoading.set(group.id, true);
    this.requestRender?.();
    // Explicit refresh must bypass the lazy-load guard.
    this.fetched.add(group.id);
    infoRegistry.refreshGroup(group.id);
  }

  private refreshAll(): void {
    for (const group of this.groups) {
      this.groupLoading.set(group.id, true);
      this.fetched.add(group.id);
    }
    this.requestRender?.();
    infoRegistry.refreshAll();
  }

  render(width: number): string[] {
    // Sync groups in case late arrivals
    this.syncGroups();

    if (this.groups.length === 0) {
      return this.renderEmpty(width);
    }

    return this.renderDashboard(width);
  }

  // ─── State views ─────────────────────────────────────────────────────

  private renderEmpty(width: number): string[] {
    const innerWidth = boxInnerWidth(width);
    const lines: string[] = [];
    lines.push(this.overlay.borderLine(innerWidth, "top"));
    lines.push(this.overlay.frameLine(this.overlay.fg("accent", this.overlay.bold("📊 UniPi Info Screen")), innerWidth));
    lines.push(this.overlay.ruleLine(innerWidth));
    lines.push(this.overlay.frameLine(this.overlay.fg("dim", "No groups registered."), innerWidth));
    lines.push(this.overlay.frameLine(this.overlay.fg("dim", "Modules will register groups on startup."), innerWidth));
    for (let i = 0; i < 4; i++) lines.push(this.overlay.frameLine("", innerWidth));
    lines.push(this.overlay.ruleLine(innerWidth));
    lines.push(this.overlay.frameLine(this.overlay.fg("dim", this.interactive ? "q/Esc close · r refresh" : "auto-dismissing…"), innerWidth));
    lines.push(this.overlay.borderLine(innerWidth, "bottom"));
    return lines;
  }

  // ─── Dashboard ───────────────────────────────────────────────────────

  private renderDashboard(width: number): string[] {
    const innerWidth = boxInnerWidth(width);
    const group = this.groups[this.activeTabIndex];
    const data = this.groupData.get(group.id) ?? {};
    const isLoading = this.groupLoading.get(group.id) ?? false;

    const CONTENT_HEIGHT = 12;
    const lines: string[] = [];

    lines.push(this.overlay.borderLine(innerWidth, "top"));

    // Header: group name + loading indicator
    const loadingDot = isLoading
      ? ` ${this.overlay.fg("warning", "●")}`
      : ` ${this.overlay.fg("success", "●")}`;
    const headerText = this.overlay.fg("accent", this.overlay.bold(` ${group.icon} ${group.name} `)) + loadingDot;
    lines.push(this.overlay.frameLine(headerText, innerWidth));
    lines.push(this.overlay.ruleLine(innerWidth));

    // Tab bar
    lines.push(this.overlay.frameLine(this.renderTabBar(innerWidth), innerWidth));
    lines.push(this.overlay.ruleLine(innerWidth));

    // Content with scrolling
    const contentLines = this.renderGroupContent(innerWidth, group, data);
    const wrapped = this.wrapLines(contentLines, innerWidth);
    const maxScroll = Math.max(0, wrapped.length - CONTENT_HEIGHT);
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);

    const visible = wrapped.slice(this.scrollOffset, this.scrollOffset + CONTENT_HEIGHT);
    for (let i = 0; i < CONTENT_HEIGHT; i++) {
      lines.push(this.overlay.frameLine(visible[i] ?? "", innerWidth));
    }

    // Footer
    lines.push(this.overlay.ruleLine(innerWidth));
    lines.push(this.overlay.frameLine(this.renderFooter(innerWidth, wrapped.length, CONTENT_HEIGHT), innerWidth));
    lines.push(this.overlay.borderLine(innerWidth, "bottom"));

    return lines;
  }

  private renderTabBar(width: number): string {
    if (this.groups.length === 0) return "";

    const tabWidths = this.groups.map(g => visibleWidth(` ${g.icon} ${g.name} `));
    const sepW = visibleWidth(this.overlay.fg("borderMuted", "│"));
    const indicatorSpace = 3;
    let maxTabs = 0;
    let totalW = 0;
    for (let i = 0; i < this.groups.length; i++) {
      const add = (i > 0 ? sepW : 0) + tabWidths[i]!;
      if (totalW + add > width - 2 - indicatorSpace) break;
      totalW += add;
      maxTabs = i + 1;
    }

    if (maxTabs >= this.groups.length) {
      return this.renderAllTabs();
    }

    if (this.activeTabIndex < this.tabScrollOffset) {
      this.tabScrollOffset = this.activeTabIndex;
    } else if (this.activeTabIndex >= this.tabScrollOffset + maxTabs) {
      this.tabScrollOffset = this.activeTabIndex - maxTabs + 1;
    }
    this.tabScrollOffset = Math.max(0, Math.min(this.tabScrollOffset, this.groups.length - maxTabs));

    const tabs: string[] = [];
    for (let i = this.tabScrollOffset; i < this.tabScrollOffset + maxTabs && i < this.groups.length; i++) {
      const g = this.groups[i]!;
      const isActive = i === this.activeTabIndex;
      const color = TAB_FG[i % TAB_FG.length]!;
      // Per-tab loading indicator
      const isLoading = this.groupLoading.get(g.id) ?? false;
      const dot = isLoading ? this.overlay.fg("warning", "●") : "";

      if (isActive) {
        tabs.push(this.overlay.fg(color, this.overlay.bold(` ${g.icon} ${g.name} ${dot}`)));
      } else {
        tabs.push(this.overlay.fg("dim", ` ${g.icon} ${g.name} ${dot}`));
      }
    }

    const tabStr = tabs.join(this.overlay.fg("borderMuted", "│"));
    if (this.tabScrollOffset > 0) return `${this.overlay.fg("dim", "◀")} ${tabStr}`;
    if (this.tabScrollOffset + maxTabs < this.groups.length) return `${tabStr} ${this.overlay.fg("dim", "▶")}`;
    return tabStr;
  }

  private renderAllTabs(): string {
    const tabs: string[] = [];
    for (let i = 0; i < this.groups.length; i++) {
      const g = this.groups[i]!;
      const isActive = i === this.activeTabIndex;
      const color = TAB_FG[i % TAB_FG.length]!;
      const isLoading = this.groupLoading.get(g.id) ?? false;
      const dot = isLoading ? this.overlay.fg("warning", "●") : "";

      if (isActive) {
        tabs.push(this.overlay.fg(color, this.overlay.bold(` ${g.icon} ${g.name} ${dot}`)));
      } else {
        tabs.push(this.overlay.fg("dim", ` ${g.icon} ${g.name} ${dot}`));
      }
    }
    return tabs.join(this.overlay.fg("borderMuted", "│"));
  }

  private renderGroupContent(width: number, group: InfoGroup, data: GroupData): string[] {
    const lines: string[] = [];
    const isLoading = this.groupLoading.get(group.id) ?? false;
    const visibleStats = infoRegistry.getVisibleStats(group.id);

    if (visibleStats.length === 0) {
      lines.push(`  ${this.overlay.fg("dim", "No stats configured for this group.")}`);
      return lines;
    }

    // If no data yet and loading, show placeholder per stat
    if (Object.keys(data).length === 0 && isLoading) {
      for (const stat of visibleStats) {
        lines.push(`  ${this.overlay.fg("dim", `${stat.label}:`)} ${this.overlay.fg("warning", "···")}`);
      }
      return lines;
    }

    const maxLabelLen = Math.max(...visibleStats.map((s) => s.label.length));

    for (const stat of visibleStats) {
      const statData = data[stat.id];
      const value = statData?.value ?? "—";
      const detail = statData?.detail;

      const label = `${stat.label}:`.padEnd(maxLabelLen + 1);
      let line = `  ${this.overlay.fg("dim", label)} ${this.overlay.bold(value)}`;

      if (detail) {
        const detailLines = detail.split("\n");
        if (detailLines.length === 1) {
          line += ` ${this.overlay.fg("dim", `(${detail})`)}`;
        } else {
          lines.push(line);
          for (const dLine of detailLines) {
            const indent = " ".repeat(maxLabelLen + 4);
            let detailLine = `${indent}${dLine}`;
            if (visibleWidth(detailLine) > width - 2) {
              detailLine = truncateToWidth(detailLine, width - 2);
            }
            lines.push(detailLine);
          }
          continue;
        }
      }

      if (visibleWidth(line) > width - 2) {
        line = truncateToWidth(line, width - 2);
      }

      lines.push(line);
    }

    return lines;
  }

  private renderFooter(width: number, totalLines: number, visibleHeight: number): string {
    const hasScroll = totalLines > visibleHeight;
    let scrollStr = "";
    if (hasScroll) {
      scrollStr = this.overlay.fg("dim", `${this.scrollOffset + 1}-${Math.min(this.scrollOffset + visibleHeight, totalLines)}/${totalLines}`);
    }

    // Last updated for active group
    const group = this.groups[this.activeTabIndex];
    const lastUp = infoRegistry.getLastUpdated(group?.id ?? "");
    const age = lastUp > 0 ? humanizeAge(Date.now() - lastUp) : "loading…";

    const hints = this.interactive
      ? [
          `${this.overlay.fg("accent", "←/→")} tabs`,
          `${this.overlay.fg("success", "↑/↓")} scroll`,
          `${this.overlay.fg("warning", "r")} refresh`,
          `${this.overlay.fg("error", "q/Esc")} close`,
        ]
      : [`${this.overlay.fg("dim", "auto-dismissing…")}`];

    const hintStr = hints.join(`  ${this.overlay.fg("borderMuted", "•")}  `);

    // Build right side: age + hints
    const ageStr = this.overlay.fg("dim", `⏱ ${age}`);
    const rightStr = `${ageStr}  ${this.overlay.fg("borderMuted", "│")}  ${hintStr}`;

    const scrollW = visibleWidth(scrollStr);
    const rightW = visibleWidth(rightStr);
    const gap = 4;
    const totalW = scrollW + gap + rightW;

    if (totalW >= width - 2) {
      return truncateToWidth(rightStr, width - 2);
    }

    const padding = " ".repeat(Math.max(0, width - 2 - totalW));
    return scrollStr + padding + rightStr;
  }

  private wrapLines(lines: string[], innerWidth: number): string[] {
    const wrapped: string[] = [];
    for (const line of lines) {
      if (!line) { wrapped.push(""); continue; }
      wrapped.push(...wrapTextWithAnsi(line, Math.max(1, innerWidth)));
    }
    return wrapped;
  }
}
