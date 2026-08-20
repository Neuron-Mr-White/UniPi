/**
 * @pi-unipi/updater — Shared List+Detail TUI Overlay
 *
 * Parameterized overlay for browse-a-list-then-view-detail patterns.
 * Used by both the changelog and readme browsers.
 */

import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { boxInnerWidth } from "@pi-unipi/core";

/** Pad content to exact visible width. */
function padVisible(content: string, targetWidth: number): string {
  const vw = visibleWidth(content);
  const pad = Math.max(0, targetWidth - vw);
  return content + " ".repeat(pad);
}

/** Configuration for a list+detail overlay. */
export interface ListDetailConfig<T> {
  /** Header title (e.g. " 📋 Changelog ") */
  title: string;
  /** Message when list is empty */
  emptyMessage: string;
  /** Footer text in list view */
  listFooter: string;
  /** Footer text in detail view */
  detailFooter: string;
  /** Load list entries lazily on first render */
  loadEntries: () => T[];
  /** Render a single list item line (without the │ borders) */
  renderItem: (entry: T, selected: boolean, theme: Theme) => string;
  /** Render the detail title line for an entry */
  renderDetailTitle: (entry: T, theme: Theme) => string;
  /** Render the detail body lines for an entry */
  renderDetailBody: (entry: T, innerWidth: number, theme: Theme) => string[];
  /** Optional: if set, Enter in list view calls this instead of default detail switch.
   *  Return true to switch to detail view, false to stay. */
  onEnter?: (entry: T, tui: import("@earendil-works/pi-tui").TUI, theme: Theme) => boolean;
  /** Optional: if set, Esc from detail view closes the overlay instead of returning to list */
  closeOnDetailBack?: boolean;
  /** Optional: open directly to a specific entry's detail view */
  openDirectIndex?: number;
}

type View = "list" | "detail";

/**
 * Create a list+detail overlay component.
 * Returns the ctx.ui.custom() callback.
 */
export function createListDetailOverlay<T>(
  config: ListDetailConfig<T>,
): (
  tui: import("@earendil-works/pi-tui").TUI,
  theme: Theme,
  _kb: import("@earendil-works/pi-coding-agent").KeybindingsManager,
  done: (result: { viewed: boolean } | null) => void,
) => { render: (width: number) => string[]; handleInput: (data: string) => void; invalidate: () => void; focused: boolean } {
  return (tui, theme, _kb, done) => {
    const state: {
      view: View;
      entries: T[];
      listIndex: number;
      listScroll: number;
      detailScroll: number;
    } = {
      view: "list",
      entries: [],
      listIndex: 0,
      listScroll: 0,
      detailScroll: 0,
    };

    let loaded = false;
    const ensureLoaded = () => {
      if (loaded) return;
      state.entries = config.loadEntries();
      if (config.openDirectIndex !== undefined && config.openDirectIndex >= 0 && config.openDirectIndex < state.entries.length) {
        state.listIndex = config.openDirectIndex;
        state.view = "detail";
        state.detailScroll = 0;
      }
      loaded = true;
    };

    const render = (width: number): string[] => {
      ensureLoaded();

      const innerWidth = boxInnerWidth(width);
      const lines: string[] = [];

      // ── Header ──────────────────────────────────────────────────────
      lines.push(theme.fg("accent", `╭${"─".repeat(innerWidth)}╮`));
      lines.push(
        theme.fg("accent", "│") +
        padVisible(theme.fg("accent", theme.bold(config.title)), innerWidth) +
        theme.fg("accent", "│"),
      );
      lines.push(theme.fg("accent", `├${"─".repeat(innerWidth)}┤`));

      // ── Content ─────────────────────────────────────────────────────
      if (state.view === "list") {
        renderListView(lines, innerWidth);
      } else {
        renderDetailView(lines, innerWidth);
      }

      // ── Footer ──────────────────────────────────────────────────────
      lines.push(theme.fg("accent", `├${"─".repeat(innerWidth)}┤`));
      const footer = state.view === "list" ? config.listFooter : config.detailFooter;
      lines.push(
        theme.fg("accent", "│") +
        padVisible(truncateToWidth(footer, innerWidth), innerWidth) +
        theme.fg("accent", "│"),
      );
      lines.push(theme.fg("accent", `╰${"─".repeat(innerWidth)}╯`));

      return lines;
    };

    const renderListView = (lines: string[], innerWidth: number) => {
      if (state.entries.length === 0) {
        lines.push(
          theme.fg("accent", "│") +
          padVisible(theme.fg("muted", `  ${config.emptyMessage}`), innerWidth) +
          theme.fg("accent", "│"),
        );
        return;
      }

      state.listIndex = Math.min(state.listIndex, state.entries.length - 1);
      state.listIndex = Math.max(0, state.listIndex);

      const maxLines = 20;
      if (state.listIndex < state.listScroll) state.listScroll = state.listIndex;
      if (state.listIndex >= state.listScroll + maxLines) {
        state.listScroll = state.listIndex - maxLines + 1;
      }

      const visible = state.entries.slice(state.listScroll, state.listScroll + maxLines);

      for (let i = 0; i < visible.length; i++) {
        const entry = visible[i]!;
        const globalIdx = state.listScroll + i;
        const selected = globalIdx === state.listIndex;
        const line = config.renderItem(entry, selected, theme);
        lines.push(
          theme.fg("accent", "│") +
          padVisible(
            selected ? theme.bg("selectedBg", truncateToWidth(line, innerWidth)) : truncateToWidth(line, innerWidth),
            innerWidth,
          ) +
          theme.fg("accent", "│"),
        );
      }
    };

    const renderDetailView = (lines: string[], innerWidth: number) => {
      const entry = state.entries[state.listIndex];
      if (!entry) {
        lines.push(
          theme.fg("accent", "│") +
          padVisible(theme.fg("muted", "  No entry selected."), innerWidth) +
          theme.fg("accent", "│"),
        );
        return;
      }

      const title = config.renderDetailTitle(entry, theme);
      lines.push(
        theme.fg("accent", "│") +
        padVisible(truncateToWidth(`  ${title}`, innerWidth), innerWidth) +
        theme.fg("accent", "│"),
      );
      lines.push(
        theme.fg("accent", "│") +
        padVisible("", innerWidth) +
        theme.fg("accent", "│"),
      );

      const bodyLines = config.renderDetailBody(entry, innerWidth, theme);
      const maxScroll = Math.max(0, bodyLines.length - 15);
      state.detailScroll = Math.min(state.detailScroll, maxScroll);
      state.detailScroll = Math.max(0, state.detailScroll);

      const visible = bodyLines.slice(state.detailScroll, state.detailScroll + 15);
      for (const line of visible) {
        lines.push(
          theme.fg("accent", "│") +
          padVisible(truncateToWidth(`  ${line}`, innerWidth), innerWidth) +
          theme.fg("accent", "│"),
        );
      }
    };

    const handleInput = (data: string) => {
      ensureLoaded();

      // Close from list view
      if ((matchesKey(data, Key.escape) || data === "q") && state.view === "list") {
        done({ viewed: true });
        return;
      }

      // Back from detail view
      if ((matchesKey(data, Key.escape) || data === "q") && state.view === "detail") {
        if (config.closeOnDetailBack) {
          done({ viewed: true });
          return;
        }
        state.view = "list";
        state.detailScroll = 0;
        tui.requestRender();
        return;
      }

      // Navigation
      if (state.view === "list") {
        if (matchesKey(data, Key.down) || data === "j") {
          state.listIndex = Math.min(state.listIndex + 1, state.entries.length - 1);
        } else if (matchesKey(data, Key.up) || data === "k") {
          state.listIndex = Math.max(state.listIndex - 1, 0);
        } else if (matchesKey(data, Key.enter)) {
          if (state.entries.length > 0) {
            if (config.onEnter) {
              const entry = state.entries[state.listIndex]!;
              const shouldSwitch = config.onEnter(entry, tui, theme);
              if (shouldSwitch) {
                state.view = "detail";
                state.detailScroll = 0;
              }
            } else {
              state.view = "detail";
              state.detailScroll = 0;
            }
          }
        } else if (data === "g") {
          state.listIndex = 0;
        } else if (data === "G") {
          state.listIndex = state.entries.length - 1;
        }
      } else {
        if (matchesKey(data, Key.down) || data === "j") {
          state.detailScroll++;
        } else if (matchesKey(data, Key.up) || data === "k") {
          state.detailScroll = Math.max(0, state.detailScroll - 1);
        } else if (data === "g") {
          state.detailScroll = 0;
        } else if (data === "G") {
          state.detailScroll = 999999;
        }
      }

      tui.requestRender();
    };

    return { render, handleInput, invalidate: () => {}, focused: true };
  };
}
