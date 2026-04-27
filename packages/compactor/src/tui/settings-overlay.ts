/**
 * @pi-unipi/compactor — TUI Settings Overlay
 *
 * Interactive settings editor for compactor configuration.
 * Navigate strategies, toggle on/off, cycle modes, apply presets.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { loadConfig, saveConfig } from "../config/manager.js";
import { applyPreset, detectPreset } from "../config/presets.js";
import type { CompactorPreset } from "../types.js";
import type { CompactorConfig } from "../types.js";

/** ANSI escape codes */
const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  magenta: "\x1b[35m",
};

const TOGGLE_ON = `${ansi.green}●${ansi.reset}`;
const TOGGLE_OFF = `${ansi.dim}○${ansi.reset}`;

/** Strategy item definition */
interface StrategyItem {
  key: string;
  label: string;
  description: string;
  modes: string[];
  getEnabled: (c: CompactorConfig) => boolean;
  setEnabled: (c: CompactorConfig, v: boolean) => void;
  getMode: (c: CompactorConfig) => string;
  setMode: (c: CompactorConfig, v: string) => void;
}

/** All configurable strategies */
const STRATEGIES: StrategyItem[] = [
  {
    key: "sessionGoals",
    label: "Session Goals",
    description: "Extract goals from conversation",
    modes: ["full", "minimal"],
    getEnabled: (c) => c.sessionGoals.enabled,
    setEnabled: (c, v) => (c.sessionGoals.enabled = v),
    getMode: (c) => c.sessionGoals.mode,
    setMode: (c, v) => (c.sessionGoals.mode = v as any),
  },
  {
    key: "filesAndChanges",
    label: "Files & Changes",
    description: "Track file activity",
    modes: ["all", "modified", "none"],
    getEnabled: (c) => c.filesAndChanges.enabled,
    setEnabled: (c, v) => (c.filesAndChanges.enabled = v),
    getMode: (c) => c.filesAndChanges.mode,
    setMode: (c, v) => (c.filesAndChanges.mode = v as any),
  },
  {
    key: "commits",
    label: "Commits",
    description: "Extract git commits",
    modes: ["full", "minimal", "none"],
    getEnabled: (c) => c.commits.enabled,
    setEnabled: (c, v) => (c.commits.enabled = v),
    getMode: (c) => c.commits.mode,
    setMode: (c, v) => (c.commits.mode = v as any),
  },
  {
    key: "outstandingContext",
    label: "Outstanding Context",
    description: "Track blockers and pending items",
    modes: ["full", "minimal"],
    getEnabled: (c) => c.outstandingContext.enabled,
    setEnabled: (c, v) => (c.outstandingContext.enabled = v),
    getMode: (c) => c.outstandingContext.mode,
    setMode: (c, v) => (c.outstandingContext.mode = v as any),
  },
  {
    key: "userPreferences",
    label: "User Preferences",
    description: "Track learned preferences",
    modes: ["all", "minimal"],
    getEnabled: (c) => c.userPreferences.enabled,
    setEnabled: (c, v) => (c.userPreferences.enabled = v),
    getMode: (c) => c.userPreferences.mode,
    setMode: (c, v) => (c.userPreferences.mode = v as any),
  },
  {
    key: "briefTranscript",
    label: "Brief Transcript",
    description: "Rolling window of recent messages",
    modes: ["full", "compact", "minimal"],
    getEnabled: (c) => c.briefTranscript.enabled,
    setEnabled: (c, v) => (c.briefTranscript.enabled = v),
    getMode: (c) => c.briefTranscript.mode,
    setMode: (c, v) => (c.briefTranscript.mode = v as any),
  },
  {
    key: "sessionContinuity",
    label: "Session Continuity",
    description: "XML resume snapshot for compaction survival",
    modes: ["full", "minimal"],
    getEnabled: (c) => c.sessionContinuity.enabled,
    setEnabled: (c, v) => (c.sessionContinuity.enabled = v),
    getMode: (c) => c.sessionContinuity.mode,
    setMode: (c, v) => (c.sessionContinuity.mode = v as any),
  },
  {
    key: "fts5Index",
    label: "FTS5 Index",
    description: "Full-text search index",
    modes: ["auto", "manual", "disabled"],
    getEnabled: (c) => c.fts5Index.enabled,
    setEnabled: (c, v) => (c.fts5Index.enabled = v),
    getMode: (c) => c.fts5Index.mode,
    setMode: (c, v) => (c.fts5Index.mode = v as any),
  },
  {
    key: "sandboxExecution",
    label: "Sandbox Execution",
    description: "Polyglot code execution",
    modes: ["all", "safe", "none"],
    getEnabled: (c) => c.sandboxExecution.enabled,
    setEnabled: (c, v) => (c.sandboxExecution.enabled = v),
    getMode: (c) => c.sandboxExecution.mode,
    setMode: (c, v) => (c.sandboxExecution.mode = v as any),
  },
  {
    key: "toolDisplay",
    label: "Tool Display",
    description: "Override tool output rendering",
    modes: ["opencode", "summary", "verbose", "minimal"],
    getEnabled: (c) => c.toolDisplay.enabled,
    setEnabled: (c, v) => (c.toolDisplay.enabled = v),
    getMode: (c) => c.toolDisplay.mode,
    setMode: (c, v) => (c.toolDisplay.mode = v as any),
  },
];

const PRESETS: CompactorPreset[] = ["opencode", "balanced", "verbose", "minimal"];

/**
 * Settings overlay component for compactor configuration.
 */
export class CompactorSettingsOverlay implements Component {
  private config: CompactorConfig;
  private selectedIndex = 0;
  private mode = "strategy" as "strategy" | "preset";
  private presetIndex = 0;
  onClose?: () => void;

  constructor() {
    this.config = loadConfig();
    const currentPreset = detectPreset(this.config);
    this.presetIndex = PRESETS.indexOf(currentPreset as CompactorPreset);
    if (this.presetIndex < 0) this.presetIndex = 0;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    switch (data) {
      case "\x1b[A": // Up
      case "k":
        if (this.mode === "strategy") {
          this.selectedIndex = (this.selectedIndex - 1 + STRATEGIES.length) % STRATEGIES.length;
        } else {
          this.presetIndex = (this.presetIndex - 1 + PRESETS.length) % PRESETS.length;
        }
        break;
      case "\x1b[B": // Down
      case "j":
        if (this.mode === "strategy") {
          this.selectedIndex = (this.selectedIndex + 1) % STRATEGIES.length;
        } else {
          this.presetIndex = (this.presetIndex + 1) % PRESETS.length;
        }
        break;
      case " ": // Space - toggle enabled
        if (this.mode === "strategy") {
          const item = STRATEGIES[this.selectedIndex];
          item.setEnabled(this.config, !item.getEnabled(this.config));
        }
        break;
      case "\x1b[C": // Right - cycle mode forward
      case "\r": // Enter
        if (this.mode === "strategy") {
          const strat = STRATEGIES[this.selectedIndex];
          const modes = strat.modes;
          const currentIdx = modes.indexOf(strat.getMode(this.config));
          const nextIdx = (currentIdx + 1) % modes.length;
          strat.setMode(this.config, modes[nextIdx]);
        } else {
          // Apply preset
          this.config = applyPreset(PRESETS[this.presetIndex]);
          this.mode = "strategy";
        }
        break;
      case "\x1b[D": // Left - cycle mode backward
        if (this.mode === "strategy") {
          const strat2 = STRATEGIES[this.selectedIndex];
          const modes2 = strat2.modes;
          const curIdx = modes2.indexOf(strat2.getMode(this.config));
          const prevIdx = (curIdx - 1 + modes2.length) % modes2.length;
          strat2.setMode(this.config, modes2[prevIdx]);
        }
        break;
      case "p": // Toggle preset mode
        this.mode = this.mode === "preset" ? "strategy" : "preset";
        break;
      case "s": // Save
        saveConfig(this.config);
        this.onClose?.();
        break;
      case "\x1b": // Escape - cancel
        this.onClose?.();
        break;
    }
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const add = (s: string) => lines.push(truncateToWidth(s, width));

    // Header
    add(`${ansi.bold}${ansi.cyan}🗜️  Compactor Settings${ansi.reset}`);
    const presetName = detectPreset(this.config);
    add(`${ansi.dim}Preset: ${presetName === "custom" ? "custom (modified)" : presetName}${ansi.reset}`);
    add("");

    if (this.mode === "preset") {
      // Preset selection
      add(`${ansi.bold}Select Preset:${ansi.reset}`);
      add("");
      for (let i = 0; i < PRESETS.length; i++) {
        const isSelected = i === this.presetIndex;
        const prefix = isSelected ? `${ansi.cyan}▸${ansi.reset}` : " ";
        const label = isSelected ? `${ansi.bold}${PRESETS[i]}${ansi.reset}` : PRESETS[i];
        add(`${prefix} ${label}`);
      }
      add("");
      add(`${ansi.dim}↑↓ navigate • Enter apply • p back to strategies • s save • Esc cancel${ansi.reset}`);
    } else {
      // Strategy list
      for (let i = 0; i < STRATEGIES.length; i++) {
        const item = STRATEGIES[i];
        const isSelected = i === this.selectedIndex;
        const enabled = item.getEnabled(this.config);
        const mode = item.getMode(this.config);
        const toggle = enabled ? TOGGLE_ON : TOGGLE_OFF;
        const labelColor = isSelected ? ansi.bold : "";
        const modeColor = ansi.magenta;
        const descColor = ansi.gray;

        const cursor = isSelected ? `${ansi.cyan}▸${ansi.reset}` : " ";
        add(`${cursor} ${toggle} ${labelColor}${item.label}${ansi.reset} ${modeColor}[${mode}]${ansi.reset}`);
        add(`   ${descColor}${item.description}${ansi.reset}`);
      }

      add("");
      add(`${ansi.dim}↑↓ navigate • Space toggle • ←→ cycle mode • p presets • s save • Esc cancel${ansi.reset}`);
    }

    return lines;
  }
}

/**
 * Factory function for ctx.ui.custom() integration.
 * Returns a render function compatible with pi-tui's custom overlay API.
 */
export function renderSettingsOverlay() {
  return (tui: any, _theme: any, _kb: any, done: (result: any) => void) => {
    const overlay = new CompactorSettingsOverlay();
    overlay.onClose = () => done(overlay);

    return {
      render: (width: number) => overlay.render(width),
      invalidate: () => {},
      handleInput: (data: string) => overlay.handleInput(data),
    };
  };
}
