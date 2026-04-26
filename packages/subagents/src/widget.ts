/**
 * @pi-unipi/subagents — Live widget
 *
 * Shows running agents above the editor.
 * Uses setWidget API for proper rendering.
 */

import type { AgentManager } from "./agent-manager.js";
import type { AgentActivity } from "./types.js";

/** Spinner frames (braille). */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Format token count. */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

/** Format duration. */
function formatMs(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms}ms`;
}

/** Format turns. */
function formatTurns(turn: number, max?: number): string {
  return max ? `⟳${turn}≤${max}` : `⟳${turn}`;
}

/** Describe current activity from active tools. */
function describeActivity(activeTools: Map<string, string>, responseText: string): string {
  if (activeTools.size > 0) {
    const names = [...new Set(activeTools.values())];
    return names.join(", ") + "…";
  }
  if (responseText) {
    const lastLine = responseText.split("\n").pop()?.trim() ?? "";
    if (lastLine.length > 0) return lastLine.slice(0, 60) + (lastLine.length > 60 ? "…" : "");
  }
  return "thinking…";
}

export class AgentWidget {
  private manager: AgentManager;
  private activity: Map<string, AgentActivity>;
  private spinnerFrame = 0;
  private timer?: ReturnType<typeof setInterval>;
  private uiCtx?: any;
  private widgetRegistered = false;
  private tui?: any;

  constructor(manager: AgentManager, activity: Map<string, AgentActivity>) {
    this.manager = manager;
    this.activity = activity;
  }

  setUICtx(ctx: any) {
    if (ctx !== this.uiCtx) {
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
    }
  }

  ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length;
      this.requestRender();
    }, 80);
  }

  markFinished(_id: string) {
    if (!this.manager.hasRunning()) {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
      // Clear widget after agent finishes
      this.requestRender();
    }
  }

  update() {
    this.requestRender();
  }

  private requestRender() {
    if (!this.uiCtx) return;

    const allAgents = this.manager.listAgents();
    const running = allAgents.filter((a) => a.status === "running" || a.status === "queued");
    const hasActive = running.length > 0;

    // Nothing to show — clear widget
    if (!hasActive) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("unipi-agents", undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      return;
    }

    // Register widget callback once, then request re-render
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget(
        "unipi-agents",
        (tui: any, theme: any) => {
          this.tui = tui;
          return {
            render: () => this.renderWidget(tui, theme),
            invalidate: () => {
              this.widgetRegistered = false;
              this.tui = undefined;
            },
          };
        },
        { placement: "aboveEditor" },
      );
      this.widgetRegistered = true;
    } else {
      // Widget already registered — request re-render
      this.tui?.requestRender?.();
    }
  }

  private renderWidget(tui: any, theme: any): string[] {
    const allAgents = this.manager.listAgents();
    const running = allAgents.filter((a) => a.status === "running");
    const queued = allAgents.filter((a) => a.status === "queued");

    if (running.length === 0 && queued.length === 0) return [];

    const w = tui.terminal?.columns ?? 80;
    const truncate = (line: string) => {
      if (line.length <= w) return line;
      return line.slice(0, w - 1) + "…";
    };

    const frame = SPINNER[this.spinnerFrame % SPINNER.length];
    const lines: string[] = [];

    // Heading
    lines.push(truncate(theme.fg("accent", "●") + " " + theme.fg("accent", "Agents")));

    // Running agents (2 lines each: header + activity)
    for (let i = 0; i < running.length; i++) {
      const a = running[i];
      const act = this.activity.get(a.id);
      const toolCount = a.toolUses;
      const tokens = act?.tokens ?? "";
      const duration = formatMs(Date.now() - a.startedAt);
      const activity = act ? describeActivity(act.activeTools, act.responseText) : "starting…";

      const parts: string[] = [];
      if (act?.turnCount) parts.push(formatTurns(act.turnCount, act.maxTurns));
      if (toolCount > 0) parts.push(`${toolCount} tool uses`);
      if (tokens) parts.push(tokens);
      parts.push(duration);

      const connector = i === running.length - 1 && queued.length === 0 ? "└─" : "├─";
      const activityConnector = i === running.length - 1 && queued.length === 0 ? "  " : "│ ";

      lines.push(
        truncate(
          theme.fg("dim", connector) +
            ` ${theme.fg("accent", frame)} ${theme.bold(a.type)}  ${theme.fg("dim", a.description)} · ${theme.fg("dim", parts.join(" · "))}`,
        ),
      );
      lines.push(
        truncate(theme.fg("dim", activityConnector) + theme.fg("dim", `  ⎿  ${activity}`)),
      );
    }

    // Queued
    if (queued.length > 0) {
      lines.push(
        truncate(theme.fg("dim", "└─") + ` ${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`),
      );
    }

    return lines;
  }

  dispose() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.uiCtx && this.widgetRegistered) {
      this.uiCtx.setWidget("unipi-agents", undefined);
      this.widgetRegistered = false;
      this.tui = undefined;
    }
  }
}
