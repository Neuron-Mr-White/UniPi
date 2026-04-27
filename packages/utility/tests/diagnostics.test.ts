/**
 * @pi-unipi/utility — Diagnostics tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runDiagnostics, formatDiagnosticsReport } from "../src/diagnostics/engine.ts";

describe("runDiagnostics", () => {
  it("returns a report with checks", async () => {
    const report = await runDiagnostics();
    assert.ok("timestamp" in report);
    assert.ok("overall" in report);
    assert.ok("checks" in report);
    assert.ok("summary" in report);
    assert.ok(report.checks.length > 0);
  });

  it("has valid summary counts", async () => {
    const report = await runDiagnostics();
    const total =
      report.summary.healthy +
      report.summary.warning +
      report.summary.error +
      report.summary.unknown;
    assert.equal(total, report.checks.length);
  });

  it("overall reflects worst status", async () => {
    const report = await runDiagnostics();
    if (report.summary.error > 0) {
      assert.equal(report.overall, "error");
    } else if (report.summary.warning > 0) {
      assert.equal(report.overall, "warning");
    }
  });
});

describe("formatDiagnosticsReport", () => {
  it("formats as markdown", async () => {
    const report = await runDiagnostics();
    const markdown = formatDiagnosticsReport(report);
    assert.ok(markdown.includes("Diagnostics Report"));
    assert.ok(markdown.includes(report.overall.toUpperCase()));
  });
});
