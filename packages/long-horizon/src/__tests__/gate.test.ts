import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ALL_MODE_TOOLS,
  DELEGATION_TOOLS,
  Gate,
  filterPayloadTools,
  hiddenToolNames,
  renderModeFragment,
  toolNameOf,
} from "../gate.js";
import { OwnerCoordinator } from "../owner.js";
import { DEFAULT_SETTINGS } from "../settings.js";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "lh-gate-"));
  const owner = new OwnerCoordinator({ statePath: () => join(dir, "state.json") });
  const gate = new Gate({
    owner,
    loadSettings: () => DEFAULT_SETTINGS,
    env: {},
  });
  return { gate, owner, dir };
}

// ── pure surface logic ───────────────────────────────────────────────────

test("toolNameOf handles OpenAI and Anthropic shapes", () => {
  assert.equal(toolNameOf({ function: { name: "bash" } }), "bash");
  assert.equal(toolNameOf({ name: "create_goal" }), "create_goal");
  assert.equal(toolNameOf({ name: 42 }), null);
  assert.equal(toolNameOf(null), null);
});

test("goal mode hides other modes' tools and defers delegation", () => {
  const hidden = hiddenToolNames("goal");
  assert.equal(hidden.has("ralph_done"), true);
  assert.equal(hidden.has("swarm_status"), true);
  assert.equal(hidden.has("spawn_helper"), true);
  assert.equal(hidden.has("bg_delegate"), true);
  assert.equal(hidden.has("create_goal"), false);
  assert.equal(hidden.has("todowrite"), false);
  assert.equal(hidden.has("bash"), false); // infrastructure untouched
});

test("swarm mode exposes delegation but hides goal tools", () => {
  const hidden = hiddenToolNames("swarm");
  assert.equal(hidden.has("spawn_helper"), false);
  assert.equal(hidden.has("create_goal"), true);
  assert.equal(hidden.has("update_goal"), true);
  assert.equal(hidden.has("swarm_yield"), false);
});

test("none mode hides every mode tool but never infrastructure", () => {
  const hidden = hiddenToolNames("none");
  for (const tool of ALL_MODE_TOOLS) {
    if (tool === "todowrite") continue; // todowrite rides all four modes
    assert.equal(hidden.has(tool), true, `${tool} should hide in none`);
  }
  assert.equal(hidden.has("bash"), false);
  assert.equal(hidden.has("memory_store"), false);
});

test("filterPayloadTools preserves order and unknown shapes pass through", () => {
  const payload = {
    model: "m",
    tools: [
      { type: "function", function: { name: "bash" } },
      { type: "function", function: { name: "create_goal" } },
      { name: "ralph_done" },
      { type: "function", function: { name: "spawn_helper" } },
    ],
  };
  const filtered = filterPayloadTools(payload, "goal");
  assert.deepEqual(
    filtered.tools.map((t: unknown) => toolNameOf(t)),
    ["bash", "create_goal"],
  );
  // Re-filtering an already-filtered payload is identity-stable (no further change).
  assert.equal(filterPayloadTools(filtered, "goal"), filtered);
  // Nothing hidden → original object identity preserved (cache-stable).
  const clean = { tools: [{ type: "function", function: { name: "bash" } }] };
  assert.equal(filterPayloadTools(clean, "goal"), clean);
  assert.deepEqual(filterPayloadTools({ messages: [] }, "none"), { messages: [] });
});

// ── fragment rendering ───────────────────────────────────────────────────

test("fragment is deterministic and carries mode + owner status", () => {
  const { gate, owner, dir } = harness();
  const state = { mode: "goal" as const, source: "default" as const };
  const a = renderModeFragment(state);
  const b = renderModeFragment(state);
  assert.equal(a, b);
  assert.match(a, /<long-horizon mode="goal" source="default">/);
  assert.match(a, /create_goal/);

  owner.activate("goal", "all tests pass");
  owner.suspend("paused(superseded_by:swarm)");
  const withOwner = renderModeFragment(
    { mode: "swarm", source: "explicit" },
    owner.getActive(),
    owner.getParked(),
  );
  assert.match(withOwner, /a parked goal owner exists/);
  assert.match(withOwner, /\/unipi:continue/);
  rmSync(dir, { recursive: true, force: true });
});

// ── gate resolution state ────────────────────────────────────────────────

test("explicit override beats owner, parks it, and is consumed once", async () => {
  const { gate, owner, dir } = harness();
  owner.activate("goal", "g");
  gate.setExplicit("swarm");
  const first = await gate.resolveForTurn("do the thing");
  assert.deepEqual(first, { mode: "swarm", source: "explicit" });
  assert.equal(owner.getParked()?.kind, "goal"); // suspend-and-switch
  const second = await gate.resolveForTurn("another message");
  assert.equal(second.mode, "goal"); // owner parked → default mode (judge off)
  assert.equal(second.source, "default");
  rmSync(dir, { recursive: true, force: true });
});

test("delegation set matches the design matrix", () => {
  assert.deepEqual([...DELEGATION_TOOLS].sort(), [
    "bg_delegate",
    "bg_result",
    "get_helper_result",
    "spawn_helper",
  ]);
});

// ── badge de-dup (UX: no ⟐ spam on steady-state turns) ─────────────────────

function fakePi(appended: Array<{ mode: string; source: string }>) {
  const handlers: Record<string, (e: unknown) => unknown> = {};
  return {
    on: (evt: string, fn: (e: unknown) => unknown) => {
      handlers[evt] = fn;
    },
    appendEntry: (_type: string, data: { mode: string; source: string }) => {
      appended.push({ mode: data.mode, source: data.source });
    },
    // no-ops for the rest of register()'s wiring
    emit: () => {},
    async fire(prompt: string) {
      await handlers["before_agent_start"]?.({ prompt, systemPrompt: "" });
    },
  };
}

test("badge prints on mode transitions only, not every turn", async () => {
  const { gate, owner, dir } = harness();
  const appended: Array<{ mode: string; source: string }> = [];
  const pi = fakePi(appended);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gate.register(pi as any);

  await pi.fire("hi");        // default mode (goal): first badge → show once
  assert.equal(appended.length, 1);
  await pi.fire("still hi");  // same mode (goal) → silent
  await pi.fire("more");      // same mode (goal) → silent
  assert.equal(appended.length, 1, "no reprint while mode is unchanged");

  // Transition to a different mode via an active swarm owner.
  owner.activate("swarm", "s");
  await pi.fire("parallelize this"); // mode swarm ≠ goal → show once
  assert.equal(appended.length, 2);
  assert.equal(appended[1]!.mode, "swarm");

  await pi.fire("keep going");        // still swarm → silent
  assert.equal(appended.length, 2, "no reprint while steady in swarm mode");

  rmSync(dir, { recursive: true, force: true });
});
