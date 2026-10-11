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
    assert.ok(markdown.includes("## Diagnostics"));
    assert.ok(markdown.includes(report.overall.toUpperCase()));
  });
});

import { vcRuntimeChecks } from "../src/diagnostics/engine.ts";

describe("vcRuntimeChecks (UNI-261)", () => {
  it("is silent off Windows", () => {
    assert.deepEqual(vcRuntimeChecks("linux", "C:\\Windows", () => false), []);
    assert.deepEqual(vcRuntimeChecks("darwin", "C:\\Windows", () => false), []);
  });

  it("warns with the winget fix when vcruntime140.dll is missing", () => {
    const seen: string[] = [];
    const [check] = vcRuntimeChecks("win32", "C:\\Windows\\", (p) => { seen.push(p); return false; });
    assert.equal(check.status, "warning");
    assert.ok(seen.includes("C:\\Windows\\System32\\vcruntime140.dll"), seen.join(","));
    assert.match(check.message, /vcruntime140\.dll/);
    assert.match(check.suggestion ?? "", /winget install Microsoft\.VCRedist\.2015\+\.x64/);
    assert.match(check.suggestion ?? "", /aka\.ms\/vs\/17\/release\/vc_redist\.x64\.exe/);
  });

  it("is healthy when the runtime DLLs exist", () => {
    const [check] = vcRuntimeChecks("win32", "D:\\Win", () => true);
    assert.equal(check.status, "healthy");
    assert.equal(check.suggestion, undefined);
  });

  it("runDiagnostics includes the wreq_js native check", async () => {
    const report = await runDiagnostics();
    const w = report.checks.find((c) => c.name === "wreq_js");
    assert.ok(w);
    assert.equal(w.status, "healthy");
  });
});
