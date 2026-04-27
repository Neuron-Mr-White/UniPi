/**
 * @pi-unipi/notify — Gotify Setup TUI Component
 *
 * Interactive overlay for setting up Gotify push notifications.
 * Guides user through server URL, app token, and priority configuration.
 * Tests connection before saving.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { sendGotifyNotification } from "../platforms/gotify.js";
import { updateConfig, loadConfig } from "../settings.js";

type SetupPhase =
  | "instructions"
  | "server-url"
  | "app-token"
  | "priority"
  | "testing"
  | "success"
  | "error"
  | "test-failed";

/**
 * Gotify setup overlay component.
 */
export class GotifySetupOverlay implements Component {
  private phase: SetupPhase = "instructions";
  private serverUrl = "";
  private appToken = "";
  private priority = "5";
  private error: string | null = null;
  private testError: string | null = null;
  private isInPaste = false;
  private pasteBuffer = "";
  private pasteTarget: "server-url" | "app-token" = "server-url";
  onClose?: () => void;
  requestRender?: () => void;
  private theme: Theme | null = null;

  constructor() {
    // Pre-fill from existing config if available
    const config = loadConfig();
    if (config.gotify.serverUrl) this.serverUrl = config.gotify.serverUrl;
    if (config.gotify.appToken) this.appToken = config.gotify.appToken;
    if (config.gotify.priority) this.priority = String(config.gotify.priority);
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    switch (this.phase) {
      case "instructions":
        if (data === "\r" || data === " ") {
          this.phase = this.serverUrl ? "app-token" : "server-url";
        } else if (data === "\x1b") {
          this.onClose?.();
        }
        break;

      case "server-url":
        this.handleTextInput(data, "server-url", () => {
          this.phase = "app-token";
        });
        break;

      case "app-token":
        this.handleTextInput(data, "app-token", () => {
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
          if (ch && this.priority.length < 2) {
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
    target: "server-url" | "app-token",
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
        } else {
          this.appToken = pasteContent;
        }
        this.isInPaste = false;
        this.pasteBuffer = "";
      }
      return;
    }
    // Detect start of bracketed paste
    if (data.includes("\x1b[200~")) {
      this.isInPaste = true;
      this.pasteTarget = target;
      this.pasteBuffer = data.replace("\x1b[200~", "");
      return;
    }
    if (data === "\r") {
      onEnter();
    } else if (data === "\x1b") {
      this.onClose?.();
    } else if (data === "\x7f" || data === "\b") {
      if (target === "server-url") {
        this.serverUrl = this.serverUrl.slice(0, -1);
      } else {
        this.appToken = this.appToken.slice(0, -1);
      }
    } else {
      // Ignore escape sequences
      if (data.startsWith("\x1b[")) return;
      if (target === "server-url") {
        this.serverUrl += data;
      } else {
        this.appToken += data;
      }
    }
  }

  private isValidPriority(): boolean {
    const num = parseInt(this.priority, 10);
    return !isNaN(num) && num >= 1 && num <= 10;
  }

  private async testConnection(): Promise<void> {
    this.phase = "testing";
    this.requestRender?.();

    try {
      await sendGotifyNotification(
        this.serverUrl.replace(/\/$/, ""),
        this.appToken,
        "Pi — Setup Test",
        `Gotify configured successfully at ${new Date().toLocaleTimeString()}`,
        parseInt(this.priority, 10) || 5
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
    updateConfig({
      gotify: {
        enabled: true,
        serverUrl: this.serverUrl.replace(/\/$/, ""),
        appToken: this.appToken,
        priority: parseInt(this.priority, 10) || 5,
      },
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
        this.fg("accent", this.bold("📡 Gotify Setup")),
        innerWidth
      )
    );
    lines.push(this.ruleLine(innerWidth));

    switch (this.phase) {
      case "instructions":
        lines.push(
          this.frameLine(
            this.fg("dim", "Set up Gotify push notifications:"),
            innerWidth
          )
        );
        lines.push(this.frameLine("", innerWidth));
        lines.push(
          this.frameLine(
            `  ${this.bold("1.")} Run a Gotify server (or use an existing one)`,
            innerWidth
          )
        );
        lines.push(
          this.frameLine(
            `     ${this.fg("dim", "See: https://gotify.net/docs/install")}`,
            innerWidth
          )
        );
        lines.push(this.frameLine("", innerWidth));
        lines.push(
          this.frameLine(
            `  ${this.bold("2.")} Open your Gotify web UI`,
            innerWidth
          )
        );
        lines.push(
          this.frameLine(
            `     Go to ${this.fg("accent", "Apps")} → Create Application`,
            innerWidth
          )
        );
        lines.push(
          this.frameLine(
            `     Copy the ${this.fg("accent", "app token")}`,
            innerWidth
          )
        );
        lines.push(this.frameLine("", innerWidth));
        lines.push(
          this.frameLine(
            `  ${this.bold("3.")} Enter your server URL and app token below`,
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
        if (this.appToken) {
          lines.push(
            this.frameLine(
              `     ${this.fg("success", "✓")} App token pre-filled from existing config`,
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

      case "server-url":
        lines.push(
          this.frameLine(
            this.fg("dim", "Enter your Gotify server URL:"),
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
            this.fg("dim", "Example: https://gotify.example.com"),
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

      case "app-token":
        lines.push(
          this.frameLine(
            this.fg("dim", "Enter your app token:"),
            innerWidth
          )
        );
        lines.push(this.frameLine("", innerWidth));
        const displayToken = this.appToken
          ? this.fg("accent", this.bold(this.maskToken(this.appToken)))
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
            this.fg("dim", "Found in Gotify → Apps → your app"),
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

      case "priority":
        lines.push(
          this.frameLine(
            this.fg("dim", "Set notification priority (1-10):"),
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
            `  ${this.fg("dim", "1")} = low · ${this.fg("dim", "5")} = normal · ${this.fg("dim", "10")} = high`,
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
            `  ${this.fg("dim", `Sending test to ${this.serverUrl}`)}`,
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
            `  ${this.fg("success", "✓ Gotify configured successfully!")}`,
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
            `  ${this.fg("dim", "Check your server URL and app token")}`,
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
