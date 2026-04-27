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

  render(width: number): string[] {
    const lines: string[] = [];
    const add = (s: string) => lines.push(truncateToWidth(s, width));

    add(`${ansi.bold}${ansi.cyan}Telegram Bot Setup${ansi.reset}`);
    add("");

    switch (this.phase) {
      case "instructions":
        this.renderInstructions(lines, width);
        break;
      case "token":
        this.renderTokenInput(lines, width);
        break;
      case "polling":
        this.renderPolling(lines, width);
        break;
      case "success":
        this.renderSuccess(lines, width);
        break;
      case "error":
        this.renderError(lines, width);
        break;
      case "timeout":
        this.renderTimeout(lines, width);
        break;
    }

    return lines;
  }

  private renderInstructions(lines: string[], width: number): void {
    lines.push(
      truncateToWidth(
        `${ansi.dim}Set up Telegram notifications in 3 steps:${ansi.reset}`,
        width
      )
    );
    add("");
    lines.push(
      truncateToWidth(
        `  ${ansi.bold}1.${ansi.reset} Open Telegram and message ${ansi.cyan}@BotFather${ansi.reset}`,
        width
      )
    );
    lines.push(
      truncateToWidth(
        `     Send /newbot and follow the prompts to create a bot`,
        width
      )
    );
    add("");
    lines.push(
      truncateToWidth(
        `  ${ansi.bold}2.${ansi.reset} Copy the bot token from BotFather`,
        width
      )
    );
    add("");
    lines.push(
      truncateToWidth(
        `  ${ansi.bold}3.${ansi.reset} Send any message to your new bot`,
        width
      )
    );
    lines.push(
      truncateToWidth(
        `     (We'll detect your chat ID automatically)`,
        width
      )
    );
    add("");
    add(
      `${ansi.dim}Press Enter to continue, Esc to cancel${ansi.reset}`
    );
  }

  private renderTokenInput(lines: string[], width: number): void {
    lines.push(
      truncateToWidth(`${ansi.dim}Paste your bot token from BotFather:${ansi.reset}`, width)
    );
    add("");
    const display = this.botToken || " ";
    lines.push(
      truncateToWidth(`  ${ansi.bold}${display}${ansi.dim}█${ansi.reset}`, width)
    );
    add("");
    add(
      `${ansi.dim}Enter to start polling • Esc to cancel${ansi.reset}`
    );
  }

  private renderPolling(lines: string[], width: number): void {
    const frame = SPINNER_FRAMES[this.spinnerFrame] || "⠋";
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const remaining = Math.max(0, 300 - elapsed);

    lines.push(
      truncateToWidth(
        `  ${ansi.cyan}${frame}${ansi.reset} ${ansi.bold}Waiting for first message...${ansi.reset}`,
        width
      )
    );
    add("");
    lines.push(
      truncateToWidth(
        `  ${ansi.dim}Send any message to your bot in Telegram${ansi.reset}`,
        width
      )
    );
    lines.push(
      truncateToWidth(
        `  ${ansi.dim}Timeout: ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}${ansi.reset}`,
        width
      )
    );
    add("");
    add(`${ansi.dim}Esc to cancel${ansi.reset}`);
  }

  private renderSuccess(lines: string[], width: number): void {
    lines.push(
      truncateToWidth(`  ${ansi.green}✓ Telegram bot configured!${ansi.reset}`, width)
    );
    add("");
    lines.push(
      truncateToWidth(`  ${ansi.dim}Chat ID: ${this.chatId}${ansi.reset}`, width)
    );
    lines.push(
      truncateToWidth(`  ${ansi.dim}Notifications will be sent to this chat${ansi.reset}`, width)
    );
    add("");
    add(`${ansi.dim}Press Enter to close${ansi.reset}`);
  }

  private renderError(lines: string[], width: number): void {
    lines.push(
      truncateToWidth(`  ${ansi.red}✗ Setup failed${ansi.reset}`, width)
    );
    add("");
    lines.push(
      truncateToWidth(`  ${ansi.dim}${this.error || "Unknown error"}${ansi.reset}`, width)
    );
    add("");
    add(`${ansi.dim}Press Enter to close${ansi.reset}`);
  }

  private renderTimeout(lines: string[], width: number): void {
    lines.push(
      truncateToWidth(`  ${ansi.yellow}⏰ Timed out after 5 minutes${ansi.reset}`, width)
    );
    add("");
    lines.push(
      truncateToWidth(
        `  ${ansi.dim}Make sure you sent a message to your bot in Telegram`,
        width
      )
    );
    lines.push(
      truncateToWidth(
        `  ${ansi.dim}You can try again with /unipi:notify-set-tg${ansi.reset}`,
        width
      )
    );
    add("");
    add(`${ansi.dim}Press Enter to close${ansi.reset}`);
  }
}
