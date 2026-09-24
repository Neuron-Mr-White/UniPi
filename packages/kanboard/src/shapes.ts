/**
 * @pi-unipi/kanboard — the CLI's JSON contract.
 *
 * Every shape the extension consumes is validated here instead of being cast,
 * so a change on the Rust side fails loudly (and the contract test in
 * `tests/contract.test.ts` feeds the real binary's output through these
 * functions). K4 changed `list --json` from an array to `{tasks, problems}` and
 * a stale cast silently broke the runner with "all.map is not a function".
 */

export class KanboardShapeError extends Error {
  readonly command: string;

  constructor(command: string, detail: string) {
    super(`unexpected ${command} output: ${detail} — the extension and the binary disagree (version mismatch?)`);
    this.name = "KanboardShapeError";
    this.command = command;
  }
}

export interface KanboardProblem {
  file: string;
  line: number;
  error: string;
  fixable?: boolean;
}

export interface KanboardRun {
  session?: string;
  pid?: number;
  host?: string;
  mode?: string;
  goal?: string | null;
  started?: string;
}

export interface KanboardActivity {
  at: string;
  actor: string;
  text: string;
}

export interface KanboardTask {
  id: string;
  title: string;
  body?: string;
  status: string;
  priority?: string;
  order?: number;
  deps?: string[];
  labels?: string[];
  run?: KanboardRun | null;
  activity?: KanboardActivity[];
  ready?: boolean;
  waitingFor?: string[];
  staleness?: string;
  allowedMoves?: string[];
  [key: string]: unknown;
}

export interface KanboardProject {
  slug: string;
  name: string;
  root?: string;
  prefix?: string;
  nextId?: number;
  createdAt?: string;
  counts?: Record<string, number>;
  total?: number;
  problems?: KanboardProblem[];
}

export interface KanboardClaim {
  task: KanboardTask | null;
  waiting?: Array<{ id: string; waitingFor?: string[] }>;
}

export interface KanboardStop {
  stopped: boolean;
  pid?: number;
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(command: string, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new KanboardShapeError(command, `expected an object, got ${Array.isArray(value) ? "an array" : typeof value}`);
  }
  return value;
}

function requireString(command: string, record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new KanboardShapeError(command, `missing string "${key}"`);
  }
  return value;
}

function optionalArray<T>(value: unknown): T[] | undefined {
  return Array.isArray(value) ? (value as T[]) : undefined;
}

/** `show …, add …, move …, note …, release …` → one task. */
export function asTask(command: string, value: unknown): KanboardTask {
  const record = requireRecord(command, value);
  return {
    ...record,
    id: requireString(command, record, "id"),
    title: requireString(command, record, "title"),
    status: requireString(command, record, "status"),
    deps: optionalArray<string>(record.deps) ?? [],
    activity: optionalArray<KanboardActivity>(record.activity) ?? [],
  } as KanboardTask;
}

export function asTaskList(value: unknown): { tasks: KanboardTask[]; problems: KanboardProblem[] } {
  if (Array.isArray(value)) {
    // Exactly the K4 regression: the runner cast the old array shape.
    throw new KanboardShapeError("list", "an array here means the binary is older than the extension");
  }
  const record = requireRecord("list", value);
  if (!Array.isArray(record.tasks)) {
    throw new KanboardShapeError("list", 'expected {tasks: [...], problems: [...]}');
  }
  const tasks = record.tasks.map((entry) => asTask("list", entry));
  const problems = (optionalArray<KanboardProblem>(record.problems) ?? []).map((problem) => ({
    file: String(problem.file ?? ""),
    line: Number(problem.line ?? 0),
    error: String(problem.error ?? ""),
    fixable: problem.fixable === true,
  }));
  return { tasks, problems };
}

/** `claim-next` → `{task: <task|null>, waiting: [...]}`. */
export function asClaimResult(value: unknown): KanboardClaim {
  const record = requireRecord("claim-next", value);
  if (!("task" in record)) {
    throw new KanboardShapeError("claim-next", 'missing "task"');
  }
  const waiting = optionalArray<{ id: string; waitingFor?: string[] }>(record.waiting) ?? [];
  return {
    task: record.task === null ? null : asTask("claim-next", record.task),
    waiting,
  };
}

export function asProject(command: string, value: unknown): KanboardProject {
  const record = requireRecord(command, value);
  return {
    ...record,
    slug: requireString(command, record, "slug"),
    name: requireString(command, record, "name"),
  } as KanboardProject;
}

export function asProjectList(value: unknown): KanboardProject[] {
  if (!Array.isArray(value)) {
    throw new KanboardShapeError("project list", `expected an array, got ${typeof value}`);
  }
  return value.map((entry) => asProject("project list", entry));
}

/** `project show` → `{project, counts, total, problems}`. */
export function asProjectDetail(value: unknown): KanboardProject & { total: number } {
  const record = requireRecord("project show", value);
  const project = asProject("project show", record.project);
  return {
    ...project,
    counts: isRecord(record.counts) ? (record.counts as Record<string, number>) : {},
    total: typeof record.total === "number" ? record.total : 0,
    problems: optionalArray<KanboardProblem>(record.problems) ?? [],
  };
}

export function asStopResult(value: unknown): KanboardStop {
  const record = requireRecord("stop", value);
  if (typeof record.stopped !== "boolean") {
    throw new KanboardShapeError("stop", 'missing boolean "stopped"');
  }
  return {
    stopped: record.stopped,
    pid: typeof record.pid === "number" ? record.pid : undefined,
    reason: typeof record.reason === "string" ? record.reason : undefined,
  };
}

/** `status` → `{daemon, alive, home}` (the extension reads daemon.json itself, but tests pin the shape). */
export function asDaemonStatus(value: unknown): { daemon: Record<string, unknown> | null; alive: boolean; home?: string } {
  const record = requireRecord("status", value);
  const daemon = record.daemon;
  if (daemon !== null && !isRecord(daemon)) {
    throw new KanboardShapeError("status", '"daemon" must be an object or null');
  }
  return {
    daemon: (daemon as Record<string, unknown> | null) ?? null,
    alive: record.alive === true,
    home: typeof record.home === "string" ? record.home : undefined,
  };
}

/** `validate` → `{ok, problems, fixed}`. */
export function asValidateResult(value: unknown): { ok: boolean; problems: KanboardProblem[]; fixed: string[] } {
  const record = requireRecord("validate", value);
  return {
    ok: record.ok === true,
    problems: optionalArray<KanboardProblem>(record.problems) ?? [],
    fixed: optionalArray<string>(record.fixed) ?? [],
  };
}
