import { test } from "node:test";
import assert from "node:assert/strict";
import { primaryArg } from "../src/transcript.js";

test("primaryArg selects the tool's main argument", () => {
  assert.equal(primaryArg("bash", { command: "npm test\nsecond" }), "npm test");
  assert.equal(primaryArg("read", { path: "/a/b" }), "/a/b");
  assert.equal(primaryArg("sidekick", { message: "do it" }), "do it");
  assert.equal(primaryArg("unknown", {}), "");
});
