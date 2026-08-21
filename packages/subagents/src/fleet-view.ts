/**
 * @pi-unipi/subagents — FleetView (persistent fleet panel)
 *
 * pi-subagents parity built on OUR panel system: a persistent setWidget slot
 * (belowEditor/aboveEditor placement from config) summarizing active work —
 * in-process agents from the AgentManager plus async process runs from the
 * run dirs. Collapsed by default; ↓/← activates selection, j/k navigate,
 * enter opens the inspector, esc deactivates.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentManager } from "./agent-manager.js";
import type { AgentActivity } from "./types.js";
import { listAsyncRunSummaries, type AsyncRunSummary } from "./fleet-data.js";

const REFRESH_MS = 500;
const MAX_AGENT_ROWS = 6;

export interface FleetEntry {
  key: string;
  source: "inprocess" | "async";
  agent: string;
  description?: string;
  startedAt: number;
  state: string;
  /** Run dir for async entries (inspector target). */
  runDir?: string;
}

export interface FleetViewOptions {
  refreshMs?: number;
  maxAgentRows?: number;
  placement?: "belowEditor" | "aboveEditor";
  /** Open the inspector for an entry (wired to ConversationViewer overlay). */
  openInspector?: (entry: FleetEntry) => Promise<void> | void;
}

function isActiveState(state: string): boolean {
  return state === "running" || state === "queued" || state === "pending";
}

/** Collect active entries across both transports. */
export function collectFleetEntries(
  manager: AgentManager,
  activity: Map<string, AgentActivity>,
  asyncDirRoot: string,
): FleetEntry[] {
  const entries: FleetEntry[] = [];

  for (const record of manager.listAgents()) {
    if (!isActiveState(record.status)) continue;
    const act = activity.get(record.id);
    entries.push({
      key: `inprocess:${record.id}`,
      source: "inprocess",
      agent: record.type,
      description: record.description,
      startedAt: record.startedAt,
      state: record.status,
    });
    void act;
  }

  for (const run of listAsyncRunSummaries(asyncDirRoot)) {
    if (!isActiveState(run.state)) continue;
    entries.push({
      key: `async:${run.runId}`,
      source: "async",
      agent: run.agent,
      description: run.taskSummary,
      startedAt: run.startedAt,
      state: run.state,
      runDir: run.runDir,
    });
  }

  return entries.sort((left, right) => left.startedAt - right.startedAt || left.key.localeCompare(right.key));
}

export class FleetView {
  private uiCtx: ExtensionUIContext | undefined;
  private tui: { requestRender(): void } | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private widgetRegistered = false;
  private lastRenderKey = "";
  private entries: FleetEntry[] = [];
  private active = false;
  private selectedKey = "main";
  private inspectorOpen = false;

  constructor(
    private manager: AgentManager,
    private activity: Map<string, AgentActivity>,
    private asyncDirRoot: string,
    private options: FleetViewOptions = {},
  ) {}

  setUICtx(ctx: ExtensionUIContext): void {
    if (ctx === this.uiCtx) return;
    this.clearRegistration();
    this.uiCtx = ctx;
    this.ensureTimer();
    this.refresh();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.clearRegistration();
    this.uiCtx = undefined;
    this.entries = [];
    this.active = false;
    this.selectedKey = "main";
  }

  /** Called when work starts/finishes to trigger a refresh. */
  refresh(): void {
    const ctx = this.uiCtx;
    if (!ctx) return;
    this.entries = collectFleetEntries(this.manager, this.activity, this.asyncDirRoot);
    this.clampSelection();

    if (this.inspectorOpen) {
      this.lastRenderKey = "";
      this.clearWidget();
      return;
    }
    if (this.entries.length === 0) {
      this.active = false;
      this.selectedKey = "main";
      this.lastRenderKey = "";
      this.clearWidget();
      return;
    }

    const renderKey = JSON.stringify({
      active: this.active,
      selected: this.selectedKey,
      entries: this.entries.map((e) => [e.key, e.state]),
    });
    if (!this.widgetRegistered) {
      ctx.setWidget(
        "unipi-fleet-status",
        (tui: unknown, _theme: unknown) => {
          this.tui = tui as { requestRender(): void };
          return {
            render: (width: number) => this.render(width),
            invalidate: () => {
              this.lastRenderKey = "";
            },
            dispose: () => {
              this.widgetRegistered = false;
              this.tui = undefined;
            },
          };
        },
        { placement: this.options.placement ?? "belowEditor" },
      );
      this.widgetRegistered = true;
      this.lastRenderKey = renderKey;
      return;
    }
    if (renderKey === this.lastRenderKey) return;
    this.lastRenderKey = renderKey;
    this.tui?.requestRender();
  }

  /**
   * Key handling for the collapsed/active roster. Returns consume intent.
   * Wired from index.ts's terminal input hook.
   */
  handleKey(data: string, editorHasFocus: () => boolean): { consume?: boolean } | undefined {
    const ctx = this.uiCtx;
    if (!ctx || this.entries.length === 0) return undefined;
    if (this.inspectorOpen) return undefined;
    if (!editorHasFocus()) {
      if (this.active) this.deactivate();
      return undefined;
    }

    if (!this.active) {
      const activates = matchesKey(data, "down") || matchesKey(data, "left");
      if (!activates || ctx.getEditorText?.() !== "") return undefined;
      this.active = true;
      this.selectedKey = "main";
      this.refresh();
      return { consume: true };
    }

    const roster = this.rosterKeys();
    const selectedIndex = Math.max(0, roster.indexOf(this.selectedKey));
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.selectedKey = roster[Math.min(roster.length - 1, selectedIndex + 1)] ?? "main";
      this.refresh();
      return { consume: true };
    }
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      if (selectedIndex === 0) {
        this.deactivate();
        return { consume: true };
      }
      this.selectedKey = roster[selectedIndex - 1] ?? "main";
      this.refresh();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      this.deactivate();
      return { consume: true };
    }
    if (matchesKey(data, Key.enter)) {
      if (this.selectedKey === "main") {
        this.deactivate();
        return { consume: true };
      }
      const entry = this.entries.find((e) => e.key === this.selectedKey);
      if (!entry) return undefined;
      this.inspectorOpen = true;
      this.refresh();
      void Promise.resolve()
        .then(() => this.options.openInspector?.(entry))
        .catch(() => {})
        .finally(() => {
          this.inspectorOpen = false;
          this.refresh();
        });
      return { consume: true };
    }
    return undefined;
  }

  render(width: number): string[] {
    if (this.entries.length === 0) return [];
    if (!this.active) {
      // Collapsed summary row.
      const count = this.entries.length;
      const noun = count === 1 ? "agent" : "agents";
      const states = new Map<string, number>();
      for (const entry of this.entries) states.set(entry.state, (states.get(entry.state) ?? 0) + 1);
      const breakdown = [...states.entries()].map(([state, n]) => `${n} ${state}`).join(", ");
      return [
        truncateToWidth(`  ${count} active ${noun} (${breakdown}) · ↓ to inspect`, width),
      ];
    }

    const roster = this.rosterKeys();
    const selectedIndex = Math.max(0, roster.indexOf(this.selectedKey));
    const lines = [truncateToWidth(`  ↑↓/jk select · enter inspect · esc back`, width), ""];
    lines.push(truncateToWidth(`  ${this.bullet(0, selectedIndex)} main`, width));

    const visibleCount = Math.min(this.options.maxAgentRows ?? MAX_AGENT_ROWS, this.entries.length);
    const start = selectedIndex < visibleCount ? 0 : selectedIndex - visibleCount + 1;
    const hiddenBelow = this.entries.length - (start + visibleCount);
    if (start > 0) lines.push(truncateToWidth(`  ↑ ${start} more`, width));
    for (let index = start; index < start + visibleCount; index++) {
      const entry = this.entries[index];
      if (!entry) break;
      lines.push(...this.renderEntry(index + 1, selectedIndex, entry, width));
    }
    if (hiddenBelow > 0) lines.push(truncateToWidth(`  ↓ ${hiddenBelow} more`, width));
    return lines;
  }

  private renderEntry(rosterIndex: number, selectedIndex: number, entry: FleetEntry, width: number): string[] {
    void rosterIndex;
    const elapsed = formatElapsed(Date.now() - entry.startedAt);
    const sourceTag = entry.source === "async" ? "proc" : "local";
    const left = `  ${this.bullet(-1, selectedIndex)} ${entry.agent} · ${entry.state}`;
    const right = `${sourceTag} · ${elapsed}`;
    return [truncateToWidth(`${left}  ${right}`, width)];
  }

  private bullet(_index: number, selectedIndex: number): string {
    return selectedIndex > 0 ? ">" : " ";
  }

  private rosterKeys(): string[] {
    return ["main", ...this.entries.map((entry) => entry.key)];
  }

  private clampSelection(): void {
    if (!this.rosterKeys().includes(this.selectedKey)) this.selectedKey = "main";
  }

  private deactivate(): void {
    this.active = false;
    this.selectedKey = "main";
    this.refresh();
  }

  private clearWidget(): void {
    if (this.widgetRegistered && this.uiCtx) {
      this.uiCtx.setWidget("unipi-fleet-status", undefined);
      this.widgetRegistered = false;
      this.tui = undefined;
    }
  }

  private clearRegistration(): void {
    this.clearWidget();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.refresh(), this.options.refreshMs ?? REFRESH_MS);
    this.timer.unref?.();
  }
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
