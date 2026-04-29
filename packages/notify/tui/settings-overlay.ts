/**
 * @pi-unipi/notify — Settings TUI Component
 *
 * Interactive settings editor for notification configuration.
 * Allows toggling platforms, configuring credentials, and per-event settings.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import {
  loadConfig,
  saveConfig,
  validateConfig,
} from "../settings.js";
import type { NotifyConfig } from "../types.js";

/** Section types */
type Section = "platforms" | "events";

/**
 * Settings overlay component.
 */
export class NotifySettingsOverlay implements Component {
  private config: NotifyConfig;
  private section: Section = "platforms";
  private selectedIndex = 0;
  private error: string | null = null;
  private saved = false;
  onClose?: () => void;
  requestRender?: () => void;
  private theme: Theme | null = null;

  constructor() {
    this.config = loadConfig();
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    switch (data) {
      case "\x1b[A": // Up
      case "k":
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        break;
      case "\x1b[B": // Down
      case "j":
        this.selectedIndex = Math.min(this.maxItems - 1, this.selectedIndex + 1);
        break;
      case " ": // Space - toggle
        this.toggleCurrent();
        break;
      case "\t": // Tab - switch section
        this.section = this.section === "platforms" ? "events" : "platforms";
        this.selectedIndex = 0;
        break;
      case "\r": // Enter - save
        this.save();
        break;
      case "\x1b": // Escape - close
        this.onClose?.();
        break;
    }
  }

  private get maxItems(): number {
    if (this.section === "platforms") return 4; // native, gotify, telegram, ntfy
    return Object.keys(this.config.events).length;
  }

  private toggleCurrent(): void {
    if (this.section === "platforms") {
      const platforms: Array<"native" | "gotify" | "telegram" | "ntfy"> = [
        "native",
        "gotify",
        "telegram",
        "ntfy",
      ];
      const key = platforms[this.selectedIndex];
      if (key) {
        this.config[key].enabled = !this.config[key].enabled;
      }
    } else {
      const eventKeys = Object.keys(this.config.events);
      const key = eventKeys[this.selectedIndex];
      if (key && this.config.events[key]) {
        this.config.events[key].enabled = !this.config.events[key].enabled;
      }
    }
  }

  private save(): void {
    const errors = validateConfig(this.config);
    if (errors.length > 0) {
      this.error = errors.join("; ");
      return;
    }
    this.error = null;
    saveConfig(this.config);
    this.saved = true;
    setTimeout(() => this.onClose?.(), 500);
  }

  // ─── Theme helpers ───────────────────────────────────────────────────

  private fg(color: string, text: string): string {
    if (this.theme) return this.theme.fg(color as any, text);
    const c: Record<string, string> = {
      accent: "\x1b[36m", success: "\x1b[32m", warning: "\x1b[33m",
      error: "\x1b[31m", dim: "\x1b[2m", borderMuted: "\x1b[90m",
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

  private getDialogHeight(): number {
    const terminalRows = process.stdout.rows ?? 30;
    return Math.max(14, Math.min(24, Math.floor(terminalRows * 0.65)));
  }

  render(width: number): string[] {
    const innerWidth = Math.max(22, width - 2);
    const lines: string[] = [];

    lines.push(this.borderLine(innerWidth, "top"));
    lines.push(this.frameLine(this.fg("accent", this.bold("🔔 Notify Settings")), innerWidth));
    lines.push(this.frameLine(this.fg("dim", "Configure notification platforms and events"), innerWidth));
    lines.push(this.ruleLine(innerWidth));

    // Section tabs
    const platformTab =
      this.section === "platforms"
        ? this.fg("accent", this.bold("[Platforms]"))
        : this.fg("dim", "Platforms");
    const eventsTab =
      this.section === "events"
        ? this.fg("accent", this.bold("[Events]"))
        : this.fg("dim", "Events");
    lines.push(this.frameLine(`  ${platformTab}  ${eventsTab}`, innerWidth));
    lines.push(this.ruleLine(innerWidth));

    if (this.section === "platforms") {
      this.renderPlatforms(lines, innerWidth);
    } else {
      this.renderEvents(lines, innerWidth);
    }

    // Status messages
    if (this.error) {
      lines.push(this.ruleLine(innerWidth));
      lines.push(this.frameLine(`  ${this.fg("error", `⚠ ${this.error}`)}`, innerWidth));
    }
    if (this.saved) {
      lines.push(this.ruleLine(innerWidth));
      lines.push(this.frameLine(`  ${this.fg("success", "✓ Settings saved")}`, innerWidth));
    }

    // Footer
    lines.push(this.ruleLine(innerWidth));
    lines.push(this.frameLine(this.fg("dim", "↑↓ navigate · Space toggle · Tab switch · Enter save · Esc cancel"), innerWidth));
    lines.push(this.borderLine(innerWidth, "bottom"));

    return lines;
  }

  private renderPlatforms(lines: string[], innerWidth: number): void {
    const platforms: Array<{
      key: "native" | "gotify" | "telegram" | "ntfy";
      label: string;
      detail: string;
    }> = [
      {
        key: "native",
        label: "Native OS",
        detail: "Desktop notifications (node-notifier)",
      },
      {
        key: "gotify",
        label: "Gotify",
        detail: this.config.gotify.serverUrl
          ? `Server: ${this.config.gotify.serverUrl}`
          : "Self-hosted push server",
      },
      {
        key: "telegram",
        label: "Telegram",
        detail: this.config.telegram.botToken
          ? "Bot configured"
          : "Bot API notifications",
      },
      {
        key: "ntfy",
        label: "ntfy",
        detail: this.config.ntfy.serverUrl
          ? `Server: ${this.config.ntfy.serverUrl}`
          : "Self-hosted push service",
      },
    ];

    for (let i = 0; i < platforms.length; i++) {
      const p = platforms[i];
      const isSelected = i === this.selectedIndex;
      const toggleOn = this.fg("success", "●");
      const toggleOff = this.fg("dim", "○");
      const toggle = this.config[p.key].enabled ? toggleOn : toggleOff;
      const label = isSelected ? this.bold(p.label) : this.fg("dim", p.label);

      lines.push(
        this.frameLine(
          `${isSelected ? this.fg("accent", "▸") : " "} ${toggle} ${label}  ${this.fg("dim", p.detail)}`,
          innerWidth
        )
      );
    }
  }

  private renderEvents(lines: string[], innerWidth: number): void {
    const events = Object.entries(this.config.events);

    for (let i = 0; i < events.length; i++) {
      const [key, cfg] = events[i];
      const isSelected = i === this.selectedIndex;
      const toggleOn = this.fg("success", "●");
      const toggleOff = this.fg("dim", "○");
      const toggle = cfg.enabled ? toggleOn : toggleOff;
      const label = isSelected ? this.bold(key) : this.fg("dim", key);

      lines.push(
        this.frameLine(
          `${isSelected ? this.fg("accent", "▸") : " "} ${toggle} ${label}`,
          innerWidth
        )
      );
    }
  }
}
