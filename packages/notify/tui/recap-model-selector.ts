/**
 * @pi-unipi/notify — Recap Model Selector TUI
 *
 * Interactive overlay for selecting the recap summarization model.
 * Uses models injected from Pi's live model registry (preferred), falling back
 * to the project-wide cached model list from ~/.unipi/config/models-cache.json.
 */

import type { Component } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { readModelCache, type CachedModel, boxInnerWidth, OverlayTheme } from "@pi-unipi/core";
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
  private overlay = new OverlayTheme();

  /**
   * @param models Optional model list, preferably collected from Pi's live
   *   model registry by the command handler. Falls back to the project-wide
   *   cache file (`~/.unipi/config/models-cache.json`), which may not exist
   *   (issue #27: selector showed "No models found" while Pi itself had
   *   models configured in `~/.pi/agent/models.json`).
   */
  constructor(models?: CachedModel[]) {
    // Prefer models injected from Pi's live model registry; fall back to cache.
    this.models = models ?? readModelCache();
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
    this.overlay.setTheme(theme);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    // Ctrl+C must always close, even mid-filter — without this the overlay
    // could trap the user on terminals with unexpected key encodings.
    if (matchesKey(data, "ctrl+c")) {
      this.onClose?.();
      return;
    }

    // Filter mode: type to search
    if (this.filterMode) {
      if (matchesKey(data, "enter")) {
        // Enter — exit filter mode
        this.filterMode = false;
        return;
      }
      if (matchesKey(data, "escape")) {
        // Escape — clear filter and exit filter mode (does NOT close overlay)
        this.filter = "";
        this.filterMode = false;
        this.applyFilter();
        this.selectedIndex = 0;
        return;
      }
      // Let the list be navigated without leaving filter mode.
      if (matchesKey(data, "up")) {
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        return;
      }
      if (matchesKey(data, "down")) {
        this.selectedIndex = Math.min(
          Math.max(0, this.filteredModels.length - 1),
          this.selectedIndex + 1
        );
        return;
      }
      if (matchesKey(data, "backspace") || data === "\x7f" || data === "\b") {
        // Backspace (legacy or kitty "\x1b[127u")
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

    // Keys are matched via matchesKey, never raw byte comparison: under the
    // kitty keyboard protocol / enhanced encodings (Ghostty, Herdr) Escape
    // arrives as "\x1b[27u" and arrows as "\x1b[57419u"/"\x1b[57420u", so
    // exact legacy comparisons silently fail there (issue #27).
    if (matchesKey(data, "up") || data === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.selectedIndex = Math.min(
        Math.max(0, this.filteredModels.length - 1),
        this.selectedIndex + 1
      );
      return;
    }
    if (data === "/") {
      // Start filter
      this.filterMode = true;
      this.filter = "";
      return;
    }
    if (matchesKey(data, "enter")) {
      // Enter — select and save
      this.selectModel();
      return;
    }
    if (matchesKey(data, "escape")) {
      // Escape — close
      this.onClose?.();
      return;
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

  render(width: number): string[] {
    const innerWidth = boxInnerWidth(width);
    const lines: string[] = [];

    lines.push(this.overlay.borderLine(innerWidth, "top"));
    lines.push(
      this.overlay.frameLine(
        this.overlay.fg("accent", this.overlay.bold("🤖 Recap Model Selector")),
        innerWidth
      )
    );
    lines.push(
      this.overlay.frameLine(
        this.overlay.fg("dim", "Select model for notification recaps"),
        innerWidth
      )
    );
    lines.push(this.overlay.ruleLine(innerWidth));

    // Filter bar
    if (this.filterMode) {
      lines.push(
        this.overlay.frameLine(
          `  ${this.overlay.fg("accent", "Filter:")} ${this.filter}${this.overlay.fg("accent", "█")}`,
          innerWidth
        )
      );
    } else if (this.filter) {
      lines.push(
        this.overlay.frameLine(
          `  ${this.overlay.fg("dim", "Filter:")} ${this.filter} ${this.overlay.fg("dim", "(press / to edit)")}`,
          innerWidth
        )
      );
    } else {
      lines.push(
        this.overlay.frameLine(
          `  ${this.overlay.fg("dim", `/${this.models.length} models · press / to filter`)}`,
          innerWidth
        )
      );
    }
    lines.push(this.overlay.ruleLine(innerWidth));

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
      const emptyMsg =
        this.filter.length > 0
          ? `No models match "${this.filter}"`
          : this.models.length === 0
            ? "No models — check ~/.pi/agent/models.json or API keys, then reopen"
            : "No models found";
      lines.push(
        this.overlay.frameLine(
          `  ${this.overlay.fg("dim", emptyMsg)}`,
          innerWidth
        )
      );
    } else {
      for (let i = startIdx; i < endIdx; i++) {
        const m = this.filteredModels[i];
        const isSelected = i === this.selectedIndex;
        const marker = isSelected ? this.overlay.fg("accent", "▸") : " ";
        const label = m.name || m.id;
        const fullRef = `${m.provider}/${m.id}`;
        const isDefault = fullRef === DEFAULT_MODEL;
        const defaultTag = isDefault
          ? ` ${this.overlay.fg("warning", "(default)")}`
          : "";

        const providerTag = this.overlay.fg("dim", `[${m.provider}]`);
        const display = isSelected
          ? `${providerTag} ${this.overlay.bold(label)}${defaultTag}`
          : `${providerTag} ${this.overlay.fg("dim", label)}${defaultTag}`;

        lines.push(this.overlay.frameLine(`  ${marker} ${display}`, innerWidth));
      }
    }

    // Scroll indicator
    if (this.filteredModels.length > maxVisible) {
      const pct = Math.round(
        ((this.selectedIndex + 1) / this.filteredModels.length) * 100
      );
      lines.push(
        this.overlay.frameLine(
          this.overlay.fg("dim", `  ${pct}% (${this.selectedIndex + 1}/${this.filteredModels.length})`),
          innerWidth
        )
      );
    }

    // Status messages
    if (this.error) {
      lines.push(this.overlay.ruleLine(innerWidth));
      lines.push(
        this.overlay.frameLine(`  ${this.overlay.fg("error", `⚠ ${this.error}`)}`, innerWidth)
      );
    }
    if (this.saved) {
      lines.push(this.overlay.ruleLine(innerWidth));
      lines.push(
        this.overlay.frameLine(
          `  ${this.overlay.fg("success", "✓ Model saved")}`,
          innerWidth
        )
      );
    }

    // Footer
    lines.push(this.overlay.ruleLine(innerWidth));
    lines.push(
      this.overlay.frameLine(
        this.overlay.fg(
          "dim",
          "↑↓ navigate · / filter · Enter select · Esc cancel"
        ),
        innerWidth
      )
    );
    lines.push(this.overlay.borderLine(innerWidth, "bottom"));

    return lines;
  }
}
