/**
 * @pi-unipi/notify — Settings TUI Component
 *
 * Interactive settings editor for notification configuration.
 * Allows toggling platforms, configuring credentials, and per-event settings.
 */

import type { Component } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  loadConfig,
  saveConfig,
  validateConfig,
} from "../settings.js";
import { loadNtfyConfig, saveNtfyConfig, getNtfyConfigScope } from "../ntfy-config.js";
import type { NotifyConfig, NtfyConfig } from "../types.js";
import { OverlayTheme, boxInnerWidth } from "@pi-unipi/core";

/** Section types */
type Section = "platforms" | "events" | "recap";

/**
 * Settings overlay component.
 */
export class NotifySettingsOverlay implements Component {
  private config: NotifyConfig;
  private ntfyConfig: NtfyConfig;
  private ntfyScope: "project" | "global" | "none";
  private section: Section = "platforms";
  private selectedIndex = 0;
  private error: string | null = null;
  private saved = false;
  onClose?: () => void;
  requestRender?: () => void;
  /** Called when user presses M in recap section to open model selector */
  onOpenModelSelector?: () => void;
  private overlay = new OverlayTheme();

  constructor() {
    this.config = loadConfig();
    const cwd = process.cwd();
    this.ntfyConfig = loadNtfyConfig(cwd);
    this.ntfyScope = getNtfyConfigScope(cwd);
  }

  setTheme(theme: Theme): void {
    this.overlay.setTheme(theme);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    // Ctrl+C always closes — escape hatch for terminals with key encodings
    // this overlay does not understand (issue #27).
    if (matchesKey(data, "ctrl+c")) {
      this.onClose?.();
      return;
    }
    // Navigation keys are matched via matchesKey, never raw byte comparison:
    // under the kitty keyboard protocol / enhanced encodings (Ghostty, Herdr)
    // Escape arrives as "\x1b[27u" (or "\x1b[27;1;27~" with modifyOtherKeys)
    // and arrows as "\x1b[57419u"/"\x1b[57420u" — exact legacy comparisons
    // like data === "\x1b[A" silently fail there.
    if (matchesKey(data, "up") || data === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.selectedIndex = Math.min(this.maxItems - 1, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, "space")) {
      this.toggleCurrent();
      return;
    }
    if (matchesKey(data, "tab")) {
      const sections: Section[] = ["platforms", "events", "recap"];
      const idx = sections.indexOf(this.section);
      this.section = sections[(idx + 1) % sections.length];
      this.selectedIndex = 0;
      return;
    }
    if (data === "m" || data === "M") {
      // Open model selector (only in recap section)
      if (this.section === "recap") {
        this.onOpenModelSelector?.();
      }
      return;
    }
    if (matchesKey(data, "enter")) {
      this.save();
      return;
    }
    if (matchesKey(data, "escape")) {
      this.onClose?.();
      return;
    }
  }

  private get maxItems(): number {
    if (this.section === "platforms") return 5; // native, gotify, telegram, ntfy + suppress option
    if (this.section === "recap") return 1; // toggle
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
      if (this.selectedIndex < platforms.length) {
        const key = platforms[this.selectedIndex];
        if (key === "ntfy") {
          // ntfy toggle updates the resolved ntfy config
          this.ntfyConfig.enabled = !this.ntfyConfig.enabled;
        } else if (key) {
          this.config[key].enabled = !this.config[key].enabled;
        }
      } else {
        // suppressWhenFocused toggle (index 4)
        this.config.native.suppressWhenFocused = !this.config.native.suppressWhenFocused;
      }
    } else if (this.section === "recap") {
      this.config.recap.enabled = !this.config.recap.enabled;
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
    // Save ntfy config to its own file if scope is known
    if (this.ntfyScope !== "none") {
      saveNtfyConfig(this.ntfyScope, process.cwd(), this.ntfyConfig);
    }
    this.saved = true;
    setTimeout(() => this.onClose?.(), 500);
  }

  render(width: number): string[] {
    const innerWidth = boxInnerWidth(width);
    const lines: string[] = [];

    lines.push(this.overlay.borderLine(innerWidth, "top"));
    lines.push(this.overlay.frameLine(this.overlay.fg("accent", this.overlay.bold("🔔 Notify Settings")), innerWidth));
    lines.push(this.overlay.frameLine(this.overlay.fg("dim", "Configure notification platforms and events"), innerWidth));
    lines.push(this.overlay.ruleLine(innerWidth));

    // Section tabs
    const platformTab =
      this.section === "platforms"
        ? this.overlay.fg("accent", this.overlay.bold("[Platforms]"))
        : this.overlay.fg("dim", "Platforms");
    const eventsTab =
      this.section === "events"
        ? this.overlay.fg("accent", this.overlay.bold("[Events]"))
        : this.overlay.fg("dim", "Events");
    const recapTab =
      this.section === "recap"
        ? this.overlay.fg("accent", this.overlay.bold("[Recap]"))
        : this.overlay.fg("dim", "Recap");
    lines.push(this.overlay.frameLine(`  ${platformTab}  ${eventsTab}  ${recapTab}`, innerWidth));
    lines.push(this.overlay.ruleLine(innerWidth));

    if (this.section === "platforms") {
      this.renderPlatforms(lines, innerWidth);
    } else if (this.section === "recap") {
      this.renderRecap(lines, innerWidth);
    } else {
      this.renderEvents(lines, innerWidth);
    }

    // Status messages
    if (this.error) {
      lines.push(this.overlay.ruleLine(innerWidth));
      lines.push(this.overlay.frameLine(`  ${this.overlay.fg("error", `⚠ ${this.error}`)}`, innerWidth));
    }
    if (this.saved) {
      lines.push(this.overlay.ruleLine(innerWidth));
      lines.push(this.overlay.frameLine(`  ${this.overlay.fg("success", "✓ Settings saved")}`, innerWidth));
    }

    // Footer
    lines.push(this.overlay.ruleLine(innerWidth));
    const footerHint = this.section === "recap"
      ? "↑↓ navigate · Space toggle · M change model · Tab switch · Enter save · Esc cancel"
      : "↑↓ navigate · Space toggle · Tab switch · Enter save · Esc cancel";
    lines.push(this.overlay.frameLine(this.overlay.fg("dim", footerHint), innerWidth));
    lines.push(this.overlay.borderLine(innerWidth, "bottom"));

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
        detail: this.ntfyScope !== "none"
          ? `Topic: ${this.ntfyConfig.topic ?? "—"} · P${this.ntfyConfig.priority} · [${this.ntfyScope}]`
          : "Not configured",
      },
    ];

    for (let i = 0; i < platforms.length; i++) {
      const p = platforms[i];
      const isSelected = i === this.selectedIndex;
      const toggleOn = this.overlay.fg("success", "●");
      const toggleOff = this.overlay.fg("dim", "○");
      // ntfy enabled state comes from resolved ntfy.json, not config.json
      const isEnabled = p.key === "ntfy" ? this.ntfyConfig.enabled : this.config[p.key].enabled;
      const toggle = isEnabled ? toggleOn : toggleOff;
      const label = isSelected ? this.overlay.bold(p.label) : this.overlay.fg("dim", p.label);

      lines.push(
        this.overlay.frameLine(
          `${isSelected ? this.overlay.fg("accent", "▸") : " "} ${toggle} ${label}  ${this.overlay.fg("dim", p.detail)}`,
          innerWidth
        )
      );
    }

    // suppressWhenFocused toggle (index 4)
    {
      const i = platforms.length;
      const isSelected = i === this.selectedIndex;
      const isEnabled = this.config.native.suppressWhenFocused === true;
      const toggleOn = this.overlay.fg("success", "●");
      const toggleOff = this.overlay.fg("dim", "○");
      const toggle = isEnabled ? toggleOn : toggleOff;
      const label = isSelected
        ? this.overlay.bold("Suppress when focused")
        : this.overlay.fg("dim", "Suppress when focused");
      const detail = this.overlay.fg("dim", isEnabled ? "Windows only — terminal in foreground → skip" : "Windows only");

      lines.push(
        this.overlay.frameLine(
          `${isSelected ? this.overlay.fg("accent", "▸") : " "} ${toggle} ${label}  ${detail}`,
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
      const toggleOn = this.overlay.fg("success", "●");
      const toggleOff = this.overlay.fg("dim", "○");
      const toggle = cfg.enabled ? toggleOn : toggleOff;
      const label = isSelected ? this.overlay.bold(key) : this.overlay.fg("dim", key);

      lines.push(
        this.overlay.frameLine(
          `${isSelected ? this.overlay.fg("accent", "▸") : " "} ${toggle} ${label}`,
          innerWidth
        )
      );
    }
  }

  private renderRecap(lines: string[], innerWidth: number): void {
    // Toggle
    const isSelected = this.selectedIndex === 0;
    const toggleOn = this.overlay.fg("success", "●");
    const toggleOff = this.overlay.fg("dim", "○");
    const toggle = this.config.recap.enabled ? toggleOn : toggleOff;
    const label = isSelected
      ? this.overlay.bold("Enable Recap")
      : this.overlay.fg("dim", "Enable Recap");

    lines.push(
      this.overlay.frameLine(
        `${isSelected ? this.overlay.fg("accent", "▸") : " "} ${toggle} ${label}`,
        innerWidth
      )
    );

    // Current model display
    const modelRef = this.config.recap.model;
    const modelLabel = this.overlay.fg("dim", `  Model: ${modelRef}`);
    lines.push(this.overlay.frameLine(modelLabel, innerWidth));
    lines.push(
      this.overlay.frameLine(
        this.overlay.fg("dim", "  Press M to change model"),
        innerWidth
      )
    );
  }
}
