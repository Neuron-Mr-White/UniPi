/**
 * @pi-unipi/notify — Settings TUI Component
 *
 * Interactive settings editor for notification configuration.
 * Allows toggling platforms, configuring credentials, and per-event settings.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import {
  loadConfig,
  saveConfig,
  validateConfig,
  type NotifyConfig,
} from "../settings.js";

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
};

const TOGGLE_ON = `${ansi.green}●${ansi.reset}`;
const TOGGLE_OFF = `${ansi.dim}○${ansi.reset}`;

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

  constructor() {
    this.config = loadConfig();
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
    if (this.section === "platforms") return 3; // native, gotify, telegram
    return Object.keys(this.config.events).length;
  }

  private toggleCurrent(): void {
    if (this.section === "platforms") {
      const platforms: Array<"native" | "gotify" | "telegram"> = [
        "native",
        "gotify",
        "telegram",
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

  render(width: number): string[] {
    const lines: string[] = [];
    const add = (s: string) => lines.push(truncateToWidth(s, width));

    add(`${ansi.bold}${ansi.cyan}Notify Settings${ansi.reset}`);
    add(`${ansi.dim}Configure notification platforms and events${ansi.reset}`);
    add("");

    // Section tabs
    const platformTab =
      this.section === "platforms"
        ? `${ansi.bold}${ansi.cyan}[Platforms]${ansi.reset}`
        : `${ansi.dim}Platforms${ansi.reset}`;
    const eventsTab =
      this.section === "events"
        ? `${ansi.bold}${ansi.cyan}[Events]${ansi.reset}`
        : `${ansi.dim}Events${ansi.reset}`;
    add(`  ${platformTab}  ${eventsTab}`);
    add("");

    if (this.section === "platforms") {
      this.renderPlatforms(lines, width);
    } else {
      this.renderEvents(lines, width);
    }

    // Status messages
    if (this.error) {
      add("");
      add(`  ${ansi.red}⚠ ${this.error}${ansi.reset}`);
    }
    if (this.saved) {
      add("");
      add(`  ${ansi.green}✓ Settings saved${ansi.reset}`);
    }

    // Footer
    add("");
    add(`${ansi.dim}↑↓ navigate • Space toggle • Tab switch • Enter save • Esc cancel${ansi.reset}`);

    return lines;
  }

  private renderPlatforms(lines: string[], width: number): void {
    const platforms: Array<{
      key: "native" | "gotify" | "telegram";
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
        detail: this.config.telegram.botId
          ? "Bot configured"
          : "Bot API notifications",
      },
    ];

    for (let i = 0; i < platforms.length; i++) {
      const p = platforms[i];
      const isSelected = i === this.selectedIndex;
      const toggle = this.config[p.key].enabled ? TOGGLE_ON : TOGGLE_OFF;
      const labelColor = isSelected ? ansi.bold : ansi.dim;

      lines.push(
        truncateToWidth(
          `${isSelected ? ansi.cyan + "▸" + ansi.reset : " "} ${toggle} ${labelColor}${p.label}${ansi.reset}  ${ansi.gray}${p.detail}${ansi.reset}`,
          width
        )
      );
    }
  }

  private renderEvents(lines: string[], width: number): void {
    const events = Object.entries(this.config.events);

    for (let i = 0; i < events.length; i++) {
      const [key, cfg] = events[i];
      const isSelected = i === this.selectedIndex;
      const toggle = cfg.enabled ? TOGGLE_ON : TOGGLE_OFF;
      const labelColor = isSelected ? ansi.bold : ansi.dim;

      lines.push(
        truncateToWidth(
          `${isSelected ? ansi.cyan + "▸" + ansi.reset : " "} ${toggle} ${labelColor}${key}${ansi.reset}`,
          width
        )
      );
    }
  }
}
