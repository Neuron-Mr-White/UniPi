/**
 * @pi-unipi/updater — Update Available TUI Overlay
 *
 * Shows when an update is found on session start.
 * Displays version diff, inline changelog for newer versions,
 * [Y] Update / [n] Skip prompt. Auto mode: countdown with cancel.
 */

import { join } from "path";
import { parseChangelog, getNewerVersions } from "../changelog.js";
import { installUpdate } from "../installer.js";
import { writeSkippedVersion } from "../cache.js";
import { loadConfig } from "../settings.js";
import type { ChangelogEntry, UpdateCheckResult } from "../../types.js";

/** ANSI codes */
const ESC = "\x1b";
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const TEAL = `${ESC}[36m`;
const AMBER = `${ESC}[33m`;
const GREEN = `${ESC}[32m`;
const RED = `${ESC}[31m`;
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

interface UpdateState {
  result: UpdateCheckResult;
  contentLines: string[];
  scroll: number;
  installing: boolean;
  installError: string | null;
  autoCountdown: number;
  autoCancelled: boolean;
  autoTimer: ReturnType<typeof setInterval> | null;
  pendingG: boolean;
}

/**
 * Render the update available overlay.
 */
export function renderUpdateOverlay(checkResult: UpdateCheckResult) {
  return (
    tui: any,
    _theme: any,
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
        ? `${BOLD}${entry.version}${RESET} — ${entry.date}`
        : `${BOLD}${entry.version}${RESET} — Unreleased`;
      contentLines.push(`  ${title}`);
      for (const [section, items] of Object.entries(entry.sections)) {
        contentLines.push(`  ${DIM}${section}${RESET}`);
        for (const item of items) {
          const formatted = item.replace(/`([^`]+)`/g, (_, code) => `${DIM}${code}${RESET}`);
          contentLines.push(`    • ${formatted}`);
        }
      }
      contentLines.push("");
    }
    if (contentLines.length === 0) {
      contentLines.push(`  ${DIM}No changelog available for this update.${RESET}`);
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
      pendingG: false,
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
      const lines: string[] = [];

      lines.push(trunc(` 📦 Update Available `, width));
      lines.push("─".repeat(width));

      const current = `${DIM}${state.result.currentVersion}${RESET}`;
      const latest = `${GREEN}${BOLD}${state.result.latestVersion}${RESET}`;
      lines.push(trunc(`  ${current} → ${latest}`, width));
      lines.push("");

      // Changelog content (scrollable)
      const maxScroll = Math.max(0, state.contentLines.length - 12);
      state.scroll = Math.min(state.scroll, maxScroll);
      state.scroll = Math.max(0, state.scroll);

      const visible = state.contentLines.slice(state.scroll, state.scroll + 12);
      for (const line of visible) {
        lines.push(trunc(line, width));
      }

      // Pad
      while (lines.length < 18) {
        lines.push("");
      }

      lines.push("─".repeat(width));

      if (state.installing) {
        lines.push(trunc(`  ${AMBER}Installing update...${RESET}`, width));
      } else if (state.installError) {
        lines.push(trunc(`  ${RED}Error: ${state.installError}${RESET}`, width));
        lines.push(trunc(`  ${DIM}Press any key to dismiss${RESET}`, width));
      } else if (config.autoUpdate === "auto" && !state.autoCancelled) {
        lines.push(
          trunc(
            `  ${GREEN}[Y]${RESET} Update now   ${DIM}[n]${RESET} Cancel   Auto-updating in ${AMBER}${state.autoCountdown}${RESET}...`,
            width,
          ),
        );
      } else {
        lines.push(
          trunc(
            `  ${GREEN}[Y]${RESET} Update now   ${DIM}[n]${RESET} Skip   j/k: scroll`,
            width,
          ),
        );
      }

      return lines;
    };

    const handleInput = (data: string) => {
      const key = data.toLowerCase();

      // Dismiss install error
      if (state.installError) {
        done({ updated: false });
        return;
      }

      if (state.installing) return;

      // Cancel auto countdown
      if (config.autoUpdate === "auto" && !state.autoCancelled) {
        if (key === "n") {
          state.autoCancelled = true;
          if (state.autoTimer) clearInterval(state.autoTimer);
          writeSkippedVersion(state.result.latestVersion);
          done({ updated: false });
          return;
        }
      }

      // Y — install
      if (key === "y") {
        doInstall();
        return;
      }

      // n — skip
      if (key === "n") {
        writeSkippedVersion(state.result.latestVersion);
        done({ updated: false });
        return;
      }

      // q/Esc — skip
      if (key === "q" || key === "\x1b") {
        writeSkippedVersion(state.result.latestVersion);
        done({ updated: false });
        return;
      }

      // Scroll
      if (key === "j" || key === "\x1b[B") {
        state.scroll++;
      } else if (key === "k" || key === "\x1b[A") {
        state.scroll = Math.max(0, state.scroll - 1);
      } else if (key === "g") {
        if (state.pendingG) {
          state.scroll = 0;
          state.pendingG = false;
        } else {
          state.pendingG = true;
          setTimeout(() => { state.pendingG = false; }, 500);
        }
      } else if (key === "G") {
        state.scroll = 999999;
      }

      tui.requestRender();
    };

    return { render, handleInput, invalidate: () => {}, focused: true };
  };
}
