/**
 * @pi-unipi/updater — Readme TUI Overlay
 *
 * Package list with versions, Enter opens content view.
 * No-arg /unipi:readme opens directly to root README content.
 * With arg, opens directly to that package's content.
 */

import { readFileSync } from "fs";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { discoverReadmes, resolveReadmePath } from "../readme.js";
import { renderMarkdown } from "../markdown.js";
import type { ReadmeEntry } from "../../types.js";

type View = "list" | "content";

interface ReadmeState {
  view: View;
  entries: ReadmeEntry[];
  listIndex: number;
  listScroll: number;
  contentScroll: number;
  contentLines: string[];
}

/**
 * Pad content to exact visible width.
 */
function padVisible(content: string, targetWidth: number): string {
  const vw = visibleWidth(content);
  const pad = Math.max(0, targetWidth - vw);
  return content + " ".repeat(pad);
}

/**
 * Render the readme overlay.
 */
export function renderReadmeOverlay(params?: { openDirect?: string }) {
  return (
    tui: any,
    theme: Theme,
    _kb: any,
    done: (result: { viewed: boolean } | null) => void,
  ) => {
    const state: ReadmeState = {
      view: "list",
      entries: [],
      listIndex: 0,
      listScroll: 0,
      contentScroll: 0,
      contentLines: [],
    };

    let loaded = false;
    const ensureLoaded = () => {
      if (loaded) return;
      state.entries = discoverReadmes();

      if (params?.openDirect) {
        const readmePath = resolveReadmePath(params.openDirect);
        if (readmePath) {
          const content = readFileSync(readmePath, "utf-8");
          state.contentLines = renderMarkdown(content, (tui.width ?? 80) - 4, theme);
          state.view = "content";
        }
      }
      loaded = true;
    };

    const render = (width: number): string[] => {
      ensureLoaded();

      const innerWidth = Math.max(22, width - 2);
      const lines: string[] = [];

      // ── Header ──────────────────────────────────────────────────────
      lines.push(theme.fg("accent", `╭${"─".repeat(innerWidth)}╮`));
      lines.push(
        theme.fg("accent", "│") +
        padVisible(theme.fg("accent", theme.bold(" 📖 README Browser ")), innerWidth) +
        theme.fg("accent", "│"),
      );
      lines.push(theme.fg("accent", `├${"─".repeat(innerWidth)}┤`));

      // ── Content ─────────────────────────────────────────────────────
      if (state.view === "list") {
        renderListView(lines, innerWidth);
      } else {
        renderContentView(lines, innerWidth);
      }

      // ── Footer ──────────────────────────────────────────────────────
      lines.push(theme.fg("accent", `├${"─".repeat(innerWidth)}┤`));
      const footer =
        state.view === "list"
          ? ` ${theme.fg("accent", "j/k")} navigate  ${theme.fg("success", "Enter")} read  ${theme.fg("error", "q/Esc")} close`
          : ` ${theme.fg("accent", "j/k")} scroll  ${theme.fg("error", "q/Esc")} back to list`;
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
          padVisible(theme.fg("muted", "  No README files found."), innerWidth) +
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
        const prefix = selected ? theme.fg("accent", "▸ ") : "  ";

        const name = selected ? theme.bold(entry.name) : theme.fg("text", entry.name);
        const version = theme.fg("muted", `v${entry.version}`);
        const line = ` ${prefix}${name}  ${version}`;
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

    const renderContentView = (lines: string[], innerWidth: number) => {
      if (state.contentLines.length === 0) {
        lines.push(
          theme.fg("accent", "│") +
          padVisible(theme.fg("muted", "  No content available."), innerWidth) +
          theme.fg("accent", "│"),
        );
        return;
      }

      const maxLines = 20;
      const maxScroll = Math.max(0, state.contentLines.length - maxLines);
      state.contentScroll = Math.min(state.contentScroll, maxScroll);
      state.contentScroll = Math.max(0, state.contentScroll);

      const visible = state.contentLines.slice(state.contentScroll, state.contentScroll + maxLines);
      for (const line of visible) {
        lines.push(
          theme.fg("accent", "│") +
          padVisible(truncateToWidth(` ${line}`, innerWidth), innerWidth) +
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

      // Back from content view
      if ((matchesKey(data, Key.escape) || data === "q") && state.view === "content") {
        if (params?.openDirect) {
          done({ viewed: true });
          return;
        }
        state.view = "list";
        state.contentScroll = 0;
        tui.requestRender();
        return;
      }

      if (state.view === "list") {
        if (matchesKey(data, Key.down) || data === "j") {
          state.listIndex = Math.min(state.listIndex + 1, state.entries.length - 1);
        } else if (matchesKey(data, Key.up) || data === "k") {
          state.listIndex = Math.max(state.listIndex - 1, 0);
        } else if (matchesKey(data, Key.enter)) {
          if (state.entries.length > 0) {
            const entry = state.entries[state.listIndex]!;
            try {
              const content = readFileSync(entry.path, "utf-8");
              state.contentLines = renderMarkdown(content, (tui.width ?? 80) - 4, theme);
              state.contentScroll = 0;
              state.view = "content";
            } catch {
              state.contentLines = ["  Error reading README file."];
              state.view = "content";
            }
          }
        } else if (data === "g") {
          state.listIndex = 0;
        } else if (data === "G") {
          state.listIndex = state.entries.length - 1;
        }
      } else {
        if (matchesKey(data, Key.down) || data === "j") {
          state.contentScroll++;
        } else if (matchesKey(data, Key.up) || data === "k") {
          state.contentScroll = Math.max(0, state.contentScroll - 1);
        } else if (data === "g") {
          state.contentScroll = 0;
        } else if (data === "G") {
          state.contentScroll = 999999;
        }
      }

      tui.requestRender();
    };

    return { render, handleInput, invalidate: () => {}, focused: true };
  };
}
