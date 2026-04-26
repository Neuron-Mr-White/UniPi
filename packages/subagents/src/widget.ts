/**
 * @pi-unipi/subagents — Live widget
 *
 * Shows running agents above the editor.
 * Adapted from pi-subagents.
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

  constructor(manager: AgentManager, activity: Map<string, AgentActivity>) {
    this.manager = manager;
    this.activity = activity;
  }

  setUICtx(ctx: any) {
    this.uiCtx = ctx;
  }

  ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length;
      this.render();
    }, 80);
  }

  markFinished(_id: string) {
    // Check if any agents still running
    if (!this.manager.hasRunning()) {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    }
  }

  update() {
    this.render();
  }

  private render() {
    const agents = this.manager.listAgents();
    const running = agents.filter((a) => a.status === "running" || a.status === "queued");

    if (running.length === 0) {
      // Clear widget
      this.uiCtx?.setIndicator?.("");
      return;
    }

    const lines: string[] = [];
    const frame = SPINNER[this.spinnerFrame];

    for (const agent of running) {
      const act = this.activity.get(agent.id);
      const toolCount = agent.toolUses;
      const tokens = act?.tokens ?? "";
      const duration = formatMs(Date.now() - agent.startedAt);
      const activity = act ? describeActivity(act.activeTools, act.responseText) : "starting…";

      const parts: string[] = [];
      if (act?.turnCount) parts.push(formatTurns(act.turnCount, act.maxTurns));
      if (toolCount > 0) parts.push(`${toolCount} tool uses`);
      if (tokens) parts.push(tokens);
      parts.push(duration);

      lines.push(
        `${frame} ${agent.type}  ${agent.description}  ·  ${parts.join(" · ")}`,
        `  ⎿  ${activity}`,
      );
    }

    const queued = agents.filter((a) => a.status === "queued").length;
    if (queued > 0) {
      lines.push(`  ${queued} queued`);
    }

    this.uiCtx?.setIndicator?.(lines.join("\n"));
  }
}
