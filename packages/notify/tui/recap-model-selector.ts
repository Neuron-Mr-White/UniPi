/**
 * @pi-unipi/notify — Recap Model Selector TUI
 *
 * Interactive overlay for selecting the recap summarization model.
 * Uses the project-wide cached model list from ~/.unipi/config/models-cache.json.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { readModelCache, type CachedModel } from "@pi-unipi/core";
import { loadConfig, saveConfig } from "../settings.js";

const DEFAULT_MODEL = "openrouter/openai/gpt-oss-20b";

/**
 * Model selector overlay for recap model selection.
 */
export class RecapModelSelectorOverlay implements Component {
  private models: CachedModel[] = [];
  private filteredModels: CachedModel[] = [];
  private selectedIndex = 0;
  private filter = "";
  private filterMode = false;
  private saved = false;
  private error: string | null = null;
  onClose?: () => void;
  requestRender?: () => void;
  private theme: Theme | null = null;

  constructor() {
    // Load cached models and filter to openrouter provider
    const allModels = readModelCache();
    this.models = allModels.filter((m) => m.provider === "openrouter");
    this.applyFilter();

    // Pre-select current config model
    const config = loadConfig();
    const currentModel = config.recap.model;
    const idx = this.filteredModels.findIndex(
      (m) => `${m.provider}/${m.id}` === currentModel
    );
    if (idx >= 0) this.selectedIndex = idx;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    // Filter mode: type to search
    if (this.filterMode) {
      if (data === "\r") {
        // Enter — exit filter mode
        this.filterMode = false;
        return;
      }
      if (data === "\x1b") {
        // Escape — clear filter and exit filter mode
        this.filter = "";
        this.filterMode = false;
        this.applyFilter();
        this.selectedIndex = 0;
        return;
      }
      if (data === "\x7f" || data === "\b") {
        // Backspace
        this.filter = this.filter.slice(0, -1);
        this.applyFilter();
        this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
        return;
      }
      if (data.length === 1 && data >= " ") {
        this.filter += data;
        this.applyFilter();
        this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
        return;
      }
      return;
    }

    switch (data) {
      case "\x1b[A": // Up
      case "k":
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        break;
      case "\x1b[B": // Down
      case "j":
        this.selectedIndex = Math.min(
          this.filteredModels.length - 1,
          this.selectedIndex + 1
        );
        break;
      case "/": // Start filter
        this.filterMode = true;
        this.filter = "";
        break;
      case "\r": // Enter — select and save
        this.selectModel();
        break;
      case "\x1b": // Escape — close
        this.onClose?.();
        break;
    }
  }

  private applyFilter(): void {
    const q = this.filter.toLowerCase();
    if (!q) {
      this.filteredModels = [...this.models];
    } else {
      this.filteredModels = this.models.filter(
        (m) =>
          m.id.toLowerCase().includes(q) ||
          (m.name?.toLowerCase().includes(q) ?? false)
      );
    }
  }

  private selectModel(): void {
    const model = this.filteredModels[this.selectedIndex];
    if (!model) {
      this.error = "No model selected";
      return;
    }

    const modelRef = `${model.provider}/${model.id}`;
    const config = loadConfig();
    config.recap.model = modelRef;
    saveConfig(config);
    this.saved = true;
    this.error = null;
    setTimeout(() => this.onClose?.(), 500);
  }

  // ─── Theme helpers ───────────────────────────────────────────────────

  private fg(color: string, text: string): string {
    if (this.theme) return this.theme.fg(color as any, text);
    const c: Record<string, string> = {
      accent: "\x1b[36m",
      success: "\x1b[32m",
      warning: "\x1b[33m",
      error: "\x1b[31m",
      dim: "\x1b[2m",
      borderMuted: "\x1b[90m",
    };
    return `${c[color] ?? ""}${text}\x1b[0m`;
  }

  private bold(text: string): string {
    return this.theme ? this.theme.bold(text) : `\x1b[1m${text}\x1b[0m`;
  }

  private frameLine(content: string, innerWidth: number): string {
    const truncated = truncateToWidth(content, innerWidth, "");
    const padding = Math.max(0, innerWidth - visibleWidth(truncated));
    return `${this.fg("borderMuted", "│")}${truncated}${" ".repeat(padding)}${this.fg("borderMuted", "│")}`;
  }

  private ruleLine(innerWidth: number): string {
    return this.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`);
  }

  private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
    const left = edge === "top" ? "┌" : "└";
    const right = edge === "top" ? "┐" : "┘";
    return this.fg("borderMuted", `${left}${"─".repeat(innerWidth)}${right}`);
  }

  render(width: number): string[] {
    const innerWidth = Math.max(40, width - 2);
    const lines: string[] = [];

    lines.push(this.borderLine(innerWidth, "top"));
    lines.push(
      this.frameLine(
        this.fg("accent", this.bold("🤖 Recap Model Selector")),
        innerWidth
      )
    );
    lines.push(
      this.frameLine(
        this.fg("dim", "Select model for notification recaps"),
        innerWidth
      )
    );
    lines.push(this.ruleLine(innerWidth));

    // Filter bar
    if (this.filterMode) {
      lines.push(
        this.frameLine(
          `  ${this.fg("accent", "Filter:")} ${this.filter}${this.fg("accent", "█")}`,
          innerWidth
        )
      );
    } else if (this.filter) {
      lines.push(
        this.frameLine(
          `  ${this.fg("dim", "Filter:")} ${this.filter} ${this.fg("dim", "(press / to edit)")}`,
          innerWidth
        )
      );
    } else {
      lines.push(
        this.frameLine(
          `  ${this.fg("dim", `/${this.models.length} models · press / to filter`)}`,
          innerWidth
        )
      );
    }
    lines.push(this.ruleLine(innerWidth));

    // Model list
    const terminalRows = process.stdout.rows ?? 30;
    const maxVisible = Math.max(5, terminalRows - 14);
    const startIdx = Math.max(
      0,
      this.selectedIndex - Math.floor(maxVisible / 2)
    );
    const endIdx = Math.min(
      this.filteredModels.length,
      startIdx + maxVisible
    );

    if (this.filteredModels.length === 0) {
      lines.push(
        this.frameLine(
          `  ${this.fg("dim", "No models found")}`,
          innerWidth
        )
      );
    } else {
      for (let i = startIdx; i < endIdx; i++) {
        const m = this.filteredModels[i];
        const isSelected = i === this.selectedIndex;
        const marker = isSelected ? this.fg("accent", "▸") : " ";
        const label = m.name || m.id;
        const fullRef = `${m.provider}/${m.id}`;
        const isDefault = fullRef === DEFAULT_MODEL;
        const defaultTag = isDefault
          ? ` ${this.fg("warning", "(default)")}`
          : "";

        const display = isSelected
          ? `${this.bold(label)}${defaultTag} ${this.fg("dim", fullRef)}`
          : `${this.fg("dim", label)}${defaultTag}`;

        lines.push(this.frameLine(`  ${marker} ${display}`, innerWidth));
      }
    }

    // Scroll indicator
    if (this.filteredModels.length > maxVisible) {
      const pct = Math.round(
        ((this.selectedIndex + 1) / this.filteredModels.length) * 100
      );
      lines.push(
        this.frameLine(
          this.fg("dim", `  ${pct}% (${this.selectedIndex + 1}/${this.filteredModels.length})`),
          innerWidth
        )
      );
    }

    // Status messages
    if (this.error) {
      lines.push(this.ruleLine(innerWidth));
      lines.push(
        this.frameLine(`  ${this.fg("error", `⚠ ${this.error}`)}`, innerWidth)
      );
    }
    if (this.saved) {
      lines.push(this.ruleLine(innerWidth));
      lines.push(
        this.frameLine(
          `  ${this.fg("success", "✓ Model saved")}`,
          innerWidth
        )
      );
    }

    // Footer
    lines.push(this.ruleLine(innerWidth));
    lines.push(
      this.frameLine(
        this.fg(
          "dim",
          "↑↓ navigate · / filter · Enter select · Esc cancel"
        ),
        innerWidth
      )
    );
    lines.push(this.borderLine(innerWidth, "bottom"));

    return lines;
  }
}
