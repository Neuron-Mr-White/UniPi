/**
 * @pi-unipi/updater — Update Available TUI Overlay
 *
 * Shows when an update is found on session start.
 * Displays version diff, inline changelog for newer versions,
 * [Y] Update / [n] Skip prompt. Auto mode: countdown with cancel.
 */

import { join } from "path";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { parseChangelog, getNewerVersions } from "../changelog.js";
import { installUpdate } from "../installer.js";
import { writeSkippedVersion } from "../cache.js";
import { loadConfig } from "../settings.js";
import type { ChangelogEntry, UpdateCheckResult } from "../../types.js";

/**
 * Pad content to exact visible width.
 */
function padVisible(content: string, targetWidth: number): string {
  const vw = visibleWidth(content);
  const pad = Math.max(0, targetWidth - vw);
  return content + " ".repeat(pad);
}

interface UpdateState {
  result: UpdateCheckResult;
  contentLines: string[];
  scroll: number;
  installing: boolean;
  installError: string | null;
  autoCountdown: number;
  autoCancelled: boolean;
  autoTimer: ReturnType<typeof setInterval> | null;
}

/**
 * Render the update available overlay.
 */
export function renderUpdateOverlay(checkResult: UpdateCheckResult) {
  return (
    tui: any,
    theme: Theme,
    _kb: any,
    done: (result: { updated: boolean } | null) => void,
  ) => {
    const config = loadConfig();

    // Load changelog for newer versions
    let newerVersions: ChangelogEntry[] = [];
    const changelogPath = join(process.cwd(), "CHANGELOG.md");
    try {
      const entries = parseChangelog(changelogPath);
      newerVersions = getNewerVersions(entries, checkResult.currentVersion);
    } catch (_err) {
      // No changelog
    }

    // Build content lines from changelog
    const contentLines: string[] = [];
    for (const entry of newerVersions) {
      const title = entry.date
        ? `${theme.bold(entry.version)} — ${theme.fg("muted", entry.date)}`
        : `${theme.bold(entry.version)} — ${theme.fg("muted", "Unreleased")}`;
      contentLines.push(`  ${title}`);
      for (const [section, items] of Object.entries(entry.sections)) {
        contentLines.push(`  ${theme.fg("muted", section)}`);
        for (const item of items) {
          const formatted = item.replace(/`([^`]+)`/g, (_, code) => theme.fg("muted", code));
          contentLines.push(`    • ${formatted}`);
        }
      }
      contentLines.push("");
    }
    if (contentLines.length === 0) {
      contentLines.push(`  ${theme.fg("muted", "No changelog available for this update.")}`);
    }

    const state: UpdateState = {
      result: checkResult,
      contentLines,
      scroll: 0,
      installing: false,
      installError: null,
      autoCountdown: 5,
      autoCancelled: false,
      autoTimer: null,
    };

    // Auto mode countdown
    if (config.autoUpdate === "auto") {
      state.autoTimer = setInterval(() => {
        if (state.autoCancelled || state.installing) {
          if (state.autoTimer) clearInterval(state.autoTimer);
          return;
        }
        state.autoCountdown--;
        if (state.autoCountdown <= 0) {
          if (state.autoTimer) clearInterval(state.autoTimer);
          doInstall();
        }
        tui.requestRender();
      }, 1000);
    }

    const doInstall = async () => {
      if (state.installing) return;
      state.installing = true;
      tui.requestRender();

      const result = await installUpdate();
      if (result.success) {
        done({ updated: true });
      } else {
        state.installing = false;
        state.installError = result.error ?? "Installation failed";
        tui.requestRender();
      }
    };

    const render = (width: number): string[] => {
      const innerWidth = Math.max(22, width - 2);
      const lines: string[] = [];

      // ── Header ──────────────────────────────────────────────────────
      lines.push(theme.fg("accent", `╭${"─".repeat(innerWidth)}╮`));
      lines.push(
        theme.fg("accent", "│") +
        padVisible(theme.fg("accent", theme.bold(" 📦 Update Available ")), innerWidth) +
        theme.fg("accent", "│"),
      );
      lines.push(theme.fg("accent", `├${"─".repeat(innerWidth)}┤`));

      // ── Version info ────────────────────────────────────────────────
      const current = theme.fg("muted", state.result.currentVersion);
      const latest = theme.fg("success", theme.bold(state.result.latestVersion));
      lines.push(
        theme.fg("accent", "│") +
        padVisible(truncateToWidth(`  ${current} → ${latest}`, innerWidth), innerWidth) +
        theme.fg("accent", "│"),
      );
      lines.push(
        theme.fg("accent", "│") +
        padVisible("", innerWidth) +
        theme.fg("accent", "│"),
      );

      // ── Changelog content (scrollable) ──────────────────────────────
      const contentHeight = 12;
      const maxScroll = Math.max(0, state.contentLines.length - contentHeight);
      state.scroll = Math.min(state.scroll, maxScroll);
      state.scroll = Math.max(0, state.scroll);

      const visible = state.contentLines.slice(state.scroll, state.scroll + contentHeight);
      for (let i = 0; i < contentHeight; i++) {
        const line = visible[i] ?? "";
        lines.push(
          theme.fg("accent", "│") +
          padVisible(truncateToWidth(line, innerWidth), innerWidth) +
          theme.fg("accent", "│"),
        );
      }

      // ── Action bar ──────────────────────────────────────────────────
      lines.push(theme.fg("accent", `├${"─".repeat(innerWidth)}┤`));

      if (state.installing) {
        lines.push(
          theme.fg("accent", "│") +
          padVisible(theme.fg("warning", "  Installing update..."), innerWidth) +
          theme.fg("accent", "│"),
        );
      } else if (state.installError) {
        lines.push(
          theme.fg("accent", "│") +
          padVisible(theme.fg("error", `  Error: ${state.installError}`), innerWidth) +
          theme.fg("accent", "│"),
        );
        lines.push(
          theme.fg("accent", "│") +
          padVisible(theme.fg("muted", "  Press any key to dismiss"), innerWidth) +
          theme.fg("accent", "│"),
        );
      } else if (config.autoUpdate === "auto" && !state.autoCancelled) {
        const actionLine = `  ${theme.fg("success", "[Y]")} Update now   ${theme.fg("muted", "[n]")} Cancel   Auto-updating in ${theme.fg("warning", String(state.autoCountdown))}...`;
        lines.push(
          theme.fg("accent", "│") +
          padVisible(truncateToWidth(actionLine, innerWidth), innerWidth) +
          theme.fg("accent", "│"),
        );
      } else {
        const actionLine = `  ${theme.fg("success", "[Y]")} Update now   ${theme.fg("muted", "[n]")} Skip   ${theme.fg("accent", "j/k")}: scroll`;
        lines.push(
          theme.fg("accent", "│") +
          padVisible(truncateToWidth(actionLine, innerWidth), innerWidth) +
          theme.fg("accent", "│"),
        );
      }

      lines.push(theme.fg("accent", `╰${"─".repeat(innerWidth)}╯`));

      return lines;
    };

    const handleInput = (data: string) => {
      // Dismiss install error
      if (state.installError) {
        done({ updated: false });
        return;
      }

      if (state.installing) return;

      // Cancel auto countdown
      if (config.autoUpdate === "auto" && !state.autoCancelled) {
        if (data === "n") {
          state.autoCancelled = true;
          if (state.autoTimer) clearInterval(state.autoTimer);
          writeSkippedVersion(state.result.latestVersion);
          done({ updated: false });
          return;
        }
      }

      // Y — install
      if (data === "y" || data === "Y") {
        doInstall();
        return;
      }

      // n — skip
      if (data === "n") {
        writeSkippedVersion(state.result.latestVersion);
        done({ updated: false });
        return;
      }

      // q/Esc — skip
      if (matchesKey(data, Key.escape) || data === "q") {
        writeSkippedVersion(state.result.latestVersion);
        done({ updated: false });
        return;
      }

      // Scroll
      if (matchesKey(data, Key.down) || data === "j") {
        state.scroll++;
      } else if (matchesKey(data, Key.up) || data === "k") {
        state.scroll = Math.max(0, state.scroll - 1);
      } else if (data === "g") {
        state.scroll = 0;
      } else if (data === "G") {
        state.scroll = 999999;
      }

      tui.requestRender();
    };

    return { render, handleInput, invalidate: () => {}, focused: true };
  };
}
