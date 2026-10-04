/**
 * @pi-unipi/info-screen — Registry
 *
 * Central registry for info pages with a cache-first reactive model:
 *
 *   memory cache (TTL)  →  disk snapshot (last session)  →  provider
 *
 * - `getCachedData` answers synchronously from memory, else from the disk
 *   snapshot, so the dashboard's first paint is never empty after the first
 *   ever run.
 * - Provider calls are de-duplicated (one in flight per page) and results are
 *   written back to the snapshot, debounced, off the render path.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { InfoGroup, GroupData } from "./types.js";
import { isStatEnabled } from "./config.js";
import { PAGE_SCOPE, PAGE_STYLES } from "./palette.js";
import { workspaceId } from "@pi-unipi/core";
import { MODULE_RENDERERS } from "./pages/modules.js";

type GroupUpdateCallback = (groupId: string, data: GroupData) => void;

const SNAPSHOT_VERSION = 2;

type Bucket = "global" | "project";
type Pages = Record<string, { at: number; data: GroupData }>;

/** Session pages never persist; project pages persist per workspace. */
const scopeOf = (id: string): "session" | Bucket => PAGE_SCOPE[id] ?? "global";
const VOLATILE = { has: (id: string): boolean => scopeOf(id) === "session" };

function cacheDir(): string {
  return join(process.env.UNIPI_DIR || join(homedir(), ".unipi"), "cache");
}

/** global → info-screen.json; project → info-screen/<workspaceId>.json */
function snapshotPath(bucket: Bucket, cwd: string): string {
  if (bucket === "global") return join(cacheDir(), "info-screen.json");
  let id = "default";
  try {
    id = workspaceId(cwd);
  } catch {
    id = "default";
  }
  return join(cacheDir(), "info-screen", `${id.replace(/[^\w.-]/g, "_")}.json`);
}

class InfoRegistry {
  private groups = new Map<string, InfoGroup>();
  private dataCache = new Map<string, GroupData>();
  private lastUpdated = new Map<string, number>();
  private cacheTtlMs = 5000;
  private globalSubscribers = new Set<GroupUpdateCallback>();
  private inflight = new Map<string, Promise<GroupData>>();

  /** Disk snapshots (global + this workspace), loaded lazily once each. */
  private snapshots: Partial<Record<Bucket, Pages>> = {};
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  /** Workspace the project snapshot belongs to (set on session_start). */
  private cwd = process.cwd();
  /** Disabled in tests / when the dir is unwritable. */
  persist = true;

  registerGroup(group: InfoGroup): void {
    const style = PAGE_STYLES[group.id];
    const g: InfoGroup = style
      ? { ...group, priority: style.priority, short: group.short ?? style.short, accent: group.accent ?? style.accent }
      : { ...group };
    // Module packages ship data only; the info screen owns their drawing.
    const custom = MODULE_RENDERERS[g.id];
    if (!g.render && custom) g.render = custom;
    this.groups.set(g.id, g);
    this.notifyGroupRegistered(g.id);
  }

  getAllGroups(): InfoGroup[] {
    return Array.from(this.groups.values()).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  getGroup(groupId: string): InfoGroup | undefined {
    return this.groups.get(groupId);
  }

  /** Synchronous: memory cache, else the last-session snapshot. */
  getCachedData(groupId: string): GroupData | null {
    const mem = this.dataCache.get(groupId);
    if (mem) return mem;
    if (VOLATILE.has(groupId)) return null;
    const snap = this.loadSnapshot(scopeOf(groupId) as Bucket)[groupId];
    return snap ? snap.data : null;
  }

  /** Last successful fetch (memory), else the snapshot's timestamp. */
  getLastUpdated(groupId: string): number {
    const t = this.lastUpdated.get(groupId);
    if (t) return t;
    if (VOLATILE.has(groupId)) return 0;
    return this.loadSnapshot(scopeOf(groupId) as Bucket)[groupId]?.at ?? 0;
  }

  async getGroupData(groupId: string): Promise<GroupData> {
    const group = this.groups.get(groupId);
    if (!group) return {};
    const last = this.lastUpdated.get(groupId) ?? 0;
    if (Date.now() - last < this.cacheTtlMs) {
      const cached = this.dataCache.get(groupId);
      if (cached) return cached;
    }
    return this.fetchOnce(groupId, group);
  }

  /** Bypass the TTL (manual refresh) but still de-duplicate. */
  forceRefresh(groupId: string): Promise<GroupData> {
    const group = this.groups.get(groupId);
    if (!group) return Promise.resolve({});
    return this.fetchOnce(groupId, group);
  }

  private fetchOnce(groupId: string, group: InfoGroup): Promise<GroupData> {
    const existing = this.inflight.get(groupId);
    if (existing) return existing;
    const p = this.fetchGroupData(groupId, group).finally(() => this.inflight.delete(groupId));
    this.inflight.set(groupId, p);
    return p;
  }

  private async fetchGroupData(groupId: string, group: InfoGroup): Promise<GroupData> {
    try {
      const data = await group.dataProvider();
      this.dataCache.set(groupId, data);
      this.lastUpdated.set(groupId, Date.now());
      this.notifySubscribers(groupId, data);
      if (!VOLATILE.has(groupId) && Object.keys(data).length > 0) this.queueSnapshot();
      return data;
    } catch {
      return this.dataCache.get(groupId) ?? {};
    }
  }

  refreshGroup(groupId: string): GroupData | null {
    const cached = this.getCachedData(groupId);
    void this.getGroupData(groupId);
    return cached;
  }

  refreshAll(): void {
    for (const id of this.groups.keys()) void this.forceRefresh(id);
  }

  subscribeAll(callback: GroupUpdateCallback): () => void {
    this.globalSubscribers.add(callback);
    return () => {
      this.globalSubscribers.delete(callback);
    };
  }

  private notifySubscribers(groupId: string, data: GroupData): void {
    for (const cb of this.globalSubscribers) {
      try {
        cb(groupId, data);
      } catch {
        /* ignore */
      }
    }
  }

  getVisibleStats(groupId: string): Array<{ id: string; label: string }> {
    const group = this.groups.get(groupId);
    if (!group?.config?.stats) return [];
    return group.config.stats.filter((stat) => isStatEnabled(groupId, stat.id) && stat.show);
  }

  /** Drop the memory entry (the snapshot stays as a stale-but-instant fallback). */
  invalidateCache(groupId: string): void {
    this.dataCache.delete(groupId);
    this.lastUpdated.delete(groupId);
  }

  private notifyGroupRegistered(groupId: string): void {
    for (const cb of this.globalSubscribers) {
      try {
        cb(groupId, {} as GroupData);
      } catch {
        /* ignore */
      }
    }
  }

  // ─── disk snapshot ─────────────────────────────────────────────────────

  /**
   * Point project-scoped snapshots at a workspace. Drops project data held in
   * memory for another workspace, so project A's numbers never show in B.
   */
  setWorkspace(cwd: string): void {
    if (cwd === this.cwd) return;
    this.cwd = cwd;
    delete this.snapshots.project;
    for (const id of [...this.dataCache.keys()]) {
      if (scopeOf(id) !== "global") this.invalidateCache(id);
    }
  }

  private loadSnapshot(bucket: Bucket): Pages {
    const hit = this.snapshots[bucket];
    if (hit) return hit;
    let pages: Pages = {};
    if (this.persist) {
      try {
        const path = snapshotPath(bucket, this.cwd);
        if (existsSync(path)) {
          const parsed = JSON.parse(readFileSync(path, "utf-8")) as { version?: number; pages?: Pages };
          if (parsed?.version === SNAPSHOT_VERSION && parsed.pages && typeof parsed.pages === "object") {
            // Never trust another bucket's pages from an older single-file snapshot.
            pages = Object.fromEntries(Object.entries(parsed.pages).filter(([id]) => scopeOf(id) === bucket));
          }
        }
      } catch {
        pages = {};
      }
    }
    this.snapshots[bucket] = pages;
    return pages;
  }

  private queueSnapshot(): void {
    if (!this.persist || this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      this.writeSnapshot();
    }, 1500);
    this.snapshotTimer.unref?.();
  }

  /** Write memory data over both snapshots (atomic rename). Exposed for shutdown. */
  writeSnapshot(): void {
    if (!this.persist) return;
    for (const bucket of ["global", "project"] as const) {
      const pages = { ...this.loadSnapshot(bucket) };
      let changed = false;
      for (const [id, data] of this.dataCache) {
        if (scopeOf(id) !== bucket || Object.keys(data).length === 0) continue;
        pages[id] = { at: this.lastUpdated.get(id) ?? Date.now(), data };
        changed = true;
      }
      this.snapshots[bucket] = pages;
      if (!changed) continue;
      try {
        const path = snapshotPath(bucket, this.cwd);
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ version: SNAPSHOT_VERSION, pages }), "utf-8");
        renameSync(tmp, path);
      } catch {
        // A snapshot we cannot persist only costs the instant first paint.
      }
    }
  }

  /** Tests: forget everything. */
  _reset(): void {
    this.groups.clear();
    this.dataCache.clear();
    this.lastUpdated.clear();
    this.inflight.clear();
    this.snapshots = {};
  }
}

/** Singleton registry instance. */
export const infoRegistry = new InfoRegistry();

if (!globalThis.__unipi_info_registry) {
  globalThis.__unipi_info_registry = infoRegistry as never;
}
