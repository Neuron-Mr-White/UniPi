/**
 * @unipi/memory — One-time palace conversion (background, resumable)
 *
 * Moves the old world (flat md files + bridge-written `unipi://` drawers)
 * onto the native layout (<project>/<type>/<id>.md + mined drawers). State
 * lives in ~/.unipi/memory/.conversion.json so a mid-way interruption just
 * resumes on the next session. An old drawer is only deleted AFTER its
 * replacement is verified in the palace. A single .conversion.lock file
 * keeps concurrent sessions from double-converting.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  DEFAULT_PALACE,
  probeDaemon,
  runProcess,
  venvBin,
  type MempalaceInstall,
} from "./mempalace.js";
import { readMemoryConfig } from "./settings.js";
import { ensureDaemon, submitJob, waitJob } from "./daemon.js";
import { MemoryReader } from "./reader.js";
import {
  ensureMempalaceYaml,
  memoryDocument,
  parseMemoryContent,
  parseMemoryFile,
  type MemoryRecord,
} from "./files.js";
import {
  legacySourceUri,
  memoryFilePath,
  memoryRoot,
  sanitizeProjectName,
  type MemoryType,
} from "./paths.js";
import { idFromTitle } from "./paths.js";

export interface ConversionState {
  phase: "pending" | "backup" | "scan" | "layout" | "mine" | "verify" | "delete" | "done" | "failed";
  done: number;
  total: number;
  startedAt: string;
  /** absolute palace dir that was backed up */
  backupPath?: string;
  errors: string[];
  /** verified record keys -> old source_uri deleted */
  deletedSources?: Record<string, string>;
  /** Unverified units already got their one re-mine. */
  remined?: boolean;
  /** Units that finished with a failure (kept after the units file is gone). */
  failedUnits?: number;
  /** ~/.unipi/memory tree backup (parallel to the palace backup). */
  mdBackupPath?: string;
  /** True when the conversion itself started the daemon — stopped on finish
   *  unless the user's autoStartDaemon switch is on. */
  startedDaemon?: boolean;
}

const CONVERSION_PATH = (): string => path.join(memoryRoot(), ".conversion.json");
const UNITS_PATH = (): string => path.join(memoryRoot(), ".conversion-units.json");
const LOCK_PATH = (): string => path.join(memoryRoot(), ".conversion.lock");
const CONFLICTS_DIR = (): string => path.join(memoryRoot(), ".conflicts");
const OLD_ROOMS = ["unipi_preference", "unipi_decision", "unipi_pattern", "unipi_summary"];
const OLD_ROOM_TYPE: Record<string, MemoryType> = {
  unipi_preference: "preference",
  unipi_decision: "decision",
  unipi_pattern: "pattern",
  unipi_summary: "summary",
};
const TYPED_ROOMS = ["preference", "decision", "pattern", "summary"];
const LEGACY_MARKERS = [
  ".mempalace-ledger.json",
  ".mempalace-migrated",
  ".mempalace-ping-verified",
];

export function readConversionState(): ConversionState | null {
  try {
    return JSON.parse(fs.readFileSync(CONVERSION_PATH(), "utf-8")) as ConversionState;
  } catch {
    return null;
  }
}

function writeConversionState(state: ConversionState): void {
  if (state.errors.length > 200) state.errors = state.errors.slice(-200);
  try {
    fs.writeFileSync(CONVERSION_PATH(), JSON.stringify(state, null, 2), "utf-8");
  } catch { /* state is best-effort; a lost write just re-runs a step */ }
}

export function conversionInProgress(): ConversionState | null {
  const s = readConversionState();
  return s && s.phase !== "done" && s.phase !== "failed" ? s : null;
}

// ── lock ────────────────────────────────────────────────────────────────────

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) {
    // EPERM means the pid exists but is owned by someone else — still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when this process holds the conversion lock (stale locks are taken). */
export function acquireConversionLock(): boolean {
  const p = LOCK_PATH();
  try {
    const cur = JSON.parse(fs.readFileSync(p, "utf-8")) as { pid?: number };
    if (typeof cur.pid === "number" && cur.pid !== process.pid && pidAlive(cur.pid)) {
      return false; // another live session is converting
    }
  } catch { /* no or unreadable lock */ }
  try {
    fs.mkdirSync(memoryRoot(), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf-8");
    return true;
  } catch {
    return true; // can't write the lock — don't block conversion on it
  }
}

export function releaseConversionLock(): void {
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK_PATH(), "utf-8")) as { pid?: number };
    if (cur.pid !== process.pid) return;
    fs.unlinkSync(LOCK_PATH());
  } catch { /* ignore */ }
}

// ── units ───────────────────────────────────────────────────────────────────

interface UnitState {
  /** Sanitized layout project dir (set at layout). */
  project: string;
  /** Original project name as stamped on the old drawer/file. */
  origProject?: string;
  rec: MemoryRecord;
  /** old bridge source_uri(s) to delete once verified. */
  oldSource?: string;
  /** Physical drawer ids that represent the old record (bulk delete). */
  drawerIds?: string[];
  /** Length of the source's body — the body-invariant baseline. */
  sourceBodyLen?: number;
  laidOut?: boolean;
  mined?: boolean;
  verified?: boolean;
  deleted?: boolean;
  failed?: boolean;
}

function writeUnitsState(units: UnitState[]): void {
  try {
    fs.writeFileSync(UNITS_PATH(), JSON.stringify(units, null, 2), "utf-8");
  } catch { /* resumability best-effort */ }
}

function readUnitsState(): UnitState[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(UNITS_PATH(), "utf-8"));
    return Array.isArray(parsed) ? (parsed as UnitState[]) : [];
  } catch {
    return [];
  }
}

// ── old drawer → record ─────────────────────────────────────────────────────

interface OldDrawer {
  project: string;
  record: MemoryRecord;
  sourceUri: string;
  drawerIds: string[];
}

/** Record skeleton from a list_drawers row — unipi_* metadata first, then
 *  the (possibly truncated) preview's frontmatter. Body is NOT available
 *  here; hydration via get_drawers fills it later. */
function oldDrawerToRecord(d: {
  drawer_id?: string;
  content_preview?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  wing?: string;
  room?: string;
}): { project: string; record: MemoryRecord; id: string } | null {
  const meta = d.metadata ?? {};
  const project =
    (meta.unipi_project as string | undefined) ??
    (meta.project as string | undefined) ??
    d.wing ??
    "unknown";
  const title =
    (meta.unipi_title as string | undefined) ??
    (meta.title as string | undefined);
  const type = OLD_ROOM_TYPE[d.room ?? ""] ?? (meta.unipi_type as MemoryType | undefined) ?? "summary";
  if (title) {
    const id = (meta.unipi_id as string | undefined) ?? idFromTitle(title);
    return {
      project,
      record: {
        id,
        title,
        content: "",
        tags: typeof meta.unipi_tags === "string" ? meta.unipi_tags.split(",").filter(Boolean) : [],
        project,
        type,
        created: (meta.content_date as string | undefined) ?? "",
        updated: (meta.last_modified as string | undefined) ?? "",
      },
      id,
    };
  }
  const rec = parseMemoryContent(d.content_preview ?? d.content ?? "");
  if (!rec || !rec.title) return null;
  const id = rec.id || idFromTitle(rec.title);
  return {
    project: rec.project || project,
    record: { ...rec, id, content: "", type },
    id,
  };
}

/** The body invariant: a non-empty source may never produce an empty/short md. */
export function bodyInvariantOk(sourceBodyLen: number | undefined, newLen: number): boolean {
  if (sourceBodyLen === undefined || sourceBodyLen <= 0 && sourceBodyLen !== -1) return true;
  if (sourceBodyLen === -1) return newLen > 0;
  return newLen >= sourceBodyLen;
}

/** Group drawer ids into ≤500-id batches for mempalace_delete_drawers. */
export function planDeleteBatches(units: { drawerIds?: string[] }[], batchSize = 500): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (const u of units) {
    for (const id of u.drawerIds ?? []) {
      cur.push(id);
      if (cur.length === batchSize) { out.push(cur); cur = []; }
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Convert one record's layout: write the typed md, verify the read-back,
 * then unlink the flat source. Returns the new absolute path.
 */
function layOutRecord(rec: MemoryRecord, project: string): string {
  const target = memoryFilePath(project, rec.type, rec.id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const doc = memoryDocument({ ...rec, project });
  fs.writeFileSync(target, doc, "utf-8");
  const reread = parseMemoryFile(target);
  if (!reread || reread.content !== rec.content) {
    throw new Error("read-back mismatch");
  }
  if (rec.filePath && rec.filePath !== target) {
    try { fs.unlinkSync(rec.filePath); } catch { /* keep */ }
  }
  return target;
}

async function submitMine(
  install: MempalaceInstall,
  sourceDir: string,
  files: string[],
  wing: string,
): Promise<{ ok: boolean; result?: Record<string, unknown> }> {
  const job = await submitJob("mine", {
    source: sourceDir,
    files,
    wing,
    agent: "unipi",
    palace_path: DEFAULT_PALACE,
  });
  if (!job.ok || !job.job) return { ok: false };
  // A 500-file batch can take minutes to embed — give it room.
  const waited = await waitJob(job.job.id, 600_000);
  return { ok: waited.done && waited.job?.state === "succeeded", result: waited.job?.result };
}

/** Bulk delete via mempalace_delete_drawers (≤500 ids per job). "unsupported"
 *  when the installed MemPalace predates the tool (3.10.0 lacks it). */
async function deleteDrawers(drawerIds: string[]): Promise<"ok" | "failed" | "unsupported"> {
  const job = await submitJob("mcp_tool", {
    name: "mempalace_delete_drawers",
    arguments: { drawer_ids: drawerIds },
  });
  if (!job.ok || !job.job) return "failed";
  const waited = await waitJob(job.job.id, 300_000);
  if (waited.done && waited.job?.state === "succeeded") return "ok";
  const err = String((waited.job?.result as { error?: unknown } | undefined)?.error ?? "");
  return /is unknown/.test(err) ? "unsupported" : "failed";
}

/** Run many mcp_tool jobs pipelined: submit a window, then wait for all. */
async function runToolJobs(
  calls: Array<{ name: string; arguments: Record<string, unknown> }>,
  window = 25,
): Promise<Array<Record<string, unknown> | null>> {
  const out: Array<Record<string, unknown> | null> = [];
  for (let i = 0; i < calls.length; i += window) {
    const jobs = await Promise.all(calls.slice(i, i + window).map((c) => submitJob("mcp_tool", c)));
    out.push(...await Promise.all(jobs.map(async (job) => {
      if (!job.ok || !job.job) return null;
      const waited = await waitJob(job.job.id, 300_000);
      return waited.done ? (waited.job?.result ?? {}) : null;
    })));
  }
  return out;
}

/** Exact-id deletes (mempalace_delete_drawer, available in 3.10), pipelined.
 *  "absent" = the drawer is already gone. */
export async function deleteDrawerMany(ids: string[]): Promise<Array<"deleted" | "absent" | "failed">> {
  const results = await runToolJobs(ids.map((id) => ({ name: "mempalace_delete_drawer", arguments: { drawer_id: id } })));
  return results.map((r) => {
    if (!r) return "failed";
    if (r.success === true) return "deleted";
    return /not found/i.test(String(r.error ?? "")) ? "absent" : "failed";
  });
}

/** delete_by_source, pipelined. Returns deleted counts (null = job failed). */
export async function deleteBySourceMany(sources: string[]): Promise<Array<number | null>> {
  const results = await runToolJobs(sources.map((src) => ({
    name: "mempalace_delete_by_source",
    arguments: { source_file: src, dry_run: false },
  })));
  return results.map((r) => {
    if (!r || r.success === false) return null;
    return typeof r.deleted === "number" ? r.deleted : 0;
  });
}

export interface ConversionDeps {
  install: MempalaceInstall;
  reader: MemoryReader;
  palacePath?: string;
}

/**
 * Run the conversion. Resumable: call once per session; each phase writes
 * its state so a later run continues. Single-runner via .conversion.lock.
 * Returns the final state.
 */
export async function runConversion(deps: ConversionDeps): Promise<ConversionState> {
  if (!acquireConversionLock()) {
    return readConversionState() ?? {
      phase: "pending", done: 0, total: 0, startedAt: "", errors: [], deletedSources: {},
    };
  }
  try {
    return await runConversionInner(deps);
  } finally {
    releaseConversionLock();
  }
}

async function runConversionInner(deps: ConversionDeps): Promise<ConversionState> {
  let state = readConversionState() ?? {
    phase: "pending" as const,
    done: 0,
    total: 0,
    startedAt: new Date().toISOString(),
    errors: [],
    deletedSources: {},
  };
  state.deletedSources = state.deletedSources ?? {};

  const daemon = await probeDaemon(DEFAULT_PALACE);
  if (!daemon.reachable || daemon.busy) {
    // Daemon-driven phases wait for a reachable, idle daemon.
    if (state.phase !== "pending" && state.phase !== "scan" && state.phase !== "layout") {
      return state;
    }
  }

  // ── Phase: backup (once) — palace + md tree, then the temp daemon ────
  if (state.phase === "pending" || state.phase === "backup") {
    if (!daemon.reachable) {
      // Temporary daemon for the migration (stopped on done/failed unless
      // the user's autoStartDaemon switch is on).
      if (deps.install && (await ensureDaemon(DEFAULT_PALACE, deps.install, true))) {
        state.startedDaemon = true;
        writeConversionState(state);
      } else {
        state.errors.push("conversion needs a reachable daemon (or one it can start)");
        writeConversionState(state);
        return state;
      }
    }
    const stamp = Math.floor(Date.now() / 1000);
    const target = `${DEFAULT_PALACE}.bak-unipi-${stamp}`;
    if (!state.backupPath) {
      const ok = await runProcess("cp", ["-a", DEFAULT_PALACE, target], 120_000);
      if (!ok) {
        state.phase = "failed";
        state.errors.push("palace backup failed");
        writeConversionState(state);
        return state;
      }
      state.backupPath = target;
    }
    if (!state.mdBackupPath) {
      const mdTarget = `${memoryRoot()}-v2-backup-${stamp}`;
      const ok = await runProcess("cp", ["-a", memoryRoot(), mdTarget], 120_000);
      if (!ok) {
        state.phase = "failed";
        state.errors.push("memory dir backup failed");
        writeConversionState(state);
        return state;
      }
      state.mdBackupPath = mdTarget;
    }
    state.phase = "scan";
    writeConversionState(state);
  }

  // ── Phase: rename + scan ─────────────────────────────────────────────
  if (state.phase === "scan") {
    // Move legacy project dirs to the sanitized name FIRST, so every
    // filePath captured by the scan is current.
    const root = memoryRoot();
    for (const dirEnt of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dirEnt.isDirectory() || dirEnt.name.startsWith(".")) continue;
      const cleaned = sanitizeProjectName(dirEnt.name);
      if (dirEnt.name === cleaned) continue;
      const src = path.join(root, dirEnt.name);
      const dst = path.join(root, cleaned);
      try {
        if (fs.existsSync(dst)) mergeDirs(src, dst, CONFLICTS_DIR());
        else fs.renameSync(src, dst);
      } catch (e) {
        state.errors.push(`dir move ${dirEnt.name}: ${String(e)}`);
      }
    }

    // Union source 1: flat + already-typed md files on disk.
    const flat = new Map<string, UnitState>();
    for (const dirEnt of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dirEnt.isDirectory() || dirEnt.name.startsWith(".")) continue;
      const dir = path.join(root, dirEnt.name);
      for (const rec of scanDirRecursive(dir)) {
        const project = sanitizeProjectName(rec.project || dirEnt.name);
        const key = `${project}/${rec.id}`;
        // Two files for the same project/id (e.g. a stray copy in another
        // project dir): the newer `updated` wins, the other goes to .conflicts.
        const prev = flat.get(key);
        if (prev) {
          const keepPrev = (prev.rec.updated || "") >= (rec.updated || "");
          moveToConflicts(keepPrev ? rec.filePath : prev.rec.filePath, `${project}-${rec.id}-dup`);
          if (keepPrev) continue;
        }
        flat.set(key, {
          project,
          origProject: rec.project || dirEnt.name,
          rec,
          sourceBodyLen: rec.content.length,
        });
      }
    }

    // Union source 2: old bridge drawers (unipi_* rooms).
    const oldDrawers = new Map<string, OldDrawer>();
    const wings = await deps.reader.listWings().catch(() => null);
    // An unreachable reader must not read as "no old drawers" — that would
    // convert the md files and leave every old drawer behind as a duplicate.
    if (!wings || (typeof wings === "object" && "error" in (wings as object))) {
      state.errors.push("scan: reader unavailable — retrying next session");
      writeConversionState(state);
      return state;
    }
    const wingNames = extractWingNames(wings);
    for (const wing of wingNames) {
      for (const room of OLD_ROOMS) {
        let offset = 0;
        for (;;) {
          const drawers = await deps.reader.listDrawers(wing, room, 100, offset);
          if (drawers.length === 0) break;
          for (const d of drawers) {
            const parsed = oldDrawerToRecord(d);
            if (!parsed) continue;
            const metaSrc = d.metadata?.source_file as string | undefined;
            // Union keys are always the SANITIZED project so flat files and
            // old drawers for the same record meet on the same key.
            const key = `${sanitizeProjectName(parsed.project)}/${parsed.id}`;
            const prev = oldDrawers.get(key);
            const drawerIds = [...(prev?.drawerIds ?? [])];
            if (d.drawer_id) drawerIds.push(d.drawer_id);
            oldDrawers.set(key, {
              project: parsed.project,
              record: parsed.record,
              // list_drawers shows only the basename of source_file, so a
              // full unipi:// URI has to be rebuilt from the stamped project/id.
              sourceUri: prev?.sourceUri ?? (metaSrc?.includes("://") ? metaSrc : legacySourceUri(parsed.project, parsed.id)),
              drawerIds,
            });
          }
          if (drawers.length < 100) break;
          offset += drawers.length;
        }
      }
    }

    // Hydrate old-drawer records: list_drawers only carries previews — fetch
    // full docs via get_drawers (bulk), strip the embedded frontmatter.
    const needsHydration: string[] = [];
    const drawerToUnit = new Map<string, string>();
    for (const [key, od] of oldDrawers) {
      if (flat.has(key)) continue; // md file wins — no hydration needed
      for (const id of od.drawerIds) {
        needsHydration.push(id);
        drawerToUnit.set(id, key);
      }
    }
    const hydratedDocs = new Map<string, ReaderDrawerContent>();
    if (needsHydration.length) {
      const docs = await deps.reader.getDrawers(needsHydration);
      for (const doc of docs) {
        hydratedDocs.set(doc.drawer_id, {
          content: doc.content ?? doc.content_preview ?? "",
          metadata: doc.metadata,
        });
      }
      if (hydratedDocs.size < needsHydration.length && !(await deps.reader.status())) {
        state.errors.push("scan: reader died during hydration — retrying next session");
        writeConversionState(state);
        return state;
      }
    }

    const units: UnitState[] = [];
    const seen = new Set<string>();
    for (const [key, u] of flat) {
      const od = oldDrawers.get(key);
      seen.add(key);
      units.push({ ...u, oldSource: od?.sourceUri, drawerIds: od?.drawerIds });
    }
    for (const [key, od] of oldDrawers) {
      if (seen.has(key)) continue;
      // Splice every hydrated chunk doc into the unit — a logical record may
      // span several physical drawers; the reassembled content already merges.
      let content = "";
      for (const id of od.drawerIds) {
        const doc = hydratedDocs.get(id);
        if (!doc) continue;
        const parsed = parseMemoryContent(doc.content);
        if (parsed && parsed.content.length > content.length) content = parsed.content;
      }
      const rec = { ...od.record, content };
      const project = sanitizeProjectName(od.project);
      const unit: UnitState = {
        project,
        origProject: od.project,
        rec: { ...rec, project },
        oldSource: od.sourceUri,
        drawerIds: od.drawerIds,
        sourceBodyLen: content.length > 0 ? content.length : -1, // -1: body should exist, didn't arrive
      };
      // Body invariant: a source that clearly had a body but produced an
      // empty record fails the unit — never write an empty md, never delete
      // its old drawer.
      if (content.length === 0) unit.failed = true;
      units.push(unit);
    }

    writeUnitsState(units);
    state.phase = "layout";
    state.done = 0;
    writeConversionState(state);
  }

  const units = readUnitsState();
  state.total = units.length;
  if (units.length === 0) {
    state.phase = "done";
    finishConversion();
    writeConversionState(state);
    return state;
  }

  // ── Phase: layout — typed dirs, conflicts, body invariant ────────────
  if (state.phase === "layout") {
    let done = state.done;
    for (const unit of units) {
      if (unit.laidOut) continue;
      const project = unit.project;
      ensureMempalaceYaml(project);
      const rec = { ...unit.rec, project };
      const conflictKey = `${project}/${rec.id}`;
      try {
        // Body invariant: never replace a non-empty source with an empty file.
        if (!bodyInvariantOk(unit.sourceBodyLen, rec.content.length)) {
          unit.failed = true;
          state.errors.push(`layout ${conflictKey}: body invariant (src ${unit.sourceBodyLen} -> ${rec.content.length})`);
          continue;
        }
        const target = memoryFilePath(project, rec.type, rec.id);
        if (fs.existsSync(target) && rec.filePath !== target) {
          // Same id already laid out — keep the newer `updated`.
          const existing = parseMemoryFile(target);
          if (existing && (existing.updated || "") > (rec.updated || "")) {
            moveToConflicts(rec.filePath, `${conflictKey}-old`);
          } else {
            if (rec.filePath) moveToConflicts(rec.filePath, `${conflictKey}-replaced`);
            layOutRecord(rec, project);
          }
        } else {
          layOutRecord(rec, project);
        }
      } catch (e) {
        state.errors.push(`layout ${conflictKey}: ${String(e)}`);
      }
      unit.laidOut = true;
      done += 1;
      state.done = done;
      if (done % 200 === 0) { writeUnitsState(units); writeConversionState(state); }
    }
    writeUnitsState(units);
    state.phase = "mine";
    state.done = 0;
    writeConversionState(state);
  }

  // ── Phase: mine — per project, batched files payload ────────────────
  if (state.phase === "mine") {
    if (!daemon.reachable) return state;
    const byProject = new Map<string, string[]>();
    for (const unit of units) {
      if (unit.mined || !unit.laidOut || unit.failed) continue;
      const file = memoryFilePath(unit.project, unit.rec.type, unit.rec.id);
      if (!fs.existsSync(file)) { unit.failed = true; continue; }
      byProject.set(unit.project, [...(byProject.get(unit.project) ?? []), file]);
    }
    let done = state.done;
    for (const [project, files] of byProject) {
      const dir = projectDirAbs(project);
      const res = await submitMine(deps.install, dir, files, project);
      for (const f of files) {
        const unit = units.find((u) => u.project === project && memoryFilePath(u.project, u.rec.type, u.rec.id) === f);
        if (unit) unit.mined = res.ok; // a failed batch stays unmined and is retried next run
      }
      if (!res.ok) state.errors.push(`mine ${dir} failed`);
      done += files.length;
      state.done = done;
      writeUnitsState(units);
      writeConversionState(state);
    }
    if (units.some((u) => u.laidOut && !u.failed && !u.mined)) {
      writeConversionState(state);
      return state;
    }
    state.phase = "verify";
    state.done = 0;
    writeConversionState(state);
  }

  // ── Phase: verify — bulk list_drawers per wing builds the source set ─
  if (state.phase === "verify") {
    if (!daemon.reachable) return state;
    // list_drawers returns source_file as a basename (response-safe metadata),
    // so key on room + basename: in this layout wing = project and room =
    // type, which makes <room>/<id>.md unique inside a wing.
    const typedSources = new Map<string, Set<string>>(); // wing -> "room/basename"
    const neededWings = [...new Set(units.filter((u) => u.mined && !u.deleted && !u.failed).map((u) => u.project))];
    for (const wing of neededWings) {
      const set = new Set<string>();
      for (const room of TYPED_ROOMS) {
        let offset = 0;
        for (;;) {
          const drawers = await deps.reader.listDrawers(wing, room, 100, offset);
          if (drawers.length === 0) break;
          for (const d of drawers) {
            const sf = d.metadata?.source_file as string | undefined;
            if (sf) set.add(`${d.room ?? room}/${path.basename(sf)}`);
          }
          if (drawers.length < 100) break;
          offset += drawers.length;
        }
      }
      typedSources.set(wing, set);
    }
    let done = state.done;
    const unverified: UnitState[] = [];
    for (const unit of units) {
      if (!unit.mined || unit.deleted || unit.failed || unit.verified) continue;
      const target = memoryFilePath(unit.project, unit.rec.type, unit.rec.id);
      let verified = typedSources.get(unit.project)?.has(`${unit.rec.type}/${unit.rec.id}.md`) ?? false;
      if (!verified) {
        // Fallback for source paths the list didn't expose (rare): one
        // filtered search.
        const hits = await deps.reader.search(unit.rec.title, 5, unit.project, target);
        verified = hits.some((h) =>
          (h.source_path ?? h.source_file ?? (h.metadata?.source_file as string | undefined) ?? "") === target,
        );
      }
      if (!verified && !(await deps.reader.status())) {
        // The reader is down, so "not found" means nothing. Stop here and
        // resume the verify phase on a later run; never fail units for it.
        state.errors.push("verify: reader unavailable — resuming later");
        writeUnitsState(units);
        writeConversionState(state);
        return state;
      }
      if (!verified) unverified.push(unit);
      else unit.verified = true;
      done += 1;
      state.done = done;
      if (done % 200 === 0) { writeUnitsState(units); writeConversionState(state); }
    }
    // Missing drawers get one re-mine before they count as failed.
    if (unverified.length && !state.remined) {
      for (const u of unverified) u.mined = false;
      state.remined = true;
      state.phase = "mine";
      state.done = 0;
      writeUnitsState(units);
      writeConversionState(state);
      return state;
    }
    for (const u of unverified) {
      state.errors.push(`verify ${u.project}/${u.rec.id}: no drawer found`);
      u.failed = true;
    }
    writeUnitsState(units);
    state.phase = "delete";
    state.done = 0;
    writeConversionState(state);
  }

  // ── Phase: delete — bulk delete_drawers on verified units ────────────
  if (state.phase === "delete") {
    if (!daemon.reachable) return state;
    // Verified units with no old record are finished outright.
    for (const u of units) {
      if (u.verified && !u.failed && !u.deleted && !u.drawerIds?.length && !u.oldSource) {
        u.deleted = true;
      }
    }
    // `done` counts EVERY finished unit (deleted old drawer or not); failed
    // units stay separate so a clean run ends at total/total.
    const recount = (): void => {
      const { done, failed } = countFinished(units);
      state.done = done;
      state.failedUnits = failed;
    };
    recount();
    const pending = units.filter((u) => u.verified && !u.deleted && !u.failed);
    // Bulk delete in ≤500-id jobs keyed by drawer id (each removes its chunk group).
    const idToUnit = new Map<string, UnitState>();
    for (const u of pending) {
      for (const id of u.drawerIds ?? []) idToUnit.set(id, u);
    }
    const batches = planDeleteBatches(pending);
    for (const batch of batches) {
      const res = await deleteDrawers(batch);
      if (res === "unsupported") break; // older MemPalace — per-source fallback below
      if (res === "ok") {
        for (const id of batch) {
          const u = idToUnit.get(id);
          if (u && !u.deleted) {
            u.deleted = true;
            if (u.oldSource) state.deletedSources![`${u.project}/${u.rec.id}`] = u.oldSource;
          }
        }
      } else {
        state.errors.push("bulk delete batch failed");
      }
      writeUnitsState(units);
      recount();
      writeConversionState(state);
    }
    // Fallback 1: exact drawer ids collected at scan time, pipelined.
    const byId = pending.filter((u) => !u.deleted && u.drawerIds?.length);
    const ids = byId.flatMap((u) => u.drawerIds!);
    const idResults = await deleteDrawerMany(ids);
    const idOutcome = new Map(ids.map((id, i) => [id, idResults[i]]));
    for (const u of byId) {
      const outs = u.drawerIds!.map((id) => idOutcome.get(id));
      if (outs.every((o) => o === "deleted" || o === "absent")) {
        u.deleted = true;
        if (u.oldSource) state.deletedSources![`${u.project}/${u.rec.id}`] = u.oldSource;
      } else {
        state.errors.push(`delete drawers of ${u.project}/${u.rec.id} failed`);
      }
    }
    writeUnitsState(units);
    recount();
    writeConversionState(state);
    // Fallback 2 (units with no known drawer ids): delete_by_source on the
    // stamped source, then the synthesized legacy URI.
    const candidatesOf = (u: UnitState): string[] =>
      [u.oldSource, legacySourceUri(u.origProject ?? u.project, u.rec.id)]
        .filter((s): s is string => !!s)
        .filter((s, i, a) => a.indexOf(s) === i);
    let remaining = pending.filter((u) => !u.deleted && !u.drawerIds?.length);
    const anyOk = new Set<UnitState>();
    for (let attempt = 0; attempt < 2 && remaining.length; attempt++) {
      const round = remaining.filter((u) => candidatesOf(u)[attempt]);
      const results = await deleteBySourceMany(round.map((u) => candidatesOf(u)[attempt]));
      round.forEach((u, i) => {
        const n = results[i];
        if (n === null) state.errors.push(`delete ${candidatesOf(u)[attempt]} failed`);
        else anyOk.add(u);
        if (n !== null && n > 0) {
          u.deleted = true;
          if (u.oldSource) state.deletedSources![`${u.project}/${u.rec.id}`] = u.oldSource;
        }
      });
      remaining = remaining.filter((u) => !u.deleted);
      writeUnitsState(units);
      recount();
      writeConversionState(state);
    }
    // Nothing matched any candidate but a job succeeded: the old drawer is
    // already gone — done. Units whose every job failed stay for a later run.
    for (const u of remaining) {
      if (anyOk.has(u)) u.deleted = true;
    }
    // Orphaned flat-path drawers: any earlier direct `mempalace mine <dir>`
    // indexed the flat file under its old absolute path — now orphaned.
    // Idempotent cleanup; `deleted: 0` is a fine outcome.
    const flatSrcs = units
      .filter((u) => u.deleted && u.rec.filePath)
      .flatMap((u) => {
        const p = u.rec.filePath!;
        const out = [p];
        // Pre-rename dirs (e.g. EnvStripper/x.md) — an earlier direct mine
        // would have stamped the ORIGINAL dir name.
        if (u.origProject && u.origProject !== u.project) {
          out.push(path.join(memoryRoot(), u.origProject, path.basename(p)));
        }
        return out;
      })
      .filter((p) => {
        const dir = path.dirname(p);
        return path.dirname(dir) === memoryRoot(); // depth-2 flat path only
      })
      .filter((p, i, a) => a.indexOf(p) === i);
    if (flatSrcs.length) {
      const res = await deleteBySourceMany(flatSrcs);
      const failed = res.filter((r) => r === null).length;
      if (failed) state.errors.push(`flat-path delete_by_source: ${failed}/${flatSrcs.length} jobs failed`);
    }
    writeUnitsState(units);
    recount();
    state.phase = units.every((u) => u.deleted || u.failed) ? "done" : "delete";
    writeConversionState(state);
  }

  if (state.phase === "done" || state.phase === "failed") {
    if (state.phase === "done") finishConversion();
    writeConversionState(state);
    // A daemon the migration started goes away again — unless the user asked
    // pi to always keep one up.
    if (state.startedDaemon && !readMemoryConfig().autoStartDaemon && deps.install) {
      await runProcess(venvBin(deps.install, "mempalace"), ["--palace", DEFAULT_PALACE, "daemon", "stop"], 15_000);
    }
  }
  return state;
}

/** Finished-unit counters for the delete phase: `done` = every unit that
 *  reached `deleted` (whether or not it had an old drawer to remove);
 *  `failed` = units that errored. Exported for tests. */
export function countFinished(units: Array<{ deleted?: boolean; failed?: boolean }>): { done: number; failed: number } {
  return {
    done: units.filter((u) => u.deleted && !u.failed).length,
    failed: units.filter((u) => u.failed).length,
  };
}

/** Drop the legacy state markers once conversion is fully done. */
function finishConversion(): void {
  const root = memoryRoot();
  for (const name of [...LEGACY_MARKERS, path.basename(UNITS_PATH())]) {
    try { fs.unlinkSync(path.join(root, name)); } catch { /* already gone */ }
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

interface ReaderDrawerContent {
  content: string;
  metadata?: Record<string, unknown>;
}

function projectDirAbs(project: string): string {
  return path.join(memoryRoot(), project);
}

function scanDirRecursive(dir: string): MemoryRecord[] {
  const out: MemoryRecord[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const rec = parseMemoryFile(full);
        if (rec) out.push(rec);
      }
    }
  };
  try { walk(dir); } catch { /* unreadable dir */ }
  return out;
}

function extractWingNames(wings: unknown): string[] {
  if (!wings) return [];
  if (Array.isArray(wings)) {
    return wings
      .map((w) => (typeof w === "string" ? w : (w as Record<string, unknown>)?.name ?? (w as Record<string, unknown>)?.wing))
      .filter((w): w is string => typeof w === "string");
  }
  if (typeof wings === "object") {
    const w = wings as Record<string, unknown>;
    const inner = (w.wings ?? w.projects ?? w.wing_names) as unknown;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return Object.keys(inner as Record<string, unknown>);
    }
    if (Array.isArray(inner)) {
      return inner
        .map((x) => (typeof x === "string" ? x : (x as Record<string, unknown>)?.name ?? (x as Record<string, unknown>)?.wing))
        .filter((x): x is string => typeof x === "string");
    }
  }
  return [];
}

/** Merge src into dst; same-relative-path conflicts go to conflictsDir. */
function mergeDirs(src: string, dst: string, conflictsDir: string): void {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      mergeDirs(s, d, conflictsDir);
    } else if (fs.existsSync(d)) {
      moveToConflicts(s, `${path.basename(src)}-${entry.name}`);
    } else {
      fs.renameSync(s, d);
    }
  }
  try { fs.rmdirSync(src); } catch { /* non-empty */ }
}

function moveToConflicts(file: string | undefined, tag: string): void {
  if (!file) return;
  try {
    fs.mkdirSync(CONFLICTS_DIR(), { recursive: true });
    const name = `${tag}-${path.basename(file)}`;
    fs.renameSync(file, path.join(CONFLICTS_DIR(), name));
  } catch { /* leave in place */ }
}


// ── migration detection + loose-file adoption ─────────────────────────────

const MIGRATION_LEGACY_MARKERS = [".mempalace-ledger.json", ".mempalace-migrated"];

/**
 * True when v2 data still needs converting: the conversion phase isn't
 * `done` AND at least one v2 trace exists — a legacy marker file, a flat
 * `*.md` directly inside a project dir, or a non-sanitized project dir name.
 */
export function needsMigration(): boolean {
  const conv = readConversionState();
  if (conv?.phase === "done") return false;
  const root = memoryRoot();
  if (!fs.existsSync(root)) return false;
  for (const marker of MIGRATION_LEGACY_MARKERS) {
    if (fs.existsSync(path.join(root, marker))) return true;
  }
  for (const dirEnt of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dirEnt.isDirectory() || dirEnt.name.startsWith(".")) continue;
    if (dirEnt.name !== sanitizeProjectName(dirEnt.name)) return true;
    const dir = path.join(root, dirEnt.name);
    try {
      if (fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isFile() && e.name.endsWith(".md"))) {
        return true;
      }
    } catch { /* unreadable dir — not our call */ }
  }
  return false;
}

export interface AdoptedFile {
  project: string;
  rec: MemoryRecord;
  /** Absolute path of the typed md that must be filed. */
  filePath: string;
  /** The flat source it replaced — delete_by_source cleans orphaned drawers. */
  oldPath: string;
  /** Original (pre-rename) flat path a stray drawer may still reference. */
  origPath?: string;
}

/**
 * Loose-file adoption (only meaningful once conversion is `done`): move
 * non-sanitized project dirs, then files sitting directly inside a project
 * dir, into `<project>/<type>/<id>.md`. Returns the records to file; each
 * source file was already unlinked by the layout step.
 */
export function adoptLooseFiles(): AdoptedFile[] {
  const out: AdoptedFile[] = [];
  const root = memoryRoot();
  if (!fs.existsSync(root)) return out;

  // Step 1: non-sanitized dirs — rename or merge into the sanitized name.
  const renamedFrom = new Map<string, string>(); // sanitized -> original name
  for (const dirEnt of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dirEnt.isDirectory() || dirEnt.name.startsWith(".")) continue;
    const cleaned = sanitizeProjectName(dirEnt.name);
    if (dirEnt.name === cleaned) continue;
    const src = path.join(root, dirEnt.name);
    const dst = path.join(root, cleaned);
    try {
      if (fs.existsSync(dst)) mergeDirs(src, dst, CONFLICTS_DIR());
      else fs.renameSync(src, dst);
      if (!renamedFrom.has(cleaned)) renamedFrom.set(cleaned, dirEnt.name);
    } catch { /* leave for next pass */ }
  }

  // Step 2: flat *.md directly inside each project dir → typed layout.
  for (const dirEnt of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dirEnt.isDirectory() || dirEnt.name.startsWith(".")) continue;
    const project = sanitizeProjectName(dirEnt.name);
    const origDirName = renamedFrom.get(project);
    const dir = path.join(root, dirEnt.name);
    let flatEntries: fs.Dirent[];
    try { flatEntries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const f of flatEntries) {
      if (!f.isFile() || f.name.startsWith(".") || !f.name.endsWith(".md")) continue;
      const full = path.join(dir, f.name);
      const rec = parseMemoryFile(full);
      if (!rec || !rec.title) continue;
      const target = memoryFilePath(project, rec.type, rec.id);
      try {
        ensureMempalaceYaml(project);
        if (fs.existsSync(target)) {
          // Same id already typed — keep the newer `updated`.
          const existing = parseMemoryFile(target);
          if (existing && (existing.updated || "") > (rec.updated || "")) {
            moveToConflicts(full, `${project}-${rec.id}-adopt-old`);
            continue;
          }
          moveToConflicts(target, `${project}-${rec.id}-adopt-replaced`);
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, memoryDocument({ ...rec, project }), "utf-8");
        fs.unlinkSync(full);
        out.push({
          project,
          rec: { ...rec, project },
          filePath: target,
          oldPath: full,
          origPath: origDirName
            ? path.join(root, origDirName, path.basename(full))
            : undefined,
        });
      } catch { /* leave the file for the next pass */ }
    }
  }
  return out;
}
