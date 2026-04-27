/**
 * @pi-unipi/utility — Analytics tests
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AnalyticsCollector } from "../src/analytics/collector.ts";

describe("AnalyticsCollector", () => {
  let collector: AnalyticsCollector;

  beforeEach(() => {
    collector = new AnalyticsCollector();
    collector.clear();
  });

  it("records events", () => {
    const event = collector.record("command_run", { command: "test" });
    assert.equal(event.type, "command_run");
    assert.ok(event.timestamp > 0);
  });

  it("records commands", () => {
    collector.recordCommand("brainstorm", "@pi-unipi/workflow", 100, true);
    const events = collector.getEventsByType("command_run");
    assert.equal(events.length, 1);
  });

  it("records errors", () => {
    collector.recordError("@pi-unipi/utility", "timeout", "Connection failed");
    const events = collector.getEventsByType("error");
    assert.equal(events.length, 1);
  });

  it("sanitizes sensitive data", () => {
    const event = collector.record("command_run", {
      apiKey: "secret123",
    });
    assert.ok((event.metadata?.apiKey as string).includes("REDACTED"));
  });

  it("truncates long strings", () => {
    const longString = "x".repeat(1000);
    const event = collector.record("search", { query: longString });
    const query = event.metadata?.query as string;
    assert.ok(query.length < 600);
    assert.ok(query.endsWith("…"));
  });

  it("computes daily rollup", () => {
    collector.recordCommand("test", "mod", 100, true);
    collector.recordCommand("test2", "mod", 200, false);
    const rollup = collector.getRollup();
    assert.equal(rollup.events.command_run, 2);
    assert.equal(rollup.totalDurationMs, 300);
  });

  it("exports to JSON", () => {
    collector.record("module_load");
    const json = collector.exportToJSON();
    assert.equal(JSON.parse(json).length, 1);
  });

  it("can be disabled", () => {
    collector.disable();
    const event = collector.record("command_run");
    assert.ok(event.id);
    // Events are not buffered when disabled
    assert.equal(collector.getEvents().length, 0);
  });
});
