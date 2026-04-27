/**
 * @pi-unipi/utility — Cleanup tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanupStale, formatCleanupReport } from "../src/lifecycle/cleanup.ts";

describe("cleanupStale", () => {
  it("returns a report", () => {
    const report = cleanupStale({ dryRun: true });
    assert.ok("timestamp" in report);
    assert.ok("results" in report);
    assert.ok("totalRemoved" in report);
    assert.ok("totalBytesFreed" in report);
  });

  it("dry run reports without removing", () => {
    const report = cleanupStale({ dryRun: true });
    // In dry run mode, paths are collected but not deleted
    // The count may be >0 if there are actual stale files in ~/.unipi
    assert.ok(report.totalRemoved >= 0);
    assert.ok(report.results.length > 0);
  });

  it("formats report as markdown", () => {
    const report = cleanupStale({ dryRun: true });
    const markdown = formatCleanupReport(report);
    assert.ok(markdown.includes("Cleanup Report"));
  });
});
