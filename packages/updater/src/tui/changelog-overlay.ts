/**
 * @pi-unipi/updater — Changelog TUI Overlay
 *
 * Version list with Current/New labels, Enter opens detail view, Esc/q back.
 * Uses ctx.ui.custom() overlay API with component return pattern.
 */

import { existsSync } from "fs";
import { join } from "path";
import { parseChangelog } from "../changelog.js";
import { getPackageVersion } from "@pi-unipi/core";
import type { ChangelogEntry } from "../../types.js";

type View = "list" | "detail";

interface ChangelogState {
  view: View;
  entries: ChangelogEntry[];
  listIndex: number;
  listScroll: number;
  detailScroll: number;
  installedVersion: string;
  pendingG: boolean;
}

/** ANSI codes */
const ESC = "\x1b";
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const TEAL = `${ESC}[36m`;
const AMBER = `${ESC}[33m`;
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
 * Render the changelog overlay.
 */
export function renderChangelogOverlay() {
  return (
    tui: any,
    _theme: any,
    _kb: any,
    done: (result: { viewed: boolean } | null) => void,
  ) => {
    const installedVersion = getPackageVersion(
      new URL("../../..", import.meta.url).pathname,
    );

    const state: ChangelogState = {
      view: "list",
      entries: [],
      listIndex: 0,
      listScroll: 0,
      detailScroll: 0,
      installedVersion,
      pendingG: false,
    };

    // Load changelog
    let loaded = false;
    const ensureLoaded = () => {
      if (loaded) return;
      const changelogPath = join(process.cwd(), "CHANGELOG.md");
      if (existsSync(changelogPath)) {
        state.entries = parseChangelog(changelogPath);
      }
      loaded = true;
    };

    const render = (width: number): string[] => {
      ensureLoaded();

      const lines: string[] = [];

      // Header
      lines.push(trunc(` 📋 Changelog `, width));
      lines.push("─".repeat(width));

      if (state.view === "list") {
        renderListView(lines, width);
      } else {
        renderDetailView(lines, width);
      }

      // Footer
      lines.push("─".repeat(width));
      const footer =
        state.view === "list"
          ? " j/k: navigate  Enter: view details  q/Esc: close "
          : " j/k: scroll  q/Esc: back to list ";
      lines.push(trunc(footer, width));

      return lines;
    };

    const renderListView = (lines: string[], width: number) => {
      if (state.entries.length === 0) {
        lines.push(trunc("  No changelog available.", width));
        return;
      }

      state.listIndex = Math.min(state.listIndex, state.entries.length - 1);
      state.listIndex = Math.max(0, state.listIndex);

      // Show visible entries (assume max ~20 lines for content)
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

        let label: string;
        if (entry.version === "Unreleased") {
          label = `${DIM}Unreleased${RESET}`;
        } else if (entry.version === state.installedVersion) {
          label = `${TEAL}✓ Current${RESET}`;
        } else {
          const pa = entry.version.split(".").map(Number);
          const pb = state.installedVersion.split(".").map(Number);
          const isNewer =
            pa[0] > pb[0] ||
            (pa[0] === pb[0] && pa[1] > pb[1]) ||
            (pa[0] === pb[0] && pa[1] === pb[1] && pa[2] > pb[2]);
          label = isNewer ? `${AMBER}↑ New${RESET}` : "";
        }

        const version = `${BOLD}${entry.version}${RESET}`;
        const date = entry.date ? ` — ${entry.date}` : "";
        const line = `${prefix}${version}${date}  ${label}`;
        lines.push(
          trunc(
            selected ? `${ESC}[7m${padVisible(line, width)}${ESC}[0m` : line,
            width,
          ),
        );
      }
    };

    const renderDetailView = (lines: string[], width: number) => {
      const entry = state.entries[state.listIndex];
      if (!entry) {
        lines.push(trunc("  No entry selected.", width));
        return;
      }

      const title = entry.date
        ? `${BOLD}${entry.version}${RESET} — ${entry.date}`
        : `${BOLD}${entry.version}${RESET} — Unreleased`;
      lines.push(trunc(`  ${title}`, width));
      lines.push("");

      const bodyLines = entry.body.split("\n");
      const maxScroll = Math.max(0, bodyLines.length - 15);
      state.detailScroll = Math.min(state.detailScroll, maxScroll);
      state.detailScroll = Math.max(0, state.detailScroll);

      const visible = bodyLines.slice(state.detailScroll, state.detailScroll + 15);
      for (const line of visible) {
        const trimmed = line.trim();
        if (trimmed.startsWith("### ")) {
          lines.push(trunc(`  ${BOLD}${trimmed.slice(4)}${RESET}`, width));
        } else if (trimmed.startsWith("- ")) {
          const content = trimmed.slice(2).replace(/`([^`]+)`/g, (_, code) => `${DIM}${code}${RESET}`);
          lines.push(trunc(`    • ${content}`, width));
        } else if (!trimmed) {
          lines.push("");
        } else {
          lines.push(trunc(`  ${trimmed}`, width));
        }
      }
    };

    const handleInput = (data: string) => {
      ensureLoaded();

      // Parse key from data string
      const key = data.toLowerCase();

      // Close from list view
      if ((key === "q" || key === "\x1b") && state.view === "list") {
        done({ viewed: true });
        return;
      }

      // Back from detail view
      if ((key === "q" || key === "\x1b") && state.view === "detail") {
        state.view = "list";
        state.detailScroll = 0;
        tui.requestRender();
        return;
      }

      // Navigation
      if (state.view === "list") {
        if (key === "j" || key === "\x1b[B") {
          state.listIndex = Math.min(state.listIndex + 1, state.entries.length - 1);
        } else if (key === "k" || key === "\x1b[A") {
          state.listIndex = Math.max(state.listIndex - 1, 0);
        } else if (key === "\r" || key === "\n") {
          if (state.entries.length > 0) {
            state.view = "detail";
            state.detailScroll = 0;
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
          state.detailScroll++;
        } else if (key === "k" || key === "\x1b[A") {
          state.detailScroll = Math.max(0, state.detailScroll - 1);
        } else if (key === "g") {
          if (state.pendingG) {
            state.detailScroll = 0;
            state.pendingG = false;
          } else {
            state.pendingG = true;
            setTimeout(() => { state.pendingG = false; }, 500);
          }
        } else if (key === "G") {
          state.detailScroll = 999999;
        }
      }

      tui.requestRender();
    };

    return { render, handleInput, invalidate: () => {}, focused: true };
  };
}
