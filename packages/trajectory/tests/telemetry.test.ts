import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { redactTelemetry, TelemetrySidecar } from "../src/telemetry.js";

test("redacts credential-shaped keys and values recursively", () => {
  assert.deepEqual(redactTelemetry({ authorization: "Bearer abc", nested: { apiKey: "secret", safe: "ok" }, value: "sk-abcdefghijklmnop" }), {
    authorization: "[REDACTED]", nested: { apiKey: "[REDACTED]", safe: "ok" }, value: "[REDACTED]",
  });
});

test("appends and reads durable JSONL events", () => {
  const root = mkdtempSync(join(tmpdir(), "trajectory-"));
  const sidecar = new TelemetrySidecar("session/unsafe", root);
  sidecar.append({ type: "request", at: 10, requestId: 1, data: { model: "m" } });
  sidecar.append({ type: "first-token", at: 20, requestId: 1 });
  assert.equal(sidecar.read().length, 2);
  assert.match(sidecar.file, /session_unsafe\.jsonl$/);
  assert.equal(readFileSync(sidecar.file, "utf8").split("\n").filter(Boolean).length, 2);
});

test("rejects pathologically large events and bounds read memory", () => {
  const root = mkdtempSync(join(tmpdir(), "trajectory-"));
  const sidecar = new TelemetrySidecar("large", root);
  const hugeArray = Array.from({ length: 30_000 }, (_, index) => ({ index, chunk: "x".repeat(80) }));
  sidecar.append({ type: "request", at: 10, requestId: 1, data: { payload: hugeArray } });
  sidecar.append({ type: "request", at: 20, requestId: 2, data: { model: "m" } });
  const lines = readFileSync(sidecar.file, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.length < 2_000_000);
  assert.equal(sidecar.read().length, 1);
  const filler = JSON.stringify({ v: 1, type: "request", at: 30, requestId: 3, data: { s: "y".repeat(400_000) } });
  appendFileSync(sidecar.file, Array(100).fill(filler).join("\n") + "\n");
  const events = sidecar.read();
  // Read is capped at 20 MB of the newest complete lines — never unbounded.
  assert.ok(events.length > 0 && events.length <= 101);
  assert.ok(events.every(event => event.type === "request"));
  assert.equal(events.at(-1)!.requestId, 3);
  assert.ok(events.length * filler.length < 21_000_000);
});
