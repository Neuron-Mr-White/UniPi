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
import type { NotifyConfig, NotifyPlatform, NtfyConfig } from "../types.js";
import { OverlayTheme, boxInnerWidth } from "@pi-unipi/core";

/** Section types */
type Section = "platforms" | "events" | "recap";

const PLATFORM_KEYS: NotifyPlatform[] = ["native", "gotify", "telegram", "ntfy"];
const CHIP_LABELS: Record<NotifyPlatform, string> = {
  native: "Native",
  gotify: "Gotify",
  telegram: "Telegram",
  ntfy: "ntfy",
};

const SUPPRESS_FOCUSED_INDEX = 4;
const SILENCE_MASTER_INDEX = 5;
const SILENCE_CHIPS_INDEX = 6;

const WINDOW_STEP_MS = 1_000;
const WINDOW_MIN_MS = 1_000;
const WINDOW_MAX_MS = 120_000;

/**
 * Settings overlay component.
 */
export class NotifySettingsOverlay implements Component {
  private config: NotifyConfig;
  private ntfyConfig: NtfyConfig;
  private ntfyScope: "project" | "global" | "none";
  private section: Section = "platforms";
  private selectedIndex = 0;
  /** Which silence-after-input chip is focused (0–3). */
  private chipIndex = 0;
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
    if (this.section === "platforms" && this.selectedIndex === SILENCE_CHIPS_INDEX) {
      if (matchesKey(data, "left") || data === "h") {
        this.chipIndex = Math.max(0, this.chipIndex - 1);
        return;
      }
      if (matchesKey(data, "right") || data === "l") {
        this.chipIndex = Math.min(PLATFORM_KEYS.length - 1, this.chipIndex + 1);
        return;
      }
    }
    if (this.section === "platforms" && this.selectedIndex === SILENCE_MASTER_INDEX) {
      if (data === "+" || data === "=") {
        this.nudgeWindow(WINDOW_STEP_MS);
        return;
      }
      if (data === "-" || data === "_") {
        this.nudgeWindow(-WINDOW_STEP_MS);
        return;
      }
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
    if (this.section === "platforms") return 7; // 4 platforms + focused + silence master + chips
    if (this.section === "recap") return 1; // toggle
    return Object.keys(this.config.events).length;
  }

  private nudgeWindow(delta: number): void {
    const current = this.config.silenceAfterInput.windowMs;
    this.config.silenceAfterInput.windowMs = Math.min(
      WINDOW_MAX_MS,
      Math.max(WINDOW_MIN_MS, current + delta),
    );
  }

  private chipOn(key: NotifyPlatform): boolean {
    const listed = this.config.silenceAfterInput.platforms;
    if (listed.length === 0) return true;
    return listed.includes(key);
  }

  private toggleSilenceChip(key: NotifyPlatform): void {
    const listed = this.config.silenceAfterInput.platforms;
    const effective = listed.length === 0 ? PLATFORM_KEYS.slice() : listed.slice();
    const idx = effective.indexOf(key);
    if (idx >= 0) {
      if (effective.length === 1) return;
      effective.splice(idx, 1);
    } else {
      effective.push(key);
    }
    const ordered = PLATFORM_KEYS.filter((p) => effective.includes(p));
    this.config.silenceAfterInput.platforms =
      ordered.length === PLATFORM_KEYS.length ? [] : ordered;
  }

  private toggleCurrent(): void {
    if (this.section === "platforms") {
      if (this.selectedIndex < PLATFORM_KEYS.length) {
        const key = PLATFORM_KEYS[this.selectedIndex];
        if (key === "ntfy") {
          // ntfy toggle updates the resolved ntfy config
          this.ntfyConfig.enabled = !this.ntfyConfig.enabled;
        } else if (key) {
          this.config[key].enabled = !this.config[key].enabled;
        }
      } else if (this.selectedIndex === SUPPRESS_FOCUSED_INDEX) {
        this.config.native.suppressWhenFocused = !this.config.native.suppressWhenFocused;
      } else if (this.selectedIndex === SILENCE_MASTER_INDEX) {
        this.config.silenceAfterInput.enabled = !this.config.silenceAfterInput.enabled;
      } else if (this.selectedIndex === SILENCE_CHIPS_INDEX) {
        const key = PLATFORM_KEYS[this.chipIndex];
        if (key) this.toggleSilenceChip(key);
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
    lines.push(this.overlay.frameLine(this.overlay.fg("dim", this.footerHint()), innerWidth));
    lines.push(this.overlay.borderLine(innerWidth, "bottom"));

    return lines;
  }

  private footerHint(): string {
    if (this.section === "recap") {
      return "↑↓ navigate · Space toggle · M change model · Tab switch · Enter save · Esc cancel";
    }
    if (this.section === "platforms" && this.selectedIndex === SILENCE_MASTER_INDEX) {
      return "↑↓ navigate · Space toggle · +/− window · Tab switch · Enter save · Esc cancel";
    }
    if (this.section === "platforms" && this.selectedIndex === SILENCE_CHIPS_INDEX) {
      return "↑↓ navigate · ←→ channel · Space toggle · Tab switch · Enter save · Esc cancel";
    }
    return "↑↓ navigate · Space toggle · Tab switch · Enter save · Esc cancel";
  }

  private silenceSummary(): string {
    const seconds = Math.round(this.config.silenceAfterInput.windowMs / 1000);
    const listed = this.config.silenceAfterInput.platforms;
    const scope = listed.length === 0 ? "all enabled" : listed.join(", ");
    return `${seconds}s · ${scope}`;
  }

  private renderPlatforms(lines: string[], innerWidth: number): void {
    const platforms: Array<{
      key: NotifyPlatform;
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
      const isSelected = this.selectedIndex === SUPPRESS_FOCUSED_INDEX;
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

    this.renderSilenceAfterInput(lines, innerWidth);
  }

  private renderSilenceAfterInput(lines: string[], innerWidth: number): void {
    const masterOn = this.config.silenceAfterInput.enabled;
    const masterSelected = this.selectedIndex === SILENCE_MASTER_INDEX;
    const toggle = masterOn
      ? this.overlay.fg("success", "●")
      : this.overlay.fg("dim", "○");
    const label = masterSelected
      ? this.overlay.bold("Quiet after activity")
      : this.overlay.fg("dim", "Quiet after activity");
    const detail = this.overlay.fg("dim", this.silenceSummary());
    lines.push(
      this.overlay.frameLine(
        `${masterSelected ? this.overlay.fg("accent", "▸") : " "} ${toggle} ${label}  ${detail}`,
        innerWidth,
      ),
    );

    const chipsSelected = this.selectedIndex === SILENCE_CHIPS_INDEX;
    const chips = PLATFORM_KEYS.map((key, i) => {
      const on = this.chipOn(key);
      const mark = on ? "●" : "○";
      const text = `${mark} ${CHIP_LABELS[key]}`;
      const focused = chipsSelected && i === this.chipIndex;
      if (focused) {
        return this.overlay.fg("accent", this.overlay.bold(`[${text}]`));
      }
      const painted = on
        ? `${this.overlay.fg("success", mark)} ${CHIP_LABELS[key]}`
        : this.overlay.fg("dim", text);
      return masterOn ? painted : this.overlay.fg("dim", text);
    });
    lines.push(
      this.overlay.frameLine(
        `${chipsSelected ? this.overlay.fg("accent", "▸") : " "}   ${chips.join("  ")}`,
        innerWidth,
      ),
    );
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
