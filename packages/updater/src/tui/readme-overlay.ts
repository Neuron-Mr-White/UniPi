/**
 * @pi-unipi/updater — Readme TUI Overlay
 *
 * Package list with versions, Enter opens content view.
 * No-arg /unipi:readme opens directly to root README content.
 * With arg, opens directly to that package's content.
 */

import { readFileSync } from "fs";
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
  pendingG: boolean;
}

/** ANSI codes */
const ESC = "\x1b";
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;

/** Truncate string to visible width */
function trunc(text: string, width: number): string {
  let vw = 0;
  let result = "";
  let inEsc = false;
  for (const ch of text) {
    if (ch === "\x1b") { inEsc = true; result += ch; continue; }
    if (inEsc) { result += ch; if (ch === "m") inEsc = false; continue; }
    if (vw >= width) break;
    result += ch;
    vw++;
  }
  return result;
}

/** Pad string to visible width */
function padVisible(content: string, targetWidth: number): string {
  const vw = content.replace(/\x1b\[[0-9;]*m/g, "").length;
  const pad = Math.max(0, targetWidth - vw);
  return content + " ".repeat(pad);
}

/**
 * Render the readme overlay.
 */
export function renderReadmeOverlay(params?: { openDirect?: string }) {
  return (
    tui: any,
    _theme: any,
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
      pendingG: false,
    };

    let loaded = false;
    const ensureLoaded = () => {
      if (loaded) return;
      state.entries = discoverReadmes();

      if (params?.openDirect) {
        const readmePath = resolveReadmePath(params.openDirect);
        if (readmePath) {
          const content = readFileSync(readmePath, "utf-8");
          state.contentLines = renderMarkdown(content, (tui.width ?? 80) - 2);
          state.view = "content";
        }
      }
      loaded = true;
    };

    const render = (width: number): string[] => {
      ensureLoaded();

      const lines: string[] = [];
      lines.push(trunc(` 📖 README Browser `, width));
      lines.push("─".repeat(width));

      if (state.view === "list") {
        renderListView(lines, width);
      } else {
        renderContentView(lines, width);
      }

      lines.push("─".repeat(width));
      const footer =
        state.view === "list"
          ? " j/k: navigate  Enter: read  q/Esc: close "
          : " j/k: scroll  q/Esc: back to list ";
      lines.push(trunc(footer, width));

      return lines;
    };

    const renderListView = (lines: string[], width: number) => {
      if (state.entries.length === 0) {
        lines.push(trunc("  No README files found.", width));
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
        const entry = visible[i];
        const globalIdx = state.listScroll + i;
        const selected = globalIdx === state.listIndex;
        const prefix = selected ? " ▸ " : "   ";

        const name = `${BOLD}${entry.name}${RESET}`;
        const version = `${DIM}v${entry.version}${RESET}`;
        const line = `${prefix}${name}  ${version}`;
        lines.push(
          trunc(
            selected ? `${ESC}[7m${padVisible(line, width)}${ESC}[0m` : line,
            width,
          ),
        );
      }
    };

    const renderContentView = (lines: string[], width: number) => {
      if (state.contentLines.length === 0) {
        lines.push(trunc("  No content available.", width));
        return;
      }

      const maxLines = 20;
      const maxScroll = Math.max(0, state.contentLines.length - maxLines);
      state.contentScroll = Math.min(state.contentScroll, maxScroll);
      state.contentScroll = Math.max(0, state.contentScroll);

      const visible = state.contentLines.slice(state.contentScroll, state.contentScroll + maxLines);
      for (const line of visible) {
        lines.push(trunc(` ${line}`, width));
      }
    };

    const handleInput = (data: string) => {
      ensureLoaded();
      const key = data.toLowerCase();

      if ((key === "q" || key === "\x1b") && state.view === "list") {
        done({ viewed: true });
        return;
      }

      if ((key === "q" || key === "\x1b") && state.view === "content") {
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
        if (key === "j" || key === "\x1b[B") {
          state.listIndex = Math.min(state.listIndex + 1, state.entries.length - 1);
        } else if (key === "k" || key === "\x1b[A") {
          state.listIndex = Math.max(state.listIndex - 1, 0);
        } else if (key === "\r" || key === "\n") {
          if (state.entries.length > 0) {
            const entry = state.entries[state.listIndex];
            try {
              const content = readFileSync(entry.path, "utf-8");
              state.contentLines = renderMarkdown(content, (tui.width ?? 80) - 2);
              state.contentScroll = 0;
              state.view = "content";
            } catch {
              state.contentLines = ["  Error reading README file."];
              state.view = "content";
            }
          }
        } else if (key === "g") {
          if (state.pendingG) {
            state.listIndex = 0;
            state.pendingG = false;
          } else {
            state.pendingG = true;
            setTimeout(() => { state.pendingG = false; }, 500);
          }
        } else if (key === "G") {
          state.listIndex = state.entries.length - 1;
        }
      } else {
        if (key === "j" || key === "\x1b[B") {
          state.contentScroll++;
        } else if (key === "k" || key === "\x1b[A") {
          state.contentScroll = Math.max(0, state.contentScroll - 1);
        } else if (key === "g") {
          if (state.pendingG) {
            state.contentScroll = 0;
            state.pendingG = false;
          } else {
            state.pendingG = true;
            setTimeout(() => { state.pendingG = false; }, 500);
          }
        } else if (key === "G") {
          state.contentScroll = 999999;
        }
      }

      tui.requestRender();
    };

    return { render, handleInput, invalidate: () => {}, focused: true };
  };
}
