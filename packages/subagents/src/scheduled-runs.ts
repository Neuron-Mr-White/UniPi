/**
 * @pi-unipi/subagents — Durable scheduled runs
 *
 * Ported from pi-subagents src/runs/background/scheduled-runs.ts (core).
 * Schedules persist per project under OUR layout:
 * ~/.unipi/schedules/<project-hash>/<id>.json. One-shot (+delay or ISO with
 * timezone) and fixed-interval (30m/6h/2d/2w) triggers; overlap policy skip;
* catchUp none|latest; pause/resume/run/delete; run history receipts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";

export type ScheduleTrigger =
  | { kind: "once"; at: string; atMs: number }
  | { kind: "interval"; every: string; everyMs: number; anchorAt: string; nextRunAt: string };

export interface ScheduleRecord {
  schemaVersion: 1;
  id: string;
  name: string;
  cwd: string;
  trigger: ScheduleTrigger;
  /** Launch parameters captured for the run (agent + task). */
  agent: string;
  task: string;
  overlap: "skip";
  catchUp: "none" | "latest";
  timeoutMs?: number;
  paused: boolean;
  createdAt: string;
  updatedAt: string;
  activeRunId?: string;
  lastRunId?: string;
}

export interface ScheduleRunRecord {
  schemaVersion: 1;
  id: string;
  scheduleId: string;
  plannedAt: string;
  dueReason: "timer" | "run-due" | "manual";
  state: "pending" | "running" | "completed" | "failed" | "skipped";
  startedAt?: string;
  completedAt?: string;
  asyncRunId?: string;
  error?: string;
}

// ============================================================================
// Parsing (reference semantics)
// ============================================================================

export function parseScheduledRunTime(at: string, now = Date.now()): number {
  const trimmed = at.trim();
  const relative = trimmed.match(/^\+(\d+)(s|m|h|d)$/);
  if (relative) {
    const amount = Number(relative[1]);
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw new Error(`Invalid at value "${at}". Relative delays must be positive, such as "+10m".`);
    }
    const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as "s" | "m" | "h" | "d"];
    const result = now + amount * unitMs;
    if (!Number.isSafeInteger(result)) throw new Error(`Invalid at value "${at}". Relative delay is too large.`);
    return result;
  }
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/);
  if (!iso) throw new Error(`Invalid at value "${at}". Use a one-shot delay such as "+10m" or an ISO timestamp with timezone.`);
  const year = Number(iso[1]);
  const month = Number(iso[2]);
  const day = Number(iso[3]);
  const hour = Number(iso[4]);
  const minute = Number(iso[5]);
  const second = iso[6] === undefined ? 0 : Number(iso[6]);
  const zone = iso[7]!;
  const offsetHour = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const offsetMinute = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  const parsed = Date.parse(trimmed);
  if (
    month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 ||
    second > 59 || offsetHour > 23 || offsetMinute > 59 || !Number.isFinite(parsed)
  ) {
    throw new Error(`Invalid at value "${at}". Use a valid ISO timestamp.`);
  }
  if (parsed <= now) throw new Error(`Scheduled time ${new Date(parsed).toISOString()} is in the past.`);
  return parsed;
}

export function parseScheduleInterval(every: string): number {
  const match = every.trim().match(/^(\d+)(m|h|d|w)$/);
  if (!match) {
    throw new Error(`Invalid every value "${every}". This first recurring slice supports fixed intervals such as "30m", "6h", "2d", or "2w".`);
  }
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error(`Invalid every value "${every}". Interval must be positive.`);
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2] as "m" | "h" | "d" | "w"];
  const result = amount * unitMs;
  if (!Number.isSafeInteger(result)) throw new Error(`Invalid every value "${every}". Interval is too large.`);
  return result;
}

// ============================================================================
// Store — OUR layout: ~/.unipi/schedules/<project-hash>/
// ============================================================================

export function scheduleStorePath(projectRoot: string, storeRoot?: string): string {
  const resolved = path.resolve(projectRoot);
  if (!storeRoot) return path.join(homedir(), ".unipi", "schedules", projectHashKey(resolved));
  const projectKey = createHash("sha256").update(resolved).digest("hex").slice(0, 20);
  return path.join(storeRoot.startsWith("~/") ? path.join(homedir(), storeRoot.slice(2)) : storeRoot, projectKey);
}

function projectHashKey(projectRoot: string): string {
  return createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
}

function writeAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

export class ScheduledRunManager {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private projectRoot: string,
    private opts: {
      storeRoot?: string;
      maxPending?: number;
      /** Launch a due schedule. Returns the async run id. */
      launch: (record: ScheduleRecord, dueReason: ScheduleRunRecord["dueReason"]) => Promise<string>;
      pollIntervalMs?: number;
    },
  ) {}

  get storeDir(): string {
    return scheduleStorePath(this.projectRoot, this.opts.storeRoot);
  }

  private recordPath(id: string): string {
    return path.join(this.storeDir, `${id}.json`);
  }

  private historyPath(id: string): string {
    return path.join(this.storeDir, `${id}.runs.json`);
  }

  create(input: {
    name: string;
    agent: string;
    task: string;
    at?: string;
    every?: string;
    catchUp?: "none" | "latest";
    timeoutMs?: number;
  }, now = Date.now()): ScheduleRecord {
    if (!input.name?.trim()) throw new Error("schedule name must be a non-empty string.");
    if (!input.agent?.trim()) throw new Error("schedule requires an agent.");
    if (!input.task?.trim()) throw new Error("schedule requires a task.");
    let trigger: ScheduleTrigger;
    if (input.at !== undefined && input.every !== undefined) {
      throw new Error("Use either 'at' (one-shot) or 'every' (recurring), not both.");
    }
    if (input.at !== undefined) {
      const atMs = parseScheduledRunTime(input.at, now);
      trigger = { kind: "once", at: input.at.trim(), atMs };
    } else if (input.every !== undefined) {
      const everyMs = parseScheduleInterval(input.every);
      trigger = {
        kind: "interval",
        every: input.every.trim(),
        everyMs,
        anchorAt: new Date(now).toISOString(),
        nextRunAt: new Date(now + everyMs).toISOString(),
      };
    } else {
      throw new Error("schedule requires 'at' (one-shot) or 'every' (recurring).");
    }

    // maxPending cap
    const existing = this.list();
    const maxPending = this.opts.maxPending ?? 20;
    if (existing.filter((r) => !r.paused && r.trigger.kind === "interval").length >= maxPending) {
      throw new Error(`Pending schedule cap reached (${maxPending}). Delete or pause schedules first.`);
    }

    const record: ScheduleRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      name: input.name.trim(),
      cwd: path.resolve(this.projectRoot),
      trigger,
      agent: input.agent.trim(),
      task: input.task.trim(),
      overlap: "skip",
      catchUp: input.catchUp ?? "latest",
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      paused: false,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
    writeAtomic(this.recordPath(record.id), record);
    return record;
  }

  list(): ScheduleRecord[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.storeDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const records: ScheduleRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith(".runs.json")) continue;
      try {
        records.push(JSON.parse(fs.readFileSync(path.join(this.storeDir, entry.name), "utf8")) as ScheduleRecord);
      } catch {
        // Skip corrupt records.
      }
    }
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  show(idOrPrefix: string): ScheduleRecord | undefined {
    return this.list().find((r) => r.id.startsWith(idOrPrefix));
  }

  private save(record: ScheduleRecord): void {
    writeAtomic(this.recordPath(record.id), record);
  }

  setPaused(idOrPrefix: string, paused: boolean): ScheduleRecord {
    const record = this.show(idOrPrefix);
    if (!record) throw new Error(`No schedule matches "${idOrPrefix}".`);
    record.paused = paused;
    record.updatedAt = new Date().toISOString();
    this.save(record);
    return record;
  }

  delete(idOrPrefix: string): boolean {
    const record = this.show(idOrPrefix);
    if (!record) return false;
    fs.rmSync(this.recordPath(record.id), { force: true });
    fs.rmSync(this.historyPath(record.id), { force: true });
    return true;
  }

  /** Run a schedule immediately (manual trigger). */
  async runNow(idOrPrefix: string): Promise<ScheduleRunRecord> {
    const record = this.show(idOrPrefix);
    if (!record) throw new Error(`No schedule matches "${idOrPrefix}".`);
    return this.execute(record, "manual");
  }

  private async execute(record: ScheduleRecord, dueReason: ScheduleRunRecord["dueReason"]): Promise<ScheduleRunRecord> {
    // Overlap policy: skip when a run is already active.
    if (record.activeRunId) {
      return {
        schemaVersion: 1,
        id: randomUUID(),
        scheduleId: record.id,
        plannedAt: new Date().toISOString(),
        dueReason,
        state: "skipped",
        error: "overlap: previous run still active",
      };
    }

    const runRecord: ScheduleRunRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      scheduleId: record.id,
      plannedAt: new Date().toISOString(),
      dueReason,
      state: "running",
      startedAt: new Date().toISOString(),
    };

    try {
      const asyncRunId = await this.opts.launch(record, dueReason);
      runRecord.asyncRunId = asyncRunId;
      runRecord.state = "completed";
    } catch (error) {
      runRecord.state = "failed";
      runRecord.error = error instanceof Error ? error.message : String(error);
    }
    runRecord.completedAt = new Date().toISOString();

    // Update the schedule + append history.
    record.lastRunId = runRecord.id;
    record.activeRunId = undefined;
    record.updatedAt = new Date().toISOString();
    if (record.trigger.kind === "interval") {
      record.trigger.nextRunAt = new Date(Date.now() + record.trigger.everyMs).toISOString();
    }
    this.save(record);

    const history = this.readHistory(record.id);
    history.push(runRecord);
    writeAtomic(this.historyPath(record.id), history);
    return runRecord;
  }

  readHistory(idOrPrefix: string): ScheduleRunRecord[] {
    const record = this.show(idOrPrefix);
    if (!record) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.historyPath(record.id), "utf8")) as ScheduleRunRecord[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /** Tick: launch all due schedules. Called by the poll timer. */
  async runDue(): Promise<ScheduleRunRecord[]> {
    const results: ScheduleRunRecord[] = [];
    const now = Date.now();
    for (const record of this.list()) {
      if (record.paused) continue;
      let due = false;
      if (record.trigger.kind === "once") {
        due = record.trigger.atMs <= now;
      } else {
        due = Date.parse(record.trigger.nextRunAt) <= now;
      }
      if (due) results.push(await this.execute(record, "timer"));
    }
    return results;
  }

  startPolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runDue().catch(() => {});
    }, this.opts.pollIntervalMs ?? 60_000);
    this.timer.unref?.();
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
