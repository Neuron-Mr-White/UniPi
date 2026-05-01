/**
 * @pi-unipi/updater — Settings TUI Overlay
 *
 * Check interval radio (30min/1h/6h/1d), auto-update radio (disabled/notify/auto).
 * Space cycles options, Enter saves, Esc cancels.
 */

import {
  loadConfig,
  saveConfig,
  getIntervalOptions,
  getAutoUpdateOptions,
  getIntervalLabel,
} from "../settings.js";
import type { UpdaterConfig } from "../../types.js";

/** ANSI codes */
const ESC = "\x1b";
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const TEAL = `${ESC}[36m`;
const GREEN = `${ESC}[32m`;
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

/**
 * Render the settings overlay.
 */
export function renderSettingsOverlay() {
  return (
    tui: any,
    _theme: any,
    _kb: any,
    done: (result: { saved: boolean } | null) => void,
  ) => {
    const state = {
      config: { ...loadConfig() } as UpdaterConfig,
      row: 0,
    };

    const intervalOptions = getIntervalOptions();
    const modeOptions = getAutoUpdateOptions();

    const render = (width: number): string[] => {
      const lines: string[] = [];

      lines.push(trunc(` ${BOLD}⚙ Updater Settings${RESET}`, width));
      lines.push("─".repeat(width));
      lines.push("");

      // Row 0: Check Interval
      const intervalLabel = getIntervalLabel(state.config.checkIntervalMs);
      const row0Selected = state.row === 0;
      const row0Prefix = row0Selected ? `${TEAL}▸${RESET} ` : "  ";
      lines.push(
        trunc(
          `  ${row0Prefix}${BOLD}Check Interval${RESET}  ${DIM}${intervalLabel}${RESET}`,
          width,
        ),
      );

      const intervalLine = intervalOptions
        .map((opt) => {
          const active = opt.ms === state.config.checkIntervalMs;
          return active
            ? `${GREEN}● ${opt.label}${RESET}`
            : `${DIM}○ ${opt.label}${RESET}`;
        })
        .join("   ");
      lines.push(trunc(`      ${intervalLine}`, width));
      lines.push("");

      // Row 1: Auto Update
      const modeLabel = state.config.autoUpdate;
      const row1Selected = state.row === 1;
      const row1Prefix = row1Selected ? `${TEAL}▸${RESET} ` : "  ";
      lines.push(
        trunc(
          `  ${row1Prefix}${BOLD}Auto Update${RESET}  ${DIM}${modeLabel}${RESET}`,
          width,
        ),
      );

      const modeLine = modeOptions
        .map((mode) => {
          const active = mode === state.config.autoUpdate;
          return active
            ? `${GREEN}● ${mode}${RESET}`
            : `${DIM}○ ${mode}${RESET}`;
        })
        .join("   ");
      lines.push(trunc(`      ${modeLine}`, width));
      lines.push("");

      lines.push("─".repeat(width));
      lines.push(
        trunc(
          `  j/k: navigate  Space: cycle  ${GREEN}Enter: save${RESET}  ${DIM}Esc: cancel${RESET}`,
          width,
        ),
      );

      return lines;
    };

    const handleInput = (data: string) => {
      const key = data.toLowerCase();

      // Close without saving
      if (key === "\x1b") {
        done({ saved: false });
        return;
      }

      // Save and close
      if (key === "\r" || key === "\n") {
        saveConfig(state.config);
        done({ saved: true });
        return;
      }

      // Navigate rows
      if (key === "j" || key === "\x1b[B") {
        state.row = Math.min(state.row + 1, 1);
      } else if (key === "k" || key === "\x1b[A") {
        state.row = Math.max(state.row - 1, 0);
      }

      // Cycle with Space
      if (key === " ") {
        if (state.row === 0) {
          const currentIdx = intervalOptions.findIndex(
            (opt) => opt.ms === state.config.checkIntervalMs,
          );
          const nextIdx = (currentIdx + 1) % intervalOptions.length;
          state.config.checkIntervalMs = intervalOptions[nextIdx].ms;
        } else {
          const currentIdx = modeOptions.indexOf(state.config.autoUpdate);
          const nextIdx = (currentIdx + 1) % modeOptions.length;
          state.config.autoUpdate = modeOptions[nextIdx];
        }
      }

      // Cycle with left/right
      if (key === "h" || key === "\x1b[D") {
        if (state.row === 0) {
          const currentIdx = intervalOptions.findIndex(
            (opt) => opt.ms === state.config.checkIntervalMs,
          );
          const prevIdx = (currentIdx - 1 + intervalOptions.length) % intervalOptions.length;
          state.config.checkIntervalMs = intervalOptions[prevIdx].ms;
        } else {
          const currentIdx = modeOptions.indexOf(state.config.autoUpdate);
          const prevIdx = (currentIdx - 1 + modeOptions.length) % modeOptions.length;
          state.config.autoUpdate = modeOptions[prevIdx];
        }
      }
      if (key === "l" || key === "\x1b[C") {
        if (state.row === 0) {
          const currentIdx = intervalOptions.findIndex(
            (opt) => opt.ms === state.config.checkIntervalMs,
          );
          const nextIdx = (currentIdx + 1) % intervalOptions.length;
          state.config.checkIntervalMs = intervalOptions[nextIdx].ms;
        } else {
          const currentIdx = modeOptions.indexOf(state.config.autoUpdate);
          const nextIdx = (currentIdx + 1) % modeOptions.length;
          state.config.autoUpdate = modeOptions[nextIdx];
        }
      }

      tui.requestRender();
    };

    return { render, handleInput, invalidate: () => {}, focused: true };
  };
}
