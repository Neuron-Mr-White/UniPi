/**
 * @pi-unipi/compactor — TUI Settings Overlay
 *
 * Interactive settings editor for compactor configuration.
 * Uses pi-tui SettingsList for proper keybinding support.
 * Tabbed sections (Presets / Strategies / Pipeline), search,
 * preset preview, per-project override.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth, SettingsList, type SettingItem, type SettingsListTheme } from "@mariozechner/pi-tui";
import { loadConfig, saveConfig, projectConfigPath } from "../config/manager.js";
import { applyPreset, detectPreset } from "../config/presets.js";
import type { CompactorPreset } from "../types.js";
import type { CompactorConfig } from "../types.js";
import { existsSync, unlinkSync } from "node:fs";

// ─── Section types ─────────────────────────────────────────────────────

type Section = "presets" | "strategies" | "pipeline";
const SECTIONS: Section[] = ["presets", "strategies", "pipeline"];

// ─── Strategy item definition ──────────────────────────────────────────

interface StrategyDef {
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
interface PipelineDef {
  key: string;
  label: string;
  description: string;
  group: string;
  getValue: (c: CompactorConfig) => boolean;
  setValue: (c: CompactorConfig, v: boolean) => void;
}

// ─── Static definitions ────────────────────────────────────────────────

const STRATEGIES: StrategyDef[] = [
  {
    key: "debug",
    label: "Verbose Debug",
    description: "Log ALL compaction events to console",
    modes: ["on", "off"],
    getEnabled: (c) => c.debug,
    setEnabled: (c, v) => (c.debug = v),
    getMode: (c) => (c.debug ? "on" : "off"),
    setMode: (c, v) => (c.debug = v === "on"),
  },
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

const PIPELINE_ITEMS: PipelineDef[] = [
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

// ─── Theme for SettingsList ────────────────────────────────────────────

const THEME: SettingsListTheme = {
  label: (text, selected) => selected ? `\x1b[1m${text}\x1b[0m` : `\x1b[2m${text}\x1b[0m`,
  value: (text, selected) => selected ? `\x1b[35m${text}\x1b[0m` : `\x1b[35m${text}\x1b[0m`,
  description: (text) => `\x1b[90m${text}\x1b[0m`,
  cursor: `\x1b[36m▸\x1b[0m`,
  hint: (text) => `\x1b[2m${text}\x1b[0m`,
};

// ─── Helper: frame a line inside box drawing ───────────────────────────

function frameLine(content: string, innerWidth: number): string {
  const truncated = truncateToWidth(content, innerWidth, "");
  const padding = Math.max(0, innerWidth - visibleWidth(truncated));
  return `\x1b[90m│\x1b[0m${truncated}${" ".repeat(padding)}\x1b[90m│\x1b[0m`;
}

function ruleLine(innerWidth: number): string {
  return `\x1b[90m├${"─".repeat(innerWidth)}┤\x1b[0m`;
}

function borderLine(innerWidth: number, edge: "top" | "bottom"): string {
  const left = edge === "top" ? "┌" : "└";
  const right = edge === "top" ? "┐" : "┘";
  return `\x1b[90m${left}${"─".repeat(innerWidth)}${right}\x1b[0m`;
}

// ─── Main component ────────────────────────────────────────────────────

/**
 * Settings overlay component for compactor configuration.
 * Uses SettingsList from pi-tui for proper vim/arrow keybinding support.
 */
export class CompactorSettingsOverlay implements Component {
  private config: CompactorConfig;
  private section: Section = "presets";
  private perProjectOverride = false;
  private projectDir: string;
  private saved = false;
  onClose?: () => void;

  // Per-section SettingsList instances
  private presetList!: SettingsList;
  private strategyList!: SettingsList;
  private pipelineList!: SettingsList;

  constructor(opts?: { cwd?: string }) {
    this.projectDir = opts?.cwd ?? process.cwd();
    this.config = loadConfig(this.projectDir);

    // Detect per-project override
    const projPath = projectConfigPath(this.projectDir);
    this.perProjectOverride = existsSync(projPath);

    this.buildLists();
  }

  invalidate(): void {
    this.currentList?.invalidate();
  }

  // ─── Build SettingsList instances ──────────────────────────────────

  private buildLists(): void {
    // ── Presets list ──────────────────────────────────────────────────
    const presetItems: SettingItem[] = PRESETS.map((name) => {
      const desc = PRESET_DESCRIPTIONS[name]!;
      return {
        id: `preset:${name}`,
        label: name.charAt(0).toUpperCase() + name.slice(1),
        description: desc.summary,
        currentValue: detectPreset(this.config) === name ? "✓ active" : "",
        values: ["apply"],
      };
    });
    // Add per-project override as a setting item
    presetItems.push({
      id: "projectOverride",
      label: "Project Override",
      description: "Override global config for this project only",
      currentValue: this.perProjectOverride ? "enabled" : "disabled",
      values: ["enabled", "disabled"],
    });

    this.presetList = new SettingsList(
      presetItems,
      8,
      THEME,
      (id, newValue) => this.onPresetChange(id, newValue),
      () => this.onCancel(),
    );

    // ── Strategies list ───────────────────────────────────────────────
    const strategyItems: SettingItem[] = STRATEGIES.map((s) => ({
      id: `strategy:${s.key}`,
      label: s.label,
      description: s.description,
      currentValue: this.formatStrategyValue(s),
      values: s.modes,
    }));

    this.strategyList = new SettingsList(
      strategyItems,
      12,
      THEME,
      (id, newValue) => this.onStrategyChange(id, newValue),
      () => this.onCancel(),
      { enableSearch: true },
    );

    // ── Pipeline list ─────────────────────────────────────────────────
    const pipelineItems: SettingItem[] = PIPELINE_ITEMS.map((p) => ({
      id: `pipeline:${p.key}`,
      label: `${p.group}: ${p.label}`,
      description: p.description,
      currentValue: p.getValue(this.config) ? "on" : "off",
      values: ["on", "off"],
    }));

    this.pipelineList = new SettingsList(
      pipelineItems,
      8,
      THEME,
      (id, newValue) => this.onPipelineChange(id, newValue),
      () => this.onCancel(),
    );
  }

  // ─── Current section's list ────────────────────────────────────────

  private get currentList(): SettingsList {
    if (this.section === "strategies") return this.strategyList;
    if (this.section === "pipeline") return this.pipelineList;
    return this.presetList;
  }

  // ─── Change handlers ───────────────────────────────────────────────

  private onPresetChange(id: string, _newValue: string): void {
    if (id === "projectOverride") {
      this.perProjectOverride = _newValue === "enabled";
      if (!this.perProjectOverride) {
        const projPath = projectConfigPath(this.projectDir);
        try { unlinkSync(projPath); } catch { /* ignore */ }
      }
      this.presetList.updateValue("projectOverride", this.perProjectOverride ? "enabled" : "disabled");
      return;
    }
    // Apply the preset
    const presetName = id.replace("preset:", "") as CompactorPreset;
    if (PRESETS.includes(presetName)) {
      this.config = applyPreset(presetName);
      // Update all strategy/pipeline items to reflect new config
      this.refreshStrategyValues();
      this.refreshPipelineValues();
      // Update preset indicators
      for (const name of PRESETS) {
        this.presetList.updateValue(
          `preset:${name}`,
          detectPreset(this.config) === name ? "✓ active" : "",
        );
      }
    }
  }

  private onStrategyChange(id: string, newValue: string): void {
    const key = id.replace("strategy:", "");
    const strat = STRATEGIES.find((s) => s.key === key);
    if (!strat) return;

    // Map the cycled value to enabled + mode
    strat.setMode(this.config, newValue);
    // If mode is "off", disable; otherwise enable
    strat.setEnabled(this.config, newValue !== "off");

    this.strategyList.updateValue(id, this.formatStrategyValue(strat));

    // Update preset indicators since config may no longer match a preset
    for (const name of PRESETS) {
      this.presetList.updateValue(
        `preset:${name}`,
        detectPreset(this.config) === name ? "✓ active" : "",
      );
    }
  }

  private onPipelineChange(id: string, newValue: string): void {
    const key = id.replace("pipeline:", "");
    const item = PIPELINE_ITEMS.find((p) => p.key === key);
    if (!item) return;
    item.setValue(this.config, newValue === "on");
    this.pipelineList.updateValue(id, newValue);

    // Update preset indicators
    for (const name of PRESETS) {
      this.presetList.updateValue(
        `preset:${name}`,
        detectPreset(this.config) === name ? "✓ active" : "",
      );
    }
  }

  private onCancel(): void {
    this.onClose?.();
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private formatStrategyValue(s: StrategyDef): string {
    const enabled = s.getEnabled(this.config);
    const mode = s.getMode(this.config);
    if (!enabled) return "off";
    return mode;
  }

  private refreshStrategyValues(): void {
    for (const s of STRATEGIES) {
      this.strategyList.updateValue(`strategy:${s.key}`, this.formatStrategyValue(s));
    }
  }

  private refreshPipelineValues(): void {
    for (const p of PIPELINE_ITEMS) {
      this.pipelineList.updateValue(`pipeline:${p.key}`, p.getValue(this.config) ? "on" : "off");
    }
  }

  // ─── Input handling ────────────────────────────────────────────────

  handleInput(data: string): void {
    // Tab switches section
    if (data === "\t" || data === "\x1b[Z") {
      const idx = SECTIONS.indexOf(this.section);
      this.section = SECTIONS[(idx + 1) % SECTIONS.length];
      return;
    }

    // Enter saves and closes
    if (data === "\r") {
      saveConfig(this.config, { perProject: this.perProjectOverride, cwd: this.projectDir });
      this.saved = true;
      setTimeout(() => this.onClose?.(), 400);
      return;
    }

    // Escape cancels (but SettingsList also handles it, calling onCancel)
    if (data === "\x1b") {
      this.onClose?.();
      return;
    }

    // Delegate all other input to the current section's SettingsList
    this.currentList.handleInput(data);
  }

  // ─── Render ────────────────────────────────────────────────────────

  render(width: number): string[] {
    const innerWidth = Math.max(22, width - 2);
    const lines: string[] = [];

    // Header
    lines.push(borderLine(innerWidth, "top"));
    lines.push(frameLine(`\x1b[1m\x1b[36m🗜️  Compactor Settings\x1b[0m`, innerWidth));

    // Current preset indicator
    const presetName = detectPreset(this.config);
    const presetLabel = presetName === "custom" ? "custom (modified)" : presetName;
    const overrideLabel = this.perProjectOverride
      ? `\x1b[33mProject override\x1b[0m`
      : `\x1b[2mGlobal config\x1b[0m`;
    lines.push(frameLine(`\x1b[2mPreset: ${presetLabel}  ·  ${overrideLabel}\x1b[0m`, innerWidth));
    lines.push(ruleLine(innerWidth));

    // Section tabs
    const tabParts = SECTIONS.map((s) => {
      const label = s.charAt(0).toUpperCase() + s.slice(1);
      if (s === this.section) {
        return `\x1b[1m\x1b[36m[${label}]\x1b[0m`;
      }
      return `\x1b[2m${label}\x1b[0m`;
    });
    lines.push(frameLine(`  ${tabParts.join("  ")}`, innerWidth));
    lines.push(ruleLine(innerWidth));

    // Section content (rendered by SettingsList)
    const contentLines = this.currentList.render(innerWidth - 2);
    for (const line of contentLines) {
      lines.push(frameLine(` ${line}`, innerWidth));
    }

    // Saved indicator
    if (this.saved) {
      lines.push(ruleLine(innerWidth));
      lines.push(frameLine(`  \x1b[32m✓ Settings saved\x1b[0m`, innerWidth));
    }

    // Footer hints
    lines.push(ruleLine(innerWidth));
    const hints = this.section === "strategies"
      ? "↑↓ navigate · Space change · Tab switch · / search · Enter save · Esc cancel"
      : "↑↓ navigate · Space change · Tab switch · Enter save · Esc cancel";
    lines.push(frameLine(`\x1b[2m${hints}\x1b[0m`, innerWidth));
    lines.push(borderLine(innerWidth, "bottom"));

    return lines;
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
      invalidate: () => overlay.invalidate(),
      handleInput: (data: string) => overlay.handleInput(data),
    };
  };
}
