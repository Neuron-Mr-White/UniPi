/**
 * @pi-unipi/utility — Cleanup tests (allowlist, temp dirs only)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCleanupItems, removeCleanupItems, formatCleanupPreview, type CleanupTarget } from "../src/lifecycle/cleanup.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "unipi-cleanup-test-"));
  const results = join(root, "tool-results");
  mkdirSync(results);
  const old = join(results, "tool-result-abc123.txt");
  const fresh = join(results, "tool-result-def456.txt");
  const foreign = join(results, "memory.db");
  for (const f of [old, fresh, foreign]) writeFileSync(f, "x".repeat(10));
  const tenDaysAgo = (Date.now() - 10 * 86_400_000) / 1000;
  utimesSync(old, tenDaysAgo, tenDaysAgo);
  utimesSync(foreign, tenDaysAgo, tenDaysAgo);
  const legacy = join(root, "db", "compactor");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "session.db"), "db");
  const backup = join(root, "memory-v2-backup-1", "p");
  mkdirSync(backup, { recursive: true });
  writeFileSync(join(backup, "memory.db"), "keep");
  utimesSync(join(backup, "memory.db"), tenDaysAgo, tenDaysAgo);
  const targets: CleanupTarget[] = [
    { id: "tool-results", label: "tool results", dir: () => results, match: /^tool-result-[a-f0-9-]+\.txt$/, minAgeDays: 7, kind: "file" },
    { id: "compactor-db", label: "legacy db", dir: () => join(root, "db"), match: /^compactor$/, minAgeDays: 0, kind: "dir" },
  ];
  return { root, old, fresh, foreign, legacy, backup, targets };
}

describe("cleanup allowlist", () => {
  it("previews only allowlisted, old-enough entries", () => {
    const f = fixture();
    const items = findCleanupItems(f.targets);
    assert.deepEqual(items.map((i) => i.path).sort(), [f.legacy, f.old].sort());
    assert.match(formatCleanupPreview(items, f.targets), /2 item\(s\)/);
  });

  it("removes the previewed items and nothing else", () => {
    const f = fixture();
    const result = removeCleanupItems(findCleanupItems(f.targets), f.targets);
    assert.equal(result.removed, 2);
    assert.equal(existsSync(f.old), false);
    assert.equal(existsSync(f.legacy), false);
    assert.equal(existsSync(f.fresh), true);
    assert.equal(existsSync(f.foreign), true);
    assert.equal(existsSync(join(f.backup, "memory.db")), true);
  });

  it("refuses paths that are not allowlisted, even if passed in", () => {
    const f = fixture();
    const result = removeCleanupItems([{ target: "tool-results", path: join(f.backup, "memory.db"), bytes: 4 }], f.targets);
    assert.equal(result.removed, 0);
    assert.equal(existsSync(join(f.backup, "memory.db")), true);
  });
});
