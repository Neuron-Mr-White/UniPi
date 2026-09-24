/**
 * App state: tasks, rules, live revisions (SSE), toasts, theme, panels.
 * One store for the board so components stay dumb.
 */

import { createSignal, onCleanup } from "solid-js";
import { createStore } from "solid-js/store";
import {
  api,
  ApiError,
  PERMISSIVE_RULES,
  type Problem,
  type ProjectSummary,
  type Rules,
  type Task,
} from "./api.js";

export interface Toast {
  id: number;
  kind: "info" | "success" | "warning" | "error";
  message: string;
}

export type ConnState = "connecting" | "live" | "reconnecting";

export const [projects, setProjects] = createStore<{ items: ProjectSummary[]; loaded: boolean }>({ items: [], loaded: false });
export const [board, setBoard] = createStore<{ tasks: Task[]; problems: Problem[]; loading: boolean; slug: string | null }>({
  tasks: [],
  problems: [],
  loading: false,
  slug: null,
});
export const [rules, setRules] = createStore<Rules>({ ...PERMISSIVE_RULES, statuses: [...PERMISSIVE_RULES.statuses] });
export const [toasts, setToasts] = createSignal<Toast[]>([]);
export const [conn, setConn] = createSignal<ConnState>("connecting");
export const [query, setQuery] = createSignal("");
export const [showArchive, setShowArchive] = createSignal(false);
export const [openTaskId, setOpenTaskId] = createSignal<string | null>(null);
export const [theme, setTheme] = createSignal<"dark" | "light">(initialTheme());

let toastId = 0;
let revisionTimer: number | undefined;
let source: EventSource | undefined;

function initialTheme(): "dark" | "light" {
  const stored = localStorage.getItem("kanboard.theme");
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(next: "dark" | "light"): void {
  setTheme(next);
  document.documentElement.dataset.theme = next;
  localStorage.setItem("kanboard.theme", next);
}

export function toggleTheme(): void {
  applyTheme(theme() === "dark" ? "light" : "dark");
}

export const state = {
  projects,
  board,
  rules,
  toasts,
  conn,
  query,
  showArchive,
  /** Current detail-panel task id. */
  openTaskId,
  setOpenTaskId,
  theme,
};

export function toast(message: string, kind: Toast["kind"] = "info"): void {
  const entry = { id: ++toastId, kind, message };
  setToasts((current) => [...current, entry]);
  setTimeout(() => setToasts((current) => current.filter((item) => item.id !== entry.id)), kind === "error" ? 9000 : 5000);
}

export function dismissToast(id: number): void {
  setToasts((current) => current.filter((item) => item.id !== id));
}

export async function loadProjects(): Promise<void> {
  try {
    setProjects("items", await api.projects());
    setProjects("loaded", true);
  } catch (error) {
    setProjects("loaded", true);
    toast(describe(error), "error");
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

export async function loadBoard(slug: string): Promise<void> {
  setBoard("loading", true);
  setBoard("slug", slug);
  try {
    const payload = await api.tasks(slug);
    setBoard("tasks", payload.tasks);
    setBoard("problems", payload.problems ?? []);
  } catch (error) {
    toast(describe(error), "error");
  } finally {
    setBoard("loading", false);
  }
}

/** SSE: one revision per board change → debounced refetch. */
export function watchBoard(slug: string): void {
  source?.close();
  setConn("connecting");
  const events = new EventSource(`/events?project=${encodeURIComponent(slug)}`);
  source = events;
  events.addEventListener("revision", () => {
    setConn("live");
    if (revisionTimer !== undefined) window.clearTimeout(revisionTimer);
    revisionTimer = window.setTimeout(() => void loadBoard(slug), 250);
  });
  events.addEventListener("open", () => setConn("live"));
  events.onerror = () => setConn("reconnecting");
  onCleanup(() => events.close());
}

export function stopWatching(): void {
  source?.close();
  source = undefined;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Apply a server response for one task into the board, preserving order. */
export function upsertTask(task: Task): void {
  const index = board.tasks.findIndex((candidate) => candidate.id === task.id);
  if (index === -1) setBoard("tasks", (current) => [...current, task]);
  else setBoard("tasks", index, task);
}

export function removeTask(id: string): void {
  setBoard("tasks", (current) => current.filter((task) => task.id !== id));
}

export function taskById(id: string | null): Task | undefined {
  return id ? board.tasks.find((task) => task.id === id) : undefined;
}

/** Case-insensitive filter over id, title, body and labels. */
export function visibleTasks(laneId: string): Task[] {
  const needle = query().trim().toLowerCase();
  return board.tasks
    .filter((task) => task.status === laneId)
    .filter((task) => {
      if (needle.length === 0) return true;
      return (
        task.id.toLowerCase().includes(needle) ||
        task.title.toLowerCase().includes(needle) ||
        (task.body ?? "").toLowerCase().includes(needle) ||
        (task.labels ?? []).some((label) => label.toLowerCase().includes(needle))
      );
    })
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
}

export function laneCount(laneId: string): number {
  return board.tasks.filter((task) => task.status === laneId).length;
}
