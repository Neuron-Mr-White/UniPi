/**
 * @pi-unipi/ask-user — Session Launcher TUI
 *
 * Secondary overlay shown when user selects a new_session option.
 * Offers Compact & run, Run directly, or Cancel.
 */

import { Key, matchesKey, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { adaptiveInnerWidth, contentWidth, normalizeWidth, safeRepeat, shouldRenderBorder, WidthKeyedCache } from "@pi-unipi/core";
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
  tui: TUI,
  theme: Theme,
  kb: KeybindingsManager,
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
    // Width-keyed so a terminal resize can never serve stale, over-wide lines.
    const lineCache = new WidthKeyedCache();

    function refresh() {
      lineCache.clear();
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

    function render(rawWidth: number): string[] {
      const width = normalizeWidth(rawWidth);
      const cached = lineCache.get(width);
      if (cached) return cached;

      const lines: string[] = [];
      // Never exceed the terminal width — pi-tui throws on over-wide lines.
      const innerWidth = adaptiveInnerWidth(width);
      const bordered = shouldRenderBorder(width);
      const border = (s: string) => theme.fg("accent", s);

      function padVisible(content: string, targetWidth: number): string {
        const vw = visibleWidth(content);
        return content + safeRepeat(" ", targetWidth - vw);
      }

      const frame = (content: string) => {
        const body = padVisible(truncateToWidth(content, innerWidth), innerWidth);
        return bordered ? border("│") + body + border("│") : body;
      };

      const add = (s: string) => lines.push(frame(s));
      const addEmpty = () => lines.push(frame(""));

      // Top border
      if (bordered) lines.push(border(`╭${safeRepeat("─", innerWidth)}╮`));

      // Header: show prefill command (truncated).
      // visibleWidth, not .length — the prefix holds an astral emoji.
      const headerPrefix = " 🚀 ";
      const maxPrefillWidth = contentWidth(innerWidth, visibleWidth(headerPrefix) + 1);
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
      if (bordered) lines.push(border(`╰${safeRepeat("─", innerWidth)}╯`));

      return lineCache.set(width, lines);
    }

    return {
      render,
      invalidate: () => {
        lineCache.clear();
      },
      handleInput,
    };
  };
}
