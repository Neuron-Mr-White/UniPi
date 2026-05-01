/**
 * @pi-unipi/ask-user — Session Launcher TUI
 *
 * Secondary overlay shown when user selects a new_session option.
 * Offers Compact & run, Run directly, or Cancel.
 */

import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { SessionLauncherResult } from "./types.js";

/** Launcher option definition */
interface LauncherOption {
  label: string;
  icon: string;
  action: SessionLauncherResult["action"];
}

const OPTIONS: LauncherOption[] = [
  { label: "Compact & run", icon: "🧹", action: "compact" },
  { label: "Run directly", icon: "▶", action: "direct" },
  { label: "Cancel", icon: "✕", action: "cancel" },
];

/**
 * Render the session launcher UI.
 *
 * Simple single-select picker with 3 fixed options.
 * No editor, no timeout, no multi-select.
 */
export function renderLauncherUI(params: {
  prefill: string;
}): (
  tui: any,
  theme: any,
  kb: any,
  done: (result: SessionLauncherResult | null) => void,
) => {
  render: (width: number) => string[];
  invalidate: () => void;
  handleInput: (data: string) => void;
} {
  return (_tui, theme, _kb, done) => {
    const { prefill } = params;

    // State
    let optionIndex = 0;
    let cachedLines: string[] | undefined;

    function refresh() {
      cachedLines = undefined;
      _tui.requestRender();
    }

    function handleInput(data: string) {
      // Navigation
      if (matchesKey(data, Key.up)) {
        optionIndex = Math.max(0, optionIndex - 1);
        refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        optionIndex = Math.min(OPTIONS.length - 1, optionIndex + 1);
        refresh();
        return;
      }

      // Enter: select
      if (matchesKey(data, Key.enter)) {
        const opt = OPTIONS[optionIndex];
        done({ action: opt.action, prefill });
        return;
      }

      // Escape: cancel
      if (matchesKey(data, Key.escape)) {
        done(null);
        return;
      }
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;

      const lines: string[] = [];
      const innerWidth = Math.max(40, width - 2);
      const border = (s: string) => theme.fg("accent", s);

      function padVisible(content: string, targetWidth: number): string {
        const vw = visibleWidth(content);
        const pad = Math.max(0, targetWidth - vw);
        return content + " ".repeat(pad);
      }

      const add = (s: string) =>
        lines.push(
          border("│") +
            padVisible(truncateToWidth(s, innerWidth), innerWidth) +
            border("│"),
        );
      const addEmpty = () =>
        lines.push(border("│") + " ".repeat(innerWidth) + border("│"));

      // Top border
      lines.push(border(`╭${"─".repeat(innerWidth)}╮`));

      // Header: show prefill command (truncated)
      const headerPrefix = " 🚀 ";
      const maxPrefillWidth = innerWidth - headerPrefix.length - 1;
      const truncatedPrefill = truncateToWidth(prefill || "(no command)", maxPrefillWidth);
      add(theme.fg("accent", headerPrefix) + theme.fg("text", truncatedPrefill));
      addEmpty();

      // Options
      for (let i = 0; i < OPTIONS.length; i++) {
        const opt = OPTIONS[i];
        const isSelected = i === optionIndex;
        const prefix = isSelected ? theme.fg("accent", "> ") : "  ";
        const label = `${opt.icon} ${opt.label}`;
        const color = isSelected ? "accent" : "text";
        add(prefix + theme.fg(color, label));
      }

      // Footer hint
      addEmpty();
      add(theme.fg("dim", " ↑↓ navigate • Enter select • Esc cancel"));

      // Bottom border
      lines.push(border(`╰${"─".repeat(innerWidth)}╯`));

      cachedLines = lines;
      return lines;
    }

    return {
      render,
      invalidate: () => {
        cachedLines = undefined;
      },
      handleInput,
    };
  };
}
