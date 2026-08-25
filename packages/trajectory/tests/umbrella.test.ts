import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../unipi/index.ts", import.meta.url), "utf8");

const EXPECTED_SCOPES = [
  "workflow", "ralph", "memory", "utility", "info-screen", "subagents", "background-tasks", "btw",
  "web-api", "ask-user", "mcp", "notify", "milestone", "kanboard", "command-enchantment", "compactor",
  "footer", "updater", "input-shortcuts", "image",
];

test("umbrella scopes every UniPi package and leaves trajectory as the final sink", () => {
  const scopes = [...source.matchAll(/load\("([^"]+)"\s*,/g)].map(match => match[1]);
  assert.deepEqual(scopes, EXPECTED_SCOPES);
  assert.match(source, /const tracer = createUnipiTracer\(pi\)/);
  assert.match(source, /trajectory\(pi, \{ traceRecorder: tracer\.recorder \}\);/);
  assert.ok(source.lastIndexOf("trajectory(pi") > source.lastIndexOf("load("));
  assert.doesNotMatch(source, /load\("trajectory"/);
});
