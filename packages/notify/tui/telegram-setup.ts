/**
 * @pi-unipi/notify — Telegram Setup TUI Component
 *
 * Interactive overlay for setting up Telegram bot notifications.
 * Guides user through BotFather flow and auto-detects chat ID.
 */

import type { Component } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { pollForChatId } from "../platforms/telegram.js";
import { updateConfig } from "../settings.js";
import { OverlayTheme, boxInnerWidth } from "@pi-unipi/core";

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
  private overlay = new OverlayTheme();

  setTheme(theme: Theme): void {
    this.overlay.setTheme(theme);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    switch (this.phase) {
      case "instructions":
        if (data === "\r" || data === " ") {
          this.phase = "token";
        } else if (matchesKey(data, "escape")) {
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
        } else if (matchesKey(data, "escape")) {
          this.cleanup();
          this.onClose?.();
        } else if (data === "\x7f" || data === "\b") {
          this.botToken = this.botToken.slice(0, -1);
        } else {
          this.processTokenInput(data);
        }
        break;
      case "polling":
        if (matchesKey(data, "escape")) {
          this.cleanup();
          this.onClose?.();
        }
        break;
      case "success":
      case "error":
      case "timeout":
        if (data === "\r" || data === " " || matchesKey(data, "escape")) {
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
        this.requestRender?.();
        // Auto-close after brief delay to show success
        setTimeout(() => this.onClose?.(), 1000);
        return;
      }

      // Check timeout
      if (Date.now() - this.startTime > this.TIMEOUT_MS) {
        this.phase = "timeout";
        this.error = "Timed out after 5 minutes";
        this.cleanup();
        this.requestRender?.();
        return;
      }

      // Schedule next poll
      this.pollTimer = setTimeout(() => this.doPoll(), 2000);
    } catch (err) {
      if (this.pollAbort?.signal.aborted) return;
      this.phase = "error";
      this.error = err instanceof Error ? err.message : String(err);
      this.cleanup();
      this.requestRender?.();
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

  render(width: number): string[] {
    const innerWidth = boxInnerWidth(width);
    const lines: string[] = [];

    lines.push(this.overlay.borderLine(innerWidth, "top"));
    lines.push(this.overlay.frameLine(this.overlay.fg("accent", this.overlay.bold("🤖 Telegram Bot Setup")), innerWidth));
    lines.push(this.overlay.ruleLine(innerWidth));

    switch (this.phase) {
      case "instructions":
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "Set up Telegram notifications in 3 steps:"), innerWidth));
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.bold("1.")} Open Telegram and message ${this.overlay.fg("accent", "@BotFather")}`, innerWidth));
        lines.push(this.overlay.frameLine(`     Send /newbot and follow the prompts to create a bot`, innerWidth));
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.bold("2.")} Copy the bot token from BotFather`, innerWidth));
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.bold("3.")} Send any message to your new bot`, innerWidth));
        lines.push(this.overlay.frameLine(`     (We'll detect your chat ID automatically)`, innerWidth));
        lines.push(this.overlay.ruleLine(innerWidth));
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "Press Enter to continue, Esc to cancel"), innerWidth));
        break;

      case "token":
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "Paste your bot token from BotFather:"), innerWidth));
        lines.push(this.overlay.frameLine("", innerWidth));
        const display = this.overlay.fg("accent", this.overlay.bold(this.botToken || " "));
        lines.push(this.overlay.frameLine(`  ${display}${this.overlay.fg("dim", "█")}`, innerWidth));
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "Enter to start polling · Esc to cancel"), innerWidth));
        break;

      case "polling": {
        const frame = SPINNER_FRAMES[this.spinnerFrame] || "⠋";
        const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
        const remaining = Math.max(0, 300 - elapsed);
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("accent", frame)} ${this.overlay.bold("Waiting for first message...")}`, innerWidth));
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("dim", "Send any message to your bot in Telegram")}`, innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("dim", `Timeout: ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`)}`, innerWidth));
        lines.push(this.overlay.ruleLine(innerWidth));
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "Esc to cancel"), innerWidth));
        break;
      }

      case "success":
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("success", "✓ Telegram bot configured!")}`, innerWidth));
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("dim", `Chat ID: ${this.chatId}`)}`, innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("dim", "Notifications will be sent to this chat")}`, innerWidth));
        lines.push(this.overlay.ruleLine(innerWidth));
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "Press Enter to close"), innerWidth));
        break;

      case "error":
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("error", "✗ Setup failed")}`, innerWidth));
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("dim", this.error || "Unknown error")}`, innerWidth));
        lines.push(this.overlay.ruleLine(innerWidth));
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "Press Enter to close"), innerWidth));
        break;

      case "timeout":
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("warning", "⏰ Timed out after 5 minutes")}`, innerWidth));
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("dim", "Make sure you sent a message to your bot in Telegram")}`, innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("dim", "You can try again with /unipi:notify-set-tg")}`, innerWidth));
        lines.push(this.overlay.ruleLine(innerWidth));
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "Press Enter to close"), innerWidth));
        break;
    }

    lines.push(this.overlay.borderLine(innerWidth, "bottom"));
    return lines;
  }
}
