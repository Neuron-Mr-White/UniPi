/**
 * @pi-unipi/info-screen — Session file parser
 *
 * Parses ~/.pi/agent/sessions/ JSONL files for usage stats.
 * Reference: tmustier/pi-extensions/usage-extension
 */

import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync, renameSync, openSync, readSync, closeSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { SavingsAccumulator, totalsOf, EMPTY_SAVINGS, type CompactionSaving, type SavingsTotals } from "@pi-unipi/core";
import { homedir } from "node:os";

/** Usage data for a single message */
interface MessageUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}

/** Aggregated usage stats */
export interface UsageStats {
  /** Total tokens by period */
  tokens: {
    today: number;
    week: number;
    month: number;
  };
  /** Total cost by period (USD) */
  cost: {
    today: number;
    allTime: number;
  };
  /** Token counts by model (all time) */
  byModel: Record<string, { tokens: number; cost: number; sessions: number }>;
  /** Token counts by model (today) */
  byModelToday: Record<string, { tokens: number; cost: number; sessions: number }>;
  /** Token counts by model (this week) */
  byModelWeek: Record<string, { tokens: number; cost: number; sessions: number }>;
  /** Token counts by model (this month) */
  byModelMonth: Record<string, { tokens: number; cost: number; sessions: number }>;
  /** Total sessions */
  sessionCount: number;
  /** Last 30 local days, oldest → newest (index 29 = today). */
  daily: Array<{ tokens: number; cost: number }>;
  /** Sessions with usage today. */
  sessionsToday: number;
  /** What compaction saved, across every session (deduped). */
  compaction: SavingsTotals;
  /** Same, per session directory (= per project). */
  compactionByDir: Record<string, SavingsTotals>;
}

/** Days kept in `daily`. */
export const DAILY_DAYS = 30;

/** Time period boundaries */
interface PeriodBounds {
  start: Date;
  end: Date;
}

/**
 * A single usage record, stored in the cache in compact tuple form.
 *
 * [timestamp, hashTokens, countedTokens, cost, modelIndex, counted]
 *
 * `hashTokens` is input+output+cacheRead+cacheWrite and exists ONLY to rebuild
 * the dedup key. `countedTokens` is input+output+cacheWrite, which is what the
 * totals actually sum (cacheRead is deliberately excluded).
 *
 * `counted` (1/0) mirrors the original `input > 0 || output > 0 || cost > 0`
 * check. It must be stored separately because the original claims the dedup
 * hash BEFORE applying that filter — so a zero-usage message still suppresses
 * a later duplicate. Collapsing the two would change the totals.
 */
type UsageRecord = [number, number, number, number, number, number];

/** Per-file cache entry, invalidated on mtime or size change. */
interface CachedFile {
  mtimeMs: number;
  size: number;
  records: UsageRecord[];
  /** Compactions in this file: [at, before, after, replies, paid, context]. */
  savings?: Array<[number, number, number, number, number, number]>;
}

interface UsageCacheFile {
  version: number;
  /** Interned model names; records store an index into this array. */
  models: string[];
  files: Record<string, CachedFile>;
}

/**
 * Bump when the record layout or parsing semantics change, so stale caches
 * from an older build are discarded rather than silently reused.
 */
const CACHE_VERSION = 2;

function getCachePath(): string {
  const base = process.env.UNIPI_DIR || join(homedir(), ".unipi");
  return join(base, "cache", "usage-stats.json");
}

/**
 * In-process copy of the cache. The JSON is ~10 MB for a heavy user: reading
 * and parsing it costs ~50 ms and rewriting it ~30 ms. Keeping it in memory
 * makes every refresh after the first a stat pass plus re-parsing only the
 * session files that changed (usually just the live one).
 */
let memCache: UsageCacheFile | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
/** Disk writes are debounced; a crash costs at most one incremental re-parse. */
const WRITE_DEBOUNCE_MS = 30_000;

function scheduleWrite(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (memCache) writeCache(memCache);
  }, WRITE_DEBOUNCE_MS);
  writeTimer.unref?.();
}

/**
 * True when a refresh would be incremental (cache present and current
 * format). Boot-time warm-ups check this so a format bump never triggers a
 * cold multi-second parse behind the user's back.
 */
export function usageCacheWarm(): boolean {
  if (memCache) return true;
  try {
    const path = getCachePath();
    if (!existsSync(path)) return false;
    // The version field is written first; read just the head of the file.
    const fd = openSync(path, "r");
    const head = Buffer.alloc(64);
    readSync(fd, head, 0, 64, 0);
    closeSync(fd);
    return head.toString("utf8").startsWith(`{"version":${CACHE_VERSION},`);
  } catch {
    return false;
  }
}

/** Flush a pending cache write now (session shutdown). */
export function flushUsageCache(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
    if (memCache) writeCache(memCache);
  }
}

function readCache(): UsageCacheFile {
  if (memCache) return memCache;
  const empty: UsageCacheFile = { version: CACHE_VERSION, models: [], files: {} };
  try {
    const path = getCachePath();
    if (!existsSync(path)) return empty;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as UsageCacheFile;
    if (!parsed || parsed.version !== CACHE_VERSION) return empty;
    if (!Array.isArray(parsed.models) || typeof parsed.files !== "object") return empty;
    memCache = parsed;
    return parsed;
  } catch {
    // Corrupt or unreadable cache: rebuild from scratch.
    return empty;
  }
}

function writeCache(cache: UsageCacheFile): void {
  try {
    const path = getCachePath();
    mkdirSync(dirname(path), { recursive: true });
    // Write-then-rename so a crash mid-write cannot leave a torn cache behind.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache), "utf-8");
    renameSync(tmp, path);
  } catch {
    // A cache we cannot persist is a performance loss, not a correctness one.
  }
}

/**
 * Get the sessions directory path.
 */
function getSessionsDir(): string {
  // Replicate Pi's logic: respect PI_CODING_AGENT_DIR env var
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "sessions");
}

/**
 * Get period boundaries for today, this week, this month.
 * Today starts at 00:00 local time.
 * Week starts on Monday.
 */
function getPeriodBounds(): { today: PeriodBounds; week: PeriodBounds; month: PeriodBounds } {
  const now = new Date();

  // Start of today (midnight local time)
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  // Start of current week (Monday 00:00)
  const weekStart = new Date(now);
  const dayOfWeek = weekStart.getDay(); // 0 = Sunday, 1 = Monday, ...
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  weekStart.setDate(weekStart.getDate() - daysSinceMonday);
  weekStart.setHours(0, 0, 0, 0);

  // Start of current month (1st day 00:00)
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  return {
    today: { start: todayStart, end: now },
    week: { start: weekStart, end: now },
    month: { start: monthStart, end: now },
  };
}



/**
 * Read a file line-by-line without materializing it in memory.
 *
 * Session files reach 200MB+, so readFileSync would allocate the whole file
 * (and its split() array) just to scan it once. Reads in 1MB chunks and keeps
 * only the trailing partial line between chunks.
 */
function forEachLine(filePath: string, onLine: (line: string) => void): void {
  const CHUNK = 1024 * 1024;
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(CHUNK);
    let carry = "";
    for (;;) {
      const bytes = readSync(fd, buf, 0, CHUNK, null);
      if (bytes <= 0) break;
      // latin1 would corrupt multi-byte UTF-8 split across a chunk boundary;
      // toString("utf8") on a Buffer slice handles the common case, and any
      // partial sequence lands in `carry` and is completed by the next chunk.
      const text = carry + buf.toString("utf8", 0, bytes);
      let start = 0;
      for (;;) {
        const nl = text.indexOf("\n", start);
        if (nl === -1) break;
        onLine(text.slice(start, nl));
        start = nl + 1;
      }
      carry = text.slice(start);
    }
    if (carry.length > 0) onLine(carry);
  } catch {
    // Skip unreadable files
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * Extract the compact usage records from one session file.
 *
 * Deliberately does NOT deduplicate: dedup is cross-file and order-dependent,
 * so it must happen at aggregation time. Caching raw per-file records keeps
 * each entry independent and lets any single file be re-parsed in isolation.
 */
function extractRecords(
  filePath: string,
  modelIndex: Map<string, number>,
  models: string[],
): { records: UsageRecord[]; savings: NonNullable<CachedFile["savings"]> } {
  const records: UsageRecord[] = [];
  const acc = new SavingsAccumulator();

  forEachLine(filePath, (line) => {
    if (!line || !line.trim()) return;
    // Cheap pre-filter: only messages and compactions matter.
    if (!line.includes('"assistant"') && !line.includes('"compaction"')) return;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      return; // Skip malformed lines
    }
    acc.feed(entry);

    if (entry.type !== "message" || entry.message?.role !== "assistant") return;
    const msg = entry.message;
    if (!msg.usage || !msg.provider || !msg.model) return;

    const input = msg.usage.input || 0;
    const output = msg.usage.output || 0;
    const cacheRead = msg.usage.cacheRead || 0;
    const cacheWrite = msg.usage.cacheWrite || 0;
    const cost = msg.usage.cost?.total || 0;

    const fallbackTs = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
    const timestamp = msg.timestamp || (Number.isNaN(fallbackTs) ? 0 : fallbackTs);

    let idx = modelIndex.get(msg.model);
    if (idx === undefined) {
      idx = models.length;
      models.push(msg.model);
      modelIndex.set(msg.model, idx);
    }

    records.push([
      timestamp,
      input + output + cacheRead + cacheWrite, // dedup key component
      input + output + cacheWrite,             // counted tokens (excludes cacheRead)
      cost,
      idx,
      input > 0 || output > 0 || cost > 0 ? 1 : 0,
    ]);
  });

  const savings = acc.items.map((c) => [c.at, c.before, c.after, c.replies, c.paid, c.context] as [number, number, number, number, number, number]);
  return { records, savings };
}

/**
 * Collect all session files recursively.
 */
function collectSessionFiles(dir: string, files: string[]): void {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        collectSessionFiles(entryPath, files);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(entryPath);
      }
    }
  } catch {
    // Skip directories we can't read
  }
}

/**
 * Parse all session files and aggregate usage stats, yielding to the event
 * loop while parsing.
 *
 * A cold parse is several seconds of pure CPU. Running it synchronously starves
 * the event loop, so keystrokes queue up and the UI cannot repaint. Deferring
 * the *start* (setTimeout) does not help — the block must be broken up.
 * `yieldEvery` files, control returns to the loop.
 */
export async function parseUsageStatsAsync(): Promise<UsageStats> {
  const { stats, pending } = collectStats();
  await pending;
  return stats;
}

/** Empty stats accumulator. */
function emptyStats(): UsageStats {
  return {
    tokens: { today: 0, week: 0, month: 0 },
    cost: { today: 0, allTime: 0 },
    byModel: {},
    byModelToday: {},
    byModelWeek: {},
    byModelMonth: {},
    sessionCount: 0,
    daily: Array.from({ length: DAILY_DAYS }, () => ({ tokens: 0, cost: 0 })),
    sessionsToday: 0,
    compaction: { ...EMPTY_SAVINGS },
    compactionByDir: {},
  };
}

/**
 * Scan all session files and aggregate usage stats.
 *
 * The returned `stats` object is filled in as `pending` progresses; the caller
 * must await it.
 */
function collectStats(): { stats: UsageStats; pending: Promise<void> } {
  const stats = emptyStats();
  const sessionsDir = getSessionsDir();
  if (!existsSync(sessionsDir)) return { stats, pending: Promise.resolve() };

  const sessionFiles: string[] = [];
  collectSessionFiles(sessionsDir, sessionFiles);
  sessionFiles.sort();

  const cache = readCache();
  const models = cache.models.slice();
  const modelIndex = new Map<string, number>();
  models.forEach((name, i) => modelIndex.set(name, i));

  const nextFiles: Record<string, CachedFile> = {};
  let cacheDirty = false;

  // Statting 600 files costs ~1ms, so the mtime+size gate is essentially free
  // compared to re-reading gigabytes of immutable history.
  const work: Array<{ path: string; cached: CachedFile | null }> = [];
  for (const filePath of sessionFiles) {
    let mtimeMs = 0;
    let size = 0;
    try {
      const st = statSync(filePath);
      mtimeMs = st.mtimeMs;
      size = st.size;
    } catch {
      continue; // Vanished between listing and statting.
    }

    const hit = cache.files[filePath];
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
      nextFiles[filePath] = hit;
      work.push({ path: filePath, cached: hit });
    } else {
      cacheDirty = true;
      work.push({ path: filePath, cached: null });
      nextFiles[filePath] = { mtimeMs, size, records: [] };
    }
  }

  // A file disappearing means the old cache had entries we must drop.
  if (Object.keys(nextFiles).length !== Object.keys(cache.files).length) cacheDirty = true;

  const seenHashes = new Map<number, number | number[]>();
  const periods = getPeriodBounds();
  const todayStart = periods.today.start.getTime();
  const weekStart = periods.week.start.getTime();
  const monthStart = periods.month.start.getTime();

  const bump = (
    bucket: Record<string, { tokens: number; cost: number; sessions: number }>,
    model: string,
    tokens: number,
    cost: number,
  ) => {
    let entry = bucket[model];
    if (!entry) {
      entry = { tokens: 0, cost: 0, sessions: 0 };
      bucket[model] = entry;
    }
    entry.tokens += tokens;
    entry.cost += cost;
    entry.sessions++;
  };

  // Local midnights for the last DAILY_DAYS days (DST-safe: built with
  // setDate, not by subtracting 24h). dayStarts[i] is day i's 00:00.
  const dayStarts: number[] = [];
  for (let i = 0; i < DAILY_DAYS; i++) {
    const d = new Date(todayStart);
    d.setDate(d.getDate() - (DAILY_DAYS - 1 - i));
    dayStarts.push(d.getTime());
  }
  const firstDay = dayStarts[0]!;
  const dayIndex = (ts: number): number => {
    if (ts < firstDay) return -1;
    for (let i = DAILY_DAYS - 1; i >= 0; i--) if (ts >= dayStarts[i]!) return i;
    return -1;
  };

  const aggregate = (records: UsageRecord[]): void => {
    let counted = 0;
    let countedToday = false;
    for (const rec of records) {
      const [timestamp, hashTokens, countedTokens, cost, modelIdx, isCounted] = rec;

      // Dedup key is claimed even for records that are not counted, matching
      // the original ordering (hash added before the validity check).
      // Exact (timestamp, tokens) dedup without building a string per record —
      // that was the single biggest cost of a warm refresh. Almost every
      // timestamp has one record, so the value is a number until it collides.
      const seen = seenHashes.get(timestamp);
      if (seen === undefined) seenHashes.set(timestamp, hashTokens);
      else if (typeof seen === "number") {
        if (seen === hashTokens) continue;
        seenHashes.set(timestamp, [seen, hashTokens]);
      } else {
        if (seen.includes(hashTokens)) continue;
        seen.push(hashTokens);
      }
      if (!isCounted) continue;

      counted++;
      const model = models[modelIdx] ?? "unknown";

      stats.cost.allTime += cost;
      bump(stats.byModel, model, countedTokens, cost);

      const di = dayIndex(timestamp);
      if (di >= 0 && di < DAILY_DAYS) {
        stats.daily[di]!.tokens += countedTokens;
        stats.daily[di]!.cost += cost;
      }

      if (timestamp >= todayStart) {
        countedToday = true;
        stats.tokens.today += countedTokens;
        stats.cost.today += cost;
        bump(stats.byModelToday, model, countedTokens, cost);
      }
      if (timestamp >= weekStart) {
        stats.tokens.week += countedTokens;
        bump(stats.byModelWeek, model, countedTokens, cost);
      }
      if (timestamp >= monthStart) {
        stats.tokens.month += countedTokens;
        bump(stats.byModelMonth, model, countedTokens, cost);
      }
    }

    if (counted > 0) {
      stats.sessionCount++;
    }
    if (countedToday) stats.sessionsToday++;
  };

  // Compactions are copied into forked session files; count each once.
  const seenCompactions = new Set<string>();
  const allSavings: CompactionSaving[] = [];
  const dirSavings = new Map<string, CompactionSaving[]>();
  const aggregateSavings = (path: string, rows: CachedFile["savings"]): void => {
    if (!rows) return;
    const dir = basename(dirname(path));
    for (const [at, before, after, replies, paid, context] of rows) {
      const key = `${at}:${before}`;
      if (seenCompactions.has(key)) continue;
      seenCompactions.add(key);
      const c: CompactionSaving = { at, before, after, replies, paid, context };
      allSavings.push(c);
      let list = dirSavings.get(dir);
      if (!list) dirSavings.set(dir, (list = []));
      list.push(c);
    }
  };

  const finish = (): void => {
    stats.compaction = totalsOf(allSavings);
    for (const [dir, list] of dirSavings) stats.compactionByDir[dir] = totalsOf(list);
    memCache = { version: CACHE_VERSION, models, files: nextFiles };
    if (cacheDirty) scheduleWrite();
  };

  const YIELD_EVERY = 25;

  const pending = (async () => {
    let sinceYield = 0;
    for (const item of work) {
      let records: UsageRecord[];
      if (item.cached) {
        records = item.cached.records;
        aggregateSavings(item.path, item.cached.savings);
      } else {
        const parsed = extractRecords(item.path, modelIndex, models);
        records = parsed.records;
        nextFiles[item.path].records = records;
        nextFiles[item.path].savings = parsed.savings;
        aggregateSavings(item.path, parsed.savings);
        // Only re-parsed files are expensive; cache hits are near-free, so
        // yielding is gated on real work to avoid pointless loop turns.
        sinceYield++;
      }
      aggregate(records);
      if (sinceYield >= YIELD_EVERY) {
        sinceYield = 0;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    finish();
  })();

  return { stats, pending };
}

/**
 * Format token count for display.
 */
export function formatTokens(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
  return `${Math.round(n / 1000000)}M`;
}

/**
 * Format cost for display.
 */
export function formatCost(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  if (n < 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
}
