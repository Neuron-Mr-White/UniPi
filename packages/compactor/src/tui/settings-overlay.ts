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

/** Top-level debug toggle that mirrors config.debug */
const GLOBAL_DEBUG: StrategyItem = {
  key: "debug",
  label: "Verbose Debug",
  description: "Log ALL compaction events to console",
  modes: ["on", "off"],
  getEnabled: (c) => c.debug,
  setEnabled: (c, v) => (c.debug = v),
  getMode: (c) => (c.debug ? "on" : "off"),
  setMode: (c, v) => (c.debug = v === "on"),
};

/** Pipeline feature item definition */
interface PipelineItem {
  key: string;
  label: string;
  description: string;
  group: string;
  getEnabled: (c: CompactorConfig) => boolean;
  setEnabled: (c: CompactorConfig, v: boolean) => void;
}

/** Pipeline features grouped by execution context */
const PIPELINE_ITEMS: PipelineItem[] = [
  // On Compaction
  {
    key: "ttlCache",
    label: "TTL Cache",
    description: "24h cache for ctx_fetch_and_index (skip re-fetch)",
    group: "On Compaction",
    getEnabled: (c) => c.pipeline.ttlCache,
    setEnabled: (c, v) => (c.pipeline.ttlCache = v),
  },
  {
    key: "autoInjection",
    label: "Auto-Injection",
    description: "Inject behavioral state after compaction",
    group: "On Compaction",
    getEnabled: (c) => c.pipeline.autoInjection,
    setEnabled: (c, v) => (c.pipeline.autoInjection = v),
  },
  // On Search
  {
    key: "proximityReranking",
    label: "Proximity Reranking",
    description: "Boost results where query terms appear close",
    group: "On Search",
    getEnabled: (c) => c.pipeline.proximityReranking,
    setEnabled: (c, v) => (c.pipeline.proximityReranking = v),
  },
  {
    key: "timelineSort",
    label: "Timeline Sort",
    description: "Unified search across ContentStore + SessionDB",
    group: "On Search",
    getEnabled: (c) => c.pipeline.timelineSort,
    setEnabled: (c, v) => (c.pipeline.timelineSort = v),
  },
  {
    key: "progressiveThrottling",
    label: "Progressive Throttling",
    description: "Rate limit ctx_search calls (1-3 ok, 4-8 reduced, 9+ blocked)",
    group: "On Search",
    getEnabled: (c) => c.pipeline.progressiveThrottling,
    setEnabled: (c, v) => (c.pipeline.progressiveThrottling = v),
  },
  // On Index
  {
    key: "mmapPragma",
    label: "mmap Pragma",
    description: "256MB mmap for FTS5 read performance",
    group: "On Index",
    getEnabled: (c) => c.pipeline.mmapPragma,
    setEnabled: (c, v) => (c.pipeline.mmapPragma = v),
  },
];

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

/** All navigable items: debug toggle first, then strategies */
const ALL_ITEMS: StrategyItem[] = [GLOBAL_DEBUG, ...STRATEGIES];

const PRESETS: CompactorPreset[] = ["opencode", "balanced", "verbose", "minimal"];

/** Get pipeline items grouped for display */
function getGroupedPipelineItems(): Array<{ group: string; items: PipelineItem[] }> {
  const groups: Map<string, PipelineItem[]> = new Map();
  for (const item of PIPELINE_ITEMS) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group)!.push(item);
  }
  return Array.from(groups.entries()).map(([group, items]) => ({ group, items }));
}

/**
 * Settings overlay component for compactor configuration.
 */
export class CompactorSettingsOverlay implements Component {
  private config: CompactorConfig;
  private selectedIndex = 0;
  private mode = "strategy" as "strategy" | "preset" | "pipeline";
  private presetIndex = 0;
  private pipelineIndex = 0;
  private pipelineItems: PipelineItem[] = [];
  onClose?: () => void;

  constructor() {
    this.config = loadConfig();
    const currentPreset = detectPreset(this.config);
    this.presetIndex = PRESETS.indexOf(currentPreset as CompactorPreset);
    if (this.presetIndex < 0) this.presetIndex = 0;
    this.pipelineItems = PIPELINE_ITEMS;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    switch (data) {
      case "\x1b[A": // Up
      case "k":
        if (this.mode === "strategy") {
          this.selectedIndex = (this.selectedIndex - 1 + ALL_ITEMS.length) % ALL_ITEMS.length;
        } else if (this.mode === "preset") {
          this.presetIndex = (this.presetIndex - 1 + PRESETS.length) % PRESETS.length;
        } else if (this.mode === "pipeline") {
          this.pipelineIndex = (this.pipelineIndex - 1 + this.pipelineItems.length) % this.pipelineItems.length;
        }
        break;
      case "\x1b[B": // Down
      case "j":
        if (this.mode === "strategy") {
          this.selectedIndex = (this.selectedIndex + 1) % ALL_ITEMS.length;
        } else if (this.mode === "preset") {
          this.presetIndex = (this.presetIndex + 1) % PRESETS.length;
        } else if (this.mode === "pipeline") {
          this.pipelineIndex = (this.pipelineIndex + 1) % this.pipelineItems.length;
        }
        break;
      case " ": // Space - toggle enabled
        if (this.mode === "strategy") {
          const item = ALL_ITEMS[this.selectedIndex];
          item.setEnabled(this.config, !item.getEnabled(this.config));
        } else if (this.mode === "pipeline") {
          const pItem = this.pipelineItems[this.pipelineIndex];
          pItem.setEnabled(this.config, !pItem.getEnabled(this.config));
        }
        break;
      case "\x1b[C": // Right - cycle mode forward
      case "\r": // Enter
        if (this.mode === "strategy") {
          const strat = ALL_ITEMS[this.selectedIndex];
          const modes = strat.modes;
          const currentIdx = modes.indexOf(strat.getMode(this.config));
          const nextIdx = (currentIdx + 1) % modes.length;
          strat.setMode(this.config, modes[nextIdx]);
        } else if (this.mode === "preset") {
          // Apply preset
          this.config = applyPreset(PRESETS[this.presetIndex]);
          this.mode = "strategy";
        } else if (this.mode === "pipeline") {
          // Toggle pipeline item on Enter
          const pItem = this.pipelineItems[this.pipelineIndex];
          pItem.setEnabled(this.config, !pItem.getEnabled(this.config));
        }
        break;
      case "\x1b[D": // Left - cycle mode backward
        if (this.mode === "strategy") {
          const strat2 = ALL_ITEMS[this.selectedIndex];
          const modes2 = strat2.modes;
          const curIdx = modes2.indexOf(strat2.getMode(this.config));
          const prevIdx = (curIdx - 1 + modes2.length) % modes2.length;
          strat2.setMode(this.config, modes2[prevIdx]);
        }
        break;
      case "p": // Toggle preset mode
        this.mode = this.mode === "preset" ? "strategy" : "preset";
        break;
      case "l": // Toggle pipeline mode
        this.mode = this.mode === "pipeline" ? "strategy" : "pipeline";
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
      add(`${ansi.dim}↑↓ navigate • Enter apply • p back to strategies • l pipeline • s save • Esc cancel${ansi.reset}`);
    } else if (this.mode === "pipeline") {
      // Pipeline feature toggles grouped by execution context
      add(`${ansi.bold}Pipeline Features${ansi.reset}`);
      add("");

      let globalIdx = 0;
      const grouped = getGroupedPipelineItems();
      for (const { group, items } of grouped) {
        add(`${ansi.bold}${ansi.yellow}${group}${ansi.reset}`);
        for (const item of items) {
          const isSelected = globalIdx === this.pipelineIndex;
          const enabled = item.getEnabled(this.config);
          const toggle = enabled ? TOGGLE_ON : TOGGLE_OFF;
          const cursor = isSelected ? `${ansi.cyan}▸${ansi.reset}` : " ";
          const labelColor = isSelected ? ansi.bold : "";
          add(`${cursor} ${toggle} ${labelColor}${item.label}${ansi.reset} ${ansi.dim}${item.description}${ansi.reset}`);
          globalIdx++;
        }
        add("");
      }
      add(`${ansi.dim}↑↓ navigate • Space toggle • l back to strategies • s save • Esc cancel${ansi.reset}`);
    } else {
      // Strategy list (GLOBAL_DEBUG at top, then all strategies)
      for (let i = 0; i < ALL_ITEMS.length; i++) {
        const item = ALL_ITEMS[i];
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
      add(`${ansi.dim}↑↓ navigate • Space toggle • ←→ cycle mode • p presets • l pipeline • s save • Esc cancel${ansi.reset}`);
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
