import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFusionToolSync, FUSION_TOOLS } from "../src/index.js";

function fakePi(initial: string[] = ["read", "bash", "edit"]) {
  const calls: string[][] = [];
  let active = [...initial];
  return {
    getActiveTools: () => [...active],
    setActiveTools: (tools: string[]) => {
      active = [...tools];
      calls.push([...tools]);
    },
    active: () => active,
    calls,
  };
}

test("non-fusion removes both fusion tools, others untouched", () => {
  const pi = fakePi(["read", "bash", "sidekick", "read_subagent", "memory_store"]);
  const sync = makeFusionToolSync(pi as never);
  sync(false);
  assert.deepEqual(pi.active(), ["read", "bash", "memory_store"]);
  assert.equal(pi.calls.length, 1);
});

test("fusion adds both tools once", () => {
  const pi = fakePi(["read", "bash"]);
  const sync = makeFusionToolSync(pi as never);
  sync(true);
  assert.deepEqual(pi.active().sort(), [...FUSION_TOOLS, "bash", "read"].sort());
  assert.equal(pi.calls.length, 1);
});

test("repeated calls with the same state don't re-set", () => {
  const pi = fakePi(["read", "sidekick", "read_subagent"]);
  const sync = makeFusionToolSync(pi as never);
  sync(false);
  sync(false);
  sync(true);
  sync(true);
  assert.equal(pi.calls.length, 2, "one remove + one add, no redundant sets");
});

test("re-syncs after pi rebuilds the tool set (session change)", () => {
  const pi = fakePi(["read", "bash"]);
  const sync = makeFusionToolSync(pi as never);
  sync(false);
  // a new session re-activates every registered extension tool
  pi.setActiveTools(["read", "bash", "sidekick", "read_subagent"]);
  sync(false);
  assert.deepEqual(pi.active(), ["read", "bash"]);
  sync(true);
  pi.setActiveTools(["read", "bash", "memory_store"]);
  sync(true);
  assert.deepEqual(pi.active().sort(), ["bash", "memory_store", "read", "read_subagent", "sidekick"]);
});

test("non-fusion session never had the tools → no redundant set", () => {
  const pi = fakePi(["read", "bash"]);
  const sync = makeFusionToolSync(pi as never);
  sync(false);
  assert.deepEqual(pi.active(), ["read", "bash"]);
  sync(false);
  assert.equal(pi.calls.length, 0);
});
