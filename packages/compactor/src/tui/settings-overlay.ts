/**
 * @pi-unipi/compactor — TUI Settings Overlay
 *
 * Interactive settings editor for compactor configuration.
 * Tabbed navigation (Presets / Strategies / Pipeline), search filter,
 * preset preview, per-project override, live stats footer.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { loadConfig, saveConfig, projectConfigPath } from "../config/manager.js";
import { applyPreset, detectPreset, PRESET_CONFIGS } from "../config/presets.js";
import type { CompactorPreset, RuntimeCounters } from "../types.js";
import type { CompactorConfig } from "../types.js";
import { existsSync, unlinkSync } from "node:fs";

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
  white: "\x1b[37m",
  blue: "\x1b[34m",
};

const TOGGLE_ON = `${ansi.green}●${ansi.reset}`;
const TOGGLE_OFF = `${ansi.dim}○${ansi.reset}`;
const CHECKBOX_ON = `${ansi.green}☑${ansi.reset}`;
const CHECKBOX_OFF = `${ansi.dim}☐${ansi.reset}`;

type Tab = "presets" | "strategies" | "pipeline";
const TABS: Tab[] = ["presets", "strategies", "pipeline"];

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

/** Pipeline feature item */
interface PipelineItem {
  key: string;
  label: string;
  description: string;
  group: "On Compaction" | "On Search" | "On Index";
  getValue: (c: CompactorConfig) => boolean;
  setValue: (c: CompactorConfig, v: boolean) => void;
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

/** All configurable strategies */
const STRATEGIES: StrategyItem[] = [
  {
    key: "sessionGoals",
    label: "Session Goals",
    description: "Extract goals from conversation",
    modes: ["full", "brief", "off"],
    getEnabled: (c) => c.sessionGoals.enabled,
    setEnabled: (c, v) => (c.sessionGoals.enabled = v),
    getMode: (c) => c.sessionGoals.mode,
    setMode: (c, v) => (c.sessionGoals.mode = v as any),
  },
  {
    key: "filesAndChanges",
    label: "Files & Changes",
    description: "Track file activity",
    modes: ["all", "modified-only", "off"],
    getEnabled: (c) => c.filesAndChanges.enabled,
    setEnabled: (c, v) => (c.filesAndChanges.enabled = v),
    getMode: (c) => c.filesAndChanges.mode,
    setMode: (c, v) => (c.filesAndChanges.mode = v as any),
  },
  {
    key: "commits",
    label: "Commits",
    description: "Extract git commits",
    modes: ["full", "brief", "off"],
    getEnabled: (c) => c.commits.enabled,
    setEnabled: (c, v) => (c.commits.enabled = v),
    getMode: (c) => c.commits.mode,
    setMode: (c, v) => (c.commits.mode = v as any),
  },
  {
    key: "outstandingContext",
    label: "Outstanding Context",
    description: "Track blockers and pending items",
    modes: ["full", "critical-only", "off"],
    getEnabled: (c) => c.outstandingContext.enabled,
    setEnabled: (c, v) => (c.outstandingContext.enabled = v),
    getMode: (c) => c.outstandingContext.mode,
    setMode: (c, v) => (c.outstandingContext.mode = v as any),
  },
  {
    key: "userPreferences",
    label: "User Preferences",
    description: "Track learned preferences",
    modes: ["all", "recent-only", "off"],
    getEnabled: (c) => c.userPreferences.enabled,
    setEnabled: (c, v) => (c.userPreferences.enabled = v),
    getMode: (c) => c.userPreferences.mode,
    setMode: (c, v) => (c.userPreferences.mode = v as any),
  },
  {
    key: "briefTranscript",
    label: "Brief Transcript",
    description: "Rolling window of recent messages",
    modes: ["full", "compact", "minimal", "off"],
    getEnabled: (c) => c.briefTranscript.enabled,
    setEnabled: (c, v) => (c.briefTranscript.enabled = v),
    getMode: (c) => c.briefTranscript.mode,
    setMode: (c, v) => (c.briefTranscript.mode = v as any),
  },
  {
    key: "sessionContinuity",
    label: "Session Continuity",
    description: "XML resume snapshot for compaction survival",
    modes: ["full", "essential-only", "off"],
    getEnabled: (c) => c.sessionContinuity.enabled,
    setEnabled: (c, v) => (c.sessionContinuity.enabled = v),
    getMode: (c) => c.sessionContinuity.mode,
    setMode: (c, v) => (c.sessionContinuity.mode = v as any),
  },
  {
    key: "fts5Index",
    label: "FTS5 Index",
    description: "Full-text search index",
    modes: ["auto", "manual", "off"],
    getEnabled: (c) => c.fts5Index.enabled,
    setEnabled: (c, v) => (c.fts5Index.enabled = v),
    getMode: (c) => c.fts5Index.mode,
    setMode: (c, v) => (c.fts5Index.mode = v as any),
  },
  {
    key: "sandboxExecution",
    label: "Sandbox Execution",
    description: "Polyglot code execution",
    modes: ["all", "safe-only", "off"],
    getEnabled: (c) => c.sandboxExecution.enabled,
    setEnabled: (c, v) => (c.sandboxExecution.enabled = v),
    getMode: (c) => c.sandboxExecution.mode,
    setMode: (c, v) => (c.sandboxExecution.mode = v as any),
  },
  {
    key: "toolDisplay",
    label: "Tool Display",
    description: "Override tool output rendering",
    modes: ["opencode", "balanced", "verbose", "custom"],
    getEnabled: (c) => c.toolDisplay.enabled,
    setEnabled: (c, v) => (c.toolDisplay.enabled = v),
    getMode: (c) => c.toolDisplay.mode,
    setMode: (c, v) => (c.toolDisplay.mode = v as any),
  },
];

const ALL_STRATEGY_ITEMS: StrategyItem[] = [GLOBAL_DEBUG, ...STRATEGIES];

const PIPELINE_ITEMS: PipelineItem[] = [
  { key: "ttlCache", label: "TTL Cache", description: "Cache with time-based expiry", group: "On Compaction", getValue: (c) => c.pipeline.ttlCache, setValue: (c, v) => (c.pipeline.ttlCache = v) },
  { key: "autoInjection", label: "Auto Injection", description: "Inject behavioral state after compaction", group: "On Compaction", getValue: (c) => c.pipeline.autoInjection, setValue: (c, v) => (c.pipeline.autoInjection = v) },
  { key: "mmapPragma", label: "MMap Pragma", description: "Use mmap for SQLite I/O", group: "On Compaction", getValue: (c) => c.pipeline.mmapPragma, setValue: (c, v) => (c.pipeline.mmapPragma = v) },
  { key: "proximityReranking", label: "Proximity Reranking", description: "Rerank search results by proximity", group: "On Search", getValue: (c) => c.pipeline.proximityReranking, setValue: (c, v) => (c.pipeline.proximityReranking = v) },
  { key: "timelineSort", label: "Timeline Sort", description: "Sort session events chronologically", group: "On Search", getValue: (c) => c.pipeline.timelineSort, setValue: (c, v) => (c.pipeline.timelineSort = v) },
  { key: "progressiveThrottling", label: "Progressive Throttling", description: "Slow down indexing for large projects", group: "On Index", getValue: (c) => c.pipeline.progressiveThrottling, setValue: (c, v) => (c.pipeline.progressiveThrottling = v) },
];

const PRESETS: CompactorPreset[] = ["precise", "balanced", "thorough", "lean"];

const PRESET_DESCRIPTIONS: Record<string, { summary: string; detail: string }> = {
  precise: {
    summary: "Code-heavy, minimal waste — compaction: full, FTS5: manual, pipeline: 2/6 on",
    detail: "Max token savings. Compaction: full. Display: minimal.\nFTS5: manual. Sandbox: safe-only. Pipeline: ttlCache+mmap on.",
  },
  balanced: {
    summary: "Daily use (default) — all strategies moderate, pipeline: all on",
    detail: "Moderate all strategies. Display: balanced.\nFTS5: auto. Sandbox: all. Pipeline: all 6 on.",
  },
  thorough: {
    summary: "Debug/audit — everything on, full transcript, pipeline: all on",
    detail: "Everything enabled. Display: verbose.\nFTS5: auto. Sandbox: all. Pipeline: all 6 on.",
  },
  lean: {
    summary: "Quick fixes, short sessions — compaction only, pipeline: all off",
    detail: "Compaction only. Display: opencode.\nFTS5: off. Sandbox: off. Pipeline: all 6 off.",
  },
};

/**
 * Settings overlay component for compactor configuration.
 * Features tabbed navigation, search filter, preset preview, per-project override.
 */
export class CompactorSettingsOverlay implements Component {
  private config: CompactorConfig;
  private activeTab: Tab = "presets";
  private selectedIndex = 0;
  private presetIndex = 0;
  private searchQuery = "";
  private perProjectOverride = false;
  private projectDir: string;
  onClose?: () => void;

  constructor(opts?: { cwd?: string }) {
    this.projectDir = opts?.cwd ?? process.cwd();
    this.config = loadConfig(this.projectDir);

    // Detect per-project override
    const projPath = projectConfigPath(this.projectDir);
    this.perProjectOverride = existsSync(projPath);

    const currentPreset = detectPreset(this.config);
    this.presetIndex = PRESETS.indexOf(currentPreset as CompactorPreset);
    if (this.presetIndex < 0) this.presetIndex = 0;
  }

  invalidate(): void {}

  /** Get currently visible strategy items (filtered by search) */
  private getVisibleItems(): StrategyItem[] {
    if (!this.searchQuery) return ALL_STRATEGY_ITEMS;
    const q = this.searchQuery.toLowerCase();
    return ALL_STRATEGY_ITEMS.filter(
      (s) => s.label.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }

  /** Set active tab by index */
  private setTab(tab: Tab): void {
    this.activeTab = tab;
    this.selectedIndex = 0;
  }

  handleInput(data: string): void {
    // Search mode: typing adds to filter
    if (data === "/" && this.activeTab === "strategies") {
      this.searchQuery = "";
      return;
    }

    // When search bar is being typed
    if (this.activeTab === "strategies" && (data.length === 1 || data === "\x7f" || data === "\b")) {
      if (data === "\x7f" || data === "\b") {
        this.searchQuery = this.searchQuery.slice(0, -1);
        this.selectedIndex = 0;
        return;
      } else if (!/[\x00-\x1f]/.test(data)) {
        this.searchQuery += data;
        this.selectedIndex = 0;
        return;
      }
    }

    switch (data) {
      case "\x1b[A": // Up
      case "k":
        if (this.activeTab === "strategies") {
          const items = this.getVisibleItems();
          this.selectedIndex = (this.selectedIndex - 1 + items.length) % items.length;
        } else if (this.activeTab === "presets") {
          this.presetIndex = (this.presetIndex - 1 + PRESETS.length) % PRESETS.length;
        } else {
          this.selectedIndex = (this.selectedIndex - 1 + PIPELINE_ITEMS.length) % PIPELINE_ITEMS.length;
        }
        break;
      case "\x1b[B": // Down
      case "j":
        if (this.activeTab === "strategies") {
          const items = this.getVisibleItems();
          this.selectedIndex = (this.selectedIndex + 1) % items.length;
        } else if (this.activeTab === "presets") {
          this.presetIndex = (this.presetIndex + 1) % PRESETS.length;
        } else {
          this.selectedIndex = (this.selectedIndex + 1) % PIPELINE_ITEMS.length;
        }
        break;
      case " ": // Space — toggle
        if (this.activeTab === "strategies") {
          const items = this.getVisibleItems();
          if (items.length > 0) {
            const item = items[this.selectedIndex];
            item.setEnabled(this.config, !item.getEnabled(this.config));
          }
        } else if (this.activeTab === "pipeline") {
          const pi = PIPELINE_ITEMS[this.selectedIndex];
          pi.setValue(this.config, !pi.getValue(this.config));
        }
        break;
      case "\x1b[C": // Right — cycle mode / next tab
      case "\r": // Enter
        if (this.activeTab === "strategies") {
          const items = this.getVisibleItems();
          if (items.length > 0) {
            const strat = items[this.selectedIndex];
            const modes = strat.modes;
            const currentIdx = modes.indexOf(strat.getMode(this.config));
            const nextIdx = (currentIdx + 1) % modes.length;
            strat.setMode(this.config, modes[nextIdx]);
          }
        } else if (this.activeTab === "presets") {
          // Apply selected preset
          this.config = applyPreset(PRESETS[this.presetIndex]);
          this.activeTab = "strategies";
        } else {
          // Next tab
          const tabIdx = TABS.indexOf(this.activeTab);
          this.setTab(TABS[(tabIdx + 1) % TABS.length]);
        }
        break;
      case "\x1b[D": // Left — cycle mode backward / prev tab
        if (this.activeTab === "strategies") {
          const items = this.getVisibleItems();
          if (items.length > 0) {
            const strat2 = items[this.selectedIndex];
            const modes2 = strat2.modes;
            const curIdx = modes2.indexOf(strat2.getMode(this.config));
            const prevIdx = (curIdx - 1 + modes2.length) % modes2.length;
            strat2.setMode(this.config, modes2[prevIdx]);
          }
        } else {
          // Prev tab
          const tabIdx = TABS.indexOf(this.activeTab);
          this.setTab(TABS[(tabIdx - 1 + TABS.length) % TABS.length]);
        }
        break;
      case "\t": // Tab — cycle tabs forward
        {
          const tabIdx = TABS.indexOf(this.activeTab);
          this.setTab(TABS[(tabIdx + 1) % TABS.length]);
        }
        break;
      case "1": this.setTab("presets"); break;
      case "2": this.setTab("strategies"); break;
      case "3": this.setTab("pipeline"); break;
      case "o": // Toggle per-project override
        this.perProjectOverride = !this.perProjectOverride;
        if (!this.perProjectOverride) {
          // Remove project config file if it exists
          const projPath = projectConfigPath(this.projectDir);
          try { unlinkSync(projPath); } catch { /* ignore */ }
        }
        break;
      case "\x1b": // Escape
        if (this.searchQuery) {
          this.searchQuery = ""; // Clear search first
        } else {
          this.onClose?.();
        }
        break;
      case "s": // Save
        saveConfig(this.config, { perProject: this.perProjectOverride, cwd: this.projectDir });
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
    const overrideLabel = this.perProjectOverride
      ? `${ansi.yellow}Project override active${ansi.reset}`
      : `${ansi.dim}Using global config${ansi.reset}`;
    const presetLabel = presetName === "custom" ? "custom (modified)" : presetName;
    add(`${ansi.dim}Preset: ${presetLabel}  |  ${overrideLabel}${ansi.reset}`);

    // Tab bar
    add("");
    const tabLine = TABS.map((t) => {
      const label = t.charAt(0).toUpperCase() + t.slice(1);
      if (t === this.activeTab) {
        return ` ${ansi.bold}${ansi.cyan}${label}${ansi.reset} `;
      }
      return ` ${ansi.dim}${label}${ansi.reset} `;
    }).join("│");
    add(`┌${"─".repeat(Math.max(0, width - 2))}┐`);
    add(`│${tabLine}${" ".repeat(Math.max(0, width - tabLine.replace(/\x1b\[[0-9;]*m/g, "").length - 1))}│`);
    add(`├${"─".repeat(Math.max(0, width - 2))}┤`);

    if (this.activeTab === "presets") {
      this.renderPresetsTab(lines as string[], width);
    } else if (this.activeTab === "strategies") {
      this.renderStrategiesTab(lines as string[], width);
    } else {
      this.renderPipelineTab(lines as string[], width);
    }

    // Footer
    add(`├${"─".repeat(Math.max(0, width - 2))}┤`);
    add(`│ ${this.renderFooter(width - 2)} │`);
    add(`└${"─".repeat(Math.max(0, width - 2))}┘`);

    return lines;
  }

  private renderPresetsTab(lines: string[], width: number): void {
    const add = (s: string) => lines.push(truncateToWidth(s, width));
    add("");
    for (let i = 0; i < PRESETS.length; i++) {
      const isSelected = i === this.presetIndex;
      const prefix = isSelected ? `${ansi.cyan}▸${ansi.reset}` : " ";
      const name = PRESETS[i];
      const desc = PRESET_DESCRIPTIONS[name] ?? { summary: "", detail: "" };
      const label = isSelected ? `${ansi.bold}${name}${ansi.reset}` : name;
      add(`${prefix} ${label}`);
      add(`   ${ansi.dim}${desc.summary}${ansi.reset}`);

      // Preview details when selected
      if (isSelected) {
        const detailLines = desc.detail.split("\n");
        for (const dl of detailLines) {
          add(`   ${ansi.blue}${dl}${ansi.reset}`);
        }
      }
      add("");
    }
  }

  private renderStrategiesTab(lines: string[], width: number): void {
    const add = (s: string) => lines.push(truncateToWidth(s, width));

    // Search bar
    if (this.searchQuery) {
      add(`${ansi.yellow}/${this.searchQuery}${ansi.reset}`);
      add("");
    }

    const items = this.getVisibleItems();
    if (items.length === 0) {
      add("");
      add(`   ${ansi.gray}No matching strategies.${ansi.reset}`);
      add("");
    } else {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
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
        if (isSelected) add("");
      }
    }

    // Per-project override checkbox
    add("");
    const checkIcon = this.perProjectOverride ? CHECKBOX_ON : CHECKBOX_OFF;
    add(`   ${checkIcon} Override for this project${ansi.dim}  (press o to toggle)${ansi.reset}`);
  }

  private renderPipelineTab(lines: string[], width: number): void {
    const add = (s: string) => lines.push(truncateToWidth(s, width));

    const groups = new Map<string, PipelineItem[]>();
    for (const pi of PIPELINE_ITEMS) {
      const g = groups.get(pi.group) ?? [];
      g.push(pi);
      groups.set(pi.group, g);
    }

    for (const [group, items] of groups) {
      add(` ${ansi.bold}${group}${ansi.reset}`);
      add("");
      for (const item of items) {
        const idx = PIPELINE_ITEMS.indexOf(item);
        const isSelected = idx === this.selectedIndex;
        const on = item.getValue(this.config);
        const toggle = on ? TOGGLE_ON : TOGGLE_OFF;
        const labelColor = isSelected ? ansi.bold : "";
        const descColor = ansi.gray;

        const cursor = isSelected ? `${ansi.cyan}▸${ansi.reset}` : " ";
        add(`${cursor} ${toggle} ${labelColor}${item.label}${ansi.reset}`);
        add(`   ${descColor}${item.description}${ansi.reset}`);
        if (isSelected) add("");
      }
      add("");
    }
  }

  private renderFooter(width: number): string {
    const shortcuts = this.activeTab === "strategies" && this.searchQuery
      ? `${ansi.dim}Esc clear search${ansi.reset}`
      : `${ansi.dim}←→ mode${this.activeTab === "presets" ? " • Enter apply" : ""}${ansi.reset} ${ansi.dim}Space toggle${ansi.reset} ${ansi.dim}s save${ansi.reset} ${ansi.dim}Esc cancel${ansi.reset} ${ansi.dim}1/2/3 tabs${ansi.reset} ${this.activeTab === "strategies" ? `${ansi.dim}/ search${ansi.reset}` : ""}`;
    return shortcuts;
  }
}

/**
 * Factory function for ctx.ui.custom() integration.
 */
export function renderSettingsOverlay(cwd?: string) {
  return (_tui: any, _theme: any, _kb: any, done: (result: any) => void) => {
    const overlay = new CompactorSettingsOverlay({ cwd });
    overlay.onClose = () => done(overlay);

    return {
      render: (width: number) => overlay.render(width),
      invalidate: () => {},
      handleInput: (data: string) => overlay.handleInput(data),
    };
  };
}
