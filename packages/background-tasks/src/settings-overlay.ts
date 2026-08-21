/**
 * @pi-unipi/background-tasks — Settings overlay TUI
 *
 * Interactive editor for background-tasks config, mounted in our panel style
 * (mcp/settings-overlay precedent): box-drawn overlay, arrow/vim navigation,
 * space to cycle values, saved atomically to the global config file.
 *
 * The master `enabled` toggle lives here: turning it off disables the whole
 * module on the next Pi start (Pi 0.80 cannot unregister tools at runtime).
 */

import { Key, matchesKey, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  loadBackgroundTasksConfig,
  saveGlobalBackgroundTasksConfig,
  type BackgroundTasksConfig,
} from "./config.js";
import { normalizeWidth, WidthKeyedCache } from "@pi-unipi/core";

/** One editable row in the overlay. */
interface SettingRow {
  key: string;
  label: string;
  /** Render the current value for display. */
  display: (config: BackgroundTasksConfig) => string;
  /** Cycle to the next value (booleans toggle; enums step). */
  cycle: (config: BackgroundTasksConfig) => void;
}

const ROWS: SettingRow[] = [
  {
    key: "enabled",
    label: "Enabled (master toggle)",
    display: (c) => (c.enabled ? "on" : "off"),
    cycle: (c) => {
      c.enabled = !c.enabled;
    },
  },
  {
    key: "notifyOnCompletion",
    label: "Notify on completion",
    display: (c) => (c.notifyOnCompletion ? "on" : "off"),
    cycle: (c) => {
      c.notifyOnCompletion = !c.notifyOnCompletion;
    },
  },
  {
    key: "triggerOnCompletion",
    label: "Wake follow-up turn",
    display: (c) => (c.triggerOnCompletion ? "on" : "off"),
    cycle: (c) => {
      c.triggerOnCompletion = !c.triggerOnCompletion;
    },
  },
  {
    key: "delegate.extensionMode",
    label: "Delegate mode",
    display: (c) => c.delegate.extensionMode,
    cycle: (c) => {
      c.delegate.extensionMode = c.delegate.extensionMode === "isolated" ? "ambient" : "isolated";
    },
  },
  {
    key: "delegate.autoDeliver",
    label: "Delegate auto-deliver",
    display: (c) => c.delegate.autoDeliver,
    cycle: (c) => {
      const order = ["never", "when_small", "always"] as const;
      const index = order.indexOf(c.delegate.autoDeliver);
      c.delegate.autoDeliver = order[(index + 1) % order.length];
    },
  },
];

/**
 * Render the background-tasks settings overlay.
 */
export function renderBackgroundTasksSettingsOverlay(params?: {
  cwd?: string;
  onComplete?: () => void;
}) {
  return (
    tui: TUI,
    theme: Theme,
    _kb: KeybindingsManager,
    done: (result: { action?: string } | null) => void,
  ) => {
    const cwd = params?.cwd ?? process.cwd();
    const loaded = loadBackgroundTasksConfig(cwd);
    // Edit a working copy; save is explicit and atomic.
    let config: BackgroundTasksConfig = structuredClone(loaded.config);
    let selectedIndex = 0;
    let dirty = false;

    // Width-keyed so a terminal resize can never serve stale, over-wide lines.
    const lineCache = new WidthKeyedCache();

    function refresh() {
      lineCache.clear();
      tui.requestRender();
    }

    function handleInput(data: string) {
      if (matchesKey(data, Key.escape) || data === "q") {
        done(null);
        return;
      }

      if (matchesKey(data, Key.up) || data === "k") {
        if (selectedIndex > 0) {
          selectedIndex--;
          refresh();
        }
        return;
      }

      if (matchesKey(data, Key.down) || data === "j") {
        if (selectedIndex < ROWS.length - 1) {
          selectedIndex++;
          refresh();
        }
        return;
      }

      // Space/enter: cycle the selected value.
      if (data === " " || data === "\r") {
        ROWS[selectedIndex]?.cycle(config);
        dirty = true;
        refresh();
        return;
      }

      // s: save
      if (data === "s") {
        try {
          saveGlobalBackgroundTasksConfig(config);
          dirty = false;
        } catch {
          // Save failures are non-fatal; keep the overlay open.
        }
        refresh();
        return;
      }
    }

    function padVisible(content: string, targetWidth: number): string {
      const vw = visibleWidth(content);
      const pad = Math.max(0, targetWidth - vw);
      return content + " ".repeat(pad);
    }

    function render(rawWidth: number): string[] {
      const width = normalizeWidth(rawWidth);
      const cached = lineCache.get(width);
      if (cached) return cached;

      const lines: string[] = [];
      const innerWidth = normalizeWidth(width) - 2;

      const header = " Background Tasks Settings ";
      const stateLabel = dirty ? theme.fg("warning", "● unsaved") : theme.fg("success", "● saved");
      const headerPad = Math.max(0, innerWidth - visibleWidth(header) - 12);
      lines.push(theme.fg("accent", `╭${"─".repeat(innerWidth)}╮`));
      lines.push(
        theme.fg("accent", "│") +
          theme.bold(header) +
          theme.fg("accent", " ".repeat(headerPad)) +
          stateLabel +
          theme.fg("accent", "│"),
      );
      lines.push(theme.fg("accent", `├${"─".repeat(innerWidth)}┤`));

      for (let i = 0; i < ROWS.length; i++) {
        const row = ROWS[i];
        const selected = i === selectedIndex;
        const prefix = selected ? theme.fg("accent", "▸ ") : "  ";
        const label = selected ? theme.bold(row.label) : theme.fg("text", row.label);
        const rawValue = row.display(config);
        const value =
          rawValue === "off" || rawValue === "never"
            ? theme.fg("error", rawValue)
            : rawValue === "on"
              ? theme.fg("success", rawValue)
              : theme.fg("accent", rawValue);
        const line = ` ${prefix}${label} ${theme.fg("muted", "─")} ${value}`;
        lines.push(
          theme.fg("accent", "│") +
            padVisible(truncateToWidth(line, innerWidth), innerWidth) +
            theme.fg("accent", "│"),
        );
      }

      lines.push(theme.fg("accent", `├${"─".repeat(innerWidth)}┤`));
      const binds = " ↑↓ select  Space cycle  s save  q/Esc close";
      lines.push(
        theme.fg("accent", "│") +
          padVisible(theme.fg("muted", truncateToWidth(binds, innerWidth)), innerWidth) +
          theme.fg("accent", "│"),
      );
      lines.push(theme.fg("accent", "╰" + "─".repeat(innerWidth) + "╯"));

      return lineCache.set(width, lines);
    }

    return { render, invalidate: refresh, handleInput };
  };
}
