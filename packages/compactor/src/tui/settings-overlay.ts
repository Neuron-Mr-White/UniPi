/**
 * @pi-unipi/compactor — TUI Settings Overlay
 *
 * Interactive settings editor for compactor configuration.
 * Uses pi-tui SettingsList for proper keybinding support.
 * Tabbed sections (Presets / Strategies / Pipeline), search,
 * preset preview, per-project override.
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, SettingsList, type SettingItem, type SettingsListTheme } from "@earendil-works/pi-tui";
import type { Theme, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig, projectConfigPath } from "../config/manager.js";
import { applyPreset, detectPreset } from "../config/presets.js";
import type { CompactorPreset } from "../types.js";
import type { CompactorConfig } from "../types.js";
import { existsSync, unlinkSync } from "node:fs";
import { boxInnerWidth, OverlayTheme } from "@pi-unipi/core";

// ─── Section types ─────────────────────────────────────────────────────

type Section = "presets" | "strategies" | "auto" | "pipeline";
const SECTIONS: Section[] = ["presets", "strategies", "auto", "pipeline"];

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
    modes: ["full", "off"],
    getEnabled: (c) => c.sessionContinuity.enabled,
    setEnabled: (c, v) => (c.sessionContinuity.enabled = v),
    getMode: (c) => c.sessionContinuity.mode,
    setMode: (c, v) => (c.sessionContinuity.mode = v as any),
  },
  {
    key: "sandboxExecution",
    label: "Sandbox Execution",
    description: "Polyglot code execution",
    modes: ["all", "off"],
    getEnabled: (c) => c.sandboxExecution.enabled,
    setEnabled: (c, v) => (c.sandboxExecution.enabled = v),
    getMode: (c) => c.sandboxExecution.mode,
    setMode: (c, v) => (c.sandboxExecution.mode = v as any),
  },
];

const PIPELINE_ITEMS: PipelineDef[] = [
  // Only expose implemented behavior. Reserved compatibility fields remain in
  // the persisted schema so existing config files continue to load.
  { key: "autoInjection", label: "Auto Injection", description: "Inject behavioral state after compaction", group: "On Compaction", getValue: (c) => c.pipeline.autoInjection, setValue: (c, v) => (c.pipeline.autoInjection = v) },
];

const PRESETS: CompactorPreset[] = ["precise", "balanced", "thorough", "lean"];

const THRESHOLD_VALUES = ["60%", "70%", "75%", "80%", "85%", "90%", "95%"];
const COOLDOWN_VALUES = ["0s", "30s", "60s", "5m", "10m"];
const REPEAT_GROWTH_VALUES = ["0", "1k", "4k", "8k", "16k", "32k"];

const PRESET_DESCRIPTIONS: Record<string, { summary: string; detail: string }> = {
  precise: {
    summary: "Code-heavy, minimal waste — compaction: full, sandbox: all",
    detail: "Max token savings. Compaction: full.\nSandbox: all. Auto injection: off.",
  },
  balanced: {
    summary: "Daily use (default) — all strategies moderate",
    detail: "Moderate all strategies.\nSandbox: all. Auto injection: on.",
  },
  thorough: {
    summary: "Debug/audit — everything on, full transcript",
    detail: "Everything enabled.\nSandbox: all. Auto injection: on.",
  },
  lean: {
    summary: "Quick fixes, short sessions — compaction only",
    detail: "Compaction only.\nSandbox: off. Auto injection: off.",
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

// ─── Shared box-drawing helper ────────────────────────────────────────

const overlay = new OverlayTheme();


function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function parsePercent(value: string): number {
  return Number(value.replace("%", ""));
}

function formatCooldown(ms: number): string {
  if (ms === 0) return "0s";
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

function parseCooldown(value: string): number {
  if (value.endsWith("m")) return Number(value.slice(0, -1)) * 60_000;
  if (value.endsWith("s")) return Number(value.slice(0, -1)) * 1000;
  return Number(value);
}

function formatGrowthTokens(tokens: number): string {
  if (tokens >= 1000 && tokens % 1000 === 0) return `${tokens / 1000}k`;
  return String(tokens);
}

function parseGrowthTokens(value: string): number {
  if (value.endsWith("k")) return Number(value.slice(0, -1)) * 1000;
  return Number(value);
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
  private autoList!: SettingsList;
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

    // ── Auto-compaction trigger list ──────────────────────────────────
    const autoItems: SettingItem[] = [
      {
        id: "auto:enabled",
        label: "Percentage Trigger",
        description: "UniPi-managed auto-compaction based on context percentage",
        currentValue: this.config.autoCompaction.enabled ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "auto:thresholdPercent",
        label: "Threshold",
        description: "Trigger when Pi reports context usage at or above this percent",
        currentValue: formatPercent(this.config.autoCompaction.thresholdPercent),
        values: uniqueValues([...THRESHOLD_VALUES, formatPercent(this.config.autoCompaction.thresholdPercent)]),
      },
      {
        id: "auto:cooldownMs",
        label: "Cooldown",
        description: "Minimum delay between UniPi-triggered compaction attempts",
        currentValue: formatCooldown(this.config.autoCompaction.cooldownMs),
        values: uniqueValues([...COOLDOWN_VALUES, formatCooldown(this.config.autoCompaction.cooldownMs)]),
      },
      {
        id: "auto:repeatMinGrowthTokens",
        label: "Repeat Growth",
        description: "If still above threshold after compaction, require this many new tokens",
        currentValue: formatGrowthTokens(this.config.autoCompaction.repeatMinGrowthTokens),
        values: uniqueValues([...REPEAT_GROWTH_VALUES, formatGrowthTokens(this.config.autoCompaction.repeatMinGrowthTokens)]),
      },
      {
        id: "auto:notify",
        label: "Notifications",
        description: "Notify when UniPi auto-compaction triggers or fails",
        currentValue: this.config.autoCompaction.notify ? "on" : "off",
        values: ["on", "off"],
      },
    ];

    this.autoList = new SettingsList(
      autoItems,
      8,
      THEME,
      (id, newValue) => this.onAutoChange(id, newValue),
      () => this.onCancel(),
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
    if (this.section === "auto") return this.autoList;
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
      // Update all strategy/auto/pipeline items to reflect new config
      this.refreshStrategyValues();
      this.refreshAutoValues();
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

  private onAutoChange(id: string, newValue: string): void {
    const key = id.replace("auto:", "");
    switch (key) {
      case "enabled":
        this.config.autoCompaction.enabled = newValue === "on";
        break;
      case "thresholdPercent":
        this.config.autoCompaction.thresholdPercent = parsePercent(newValue);
        break;
      case "cooldownMs":
        this.config.autoCompaction.cooldownMs = parseCooldown(newValue);
        break;
      case "repeatMinGrowthTokens":
        this.config.autoCompaction.repeatMinGrowthTokens = parseGrowthTokens(newValue);
        break;
      case "notify":
        this.config.autoCompaction.notify = newValue === "on";
        break;
      default:
        return;
    }

    this.autoList.updateValue(id, this.formatAutoValue(key));

    // Update preset indicators
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

  private formatAutoValue(key: string): string {
    const auto = this.config.autoCompaction;
    switch (key) {
      case "enabled": return auto.enabled ? "on" : "off";
      case "thresholdPercent": return formatPercent(auto.thresholdPercent);
      case "cooldownMs": return formatCooldown(auto.cooldownMs);
      case "repeatMinGrowthTokens": return formatGrowthTokens(auto.repeatMinGrowthTokens);
      case "notify": return auto.notify ? "on" : "off";
      default: return "";
    }
  }

  private refreshStrategyValues(): void {
    for (const s of STRATEGIES) {
      this.strategyList.updateValue(`strategy:${s.key}`, this.formatStrategyValue(s));
    }
  }

  private refreshAutoValues(): void {
    for (const key of ["enabled", "thresholdPercent", "cooldownMs", "repeatMinGrowthTokens", "notify"]) {
      this.autoList.updateValue(`auto:${key}`, this.formatAutoValue(key));
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
    if (data === "\t" || matchesKey(data, Key.shift("tab"))) {
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
    if (matchesKey(data, "escape")) {
      this.onClose?.();
      return;
    }

    // Delegate all other input to the current section's SettingsList
    this.currentList.handleInput(data);
  }

  // ─── Render ────────────────────────────────────────────────────────

  render(width: number): string[] {
    const innerWidth = boxInnerWidth(width);
    const lines: string[] = [];

    // Header
    lines.push(overlay.borderLine(innerWidth, "top"));
    lines.push(overlay.frameLine(`\x1b[1m\x1b[36m🗜️  Compactor Settings\x1b[0m`, innerWidth));

    // Current preset indicator
    const presetName = detectPreset(this.config);
    const presetLabel = presetName === "custom" ? "custom (modified)" : presetName;
    const overrideLabel = this.perProjectOverride
      ? `\x1b[33mProject override\x1b[0m`
      : `\x1b[2mGlobal config\x1b[0m`;
    lines.push(overlay.frameLine(`\x1b[2mPreset: ${presetLabel}  ·  ${overrideLabel}\x1b[0m`, innerWidth));
    lines.push(overlay.ruleLine(innerWidth));

    // Section tabs
    const tabParts = SECTIONS.map((s) => {
      const label = s.charAt(0).toUpperCase() + s.slice(1);
      if (s === this.section) {
        return `\x1b[1m\x1b[36m[${label}]\x1b[0m`;
      }
      return `\x1b[2m${label}\x1b[0m`;
    });
    lines.push(overlay.frameLine(`  ${tabParts.join("  ")}`, innerWidth));
    lines.push(overlay.ruleLine(innerWidth));

    // Section content (rendered by SettingsList)
    const contentLines = this.currentList.render(innerWidth - 2);
    for (const line of contentLines) {
      lines.push(overlay.frameLine(` ${line}`, innerWidth));
    }

    // Saved indicator
    if (this.saved) {
      lines.push(overlay.ruleLine(innerWidth));
      lines.push(overlay.frameLine(`  \x1b[32m✓ Settings saved\x1b[0m`, innerWidth));
    }

    // Footer hints
    lines.push(overlay.ruleLine(innerWidth));
    const hints = this.section === "strategies"
      ? "↑↓ navigate · Space change · Tab switch · / search · Enter save · Esc cancel"
      : "↑↓ navigate · Space change · Tab switch · Enter save · Esc cancel";
    lines.push(overlay.frameLine(`\x1b[2m${hints}\x1b[0m`, innerWidth));
    lines.push(overlay.borderLine(innerWidth, "bottom"));

    return lines;
  }
}

/**
 * Factory function for ctx.ui.custom() integration.
 */
export function renderSettingsOverlay(cwd?: string) {
  return (_tui: TUI, _theme: Theme, _kb: KeybindingsManager, done: (result: CompactorSettingsOverlay) => void) => {
    const overlay = new CompactorSettingsOverlay({ cwd });
    overlay.onClose = () => done(overlay);

    return {
      render: (width: number) => overlay.render(width),
      invalidate: () => overlay.invalidate(),
      handleInput: (data: string) => overlay.handleInput(data),
    };
  };
}
