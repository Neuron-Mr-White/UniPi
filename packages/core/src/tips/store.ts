/**
 * Tip show-counts — ~/.unipi/global/tips/tips.json, write-through JSON.
 *
 *   { "<tipId>": { "count": 2, "last": 1730000000000 } }
 */

import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { statePath } from "../workspace/paths.js";

export interface TipRecord {
  count: number;
  last: number;
}

export type TipCounts = Record<string, TipRecord>;

let cache: TipCounts | null = null;

export function loadTipCounts(): TipCounts {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(statePath("tips", "tips.json", "global"), "utf-8"));
    cache = (typeof parsed === "object" && parsed !== null ? parsed : {}) as TipCounts;
  } catch {
    cache = {};
  }
  return cache;
}

export function recordTipShow(id: string): void {
  const counts = loadTipCounts();
  const prev = counts[id];
  counts[id] = { count: (prev?.count ?? 0) + 1, last: Date.now() };
  try {
    writeFileSync(statePath("tips", "tips.json", "global"), JSON.stringify(counts, null, 2));
  } catch {
    // best-effort — a lost count just re-shows the tip
  }
}

export function resetTipCounts(): void {
  cache = {};
  try {
    unlinkSync(statePath("tips", "tips.json", "global"));
  } catch {
    // absent file is already reset
  }
}

/** Test hook: drop the memoized counts so the next load re-reads disk. */
export function resetTipCountsCache(): void {
  cache = null;
}
