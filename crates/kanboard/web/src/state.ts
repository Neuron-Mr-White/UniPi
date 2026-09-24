/**
 * App state: projects, the open board, rules, live revisions (SSE), view and
 * display preferences, filters, selection, dialogs and toasts. One module so the
 * components stay presentational.
 */

import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import {
  api,
  ApiError,
  LANES,
  PERMISSIVE_RULES,
  type Problem,
  type ProjectSummary,
  type Rules,
  type Task,
} from "./api.js";

// ─── types ──────────────────────────────────────────────────────────────────

export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

export interface Toast {
  id: number;
  kind: "info" | "success" | "warning" | "error";
  message: string;
  action?: ToastAction;
}

export type ConnState = "connecting" | "live" | "reconnecting";
export type View = "board" | "list";
/** Sidebar shortcuts that narrow the list to one lane. */
export type Scope = "all" | "in_review" | "blocked";
export type Density = "comfortable" | "compact";

export interface CommentRequest {
  task: Task;
  to: string;
  hint: string;
  /** Called after the move succeeded (e.g. to re-order the dropped card). */
  after?: () => Promise<void>;
}

// ─── stores & signals ───────────────────────────────────────────────────────

export const [projects, setProjects] = createStore<{ items: ProjectSummary[]; loaded: boolean }>({ items: [], loaded: false });
export const [board, setBoard] = createStore<{ tasks: Task[]; problems: Problem[]; loading: boolean; loaded: boolean }>({
  tasks: [],
  problems: [],
  loading: false,
  loaded: false,
});
export const [rules, setRules] = createStore<Rules>({ ...PERMISSIVE_RULES, statuses: [...PERMISSIVE_RULES.statuses] });

export const [slug, setSlug] = createSignal<string | null>(new URLSearchParams(location.search).get("project"));
export const [toasts, setToasts] = createSignal<Toast[]>([]);
export const [conn, setConn] = createSignal<ConnState>("connecting");
export const [query, setQuery] = createSignal("");
export const [openTaskId, setOpenTaskId] = createSignal<string | null>(null);
export const [selectedId, setSelectedId] = createSignal<string | null>(null);
export const [theme, setTheme] = createSignal<"dark" | "light">(initialTheme());
export const [view, setViewSignal] = createSignal<View>(initialView());
export const [scope, setScope] = createSignal<Scope>("all");
export const [sidebarCollapsed, setSidebarCollapsedSignal] = createSignal(localStorage.getItem("kanboard.sidebar") === "collapsed");
export const [paletteOpen, setPaletteOpen] = createSignal(false);
export const [shortcutsOpen, setShortcutsOpen] = createSignal(false);
export const [newTaskLane, setNewTaskLane] = createSignal<string | null>(null);
export const [commentRequest, setCommentRequest] = createSignal<CommentRequest | null>(null);
/** Ticks every 15s so elapsed times ("running 4m") stay current. */
export const [now, setNow] = createSignal(Date.now());
setInterval(() => setNow(Date.now()), 15_000);

export const [filters, setFilters] = createStore<{ priorities: string[]; labels: string[]; running: boolean; waiting: boolean }>({
  priorities: [],
  labels: [],
  running: false,
  waiting: false,
});

interface DisplayPrefs {
  hidden: string[];
  excerpt: boolean;
  density: Density;
  /** Draw same-lane dependency chains as adjacent, connected blocks. */
  chains: boolean;
}
export const [display, setDisplayStore] = createStore<DisplayPrefs>(initialDisplay());

// ─── preferences ────────────────────────────────────────────────────────────

function initialTheme(): "dark" | "light" {
  const stored = localStorage.getItem("kanboard.theme");
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function initialView(): View {
  const fromUrl = new URLSearchParams(location.search).get("view");
  if (fromUrl === "list" || fromUrl === "board") return fromUrl;
  return localStorage.getItem("kanboard.view") === "list" ? "list" : "board";
}

function initialDisplay(): DisplayPrefs {
  try {
    const parsed = JSON.parse(localStorage.getItem("kanboard.display") ?? "null") as Partial<DisplayPrefs> | null;
    if (parsed && Array.isArray(parsed.hidden)) {
      return {
        hidden: parsed.hidden.filter((lane) => typeof lane === "string"),
        excerpt: parsed.excerpt !== false,
        density: parsed.density === "compact" ? "compact" : "comfortable",
        chains: parsed.chains !== false,
      };
    }
  } catch {
    /* corrupt prefs → defaults */
  }
  return { hidden: ["archived"], excerpt: true, density: "comfortable", chains: true };
}

export function setDisplay<K extends keyof DisplayPrefs>(key: K, value: DisplayPrefs[K]): void {
  setDisplayStore(key, value as never);
  localStorage.setItem("kanboard.display", JSON.stringify({ ...display }));
}

export function toggleLane(laneId: string): void {
  const hidden = display.hidden.includes(laneId) ? display.hidden.filter((lane) => lane !== laneId) : [...display.hidden, laneId];
  setDisplay("hidden", hidden);
}

export function applyTheme(next: "dark" | "light"): void {
  setTheme(next);
  document.documentElement.dataset.theme = next;
  localStorage.setItem("kanboard.theme", next);
}

export function toggleTheme(): void {
  applyTheme(theme() === "dark" ? "light" : "dark");
}

export function setView(next: View, nextScope: Scope = "all"): void {
  setViewSignal(next);
  setScope(nextScope);
  localStorage.setItem("kanboard.view", next);
  syncUrl();
}

export function setSidebarCollapsed(next: boolean): void {
  setSidebarCollapsedSignal(next);
  localStorage.setItem("kanboard.sidebar", next ? "collapsed" : "open");
}

function syncUrl(): void {
  const params = new URLSearchParams(location.search);
  const current = slug();
  if (current) params.set("project", current);
  else params.delete("project");
  if (view() === "list") params.set("view", "list");
  else params.delete("view");
  params.delete("t"); // the token lives in the cookie after the first visit
  const search = params.toString();
  history.replaceState(null, "", `${location.pathname}${search ? `?${search}` : ""}`);
}

// ─── toasts ─────────────────────────────────────────────────────────────────

let toastId = 0;

export function toast(message: string, kind: Toast["kind"] = "info", action?: ToastAction): void {
  const entry: Toast = { id: ++toastId, kind, message, action };
  setToasts((current) => [...current.slice(-3), entry]);
  const ttl = action ? 8000 : kind === "error" ? 9000 : 4500;
  setTimeout(() => dismissToast(entry.id), ttl);
}

export function dismissToast(id: number): void {
  setToasts((current) => current.filter((item) => item.id !== id));
}

export function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

// ─── loading ────────────────────────────────────────────────────────────────

let revisionTimer: number | undefined;
let source: EventSource | undefined;

export async function loadProjects(): Promise<void> {
  try {
    setProjects("items", await api.projects());
  } catch (error) {
    toast(describe(error), "error");
  } finally {
    setProjects("loaded", true);
  }
}

export async function loadRules(): Promise<void> {
  try {
    setRules(await api.rules());
  } catch {
    // Older daemon: the per-task allowedMoves still work; the server refuses the rest.
    setRules({ ...PERMISSIVE_RULES, statuses: [...PERMISSIVE_RULES.statuses] });
  }
}

export async function loadBoard(target: string | null = slug()): Promise<void> {
  if (!target) return;
  setBoard("loading", true);
  try {
    const payload = await api.tasks(target);
    if (slug() !== target) return; // switched project meanwhile
    setBoard("tasks", payload.tasks);
    setBoard("problems", payload.problems ?? []);
    setBoard("loaded", true);
  } catch (error) {
    toast(describe(error), "error");
  } finally {
    setBoard("loading", false);
  }
}

/** SSE: one revision per board change → debounced refetch (board + sidebar counts). */
function watchBoard(target: string): void {
  source?.close();
  setConn("connecting");
  const events = new EventSource(`/events?project=${encodeURIComponent(target)}`);
  source = events;
  events.addEventListener("revision", () => {
    setConn("live");
    if (revisionTimer !== undefined) window.clearTimeout(revisionTimer);
    revisionTimer = window.setTimeout(() => {
      void loadBoard(target);
      void loadProjects();
    }, 250);
  });
  events.addEventListener("open", () => setConn("live"));
  events.onerror = () => setConn("reconnecting");
}

export async function openProject(target: string | null): Promise<void> {
  setSlug(target);
  setOpenTaskId(null);
  setSelectedId(null);
  setBoard({ tasks: [], problems: [], loaded: false });
  syncUrl();
  if (!target) {
    source?.close();
    source = undefined;
    return;
  }
  await loadBoard(target);
  watchBoard(target);
}

// ─── board helpers ──────────────────────────────────────────────────────────

/** Apply a server response for one task into the board. */
export function upsertTask(task: Task): void {
  const index = board.tasks.findIndex((candidate) => candidate.id === task.id);
  if (index === -1) setBoard("tasks", (current) => [...current, task]);
  else setBoard("tasks", index, task);
}

export function taskById(id: string | null): Task | undefined {
  return id ? board.tasks.find((task) => task.id === id) : undefined;
}

export function currentProject(): ProjectSummary | undefined {
  return projects.items.find((project) => project.slug === slug());
}

export function visibleLanes(): readonly { id: string; label: string }[] {
  const lanes = LANES.filter((lane) => !display.hidden.includes(lane.id));
  if (scope() !== "all") return lanes.filter((lane) => lane.id === scope()).length > 0 ? LANES.filter((lane) => lane.id === scope()) : lanes;
  return lanes;
}

export function filterCount(): number {
  return filters.priorities.length + filters.labels.length + (filters.running ? 1 : 0) + (filters.waiting ? 1 : 0);
}

export function clearFilters(): void {
  setFilters({ priorities: [], labels: [], running: false, waiting: false });
  setQuery("");
}

export function allLabels(): string[] {
  const seen = new Set<string>();
  for (const task of board.tasks) for (const label of task.labels ?? []) seen.add(label);
  return [...seen].sort();
}

/** Text query + filter popover + sidebar scope. */
export function matches(task: Task): boolean {
  const needle = query().trim().toLowerCase();
  if (
    needle.length > 0 &&
    !(
      task.id.toLowerCase().includes(needle) ||
      task.title.toLowerCase().includes(needle) ||
      (task.body ?? "").toLowerCase().includes(needle) ||
      (task.labels ?? []).some((label) => label.toLowerCase().includes(needle))
    )
  )
    return false;
  if (filters.priorities.length > 0 && !filters.priorities.includes(task.priority ?? "none")) return false;
  if (filters.labels.length > 0 && !(task.labels ?? []).some((label) => filters.labels.includes(label))) return false;
  if (filters.running && !task.run) return false;
  if (filters.waiting && (task.waitingFor ?? []).length === 0) return false;
  return true;
}

export function laneTasks(laneId: string): Task[] {
  return board.tasks
    .filter((task) => task.status === laneId && matches(task))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
}

/** One drawn row of a lane: a task and its place in a same-lane chain. */
export interface LaneItem {
  task: Task;
  /** Position within its chain block; `single` when it is not chained. */
  chain: "single" | "first" | "middle" | "last";
  /** Same-lane parents, drawn above it in the block. */
  parents: string[];
}

/**
 * Lane order with same-lane dependency chains pulled together. Pure layout: the
 * stored order is untouched and every card still moves on its own.
 *
 * Tasks linked by deps *within the lane* form a component. The component is
 * placed where its earliest member (by stored order) sits, and its members are
 * laid out topologically (parents first), ties broken by stored order. Branches
 * (several parents / children) stay one block in a valid order; tasks with more
 * than one parent keep their "after …" tag so nothing is hidden.
 */
export function laneLayout(laneId: string): LaneItem[] {
  const tasks = laneTasks(laneId);
  if (!display.chains || tasks.length < 2) return tasks.map((task) => ({ task, chain: "single", parents: [] }));
  const here = new Map(tasks.map((task) => [task.id, task]));
  const rank = new Map(tasks.map((task, index) => [task.id, index]));
  const parentsOf = (task: Task): string[] => (task.deps ?? []).filter((dep) => here.has(dep));

  // Union-find over same-lane edges.
  const root = new Map(tasks.map((task) => [task.id, task.id]));
  const find = (id: string): string => {
    let current = id;
    while (root.get(current) !== current) current = root.get(current)!;
    root.set(id, current);
    return current;
  };
  for (const task of tasks) for (const dep of parentsOf(task)) root.set(find(task.id), find(dep));

  const groups = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = find(task.id);
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }

  const out: LaneItem[] = [];
  const placed = new Set<string>();
  for (const task of tasks) {
    const key = find(task.id);
    if (placed.has(key)) continue;
    placed.add(key);
    const members = groups.get(key)!;
    if (members.length === 1) {
      out.push({ task, chain: "single", parents: [] });
      continue;
    }
    // Kahn's algorithm, ready set ordered by stored rank.
    const ids = new Set(members.map((member) => member.id));
    const indegree = new Map(members.map((member) => [member.id, parentsOf(member).filter((dep) => ids.has(dep)).length]));
    const queue = members.filter((member) => indegree.get(member.id) === 0);
    const ordered: Task[] = [];
    while (queue.length > 0) {
      queue.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
      const next = queue.shift()!;
      ordered.push(next);
      for (const member of members) {
        if (!parentsOf(member).includes(next.id)) continue;
        const left = indegree.get(member.id)! - 1;
        indegree.set(member.id, left);
        if (left === 0) queue.push(member);
      }
    }
    // A cycle can't exist (the binary rejects it); fall back to rank for safety.
    for (const member of members) if (!ordered.includes(member)) ordered.push(member);
    ordered.forEach((member, index) =>
      out.push({
        task: member,
        chain: index === 0 ? "first" : index === ordered.length - 1 ? "last" : "middle",
        parents: parentsOf(member),
      }),
    );
  }
  return out;
}

export function laneCount(laneId: string): number {
  return board.tasks.filter((task) => task.status === laneId).length;
}

/** Every visible task in reading order (lane by lane) — drives J/K. */
export function orderedVisible(): Task[] {
  return visibleLanes().flatMap((lane) => laneLayout(lane.id).map((item) => item.task));
}

export function moveSelection(delta: number): void {
  const ordered = orderedVisible();
  if (ordered.length === 0) return;
  const index = ordered.findIndex((task) => task.id === selectedId());
  const next = index === -1 ? (delta > 0 ? 0 : ordered.length - 1) : Math.min(ordered.length - 1, Math.max(0, index + delta));
  setSelectedId(ordered[next]!.id);
  document.querySelector(`[data-id="${CSS.escape(ordered[next]!.id)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

export function runningTasks(): Task[] {
  return board.tasks.filter((task) => !!task.run);
}

/** "4m", "2h 5m", "3d" — compact elapsed time for the agent chip. */
export function elapsed(iso: string | undefined): string {
  if (!iso) return "";
  const start = Date.parse(iso);
  if (Number.isNaN(start)) return "";
  const minutes = Math.max(0, Math.floor((now() - start) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

export function laneLabel(id: string): string {
  return LANES.find((lane) => lane.id === id)?.label ?? id.replace("_", " ");
}
