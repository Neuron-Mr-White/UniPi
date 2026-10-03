/**
 * Hint store — ~/.unipi/global/hints/hints.json, write-through JSON.
 *
 * Persists show counts, learned hints, and last seen unipi version:
 *   {
 *     "counts": { "<hintId>": { "count": 2, "last": 1730000000000 } },
 *     "learned": ["utility.settings-hub"],
 *     "lastSeenVersion": "3.0.0-alpha.20"
 *   }
 */

import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { statePath } from "../workspace/paths.js";

export interface HintRecord {
  count: number;
  last: number;
}

export interface HintStoreData {
  counts: Record<string, HintRecord>;
  learned: string[];
  lastSeenVersion?: string;
}

let cache: HintStoreData | null = null;

function emptyStore(): HintStoreData {
  return {
    counts: {},
    learned: [],
    lastSeenVersion: undefined,
  };
}

export function loadHintStore(): HintStoreData {
  if (cache) return cache;
  try {
    const raw = readFileSync(statePath("hints", "hints.json", "global"), "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      cache = {
        counts: (typeof parsed.counts === "object" && parsed.counts !== null ? parsed.counts : {}) as Record<string, HintRecord>,
        learned: Array.isArray(parsed.learned) ? parsed.learned : [],
        lastSeenVersion: typeof parsed.lastSeenVersion === "string" ? parsed.lastSeenVersion : undefined,
      };
    } else {
      cache = emptyStore();
    }
  } catch {
    cache = emptyStore();
  }
  return cache;
}

function saveStore(): void {
  if (!cache) return;
  try {
    writeFileSync(statePath("hints", "hints.json", "global"), JSON.stringify(cache, null, 2));
  } catch {
    // best-effort
  }
}

export function recordHintShow(id: string): void {
  const store = loadHintStore();
  const prev = store.counts[id];
  store.counts[id] = { count: (prev?.count ?? 0) + 1, last: Date.now() };
  saveStore();
}

export function recordHintLearned(id: string): void {
  const store = loadHintStore();
  if (!store.learned.includes(id)) {
    store.learned.push(id);
    saveStore();
  }
}

export function isHintLearned(id: string): boolean {
  const store = loadHintStore();
  return store.learned.includes(id);
}

export function setLastSeenVersion(version: string): void {
  const store = loadHintStore();
  store.lastSeenVersion = version;
  saveStore();
}

export function getLastSeenVersion(): string | undefined {
  const store = loadHintStore();
  return store.lastSeenVersion;
}

export function resetHintHistory(): void {
  const store = loadHintStore();
  store.counts = {};
  store.learned = [];
  try {
    writeFileSync(statePath("hints", "hints.json", "global"), JSON.stringify(store, null, 2));
  } catch {
    // best effort
  }
}

/** Clear disk file and cached store completely (e.g. for testing clean slate). */
export function clearHintStoreFile(): void {
  cache = null;
  try {
    unlinkSync(statePath("hints", "hints.json", "global"));
  } catch {
    // absent file is already clear
  }
}

/** Test hook: drop memoized store so next call re-reads disk. */
export function resetHintStoreCache(): void {
  cache = null;
}
