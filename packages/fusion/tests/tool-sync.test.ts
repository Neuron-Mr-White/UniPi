import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFusionToolSync, FUSION_TOOLS } from "../src/index.js";
import { setReadSubagentDemand, resetSubagentRegistry } from "@pi-unipi/core/child-agent.js";

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

test("non-fusion removes the sidekick tool, others untouched", () => {
  resetSubagentRegistry();
  const pi = fakePi(["read", "bash", "sidekick", "read_subagent", "memory_store"]);
  const sync = makeFusionToolSync(pi as never);
  sync(false);
  assert.deepEqual(pi.active(), ["read", "bash", "read_subagent", "memory_store"], "only sidekick is removed — read_subagent is demand-driven");
  assert.equal(pi.calls.length, 1);
});

test("fusion adds sidekick once; demand adds read_subagent", () => {
  resetSubagentRegistry();
  const pi = fakePi(["read", "bash"]);
  const sync = makeFusionToolSync(pi as never);
  sync(true);
  assert.deepEqual(pi.active().sort(), [...FUSION_TOOLS, "bash", "read"].sort());
  setReadSubagentDemand(pi as never, "fusion", true);
  assert.ok(pi.active().includes("read_subagent"));
});

test("repeated calls with the same state don't re-set", () => {
  resetSubagentRegistry();
  const pi = fakePi(["read", "sidekick"]);
  const sync = makeFusionToolSync(pi as never);
  sync(false);
  sync(false);
  sync(true);
  sync(true);
  assert.equal(pi.calls.length, 2, "one remove + one add, no redundant sets");
});

test("re-syncs after pi rebuilds the tool set (session change)", () => {
  resetSubagentRegistry();
  const pi = fakePi(["read", "bash"]);
  const sync = makeFusionToolSync(pi as never);
  sync(false);
  // a new session re-activates every registered extension tool
  pi.setActiveTools(["read", "bash", "sidekick"]);
  sync(false);
  assert.deepEqual(pi.active(), ["read", "bash"]);
  sync(true);
  pi.setActiveTools(["read", "bash", "memory_store"]);
  sync(true);
  assert.deepEqual(pi.active().sort(), ["bash", "memory_store", "read", "sidekick"]);
});

test("non-fusion session never had the tools → no redundant set", () => {
  resetSubagentRegistry();
  const pi = fakePi(["read", "bash"]);
  const sync = makeFusionToolSync(pi as never);
  sync(false);
  assert.deepEqual(pi.active(), ["read", "bash"]);
  sync(false);
  assert.equal(pi.calls.length, 0);
});
