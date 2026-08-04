/**
 * @pi-unipi/image — Model selector overlay
 *
 * Picks either an image-generation model (from pi-ai's image catalog) or a
 * vision model (from pi's chat registry, filtered to image-capable models).
 */

import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { boxInnerWidth, safeRepeat } from "@pi-unipi/core";

export interface SelectableModel {
  provider: string;
  id: string;
  name?: string;
}

export type ModelSelectorKind = "generate" | "recognize";

/** Overlay listing models with filter, navigation and selection. */
export class ImageModelSelectorOverlay implements Component {
  private models: SelectableModel[] = [];
  private filtered: SelectableModel[] = [];
  private selectedIndex = 0;
  private filter = "";
  private filterMode = false;
  private saved = false;
  private error: string | null = null;
  private theme: Theme | null = null;

  onClose?: () => void;
  onSelect?: (modelRef: string) => void;
  requestRender?: () => void;

  constructor(
    private readonly kind: ModelSelectorKind,
    models: SelectableModel[],
    currentRef?: string,
  ) {
    this.models = models;
    this.applyFilter();

    if (currentRef) {
      const index = this.filtered.findIndex(
        (m) => `${m.provider}/${m.id}` === currentRef,
      );
      if (index >= 0) this.selectedIndex = index;
    }
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    // Ctrl+C must always escape, even mid-filter. Without this the overlay traps
    // the user with no way out.
    if (data === "\x03") {
      this.onClose?.();
      return;
    }

    if (this.filterMode) {
      this.handleFilterInput(data);
      return;
    }

    switch (data) {
      case "\x1b[A":
      case "k":
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        break;
      case "\x1b[B":
      case "j":
        this.selectedIndex = Math.min(this.filtered.length - 1, this.selectedIndex + 1);
        break;
      case "/":
        this.filterMode = true;
        this.filter = "";
        break;
      case "\r":
        this.commit();
        break;
      case "\x1b":
        this.onClose?.();
        break;
    }
  }

  private handleFilterInput(data: string): void {
    if (data === "\r") {
      this.filterMode = false;
      return;
    }
    if (data === "\x1b") {
      this.filter = "";
      this.filterMode = false;
      this.applyFilter();
      this.selectedIndex = 0;
      return;
    }
    if (data === "\x7f" || data === "\b") {
      this.filter = this.filter.slice(0, -1);
      this.applyFilter();
      this.clampSelection();
      return;
    }
    if (data.length === 1 && data >= " ") {
      this.filter += data;
      this.applyFilter();
      this.clampSelection();
    }
  }

  private clampSelection(): void {
    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, this.filtered.length - 1),
    );
  }

  private applyFilter(): void {
    const query = this.filter.toLowerCase();
    this.filtered = query
      ? this.models.filter(
          (m) =>
            m.id.toLowerCase().includes(query) ||
            m.provider.toLowerCase().includes(query) ||
            (m.name?.toLowerCase().includes(query) ?? false),
        )
      : [...this.models];
  }

  private commit(): void {
    const model = this.filtered[this.selectedIndex];
    if (!model) {
      this.error = "No model selected";
      return;
    }

    this.onSelect?.(`${model.provider}/${model.id}`);
    this.saved = true;
    this.error = null;
    // Close immediately. A deferred close leaves the overlay focused while the
    // caller resumes, which is what let input reach two components at once.
    this.onClose?.();
  }

  // ─── Theme helpers ───────────────────────────────────────────────────

  private fg(color: string, text: string): string {
    if (this.theme) return this.theme.fg(color as never, text);
    const codes: Record<string, string> = {
      accent: "\x1b[36m",
      success: "\x1b[32m",
      warning: "\x1b[33m",
      error: "\x1b[31m",
      dim: "\x1b[2m",
      borderMuted: "\x1b[90m",
    };
    return `${codes[color] ?? ""}${text}\x1b[0m`;
  }

  private bold(text: string): string {
    return this.theme ? this.theme.bold(text) : `\x1b[1m${text}\x1b[0m`;
  }

  private frameLine(content: string, innerWidth: number): string {
    const truncated = truncateToWidth(content, innerWidth, "");
    const padding = safeRepeat(" ", innerWidth - visibleWidth(truncated));
    return `${this.fg("borderMuted", "│")}${truncated}${padding}${this.fg("borderMuted", "│")}`;
  }

  private ruleLine(innerWidth: number): string {
    return this.fg("borderMuted", `├${safeRepeat("─", innerWidth)}┤`);
  }

  private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
    const left = edge === "top" ? "┌" : "└";
    const right = edge === "top" ? "┐" : "┘";
    return this.fg("borderMuted", `${left}${safeRepeat("─", innerWidth)}${right}`);
  }

  render(width: number): string[] {
    const innerWidth = boxInnerWidth(width);
    const lines: string[] = [];

    const title =
      this.kind === "generate"
        ? "🎨 Image Generation Model"
        : "👁  Image Recognition Model";
    const subtitle =
      this.kind === "generate"
        ? "Model used by image_generate"
        : "Vision model used by image_recognize";

    lines.push(this.borderLine(innerWidth, "top"));
    lines.push(this.frameLine(this.fg("accent", this.bold(title)), innerWidth));
    lines.push(this.frameLine(this.fg("dim", subtitle), innerWidth));
    lines.push(this.ruleLine(innerWidth));

    // Filter bar
    if (this.filterMode) {
      lines.push(
        this.frameLine(
          `  ${this.fg("accent", "Filter:")} ${this.filter}${this.fg("accent", "█")}`,
          innerWidth,
        ),
      );
    } else if (this.filter) {
      lines.push(
        this.frameLine(
          `  ${this.fg("dim", "Filter:")} ${this.filter} ${this.fg("dim", "(press / to edit)")}`,
          innerWidth,
        ),
      );
    } else {
      lines.push(
        this.frameLine(
          `  ${this.fg("dim", `${this.models.length} models · press / to filter`)}`,
          innerWidth,
        ),
      );
    }
    lines.push(this.ruleLine(innerWidth));

    // Model list
    const terminalRows = process.stdout.rows ?? 30;
    const maxVisible = Math.max(5, terminalRows - 14);
    const start = Math.max(0, this.selectedIndex - Math.floor(maxVisible / 2));
    const end = Math.min(this.filtered.length, start + maxVisible);

    if (this.filtered.length === 0) {
      const empty =
        this.models.length === 0
          ? this.kind === "generate"
            ? "No image models available (needs OpenRouter)"
            : "No vision-capable models configured"
          : "No models match the filter";
      lines.push(this.frameLine(`  ${this.fg("dim", empty)}`, innerWidth));
    } else {
      for (let i = start; i < end; i++) {
        const model = this.filtered[i];
        const isSelected = i === this.selectedIndex;
        const marker = isSelected ? this.fg("accent", "▸") : " ";
        const label = model.name || model.id;
        const providerTag = this.fg("dim", `[${model.provider}]`);
        const display = isSelected
          ? `${providerTag} ${this.bold(label)}`
          : `${providerTag} ${this.fg("dim", label)}`;
        lines.push(this.frameLine(`  ${marker} ${display}`, innerWidth));
      }
    }

    if (this.filtered.length > maxVisible) {
      const pct = Math.round(((this.selectedIndex + 1) / this.filtered.length) * 100);
      lines.push(
        this.frameLine(
          this.fg("dim", `  ${pct}% (${this.selectedIndex + 1}/${this.filtered.length})`),
          innerWidth,
        ),
      );
    }

    if (this.error) {
      lines.push(this.ruleLine(innerWidth));
      lines.push(this.frameLine(`  ${this.fg("error", `⚠ ${this.error}`)}`, innerWidth));
    }
    if (this.saved) {
      lines.push(this.ruleLine(innerWidth));
      lines.push(this.frameLine(`  ${this.fg("success", "✓ Model saved")}`, innerWidth));
    }

    lines.push(this.ruleLine(innerWidth));
    lines.push(
      this.frameLine(
        this.fg("dim", "↑↓ navigate · / filter · Enter select · Esc cancel"),
        innerWidth,
      ),
    );
    lines.push(this.borderLine(innerWidth, "bottom"));

    return lines;
  }
}
