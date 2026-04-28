/**
 * @pi-unipi/subagents — Live widget
 *
 * Shows running/completed agents above the editor with:
 * - Animated braille spinners
 * - Finished agent lingering (1 turn success, 2 turns error)
 * - Priority-based overflow (running > queued > finished)
 * - Status bar integration
 * - Activity description grouping
 * - ANSI-aware truncation via pi-tui
 */

import { truncateToWidth } from "@mariozechner/pi-tui";
import type { AgentManager } from "./agent-manager.js";
import type { AgentActivity } from "./types.js";

// ---- Constants ----

/** Maximum lines the widget may render. */
const MAX_WIDGET_LINES = 12;

/** Braille spinner frames. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Statuses that indicate error/non-success (for linger behavior). */
const ERROR_STATUSES = new Set(["error", "aborted", "stopped"]);

/** Tool name → human-readable action for activity descriptions. */
const TOOL_DISPLAY: Record<string, string> = {
  read: "reading",
  bash: "running command",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding files",
  ls: "listing",
};

// ---- Formatting helpers ----

/** Format duration. */
function formatMs(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms}ms`;
}

/** Format turns with optional max limit: "⟳5≤30" or "⟳5". */
function formatTurns(turn: number, max?: number): string {
  return max != null ? `⟳${turn}≤${max}` : `⟳${turn}`;
}

/** Format token count compactly: "33.8k token", "1.2M token". */
function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M token`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k token`;
  return `${count} token`;
}

/**
 * Build a human-readable activity string from currently-running tools.
 * Groups by tool type with counts: "reading 3 files, searching 2 patterns".
 */
function describeActivity(activeTools: Map<string, string>, responseText?: string): string {
  if (activeTools.size > 0) {
    const groups = new Map<string, number>();
    for (const toolName of activeTools.values()) {
      const action = TOOL_DISPLAY[toolName] ?? toolName;
      groups.set(action, (groups.get(action) ?? 0) + 1);
    }

    const parts: string[] = [];
    for (const [action, count] of groups) {
      if (count > 1) {
        parts.push(`${action} ${count} ${action === "searching" ? "patterns" : "files"}`);
      } else {
        parts.push(action);
      }
    }
    return parts.join(", ") + "…";
  }

  if (responseText && responseText.trim().length > 0) {
    const lastLine = responseText.split("\n").find((l) => l.trim())?.trim() ?? "";
    if (lastLine.length > 60) return lastLine.slice(0, 60) + "…";
    if (lastLine.length > 0) return lastLine;
  }

  return "thinking…";
}

// ---- Widget ----

export class AgentWidget {
  private spinnerFrame = 0;
  private timer?: ReturnType<typeof setInterval>;
  private uiCtx?: any;
  private tui?: any;
  private widgetRegistered = false;
  /** Last content key — skips requestRender when only spinner changed. */
  private lastContentKey = "";

  /** Tracks how many turns each finished agent has survived. */
  private finishedTurnAge = new Map<string, number>();
  /** How many extra turns error/aborted agents linger. */
  private static readonly ERROR_LINGER_TURNS = 2;
  /** Last status bar text for dedup. */
  private lastStatusText: string | undefined;

  constructor(
    private manager: AgentManager,
    private activity: Map<string, AgentActivity>,
  ) {}

  setUICtx(ctx: any) {
    if (ctx !== this.uiCtx) {
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
      this.lastStatusText = undefined;
    }
  }

  /**
   * Called on each new turn (tool_execution_start).
   * Ages finished agents and clears those that have lingered long enough.
   */
  onTurnStart() {
    for (const [id, age] of this.finishedTurnAge) {
      this.finishedTurnAge.set(id, age + 1);
    }
    this.update();
  }

  ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length;
      if (this.lastContentKey) this.triggerRender();
    }, 80);
  }

  /** Record an agent as finished (call when agent completes). */
  markFinished(agentId: string) {
    if (!this.finishedTurnAge.has(agentId)) {
      this.finishedTurnAge.set(agentId, 0);
    }
  }

  update() {
    this.triggerRender();
  }

  /** Check if a finished agent should still be shown. */
  private shouldShowFinished(agentId: string, status: string): boolean {
    const age = this.finishedTurnAge.get(agentId) ?? 0;
    const maxAge = ERROR_STATUSES.has(status) ? AgentWidget.ERROR_LINGER_TURNS : 1;
    return age < maxAge;
  }

  /**
   * Build a content key capturing what's actually visible.
   * Excludes spinner — spinner-only changes skip requestRender.
   */
  private buildContentKey(): string {
    const allAgents = this.manager.listAgents();
    const parts: string[] = [];
    for (const a of allAgents) {
      if (a.status === "running" || a.status === "queued") {
        const act = this.activity.get(a.id);
        parts.push(
          `${a.id}:${a.status}:${a.toolUses}:${act?.turnCount ?? 0}:${act?.tokens ?? ""}:${describeActivity(act?.activeTools ?? new Map(), act?.responseText ?? "")}`,
        );
      } else if (a.completedAt && this.shouldShowFinished(a.id, a.status)) {
        parts.push(`${a.id}:${a.status}:${a.toolUses}:finished`);
      }
    }
    return parts.join("|");
  }

  private triggerRender() {
    if (!this.uiCtx) return;

    const contentKey = this.buildContentKey();
    const hasContent = contentKey.length > 0;

    // Nothing to show — clear widget
    if (!hasContent) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("unipi-agents", undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
        this.lastContentKey = "";
      }
      if (this.lastStatusText !== undefined) {
        this.uiCtx.setStatus?.("subagents", undefined);
        this.lastStatusText = undefined;
      }
      // Clean up stale finished entries
      const allAgents = this.manager.listAgents();
      for (const [id] of this.finishedTurnAge) {
        if (!allAgents.some((a) => a.id === id)) this.finishedTurnAge.delete(id);
      }
      return;
    }

    // Status bar
    this.updateStatusBar();

    // Register widget callback once
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget(
        "unipi-agents",
        (tui: any, theme: any) => {
          this.tui = tui;
          return {
            render: (width: number) => this.renderWidget(tui, theme, width),
            invalidate: () => {
              this.widgetRegistered = false;
              this.tui = undefined;
            },
          };
        },
        { placement: "aboveEditor" },
      );
      this.widgetRegistered = true;
      this.lastContentKey = "";
    }

    // Only request render when content actually changed
    if (contentKey !== this.lastContentKey) {
      this.lastContentKey = contentKey;
      this.tui?.requestRender?.();
    }
  }

  private updateStatusBar() {
    if (!this.uiCtx?.setStatus) return;
    const allAgents = this.manager.listAgents();
    let runningCount = 0;
    let queuedCount = 0;
    for (const a of allAgents) {
      if (a.status === "running") runningCount++;
      else if (a.status === "queued") queuedCount++;
    }

    let newStatusText: string | undefined;
    if (runningCount > 0 || queuedCount > 0) {
      const parts: string[] = [];
      if (runningCount > 0) parts.push(`${runningCount} running`);
      if (queuedCount > 0) parts.push(`${queuedCount} queued`);
      const total = runningCount + queuedCount;
      newStatusText = `${parts.join(", ")} agent${total === 1 ? "" : "s"}`;
    }

    if (newStatusText !== this.lastStatusText) {
      this.uiCtx.setStatus("subagents", newStatusText);
      this.lastStatusText = newStatusText;
    }
  }

  /** Render a finished agent line. */
  private renderFinishedLine(
    a: { id: string; type: string; status: string; description: string; toolUses: number; startedAt: number; completedAt?: number; error?: string },
    theme: any,
    w: number,
  ): string {
    const duration = formatMs((a.completedAt ?? Date.now()) - a.startedAt);

    let icon: string;
    let statusText: string;
    if (a.status === "completed") {
      icon = theme.fg("success", "✓");
      statusText = "";
    } else if (a.status === "stopped") {
      icon = theme.fg("dim", "■");
      statusText = theme.fg("dim", " stopped");
    } else if (a.status === "error") {
      icon = theme.fg("error", "✗");
      const errMsg = a.error ? `: ${a.error.slice(0, 40)}` : "";
      statusText = theme.fg("error", ` error${errMsg}`);
    } else {
      // aborted
      icon = theme.fg("error", "✗");
      statusText = theme.fg("warning", " aborted");
    }

    const parts: string[] = [];
    const act = this.activity.get(a.id);
    if (act) parts.push(formatTurns(act.turnCount, act.maxTurns));
    if (a.toolUses > 0) parts.push(`${a.toolUses} tool use${a.toolUses === 1 ? "" : "s"}`);
    parts.push(duration);

    const line =
      theme.fg("dim", "├─") +
      " " +
      icon +
      " " +
      theme.fg("dim", a.type) +
      "  " +
      theme.fg("dim", a.description) +
      " " +
      theme.fg("dim", "·") +
      " " +
      theme.fg("dim", parts.join(" · ")) +
      statusText;

    return truncateToWidth(line, w);
  }

  private renderWidget(tui: any, theme: any, width?: number): string[] {
    const allAgents = this.manager.listAgents();
    const running = allAgents.filter((a) => a.status === "running");
    const queued = allAgents.filter((a) => a.status === "queued");
    const finished = allAgents.filter(
      (a) =>
        a.status !== "running" &&
        a.status !== "queued" &&
        a.completedAt &&
        this.shouldShowFinished(a.id, a.status),
    );

    const hasActive = running.length > 0 || queued.length > 0;
    const hasFinished = finished.length > 0;
    if (!hasActive && !hasFinished) return [];

    const w = width ?? tui.terminal?.columns ?? 80;
    const frame = SPINNER[this.spinnerFrame % SPINNER.length];
    const headingColor = hasActive ? "accent" : "dim";
    const headingIcon = hasActive ? "●" : "○";

    // Build sections: finished (1 line each), running (2 lines each), queued (1 line)
    const finishedLines: string[] = finished.map((a) => this.renderFinishedLine(a, theme, w));

    const runningLines: string[][] = running.map((a) => {
      const act = this.activity.get(a.id);
      const toolCount = a.toolUses;
      const tokens = act?.tokens ?? "";
      const elapsed = formatMs(Date.now() - a.startedAt);
      const activity = act ? describeActivity(act.activeTools, act.responseText) : "starting…";

      const parts: string[] = [];
      if (act?.turnCount) parts.push(formatTurns(act.turnCount, act.maxTurns));
      if (toolCount > 0) parts.push(`${toolCount} tool use${toolCount === 1 ? "" : "s"}`);
      if (tokens) parts.push(tokens);
      parts.push(elapsed);

      return [
        truncateToWidth(
          theme.fg("dim", "├─") +
            ` ${theme.fg("accent", frame)} ${theme.bold(a.type)}  ${theme.fg("dim", a.description)} ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(" · "))}`,
          w,
        ),
        truncateToWidth(theme.fg("dim", "│  ") + theme.fg("dim", `  ⎿  ${activity}`), w),
      ];
    });

    const queuedLine =
      queued.length > 0
        ? truncateToWidth(
            theme.fg("dim", "├─") + ` ${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`,
            w,
          )
        : undefined;

    // Assemble with overflow cap
    const maxBody = MAX_WIDGET_LINES - 1; // heading takes 1 line
    const totalBody = finishedLines.length + runningLines.length * 2 + (queuedLine ? 1 : 0);

    const lines: string[] = [truncateToWidth(theme.fg(headingColor, headingIcon) + " " + theme.fg(headingColor, "Agents"), w)];

    if (totalBody <= maxBody) {
      // Everything fits
      lines.push(...finishedLines);
      for (const pair of runningLines) lines.push(...pair);
      if (queuedLine) lines.push(queuedLine);

      // Fix last connector: ├─ → └─
      if (lines.length > 1) {
        const last = lines.length - 1;
        lines[last] = lines[last].replace("├─", "└─");
        if (runningLines.length > 0 && !queuedLine && last >= 2) {
          lines[last - 1] = lines[last - 1].replace("├─", "└─");
          lines[last] = lines[last].replace("│  ", "   ");
        }
      }
    } else {
      // Overflow — prioritize: running > queued > finished
      let budget = maxBody - 1; // reserve 1 for overflow indicator
      let hiddenRunning = 0;
      let hiddenFinished = 0;

      // 1. Running agents (2 lines each)
      for (const pair of runningLines) {
        if (budget >= 2) {
          lines.push(...pair);
          budget -= 2;
        } else {
          hiddenRunning++;
        }
      }

      // 2. Queued
      if (queuedLine && budget >= 1) {
        lines.push(queuedLine);
        budget--;
      }

      // 3. Finished
      for (const fl of finishedLines) {
        if (budget >= 1) {
          lines.push(fl);
          budget--;
        } else {
          hiddenFinished++;
        }
      }

      // Overflow summary
      const overflowParts: string[] = [];
      if (hiddenRunning > 0) overflowParts.push(`${hiddenRunning} running`);
      if (hiddenFinished > 0) overflowParts.push(`${hiddenFinished} finished`);
      if (overflowParts.length > 0) {
        lines.push(
          truncateToWidth(
            theme.fg("dim", "└─") + ` ${theme.fg("dim", `+${hiddenRunning + hiddenFinished} more (${overflowParts.join(", ")})`)}`,
            w,
          ),
        );
      }
    }

    return lines;
  }

  dispose() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.uiCtx) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("unipi-agents", undefined);
      }
      if (this.lastStatusText !== undefined) {
        this.uiCtx.setStatus?.("subagents", undefined);
      }
    }
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastStatusText = undefined;
  }
}
