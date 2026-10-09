/**
 * @unipi/memory — One warm read-only MCP server per session
 *
 * `mempalace-mcp --palace <p> --read-only` over stdio: a long-lived process
 * doing reads at ~30ms per call instead of ~1s cold spawns. The daemon's own
 * read surface doesn't exist (writes-only job queue), so this is how pi sees
 * every drawer — its own plus Devin/zcode/diary notes written by other tools.
 * Respawns once on crash; the caller kills it on session shutdown.
 *
 * Memory: the server is ~85 MB idle and ~300–470 MB once the first search has
 * loaded the embedder + HNSW index, and there is one per pi session (incl.
 * subagent children). So the reader starts lazily on the first call and
 * unloads itself after `idleMs` without calls; the next call respawns it
 * (~1.4 s cold instead of ~30 ms warm).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mempalaceEnv, venvBin, type MempalaceInstall } from "./mempalace.js";

/** Default idle window before the reader process is unloaded. */
export const READER_IDLE_MS = 10 * 60_000;

export interface ReaderSearchHit {
  drawer_id: string;
  text?: string;
  content?: string;
  /** Flat fields on the response: wing/room/source_file(basename)/source_path(abs). */
  wing?: string;
  room?: string;
  source_file?: string;
  source_path?: string;
  added_by?: string;
  metadata?: Record<string, unknown>;
  score?: number;
  similarity?: number;
}

export interface ReaderDrawer {
  drawer_id: string;
  wing?: string;
  room?: string;
  content_preview?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

interface JsonRpcResponse {
  id: number;
  result?: {
    tools?: Array<{ name: string }>;
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

export class MemoryReader {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private buffer = "";
  private pending = new Map<number, { resolve: (v: JsonRpcResponse) => void; timer: NodeJS.Timeout }>();
  /** Respawn timestamps inside the last 10 minutes — at most 5 restarts per window. */
  private respawns: number[] = [];
  private starting: Promise<boolean> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  /** In-flight tool calls — the idle unload never fires under them. */
  private active = 0;
  /** The last exit was our own idle unload — the next start isn't a crash respawn. */
  private unloadedIdle = false;
  /** Times the process was unloaded for idleness (diagnostics/tests). */
  idleUnloads = 0;

  constructor(
    private readonly install: MempalaceInstall,
    private readonly palacePath: string,
    /** readOnly=false spawns the WRITE-mode server (for one-shot deletes). */
    private readonly readOnly = true,
    /** Unload the process after this long without calls; 0 = keep it warm. */
    private readonly idleMs = READER_IDLE_MS,
  ) {}

  /** The live server pid, if one is running. */
  get pid(): number | undefined {
    return this.alive() ? this.proc?.pid : undefined;
  }

  private alive(): boolean {
    // A signal-killed child (e.g. OOM SIGKILL) keeps exitCode null — check both.
    return !!this.proc && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  /** Start (or confirm) the reader process. Idempotent + single-flight. */
  async start(): Promise<boolean> {
    if (this.alive()) return true;
    if (this.starting) return this.starting;
    if (this.unloadedIdle) {
      // Coming back from an idle unload is not a crash — don't spend the
      // crash-respawn budget on it.
      this.unloadedIdle = false;
    } else {
      const now = Date.now();
      this.respawns = this.respawns.filter((t) => now - t < 10 * 60_000);
      if (this.respawns.length >= 5) return false;
      this.respawns.push(now);
    }
    this.starting = this.spawn();
    const ok = await this.starting;
    this.starting = null;
    return ok;
  }

  private spawn(): Promise<boolean> {
    return new Promise((resolve) => {
      let proc: ChildProcess;
      try {
        proc = spawn(
          venvBin(this.install, "mempalace-mcp"),
          this.readOnly
            ? ["--palace", this.palacePath, "--read-only"]
            : ["--palace", this.palacePath],
          { stdio: ["pipe", "pipe", "ignore"], env: mempalaceEnv() },
        );
      } catch {
        resolve(false);
        return;
      }
      this.proc = proc;
      this.buffer = "";
      proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
      proc.on("error", () => this.failPending());
      proc.on("close", () => {
        this.failPending();
        if (this.proc === proc) this.proc = null; // next call respawns (rate-limited in start)
      });
      // initialize + ready check — the server answers initialize before tools are usable.
      this.callRaw("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "unipi-memory", version: "1" },
      })
        .then((m) => {
          if (!m.result) {
            resolve(false);
            return;
          }
          this.notify("notifications/initialized", {});
          resolve(true);
        })
        .catch(() => resolve(false));
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf-8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      const entry = this.pending.get(msg.id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        entry.resolve(msg);
      }
    }
  }

  private failPending(): void {
    for (const [, e] of this.pending) {
      clearTimeout(e.timer);
      e.resolve({ id: 0, error: { code: -1, message: "reader process exited" } });
    }
    this.pending.clear();
  }

  private notify(method: string, params: Record<string, unknown>): void {
    try {
      this.proc?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    } catch { /* pipe broken */ }
  }

  private callRaw(method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, error: { code: -2, message: "reader call timed out" } });
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, timer });
      try {
        this.proc?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ id, error: { code: -3, message: "reader stdin broken" } });
      }
    });
  }

  /** (Re)arm the idle unload — called whenever the reader goes quiet. */
  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.idleMs <= 0 || this.active > 0 || !this.alive()) return;
    this.idleTimer = setTimeout(() => this.unloadIfIdle(), this.idleMs);
    this.idleTimer.unref?.();
  }

  private unloadIfIdle(): void {
    this.idleTimer = null;
    if (this.active > 0 || this.starting || !this.alive()) return;
    this.unloadedIdle = true;
    this.idleUnloads += 1;
    this.stopProcess();
  }

  private stopProcess(): void {
    const proc = this.proc;
    this.proc = null;
    // stdin EOF is the server's clean shutdown; the signal covers a wedged one.
    try { proc?.stdin?.end(); } catch { /* ignore */ }
    try { proc?.kill(); } catch { /* ignore */ }
    this.failPending();
  }

  /** tools/call → parsed tool payload (the server returns JSON text). */
  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.active += 1;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    try {
      return await this.callToolInner(name, args);
    } finally {
      this.active -= 1;
      this.armIdle();
    }
  }

  private async callToolInner(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!(await this.start())) return { error: "reader unavailable" };
    const m = await this.callRaw("tools/call", { name, arguments: args });
    const text = m.result?.content?.[0]?.text;
    if (typeof text !== "string") {
      return { error: m.error?.message ?? "empty tool response" };
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async search(query: string, limit: number, wing?: string, sourceFile?: string): Promise<ReaderSearchHit[]> {
    const args: Record<string, unknown> = { query, limit };
    if (wing) args.wing = wing;
    if (sourceFile) args.source_file = sourceFile;
    const res = (await this.callTool("mempalace_search", args)) as
      | { results?: ReaderSearchHit[] }
      | { error: string };
    if (!res || typeof res !== "object" || !Array.isArray((res as { results?: unknown }).results)) {
      return [];
    }
    return (res as { results: ReaderSearchHit[] }).results;
  }

  async listDrawers(wing?: string, room?: string, limit = 100, offset = 0): Promise<ReaderDrawer[]> {
    // mempalace_list_drawers caps limit at 100.
    const args: Record<string, unknown> = { limit: Math.min(limit, 100), offset };
    if (wing) args.wing = wing;
    if (room) args.room = room;
    const res = (await this.callTool("mempalace_list_drawers", args)) as
      | { drawers?: ReaderDrawer[] }
      | { error: string };
    if (!res || typeof res !== "object" || !Array.isArray((res as { drawers?: unknown }).drawers)) {
      return [];
    }
    return (res as { drawers: ReaderDrawer[] }).drawers;
  }

  async getDrawer(drawerId: string): Promise<ReaderDrawer | null> {
    const res = (await this.callTool("mempalace_get_drawer", { drawer_id: drawerId })) as
      | ReaderDrawer
      | { error: string };
    if (!res || typeof res !== "object" || !(res as ReaderDrawer).drawer_id) return null;
    return res as ReaderDrawer;
  }

  /** Bulk get_drawer (≤500 ids per call) — logical ids reassemble chunk groups.
   *  MemPalace releases without mempalace_get_drawers (3.10.0) fall back to
   *  one get_drawer per id. */
  async getDrawers(drawerIds: string[]): Promise<ReaderDrawer[]> {
    const out: ReaderDrawer[] = [];
    let bulk = true;
    for (let i = 0; i < drawerIds.length; i += 500) {
      const chunk = drawerIds.slice(i, i + 500);
      if (bulk) {
        const res = (await this.callTool("mempalace_get_drawers", { drawer_ids: chunk })) as
          | { results?: ReaderDrawer[] }
          | { error: string };
        if (res && typeof res === "object" && Array.isArray((res as { results?: unknown }).results)) {
          out.push(...(res as { results: ReaderDrawer[] }).results);
          continue;
        }
        bulk = false;
      }
      for (const id of chunk) {
        const d = await this.getDrawer(id);
        if (d) out.push(d);
      }
    }
    return out;
  }

  /** Escape hatch for one-shot write-mode calls (delete_by_source). */
  async callWriteTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.callTool(name, args);
  }

  async status(): Promise<Record<string, unknown> | null> {
    const res = await this.callTool("mempalace_status", {});
    if (!res || typeof res !== "object" || "error" in (res as object)) return null;
    return res as Record<string, unknown>;
  }

  async listWings(): Promise<unknown> {
    return this.callTool("mempalace_list_wings", {});
  }

  kill(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.stopProcess();
  }
}
