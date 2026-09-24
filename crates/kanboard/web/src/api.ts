/**
 * API client + shared types. Every shape mirrors the Rust side (`src/shapes.ts`
 * on the extension side validates the same JSON); a mismatch surfaces as a toast
 * rather than a blank board.
 */

export interface Problem {
  file: string;
  line: number;
  error: string;
  fixable?: boolean;
}

export interface Run {
  session?: string;
  pid?: number;
  host?: string;
  mode?: string;
  goal?: string | null;
  started?: string;
}

export interface Activity {
  at: string;
  actor: string;
  text: string;
}

export interface Task {
  id: string;
  title: string;
  body?: string;
  status: string;
  priority: string;
  order: number;
  deps: string[];
  labels: string[];
  created: string;
  updated: string;
  run?: Run | null;
  activity: Activity[];
  ready?: boolean;
  waitingFor?: string[];
  /** Deps still in Backlog (or missing): only a human can schedule them. */
  lockedBy?: string[];
  depsStatus?: Array<{ id: string; status: string | null }>;
  staleness?: string;
  allowedMoves?: string[];
  path?: string;
}

export interface ProjectSummary {
  slug: string;
  name: string;
  root?: string;
  prefix?: string;
  counts?: Record<string, number>;
  total?: number;
  /** Tasks with a live run block. */
  running?: number;
  problems?: Problem[];
  /** Newest task change (RFC 3339), null for an empty project. */
  updatedAt?: string | null;
}

export interface Rules {
  statuses: string[];
  allowedMoves: Record<string, string[]>;
  commentRequired: Record<string, Record<string, string>>;
  final: string[];
}

export const STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
  "archived",
] as const;

export const LANES = [
  { id: "backlog", label: "Backlog" },
  { id: "todo", label: "Todo" },
  { id: "in_progress", label: "In Progress" },
  { id: "in_review", label: "In Review" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" },
  { id: "cancelled", label: "Cancelled" },
  { id: "archived", label: "Archive" },
] as const;

export const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
export const PRIORITY_LABEL: Record<string, string> = {
  none: "No priority",
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};
export const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

export function laneLabel(status: string): string {
  return LANES.find((lane) => lane.id === status)?.label ?? status.replace("_", " ");
}
export const MUTED_LANES = new Set(["done", "cancelled", "archived"]);

export class ApiError extends Error {
  readonly status: number;
  readonly needsComment: boolean;

  constructor(message: string, status: number, needsComment = false) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.needsComment = needsComment;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const record = (payload ?? {}) as { error?: string; needsComment?: boolean };
    throw new ApiError(record.error ?? `request failed (${response.status})`, response.status, record.needsComment === true);
  }
  return payload as T;
}

export const api = {
  projects: () => request<ProjectSummary[]>("/api/projects"),
  rules: () => request<Rules>("/api/rules"),
  tasks: (slug: string) =>
    request<{ tasks: Task[]; problems: Problem[] }>(`/api/projects/${encodeURIComponent(slug)}/tasks`),
  task: (slug: string, id: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`),
  create: (slug: string, body: { title: string; body?: string; status?: string; priority?: string; after?: string[] }) =>
    request<Task>(`/api/tasks/${encodeURIComponent(slug)}/create`, { method: "POST", body: JSON.stringify(body) }),
  move: (slug: string, id: string, status: string, comment?: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(slug)}/${encodeURIComponent(id)}/move`, {
      method: "POST",
      body: JSON.stringify({ status, comment }),
    }),
  note: (slug: string, id: string, text: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(slug)}/${encodeURIComponent(id)}/note`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  edit: (slug: string, id: string, patch: { title?: string; body?: string; priority?: string; labels?: string[] }) =>
    request<Task>(`/api/tasks/${encodeURIComponent(slug)}/${encodeURIComponent(id)}/edit`, {
      method: "POST",
      body: JSON.stringify(patch),
    }),
  link: (slug: string, id: string, dep: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(slug)}/${encodeURIComponent(id)}/link`, {
      method: "POST",
      body: JSON.stringify({ dep }),
    }),
  unlink: (slug: string, id: string, dep: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(slug)}/${encodeURIComponent(id)}/unlink`, {
      method: "POST",
      body: JSON.stringify({ dep }),
    }),
  order: (slug: string, id: string, target: { before?: string; afterPos?: string; top?: boolean; bottom?: boolean }) =>
    request<Task>(`/api/tasks/${encodeURIComponent(slug)}/${encodeURIComponent(id)}/order`, {
      method: "POST",
      body: JSON.stringify({ before: target.before, after_pos: target.afterPos, top: target.top, bottom: target.bottom }),
    }),
  duplicate: (slug: string, id: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(slug)}/${encodeURIComponent(id)}/duplicate`, { method: "POST", body: "{}" }),
};

/** Fallback when `/api/rules` is unavailable: permissive, server still decides. */
export const PERMISSIVE_RULES: Rules = {
  statuses: [...STATUSES],
  allowedMoves: {},
  commentRequired: {},
  final: ["done", "cancelled", "archived"],
};

/** Can a card move from `from` to `to`, according to the server's rules? */
export function canMove(rules: Rules, task: Task, to: string): boolean {
  if (to === task.status) return true;
  const explicit = task.allowedMoves;
  if (Array.isArray(explicit) && explicit.length > 0) return explicit.includes(to);
  const allowed = rules.allowedMoves[task.status];
  if (!allowed) return true; // unknown → let the server refuse (with a reason)
  return allowed.includes(to);
}

export function needsComment(rules: Rules, from: string, to: string): string | null {
  return rules.commentRequired[from]?.[to] ?? null;
}
