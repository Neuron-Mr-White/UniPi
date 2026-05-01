/**
 * @pi-unipi/updater — Changelog TUI Overlay
 *
 * Version list with Current/New labels, Enter opens detail view, Esc/q back.
 * Uses ctx.ui.custom() overlay API with component return pattern.
 */

import { existsSync } from "fs";
import { join } from "path";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
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
 * Render the changelog overlay.
 */
export function renderChangelogOverlay() {
  return (
    tui: any,
    theme: Theme,
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

      const innerWidth = Math.max(22, width - 2);
      const lines: string[] = [];

      // ── Header ──────────────────────────────────────────────────────
      lines.push(theme.fg("accent", `╭${"─".repeat(innerWidth)}╮`));
      lines.push(
        theme.fg("accent", "│") +
        padVisible(theme.fg("accent", theme.bold(" 📋 Changelog ")), innerWidth) +
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
      const footer =
        state.view === "list"
          ? ` ${theme.fg("accent", "j/k")} navigate  ${theme.fg("success", "Enter")} view details  ${theme.fg("error", "q/Esc")} close`
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
          padVisible(theme.fg("muted", "  No changelog available."), innerWidth) +
          theme.fg("accent", "│"),
        );
        return;
      }

      state.listIndex = Math.min(state.listIndex, state.entries.length - 1);
      state.listIndex = Math.max(0, state.listIndex);

      // Show visible entries
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

        let label: string;
        if (entry.version === "Unreleased") {
          label = theme.fg("muted", "Unreleased");
        } else if (entry.version === state.installedVersion) {
          label = theme.fg("success", "✓ Current");
        } else {
          const pa = entry.version.split(".").map(Number);
          const pb = state.installedVersion.split(".").map(Number);
          const isNewer =
            pa[0]! > pb[0]! ||
            (pa[0] === pb[0] && pa[1]! > pb[1]!) ||
            (pa[0] === pb[0] && pa[1] === pb[1] && pa[2]! > pb[2]!);
          label = isNewer ? theme.fg("warning", "↑ New") : "";
        }

        const version = selected ? theme.bold(entry.version) : theme.fg("text", entry.version);
        const date = entry.date ? ` — ${theme.fg("muted", entry.date)}` : "";
        const line = ` ${prefix}${version}${date}  ${label}`;
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

      const title = entry.date
        ? `${theme.bold(entry.version)} — ${theme.fg("muted", entry.date)}`
        : `${theme.bold(entry.version)} — ${theme.fg("muted", "Unreleased")}`;
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

      const bodyLines = entry.body.split("\n");
      const maxScroll = Math.max(0, bodyLines.length - 15);
      state.detailScroll = Math.min(state.detailScroll, maxScroll);
      state.detailScroll = Math.max(0, state.detailScroll);

      const visible = bodyLines.slice(state.detailScroll, state.detailScroll + 15);
      for (const line of visible) {
        const trimmed = line.trim();
        let styled: string;
        if (trimmed.startsWith("### ")) {
          styled = `  ${theme.bold(trimmed.slice(4))}`;
        } else if (trimmed.startsWith("- ")) {
          const content = trimmed.slice(2).replace(/`([^`]+)`/g, (_, code) => theme.fg("muted", code));
          styled = `    • ${content}`;
        } else if (!trimmed) {
          styled = "";
        } else {
          styled = `  ${trimmed}`;
        }
        lines.push(
          theme.fg("accent", "│") +
          padVisible(truncateToWidth(styled, innerWidth), innerWidth) +
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
            state.view = "detail";
            state.detailScroll = 0;
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
