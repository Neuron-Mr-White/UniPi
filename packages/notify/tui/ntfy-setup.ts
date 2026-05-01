/**
 * @pi-unipi/notify — ntfy Setup TUI Component
 *
 * Interactive overlay for setting up ntfy push notifications.
 * Guides user through server URL, topic, optional token, and priority.
 * Tests connection before saving.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { sendNtfyNotification } from "../platforms/ntfy.js";
import { loadNtfyConfig, saveNtfyConfig, getNtfyConfigScope } from "../ntfy-config.js";

type SetupPhase =
  | "instructions"
  | "scope"
  | "server-url"
  | "topic"
  | "token"
  | "priority"
  | "testing"
  | "success"
  | "error"
  | "test-failed";

/**
 * ntfy setup overlay component.
 */
export class NtfySetupOverlay implements Component {
  private phase: SetupPhase = "instructions";
  private scope: "global" | "project" = "global";
  private scopeIndex = 0; // 0 = global, 1 = project
  private serverUrl = "";
  private topic = "";
  private token = "";
  private priority = "3";
  private error: string | null = null;
  private testError: string | null = null;
  private isInPaste = false;
  private pasteBuffer = "";
  onClose?: () => void;
  requestRender?: () => void;
  private theme: Theme | null = null;

  constructor() {
    // Determine current scope and pre-fill from resolved config
    const cwd = process.cwd();
    const existingScope = getNtfyConfigScope(cwd);
    if (existingScope !== "none") {
      this.scope = existingScope;
      this.scopeIndex = existingScope === "project" ? 1 : 0;
    }
    const config = loadNtfyConfig(cwd);
    if (config.serverUrl) this.serverUrl = config.serverUrl;
    if (config.topic) this.topic = config.topic;
    if (config.token) this.token = config.token;
    if (config.priority) this.priority = String(config.priority);
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    switch (this.phase) {
      case "instructions":
        if (data === "\r" || data === " ") {
          this.phase = "scope";
        } else if (data === "\x1b") {
          this.onClose?.();
        }
        break;

      case "scope":
        if (data === "\x1b[A" || data === "k") {
          // Up
          this.scopeIndex = Math.max(0, this.scopeIndex - 1);
        } else if (data === "\x1b[B" || data === "j") {
          // Down
          this.scopeIndex = Math.min(1, this.scopeIndex + 1);
        } else if (data === "\r" || data === " ") {
          this.scope = this.scopeIndex === 1 ? "project" : "global";
          this.phase = this.serverUrl ? "topic" : "server-url";
        } else if (data === "\x1b") {
          this.onClose?.();
        }
        break;

      case "server-url":
        this.handleTextInput(data, "server-url", () => {
          if (!this.serverUrl) {
            this.serverUrl = "https://ntfy.sh";
          }
          this.phase = "topic";
        });
        break;

      case "topic":
        this.handleTextInput(data, "topic", () => {
          this.phase = "token";
        });
        break;

      case "token":
        this.handleTextInput(data, "token", () => {
          this.phase = "priority";
        });
        break;

      case "priority":
        if (data === "\r" && this.isValidPriority()) {
          this.testConnection();
        } else if (data === "\x1b") {
          this.onClose?.();
        } else if (data === "\x7f" || data === "\b") {
          this.priority = this.priority.slice(0, -1);
        } else {
          const ch = data.replace(/[^\d]/g, "");
          if (ch && this.priority.length < 1) {
            this.priority += ch;
          }
        }
        break;

      case "testing":
        if (data === "\x1b") {
          this.onClose?.();
        }
        break;

      case "success":
      case "error":
      case "test-failed":
        if (data === "\r" || data === " " || data === "\x1b") {
          this.onClose?.();
        }
        break;
    }
  }

  private handleTextInput(
    data: string,
    target: "server-url" | "topic" | "token",
    onEnter: () => void
  ): void {
    // Handle bracketed paste mode
    if (this.isInPaste) {
      this.pasteBuffer += data;
      const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
      if (endIndex !== -1) {
        const pasteContent = this.pasteBuffer.substring(0, endIndex).trim();
        if (target === "server-url") {
          this.serverUrl = pasteContent;
        } else if (target === "topic") {
          this.topic = pasteContent;
        } else {
          this.token = pasteContent;
        }
        this.isInPaste = false;
        this.pasteBuffer = "";
      }
      return;
    }
    // Detect start of bracketed paste
    if (data.includes("\x1b[200~")) {
      this.isInPaste = true;
      this.pasteBuffer = data.replace("\x1b[200~", "");
      return;
    }
    if (data === "\r") {
      onEnter();
    } else if (data === "\x1b") {
      // Escape during token phase — skip token (optional field)
      if (target === "token") {
        this.phase = "priority";
      } else {
        this.onClose?.();
      }
    } else if (data === "\x7f" || data === "\b") {
      if (target === "server-url") {
        this.serverUrl = this.serverUrl.slice(0, -1);
      } else if (target === "topic") {
        this.topic = this.topic.slice(0, -1);
      } else {
        this.token = this.token.slice(0, -1);
      }
    } else {
      // Ignore escape sequences
      if (data.startsWith("\x1b[")) return;
      if (target === "server-url") {
        this.serverUrl += data;
      } else if (target === "topic") {
        this.topic += data;
      } else {
        this.token += data;
      }
    }
  }

  private isValidPriority(): boolean {
    const num = parseInt(this.priority, 10);
    return !isNaN(num) && num >= 1 && num <= 5;
  }

  private async testConnection(): Promise<void> {
    this.phase = "testing";
    this.requestRender?.();

    try {
      await sendNtfyNotification(
        this.serverUrl.replace(/\/$/, ""),
        this.topic,
        "Pi — Setup Test",
        `ntfy configured successfully at ${new Date().toLocaleTimeString()}`,
        parseInt(this.priority, 10) || 3,
        this.token || undefined
      );
      this.saveConfig();
      this.phase = "success";
      this.requestRender?.();
      setTimeout(() => this.onClose?.(), 1500);
    } catch (err) {
      this.testError = err instanceof Error ? err.message : String(err);
      this.phase = "test-failed";
      this.requestRender?.();
    }
  }

  private saveConfig(): void {
    const cwd = process.cwd();
    saveNtfyConfig(this.scope, cwd, {
      enabled: true,
      serverUrl: this.serverUrl.replace(/\/$/, ""),
      topic: this.topic,
      token: this.token || undefined,
      priority: parseInt(this.priority, 10) || 3,
    });
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

  private maskToken(token: string): string {
    if (token.length <= 8) return token;
    return token.slice(0, 4) + "•".repeat(token.length - 8) + token.slice(-4);
  }

  render(width: number): string[] {
    const innerWidth = Math.max(22, width - 2);
    const lines: string[] = [];

    lines.push(this.borderLine(innerWidth, "top"));
    lines.push(
      this.frameLine(
        this.fg("accent", this.bold("📢 ntfy Setup")),
        innerWidth
      )
    );
    lines.push(this.ruleLine(innerWidth));

    switch (this.phase) {
      case "instructions":
        lines.push(
          this.frameLine(
            this.fg("dim", "Set up ntfy push notifications:"),
            innerWidth
          )
        );
        lines.push(this.frameLine("", innerWidth));
        lines.push(
          this.frameLine(
            `  ${this.bold("1.")} ntfy is a simple HTTP-based notification service`,
            innerWidth
          )
        );
        lines.push(
          this.frameLine(
            `     ${this.fg("dim", "Public: https://ntfy.sh | Self-hosted: any ntfy server")}`,
            innerWidth
          )
        );
        lines.push(this.frameLine("", innerWidth));
        lines.push(
          this.frameLine(
            `  ${this.bold("2.")} Choose a topic (acts as a channel name)`,
            innerWidth
          )
        );
        lines.push(
          this.frameLine(
            `     ${this.fg("dim", "Subscribe to the topic in the ntfy app or web UI")}`,
            innerWidth
          )
        );
        lines.push(this.frameLine("", innerWidth));
        lines.push(
          this.frameLine(
            `  ${this.bold("3.")} Optionally set an access token for private servers`,
            innerWidth
          )
        );
        if (this.serverUrl) {
          lines.push(
            this.frameLine(
              `     ${this.fg("success", "✓")} Server URL pre-filled from existing config`,
              innerWidth
            )
          );
        }
        if (this.topic) {
          lines.push(
            this.frameLine(
              `     ${this.fg("success", "✓")} Topic pre-filled from existing config`,
              innerWidth
            )
          );
        }
        lines.push(this.ruleLine(innerWidth));
        lines.push(
          this.frameLine(
            this.fg("dim", "Press Enter to continue, Esc to cancel"),
            innerWidth
          )
        );
        break;

      case "scope": {
        lines.push(
          this.frameLine(
            this.fg("dim", "Where should this config be saved?"),
            innerWidth
          )
        );
        lines.push(this.frameLine("", innerWidth));
        const options = ["Global (all projects)", "Project (this project only)"];
        for (let i = 0; i < options.length; i++) {
          const isSelected = i === this.scopeIndex;
          const label = isSelected ? this.bold(options[i]) : this.fg("dim", options[i]);
          lines.push(
            this.frameLine(
              `  ${isSelected ? this.fg("accent", "▸") : " "} ${label}`,
              innerWidth
            )
          );
        }
        lines.push(this.frameLine("", innerWidth));
        lines.push(this.ruleLine(innerWidth));
        lines.push(
          this.frameLine(
            this.fg("dim", "↑↓ select · Enter confirm · Esc cancel"),
            innerWidth
          )
        );
        break;
      }

      case "server-url":
        lines.push(
          this.frameLine(
            this.fg("dim", "Enter ntfy server URL:"),
            innerWidth
          )
        );
        lines.push(this.frameLine("", innerWidth));
        lines.push(
          this.frameLine(
            `  ${this.fg("accent", this.bold(this.serverUrl || " "))}${this.fg("dim", "█")}`,
            innerWidth
          )
        );
        lines.push(this.frameLine("", innerWidth));
        lines.push(
          this.frameLine(
            this.fg("dim", "Default: https://ntfy.sh (public)"),
            innerWidth
          )
        );
        lines.push(
          this.frameLine(
            this.fg("dim", "Leave empty and press Enter for default"),
            innerWidth
          )
        );
        lines.push(this.ruleLine(innerWidth));
        lines.push(
          this.frameLine(
            this.fg("dim", "Enter to continue · Esc to cancel"),
            innerWidth
          )
        );
        break;

      case "topic":
        lines.push(
          this.frameLine(
            this.fg("dim", "Enter topic name:"),
            innerWidth
          )
        );
        lines.push(this.frameLine("", innerWidth));
        lines.push(
          this.frameLine(
            `  ${this.fg("accent", this.bold(this.topic || " "))}${this.fg("dim", "█")}`,
            innerWidth
          )
        );
        lines.push(this.frameLine("", innerWidth));
        lines.push(
          this.frameLine(
            this.fg("dim", "e.g. my-pi-notifications, project-alerts"),
            innerWidth
          )
        );
        lines.push(
          this.frameLine(
            this.fg("dim", "Pick something unique if using public ntfy.sh"),
            innerWidth
          )
        );
        lines.push(this.ruleLine(innerWidth));
        lines.push(
          this.frameLine(
            this.fg("dim", "Enter to continue · Esc to cancel"),
            innerWidth
          )
        );
        break;

      case "token":
        lines.push(
          this.frameLine(
            this.fg("dim", "Enter access token (optional):"),
            innerWidth
          )
        );
        lines.push(this.frameLine("", innerWidth));
        const displayToken = this.token
          ? this.fg("accent", this.bold(this.maskToken(this.token)))
          : " ";
        lines.push(
          this.frameLine(
            `  ${displayToken}${this.fg("dim", "█")}`,
            innerWidth
          )
        );
        lines.push(this.frameLine("", innerWidth));
        lines.push(
          this.frameLine(
            this.fg("dim", "Only needed for private/authenticated ntfy servers"),
            innerWidth
          )
        );
        lines.push(
          this.frameLine(
            this.fg("dim", "Not needed for public ntfy.sh"),
            innerWidth
          )
        );
        lines.push(this.ruleLine(innerWidth));
        lines.push(
          this.frameLine(
            this.fg("dim", "Enter to continue · Esc to skip"),
            innerWidth
          )
        );
        break;

      case "priority":
        lines.push(
          this.frameLine(
            this.fg("dim", "Set notification priority (1-5):"),
            innerWidth
          )
        );
        lines.push(this.frameLine("", innerWidth));
        lines.push(
          this.frameLine(
            `  ${this.fg("accent", this.bold(this.priority || " "))}${this.fg("dim", "█")}`,
            innerWidth
          )
        );
        lines.push(this.frameLine("", innerWidth));
        lines.push(
          this.frameLine(
            `  ${this.fg("dim", "1")} = min · ${this.fg("dim", "3")} = default · ${this.fg("dim", "5")} = max`,
            innerWidth
          )
        );
        lines.push(this.ruleLine(innerWidth));
        lines.push(
          this.frameLine(
            this.fg("dim", "Enter to test connection · Esc to cancel"),
            innerWidth
          )
        );
        break;

      case "testing":
        lines.push(this.frameLine("", innerWidth));
        lines.push(
          this.frameLine(
            `  ${this.fg("accent", "⠋")} ${this.bold("Testing connection...")}`,
            innerWidth
          )
        );
        lines.push(this.frameLine("", innerWidth));
        lines.push(
          this.frameLine(
            `  ${this.fg("dim", `Sending test to ${this.serverUrl}/${this.topic}`)}`,
            innerWidth
          )
        );
        lines.push(this.ruleLine(innerWidth));
        lines.push(
          this.frameLine(
            this.fg("dim", "Esc to cancel"),
            innerWidth
          )
        );
        break;

      case "success":
        lines.push(this.frameLine("", innerWidth));
        lines.push(
          this.frameLine(
            `  ${this.fg("success", "✓ ntfy configured successfully!")}`,
            innerWidth
          )
        );
        lines.push(this.frameLine("", innerWidth));
        lines.push(
          this.frameLine(
            `  ${this.fg("dim", `Server: ${this.serverUrl}`)}`,
            innerWidth
          )
        );
        lines.push(
          this.frameLine(
            `  ${this.fg("dim", `Topic: ${this.topic}`)}`,
            innerWidth
          )
        );
        lines.push(
          this.frameLine(
            `  ${this.fg("dim", `Priority: ${this.priority}`)}`,
            innerWidth
          )
        );
        lines.push(this.ruleLine(innerWidth));
        lines.push(
          this.frameLine(
            this.fg("dim", "Closing..."),
            innerWidth
          )
        );
        break;

      case "test-failed":
        lines.push(this.frameLine("", innerWidth));
        lines.push(
          this.frameLine(
            `  ${this.fg("error", "✗ Connection test failed")}`,
            innerWidth
          )
        );
        lines.push(this.frameLine("", innerWidth));
        lines.push(
          this.frameLine(
            `  ${this.fg("dim", this.testError || "Unknown error")}`,
            innerWidth
          )
        );
        lines.push(this.frameLine("", innerWidth));
        lines.push(
          this.frameLine(
            `  ${this.fg("dim", "Check your server URL and topic")}`,
            innerWidth
          )
        );
        lines.push(this.ruleLine(innerWidth));
        lines.push(
          this.frameLine(
            this.fg("dim", "Press Enter to close"),
            innerWidth
          )
        );
        break;

      case "error":
        lines.push(this.frameLine("", innerWidth));
        lines.push(
          this.frameLine(
            `  ${this.fg("error", "✗ Setup failed")}`,
            innerWidth
          )
        );
        lines.push(this.frameLine("", innerWidth));
        lines.push(
          this.frameLine(
            `  ${this.fg("dim", this.error || "Unknown error")}`,
            innerWidth
          )
        );
        lines.push(this.ruleLine(innerWidth));
        lines.push(
          this.frameLine(
            this.fg("dim", "Press Enter to close"),
            innerWidth
          )
        );
        break;
    }

    lines.push(this.borderLine(innerWidth, "bottom"));
    return lines;
  }
}
