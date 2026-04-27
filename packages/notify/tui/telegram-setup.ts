/**
 * @pi-unipi/notify — Telegram Setup TUI Component
 *
 * Interactive overlay for setting up Telegram bot notifications.
 * Guides user through BotFather flow and auto-detects chat ID.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { pollForChatId } from "../platforms/telegram.js";
import { updateConfig } from "../settings.js";

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
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private startTime = Date.now();
  private readonly TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  onClose?: () => void;

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
        if (data === "\r" && this.botToken.length > 0) {
          this.startPolling();
        } else if (data === "\x1b") {
          this.cleanup();
          this.onClose?.();
        } else if (data === "\x7f" || data === "\b") {
          this.botToken = this.botToken.slice(0, -1);
        } else if (data.length === 1 && data.match(/[0-9:A-Za-z_-]/)) {
          this.botToken += data;
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

  private startPolling(): void {
    this.phase = "polling";
    this.startTime = Date.now();
    this.pollAbort = new AbortController();

    // Start spinner animation
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
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

  /** Helper to push a truncated line */
  private line(lines: string[], s: string, width: number): void {
    lines.push(truncateToWidth(s, width));
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const l = (s: string) => this.line(lines, s, width);

    l(`${ansi.bold}${ansi.cyan}Telegram Bot Setup${ansi.reset}`);
    l("");

    switch (this.phase) {
      case "instructions":
        l(`${ansi.dim}Set up Telegram notifications in 3 steps:${ansi.reset}`);
        l("");
        l(`  ${ansi.bold}1.${ansi.reset} Open Telegram and message ${ansi.cyan}@BotFather${ansi.reset}`);
        l(`     Send /newbot and follow the prompts to create a bot`);
        l("");
        l(`  ${ansi.bold}2.${ansi.reset} Copy the bot token from BotFather`);
        l("");
        l(`  ${ansi.bold}3.${ansi.reset} Send any message to your new bot`);
        l(`     (We'll detect your chat ID automatically)`);
        l("");
        l(`${ansi.dim}Press Enter to continue, Esc to cancel${ansi.reset}`);
        break;

      case "token":
        l(`${ansi.dim}Paste your bot token from BotFather:${ansi.reset}`);
        l("");
        const display = this.botToken || " ";
        l(`  ${ansi.bold}${display}${ansi.dim}█${ansi.reset}`);
        l("");
        l(`${ansi.dim}Enter to start polling • Esc to cancel${ansi.reset}`);
        break;

      case "polling": {
        const frame = SPINNER_FRAMES[this.spinnerFrame] || "⠋";
        const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
        const remaining = Math.max(0, 300 - elapsed);
        l(`  ${ansi.cyan}${frame}${ansi.reset} ${ansi.bold}Waiting for first message...${ansi.reset}`);
        l("");
        l(`  ${ansi.dim}Send any message to your bot in Telegram${ansi.reset}`);
        l(`  ${ansi.dim}Timeout: ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}${ansi.reset}`);
        l("");
        l(`${ansi.dim}Esc to cancel${ansi.reset}`);
        break;
      }

      case "success":
        l(`  ${ansi.green}✓ Telegram bot configured!${ansi.reset}`);
        l("");
        l(`  ${ansi.dim}Chat ID: ${this.chatId}${ansi.reset}`);
        l(`  ${ansi.dim}Notifications will be sent to this chat${ansi.reset}`);
        l("");
        l(`${ansi.dim}Press Enter to close${ansi.reset}`);
        break;

      case "error":
        l(`  ${ansi.red}✗ Setup failed${ansi.reset}`);
        l("");
        l(`  ${ansi.dim}${this.error || "Unknown error"}${ansi.reset}`);
        l("");
        l(`${ansi.dim}Press Enter to close${ansi.reset}`);
        break;

      case "timeout":
        l(`  ${ansi.yellow}⏰ Timed out after 5 minutes${ansi.reset}`);
        l("");
        l(`  ${ansi.dim}Make sure you sent a message to your bot in Telegram`);
        l(`  ${ansi.dim}You can try again with /unipi:notify-set-tg${ansi.reset}`);
        l("");
        l(`${ansi.dim}Press Enter to close${ansi.reset}`);
        break;
    }

    return lines;
  }
}
