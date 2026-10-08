/**
 * Work adapter (UNI-160 "session control centre" §4 Running): one item list
 * over background tasks, subagents, and the Fusion sidekick — footer-style
 * dots (green running, yellow stopped, red failed, gray done). No TUI
 * dependency so the TUI tray (UNI-126) can reuse it later; lives in
 * app-bridge because that is the only consumer today, but imports nothing
 * bridge-specific.
 *
 * Every producer is read lazily off globalThis (`Symbol.for`), duck-typed
 * against its public shape (same pattern as the bridge's btw lookup in
 * bridge.ts): app-bridge never gains a hard dependency on background-tasks /
 * subagents / fusion. A pi without those modules installed just reports an
 * empty list.
 */
import { bus, UNIPI_EVENTS } from "@pi-unipi/core";

export type WorkDot = "running" | "stopped" | "failed" | "done";

/** One row of the phone's "Running" section. */
export interface WorkItem {
  id: string;
  kind: "bg" | "subagent" | "sidekick";
  title: string;
  dot: WorkDot;
  detail?: string;
  startedAt: number;
  endedAt?: number;
  /** bg: can be stopped while running. subagent: can be stopped, or sent to
   *  background while running in the foreground. sidekick: neither (owned by
   *  Fusion's own lifecycle — turning Fusion off is the only "stop"). */
  canStop: boolean;
  canRerun: boolean;
  canBackground: boolean;
}

// ── background-tasks (duck-typed; see registry-shared.ts / types.ts) ──────

type BgStatus = "running" | "completed" | "failed" | "killed";
interface BgTaskSnapshot {
  id: string;
  name?: string;
  command: string;
  status: BgStatus;
  error?: string;
  startTime: number;
  endTime?: number;
}
interface BgTask {
  id: string;
}
interface BgRegistry {
  allTasks(): BgTask[];
  snapshot(task: BgTask): BgTaskSnapshot;
  resolveTask(idOrPrefix: string): BgTask;
  stopTask(task: BgTask, kind: "user"): Promise<BgTask>;
  getTaskLogs(task: BgTask, maxBytes: number, tail: boolean): Promise<{ text: string; details: { truncated: boolean } }>;
}
const BG_REGISTRY_KEY = Symbol.for("unipi.background-tasks.shared-registry");
const getBgRegistry = (): BgRegistry | undefined => (globalThis as unknown as Record<symbol, unknown>)[BG_REGISTRY_KEY] as BgRegistry | undefined;

// ── subagents (duck-typed; see manager-shared.ts / manager.ts) ────────────

type SubagentStatus = "running" | "completed" | "failed" | "cancelled";
interface SubagentRecord {
  id: string;
  title: string;
  status: SubagentStatus;
  background: boolean;
  startedAt: number;
  endedAt?: number;
  task?: string;
  report?: string;
  error?: string;
}
interface SubagentManager {
  run(id: string): unknown;
  cancel(id: string, by: "user" | "session"): boolean;
  setBackground(id: string, background: boolean): void;
}
const SUBAGENT_MANAGER_KEY = Symbol.for("unipi.subagents.shared-manager");
const getSubagentManager = (): SubagentManager | undefined => (globalThis as unknown as Record<symbol, unknown>)[SUBAGENT_MANAGER_KEY] as SubagentManager | undefined;

/** `getSharedSubagents()`'s records — published alongside the manager under
 *  the SAME key's module (manager.ts keeps a module-level map); the bridge
 *  reads it through the manager accessor's sibling export instead of a
 *  second symbol, so this stays a plain function reference captured once. */
let sharedSubagentsFn: (() => readonly SubagentRecord[]) | undefined;
const SUBAGENT_LIST_KEY = Symbol.for("unipi.subagents.shared-list"); // keep in sync with manager-shared.ts
function getSharedSubagentRecords(): readonly SubagentRecord[] {
  if (!sharedSubagentsFn) {
    sharedSubagentsFn = (globalThis as unknown as Record<symbol, unknown>)[SUBAGENT_LIST_KEY] as (() => readonly SubagentRecord[]) | undefined;
  }
  return sharedSubagentsFn?.() ?? [];
}

function bgDot(status: BgStatus): WorkDot {
  if (status === "running") return "running";
  if (status === "killed") return "stopped";
  if (status === "failed") return "failed";
  return "done";
}

function subagentDot(status: SubagentStatus): WorkDot {
  if (status === "running") return "running";
  if (status === "cancelled") return "stopped";
  if (status === "failed") return "failed";
  return "done";
}

function bgItem(task: BgTask, registry: BgRegistry): WorkItem {
  const s = registry.snapshot(task);
  return {
    id: `bg-${s.id}`,
    kind: "bg",
    title: s.name ?? s.command,
    dot: bgDot(s.status),
    detail: s.status === "running" ? s.command : s.error,
    startedAt: s.startTime,
    endedAt: s.endTime,
    canStop: s.status === "running",
    canRerun: s.status !== "running",
    canBackground: false,
  };
}

function subagentItem(rec: SubagentRecord): WorkItem {
  return {
    id: `agent-${rec.id}`,
    kind: "subagent",
    title: rec.title,
    dot: subagentDot(rec.status),
    detail: rec.status === "running" ? rec.task : rec.error ?? rec.report,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    canStop: rec.status === "running",
    canRerun: rec.status !== "running",
    canBackground: rec.status === "running" && !rec.background,
  };
}

/** Fusion's sidekick, read off the bus (sticky `FUSION_STATUS`) — never a
 *  direct fusion import, so app-bridge stays dependency-free of it too. */
function sidekickItem(): WorkItem | undefined {
  const status = bus.get(UNIPI_EVENTS.FUSION_STATUS);
  if (!status) return undefined;
  return {
    id: "sidekick",
    kind: "sidekick",
    title: `${status.sidekickName || "Sidekick"} (Fusion)`,
    dot: status.busy ? "running" : "done",
    detail: status.busy ? `helping ${status.leadName || "the lead"}` : "idle — waiting for a handoff",
    startedAt: 0,
    canStop: false,
    canRerun: false,
    canBackground: false,
  };
}

/** Every work item, running items pinned to the top, then newest-started first. */
export function listWorkItems(): WorkItem[] {
  const items: WorkItem[] = [];
  try {
    const registry = getBgRegistry();
    if (registry) for (const task of registry.allTasks()) items.push(bgItem(task, registry));
  } catch {
    /* background-tasks not installed / registry gone */
  }
  try {
    for (const rec of getSharedSubagentRecords()) items.push(subagentItem(rec));
  } catch {
    /* subagents not installed */
  }
  try {
    const side = sidekickItem();
    if (side) items.push(side);
  } catch {
    /* fusion not installed / no status yet */
  }
  items.sort((a, b) => {
    const aRunning = a.dot === "running" ? 1 : 0;
    const bRunning = b.dot === "running" ? 1 : 0;
    if (aRunning !== bRunning) return bRunning - aRunning;
    return b.startedAt - a.startedAt;
  });
  return items;
}

export function runningWorkCount(): number {
  return listWorkItems().filter((i) => i.dot === "running").length;
}

function splitId(id: string): [string, string] {
  const i = id.indexOf("-");
  return i < 0 ? [id, ""] : [id.slice(0, i), id.slice(i + 1)];
}

/** Stops a bg task (kind "bg") or cancels a subagent (kind "subagent").
 *  Sidekick items can't be stopped directly (see WorkItem.canStop). */
export async function stopWorkItem(id: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const [kind, rest] = splitId(id);
  if (kind === "bg") {
    const registry = getBgRegistry();
    if (!registry) return { ok: false, message: "Background tasks are not available." };
    try {
      const task = registry.resolveTask(rest);
      await registry.stopTask(task, "user");
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
  if (kind === "agent") {
    const manager = getSubagentManager();
    if (!manager) return { ok: false, message: "Subagents are not available." };
    return manager.cancel(rest, "user") ? { ok: true } : { ok: false, message: "That subagent isn't running." };
  }
  return { ok: false, message: "This item can't be stopped." };
}

/** Moves a running foreground subagent to the background. bg tasks and the
 *  sidekick don't support this (see WorkItem.canBackground). */
export function backgroundWorkItem(id: string): { ok: true } | { ok: false; message: string } {
  const [kind, rest] = splitId(id);
  if (kind !== "agent") return { ok: false, message: "Only subagents can be sent to the background." };
  const manager = getSubagentManager();
  if (!manager) return { ok: false, message: "Subagents are not available." };
  const run = manager.run(rest);
  if (!run) return { ok: false, message: "That subagent isn't running." };
  manager.setBackground(rest, true);
  return { ok: true };
}

/** Live log page for a bg task (§4 "bg = live log"): reads the task's
 *  outputPath, tail-first by default, capped at `maxBytes` (≤256 KB per the
 *  phone's paging budget). */
export async function workLogPage(
  id: string,
  opts: { maxBytes?: number } = {},
): Promise<{ text: string; more: boolean; at: number } | { error: string }> {
  const [kind, rest] = splitId(id);
  if (kind !== "bg") return { error: "Only background tasks have a log." };
  const registry = getBgRegistry();
  if (!registry) return { error: "Background tasks are not available." };
  try {
    const task = registry.resolveTask(rest);
    const maxBytes = Math.min(opts.maxBytes ?? 256 * 1024, 256 * 1024);
    const { text, details } = await registry.getTaskLogs(task, maxBytes, true);
    return { text, more: details.truncated, at: Date.now() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

