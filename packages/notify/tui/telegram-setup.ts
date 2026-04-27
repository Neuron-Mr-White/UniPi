/**
 * @pi-unipi/notify — Telegram Setup TUI Component
 *
 * Interactive overlay for setting up Telegram bot notifications.
 * Guides user through BotFather flow and auto-detects chat ID.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { pollForChatId } from "../platforms/telegram.js";
import { updateConfig } from "../settings.js";

type SetupPhase = "instructions" | "token" | "polling" | "success" | "error" | "timeout";

/** Spinner frames */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Telegram setup overlay component.
 */
export class TelegramSetupOverlay implements Component {
  private phase: SetupPhase = "instructions";
  private botToken = "";
  private chatId: string | null = null;
  private error: string | null = null;
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private pollAbort: AbortController | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private startTime = Date.now();
  private readonly TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  private isInPaste = false;
  private pasteBuffer = "";
  onClose?: () => void;
  requestRender?: () => void;
  private theme: Theme | null = null;

  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    switch (this.phase) {
      case "instructions":
        if (data === "\r" || data === " ") {
          this.phase = "token";
        } else if (data === "\x1b") {
          this.cleanup();
          this.onClose?.();
        }
        break;
      case "token":
        // Handle bracketed paste mode
        if (this.isInPaste) {
          this.pasteBuffer += data;
          const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
          if (endIndex !== -1) {
            // Extract pasted content and process it
            const pasteContent = this.pasteBuffer.substring(0, endIndex);
            this.processTokenInput(pasteContent);
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
        if (data === "\r" && this.botToken.length > 0) {
          this.startPolling();
        } else if (data === "\x1b") {
          this.cleanup();
          this.onClose?.();
        } else if (data === "\x7f" || data === "\b") {
          this.botToken = this.botToken.slice(0, -1);
        } else {
          this.processTokenInput(data);
        }
        break;
      case "polling":
        if (data === "\x1b") {
          this.cleanup();
          this.onClose?.();
        }
        break;
      case "success":
      case "error":
      case "timeout":
        if (data === "\r" || data === " " || data === "\x1b") {
          this.cleanup();
          this.onClose?.();
        }
        break;
    }
  }

  private processTokenInput(data: string): void {
    // Ignore escape sequences (arrow keys, function keys, etc.)
    if (data.startsWith("\x1b[")) return;
    // Filter to valid bot token characters only
    const cleaned = data.replace(/[^0-9:A-Za-z_-]/g, "");
    if (cleaned.length > 0) {
      this.botToken += cleaned;
    }
  }

  private startPolling(): void {
    this.phase = "polling";
    this.startTime = Date.now();
    this.pollAbort = new AbortController();

    // Start spinner animation
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.requestRender?.();
    }, 80);

    // Start polling
    this.doPoll();
  }

  private async doPoll(): Promise<void> {
    if (this.phase !== "polling" || !this.pollAbort) return;

    try {
      const chatId = await pollForChatId(
        this.botToken,
        this.pollAbort.signal
      );

      if (chatId) {
        this.chatId = chatId;
        this.phase = "success";
        this.saveConfig();
        this.cleanup();
        return;
      }

      // Check timeout
      if (Date.now() - this.startTime > this.TIMEOUT_MS) {
        this.phase = "timeout";
        this.error = "Timed out after 5 minutes";
        this.cleanup();
        return;
      }

      // Schedule next poll
      this.pollTimer = setTimeout(() => this.doPoll(), 2000);
    } catch (err) {
      if (this.pollAbort?.signal.aborted) return;
      this.phase = "error";
      this.error = err instanceof Error ? err.message : String(err);
      this.cleanup();
    }
  }

  private saveConfig(): void {
    if (this.botToken && this.chatId) {
      updateConfig({
        telegram: {
          enabled: true,
          botToken: this.botToken,
          chatId: this.chatId,
        },
      });
    }
  }

  private cleanup(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.pollAbort) {
      this.pollAbort.abort();
      this.pollAbort = null;
    }
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

  render(width: number): string[] {
    const innerWidth = Math.max(22, width - 2);
    const lines: string[] = [];

    lines.push(this.borderLine(innerWidth, "top"));
    lines.push(this.frameLine(this.fg("accent", this.bold("🤖 Telegram Bot Setup")), innerWidth));
    lines.push(this.ruleLine(innerWidth));

    switch (this.phase) {
      case "instructions":
        lines.push(this.frameLine(this.fg("dim", "Set up Telegram notifications in 3 steps:"), innerWidth));
        lines.push(this.frameLine("", innerWidth));
        lines.push(this.frameLine(`  ${this.bold("1.")} Open Telegram and message ${this.fg("accent", "@BotFather")}`, innerWidth));
        lines.push(this.frameLine(`     Send /newbot and follow the prompts to create a bot`, innerWidth));
        lines.push(this.frameLine("", innerWidth));
        lines.push(this.frameLine(`  ${this.bold("2.")} Copy the bot token from BotFather`, innerWidth));
        lines.push(this.frameLine("", innerWidth));
        lines.push(this.frameLine(`  ${this.bold("3.")} Send any message to your new bot`, innerWidth));
        lines.push(this.frameLine(`     (We'll detect your chat ID automatically)`, innerWidth));
        lines.push(this.ruleLine(innerWidth));
        lines.push(this.frameLine(this.fg("dim", "Press Enter to continue, Esc to cancel"), innerWidth));
        break;

      case "token":
        lines.push(this.frameLine(this.fg("dim", "Paste your bot token from BotFather:"), innerWidth));
        lines.push(this.frameLine("", innerWidth));
        const display = this.fg("accent", this.bold(this.botToken || " "));
        lines.push(this.frameLine(`  ${display}${this.fg("dim", "█")}`, innerWidth));
        lines.push(this.frameLine("", innerWidth));
        lines.push(this.frameLine(this.fg("dim", "Enter to start polling · Esc to cancel"), innerWidth));
        break;

      case "polling": {
        const frame = SPINNER_FRAMES[this.spinnerFrame] || "⠋";
        const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
        const remaining = Math.max(0, 300 - elapsed);
        lines.push(this.frameLine(`  ${this.fg("accent", frame)} ${this.bold("Waiting for first message...")}`, innerWidth));
        lines.push(this.frameLine("", innerWidth));
        lines.push(this.frameLine(`  ${this.fg("dim", "Send any message to your bot in Telegram")}`, innerWidth));
        lines.push(this.frameLine(`  ${this.fg("dim", `Timeout: ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`)}`, innerWidth));
        lines.push(this.ruleLine(innerWidth));
        lines.push(this.frameLine(this.fg("dim", "Esc to cancel"), innerWidth));
        break;
      }

      case "success":
        lines.push(this.frameLine(`  ${this.fg("success", "✓ Telegram bot configured!")}`, innerWidth));
        lines.push(this.frameLine("", innerWidth));
        lines.push(this.frameLine(`  ${this.fg("dim", `Chat ID: ${this.chatId}`)}`, innerWidth));
        lines.push(this.frameLine(`  ${this.fg("dim", "Notifications will be sent to this chat")}`, innerWidth));
        lines.push(this.ruleLine(innerWidth));
        lines.push(this.frameLine(this.fg("dim", "Press Enter to close"), innerWidth));
        break;

      case "error":
        lines.push(this.frameLine(`  ${this.fg("error", "✗ Setup failed")}`, innerWidth));
        lines.push(this.frameLine("", innerWidth));
        lines.push(this.frameLine(`  ${this.fg("dim", this.error || "Unknown error")}`, innerWidth));
        lines.push(this.ruleLine(innerWidth));
        lines.push(this.frameLine(this.fg("dim", "Press Enter to close"), innerWidth));
        break;

      case "timeout":
        lines.push(this.frameLine(`  ${this.fg("warning", "⏰ Timed out after 5 minutes")}`, innerWidth));
        lines.push(this.frameLine("", innerWidth));
        lines.push(this.frameLine(`  ${this.fg("dim", "Make sure you sent a message to your bot in Telegram")}`, innerWidth));
        lines.push(this.frameLine(`  ${this.fg("dim", "You can try again with /unipi:notify-set-tg")}`, innerWidth));
        lines.push(this.ruleLine(innerWidth));
        lines.push(this.frameLine(this.fg("dim", "Press Enter to close"), innerWidth));
        break;
    }

    lines.push(this.borderLine(innerWidth, "bottom"));
    return lines;
  }
}
