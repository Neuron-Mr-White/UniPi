/**
 * @pi-unipi/subagents — Mission store
 *
 * Ported from pi-subagents src/missions/store.ts (core). Durable mission
 * records under OUR layout: ~/.unipi/missions/<project-hash>/<missionId>.json
 * (project-keyed by sha256 of the resolved cwd), with an optional global
 * pointer index (~/.unipi/missions/index/) and retainTerminal pruning that
 * removes only the oldest terminal records.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";

export const MISSION_STATUSES = [
  "planned",
  "active",
  "waiting",
  "needs_decision",
  "completed",
  "failed",
  "cancelled",
] as const;

export type MissionStatus = (typeof MISSION_STATUSES)[number];

const TERMINAL_MISSION_STATUSES = new Set<string>(["completed", "failed", "cancelled"]);
const DEFAULT_TERMINAL_MISSION_RETENTION = 200;

export interface MissionGoal {
  status: "active" | "paused" | "budget-exhausted";
}

export interface MissionTokenBudget {
  tokens: number;
}

export interface MissionRunLink {
  runId: string;
  agent?: string;
  mode?: string;
  status?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface MissionDecision {
  id: string;
  status: "open" | "resolved";
  title: string;
  prompt?: string;
  options?: string[];
  recommendation?: string;
  createdAt: string;
  resolvedAt?: string;
  resolution?: string;
}

export interface MissionArtifact {
  kind: string;
  path: string;
  description?: string;
}

export interface MissionReceipt {
  kind: string;
  status: string;
  title: string;
  url: string;
  createdAt: string;
  description?: string;
}

export interface MissionRecord {
  schemaVersion: 1;
  id: string;
  title: string;
  objective: string;
  goal?: MissionGoal;
  budget?: MissionTokenBudget;
  usage?: { tokens: number };
  status: MissionStatus;
  createdAt: string;
  updatedAt: string;
  cwd?: string;
  ownerSessionId?: string;
  runs: MissionRunLink[];
  decisions: MissionDecision[];
  artifacts: MissionArtifact[];
  receipts: MissionReceipt[];
  summary?: string;
  labels?: string[];
}

export interface MissionIndexEntry {
  schemaVersion: 1;
  missionId: string;
  projectRoot: string;
  recordPath: string;
  title: string;
  status: MissionStatus;
  updatedAt: string;
  lastRunId?: string;
}

export interface MissionStoreConfig {
  enabled?: boolean;
  directory?: string;
  globalIndex?: boolean;
  globalIndexDir?: string;
  retainTerminal?: number;
}

export interface MissionStoreLocation {
  projectRoot: string;
  missionDir: string;
  globalIndexDir: string;
  writeGlobalIndex: boolean;
  retainTerminal?: number;
}

// ============================================================================
// Validation helpers
// ============================================================================

const MISSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validateMissionId(value: unknown, label = "missionId"): string {
  if (typeof value !== "string" || !MISSION_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be 1-128 characters using letters, numbers, '.', '_' or '-', and start with a letter or number.`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function missionStatus(value: unknown, label: string): MissionStatus {
  if (typeof value === "string" && (MISSION_STATUSES as readonly string[]).includes(value)) {
    return value as MissionStatus;
  }
  throw new Error(`${label} must be one of ${MISSION_STATUSES.join(", ")}.`);
}

function parseBudget(value: unknown, label: string): MissionTokenBudget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object with tokens.`);
  const tokens = (value as { tokens?: unknown }).tokens;
  if (typeof tokens !== "number" || !Number.isInteger(tokens) || tokens <= 0) {
    throw new Error(`${label}.tokens must be a positive integer.`);
  }
  return { tokens };
}

/** Parse + validate a full mission record. */
export function parseMissionRecord(value: unknown, source = "mission record"): MissionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} must be an object.`);
  }
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1) throw new Error(`${source}.schemaVersion must be 1`);
  const arrays = ["runs", "decisions", "artifacts", "receipts"] as const;
  for (const key of arrays) {
    if (!Array.isArray(input[key])) throw new Error(`${source}.${key} must be an array.`);
  }
  return {
    schemaVersion: 1,
    id: validateMissionId(input.id, `${source}.id`),
    title: requiredString(input.title, `${source}.title`),
    objective: requiredString(input.objective, `${source}.objective`),
    ...(input.goal && typeof input.goal === "object" ? { goal: input.goal as MissionGoal } : {}),
    ...(input.budget ? { budget: parseBudget(input.budget, `${source}.budget`) } : {}),
    ...(input.usage && typeof input.usage === "object" ? { usage: input.usage as { tokens: number } } : {}),
    status: missionStatus(input.status, `${source}.status`),
    createdAt: requiredString(input.createdAt, `${source}.createdAt`),
    updatedAt: requiredString(input.updatedAt, `${source}.updatedAt`),
    ...(optionalString(input.cwd) ? { cwd: input.cwd as string } : {}),
    ...(optionalString(input.ownerSessionId) ? { ownerSessionId: input.ownerSessionId as string } : {}),
    runs: input.runs as MissionRunLink[],
    decisions: input.decisions as MissionDecision[],
    artifacts: input.artifacts as MissionArtifact[],
    receipts: input.receipts as MissionReceipt[],
    ...(optionalString(input.summary) ? { summary: input.summary as string } : {}),
    ...(Array.isArray(input.labels) ? { labels: input.labels.filter((l): l is string => typeof l === "string") } : {}),
  };
}

// ============================================================================
// Store location — OUR layout: ~/.unipi/missions/<project-hash>/
// ============================================================================

function expandConfiguredPath(raw: string, projectRoot: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("~/")) return path.join(homedir(), trimmed.slice(2));
  if (path.isAbsolute(trimmed)) return trimmed;
  return path.resolve(projectRoot, trimmed);
}

/** Project hash key (sha256 of the resolved root, first 16 hex chars). */
export function projectHashKey(projectRoot: string): string {
  return createHash("sha256").update(path.resolve(projectRoot)).digest("hex").slice(0, 16);
}

export function resolveMissionStoreLocation(input: {
  projectRoot: string;
  config?: MissionStoreConfig;
}): MissionStoreLocation {
  const projectRoot = path.resolve(input.projectRoot);
  const unipiDir = path.join(homedir(), ".unipi");
  const defaultMissionDir = path.join(unipiDir, "missions", projectHashKey(projectRoot));
  const missionDir = input.config?.directory
    ? expandConfiguredPath(input.config.directory, projectRoot)
    : defaultMissionDir;
  const globalIndexDir = input.config?.globalIndexDir
    ? expandConfiguredPath(input.config.globalIndexDir, projectRoot)
    : path.join(unipiDir, "missions", "index");
  return {
    projectRoot,
    missionDir,
    globalIndexDir,
    writeGlobalIndex: input.config?.globalIndex !== false,
    ...(input.config?.retainTerminal !== undefined ? { retainTerminal: input.config.retainTerminal } : {}),
  };
}

export function missionRecordPath(location: MissionStoreLocation, missionId: string): string {
  return path.join(location.missionDir, `${validateMissionId(missionId)}.json`);
}

// ============================================================================
// CRUD
// ============================================================================

function writePrivateAtomicJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function indexPath(location: MissionStoreLocation, missionId: string): string {
  const key = createHash("sha256").update(`${location.projectRoot}\0${missionId}`).digest("hex");
  return path.join(location.globalIndexDir, `${key}.json`);
}

function writeMission(location: MissionStoreLocation, record: MissionRecord): MissionRecord {
  const validated = parseMissionRecord(record);
  writePrivateAtomicJson(missionRecordPath(location, validated.id), validated);
  if (location.writeGlobalIndex) {
    const lastRunId = validated.runs.at(-1)?.runId;
    const entry: MissionIndexEntry = {
      schemaVersion: 1,
      missionId: validated.id,
      projectRoot: location.projectRoot,
      recordPath: missionRecordPath(location, validated.id),
      title: validated.title,
      status: validated.status,
      updatedAt: validated.updatedAt,
      ...(lastRunId ? { lastRunId } : {}),
    };
    writePrivateAtomicJson(indexPath(location, validated.id), entry);
  }
  return validated;
}

function pruneTerminalMissions(location: MissionStoreLocation, maxTerminal: number): void {
  const terminal = listMissions(location)
    .records.filter((record) => TERMINAL_MISSION_STATUSES.has(record.status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  for (const record of terminal.slice(maxTerminal)) {
    try {
      fs.rmSync(missionRecordPath(location, record.id), { force: true });
      if (location.writeGlobalIndex) fs.rmSync(indexPath(location, record.id), { force: true });
    } catch {
      // Retention is best-effort and must never block a launch.
    }
  }
}

export interface MissionCreateInput {
  title: string;
  objective: string;
  goal?: boolean;
  budget?: { tokens: number };
  status?: MissionStatus;
  ownerSessionId?: string;
  labels?: string[];
}

export function createMission(
  location: MissionStoreLocation,
  input: MissionCreateInput,
  now = new Date(),
  retainTerminal = location.retainTerminal ?? DEFAULT_TERMINAL_MISSION_RETENTION,
): MissionRecord {
  if (input.goal === true && !input.budget) {
    throw new Error("mission.budget is required when mission.goal is true");
  }
  const createdAt = now.toISOString();
  const record: MissionRecord = {
    schemaVersion: 1,
    id: randomUUID(),
    title: requiredString(input.title, "mission.title").trim(),
    objective: requiredString(input.objective, "mission.objective").trim(),
    ...(input.goal === true ? { goal: { status: "active" as const } } : {}),
    ...(input.budget ? { budget: parseBudget(input.budget, "mission.budget") } : {}),
    ...(input.goal === true ? { usage: { tokens: 0 } } : {}),
    status: input.status ?? "planned",
    createdAt,
    updatedAt: createdAt,
    cwd: location.projectRoot,
    runs: [],
    decisions: [],
    artifacts: [],
    receipts: [],
    ...(input.ownerSessionId ? { ownerSessionId: requiredString(input.ownerSessionId, "mission.ownerSessionId") } : {}),
    ...(input.labels ? { labels: input.labels.filter((l): l is string => typeof l === "string") } : {}),
  };
  const created = writeMission(location, record);
  pruneTerminalMissions(location, retainTerminal);
  return created;
}

export class MissionNotFoundError extends Error {
  readonly code = "MISSION_NOT_FOUND";

  constructor(missionId: string, missionDir: string) {
    super(`Mission '${missionId}' was not found in mission directory '${missionDir}'. If it was created in another worktree, run the request from that worktree.`);
    this.name = "MissionNotFoundError";
  }
}

export function readMission(location: MissionStoreLocation, missionId: string): MissionRecord {
  const filePath = missionRecordPath(location, missionId);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MissionNotFoundError(missionId, location.missionDir);
    throw error;
  }
  try {
    return parseMissionRecord(JSON.parse(raw), filePath);
  } catch (error) {
    throw new Error(`Invalid mission file '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface MissionListResult {
  records: MissionRecord[];
  warnings: string[];
}

export function listMissions(location: MissionStoreLocation): MissionListResult {
  if (!fs.existsSync(location.missionDir)) return { records: [], warnings: [] };
  const records: MissionRecord[] = [];
  const warnings: string[] = [];
  for (const name of fs.readdirSync(location.missionDir).filter((item) => item.endsWith(".json")).sort()) {
    const filePath = path.join(location.missionDir, name);
    try {
      records.push(parseMissionRecord(JSON.parse(fs.readFileSync(filePath, "utf-8")), filePath));
    } catch (error) {
      warnings.push(`Skipped corrupt mission '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return { records, warnings };
}

export interface MissionUpdateInput {
  status?: MissionStatus;
  summary?: string;
  labels?: string[];
  addRun?: MissionRunLink;
  addDecision?: Omit<MissionDecision, "id" | "createdAt"> & { id?: string };
  resolveDecision?: { id: string; resolution: string };
  addArtifact?: MissionArtifact;
  addReceipt?: MissionReceipt;
  incrementUsage?: { tokens: number };
}

export function updateMission(
  location: MissionStoreLocation,
  missionId: string,
  update: MissionUpdateInput,
  now = new Date(),
  retainTerminal = location.retainTerminal ?? DEFAULT_TERMINAL_MISSION_RETENTION,
): MissionRecord {
  const current = readMission(location, missionId);
  const next: MissionRecord = { ...current, updatedAt: now.toISOString() };

  if (update.status !== undefined) next.status = update.status;
  if (update.summary !== undefined) next.summary = update.summary;
  if (update.labels !== undefined) next.labels = update.labels;
  if (update.addRun) next.runs = [...next.runs, update.addRun];
  if (update.addArtifact) next.artifacts = [...next.artifacts, update.addArtifact];
  if (update.addReceipt) next.receipts = [...next.receipts, update.addReceipt];
  if (update.incrementUsage) {
    const base = next.usage?.tokens ?? 0;
    next.usage = { tokens: base + update.incrementUsage.tokens };
    // Goal continuation: budget exhaustion flips the goal status.
    if (next.goal && next.budget && next.usage.tokens >= next.budget.tokens) {
      next.goal = { ...next.goal, status: "budget-exhausted" };
    }
  }
  if (update.addDecision) {
    next.decisions = [
      ...next.decisions,
      {
        ...update.addDecision,
        id: update.addDecision.id ?? randomUUID().slice(0, 8),
        status: "open",
        createdAt: now.toISOString(),
      } as MissionDecision,
    ];
  }
  if (update.resolveDecision) {
    next.decisions = next.decisions.map((decision) =>
      decision.id === update.resolveDecision!.id && decision.status === "open"
        ? { ...decision, status: "resolved", resolvedAt: now.toISOString(), resolution: update.resolveDecision!.resolution }
        : decision,
    );
  }

  const saved = writeMission(location, next);
  pruneTerminalMissions(location, retainTerminal);
  return saved;
}
