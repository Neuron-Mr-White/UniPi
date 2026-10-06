import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { resetBusForTests, UNIPI_EVENTS } from "@pi-unipi/core";
import {
  ALL_MODE_TOOLS,
  DELEGATION_TOOLS,
  Gate,
  filterPayloadTools,
  hiddenToolNames,
  renderModeFragment,
  syncModeTools,
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

beforeEach(() => resetBusForTests());

// ── pure surface logic ───────────────────────────────────────────────────

test("toolNameOf handles OpenAI and Anthropic shapes", () => {
  assert.equal(toolNameOf({ function: { name: "bash" } }), "bash");
  assert.equal(toolNameOf({ name: "create_goal" }), "create_goal");
  assert.equal(toolNameOf({ name: 42 }), null);
  assert.equal(toolNameOf(null), null);
});

test("goal mode hides other modes' tools; delegation is never hidden", () => {
  const hidden = hiddenToolNames("goal");
  assert.equal(hidden.has("ralph_done"), true);
  assert.equal(hidden.has("swarm_status"), true);
  assert.equal(hidden.has("run_subagent"), false, "run_subagent is first-class in every mode");
  assert.equal(hidden.has("create_goal"), false);
  assert.equal(hidden.has("todowrite"), false);
  assert.equal(hidden.has("bash"), false); // infrastructure untouched
});

test("swarm mode exposes delegation but hides goal tools", () => {
  const hidden = hiddenToolNames("swarm");
  assert.equal(hidden.has("run_subagent"), false);
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
      { type: "function", function: { name: "run_subagent" } },
    ],
  };
  const filtered = filterPayloadTools(payload, "goal");
  assert.deepEqual(
    filtered.tools.map((t: unknown) => toolNameOf(t)),
    ["bash", "create_goal", "run_subagent"],
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
  const state = { mode: "none" as const, source: "default" as const };
  const a = renderModeFragment(state);
  const b = renderModeFragment(state);
  assert.equal(a, b);
  assert.match(a, /<long-horizon mode="none" source="default">/);
  // none lists no control tools; goal mode does.
  assert.doesNotMatch(a, /create_goal/);
  assert.match(renderModeFragment({ mode: "goal", source: "default" }), /create_goal/);

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
  assert.equal(second.mode, "none"); // owner parked → default mode (judge off)
  assert.equal(second.source, "default");
  rmSync(dir, { recursive: true, force: true });
});

test("delegation set is empty — subagents are first-class in every mode", () => {
  assert.deepEqual([...DELEGATION_TOOLS], []);
});

// ── badge de-dup (UX: no ⟐ spam on steady-state turns) ─────────────────────

function fakePi(appended: Array<{ mode: string; source: string }>) {
  const handlers: Record<string, (e: unknown) => unknown> = {};
  const activeTools: string[] = ["read", "bash", ...ALL_MODE_TOOLS];
  return {
    activeTools,
    on: (evt: string, fn: (e: unknown) => unknown) => {
      handlers[evt] = fn;
    },
    appendEntry: (_type: string, data: { mode: string; source: string }) => {
      appended.push({ mode: data.mode, source: data.source });
    },
    // no-ops for the rest of register()'s wiring
    emit: () => {},
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools.splice(0, activeTools.length, ...names);
    },
    async fire(prompt: string) {
      await handlers["before_agent_start"]?.({ prompt, systemPrompt: "", systemPromptOptions: { sections: {} } });
    },
    async fireEvent(name: string, event: unknown) {
      await handlers[name]?.(event);
    },
  };
}

test("badge prints on mode transitions only, not every turn", async () => {
  const { gate, owner, dir } = harness();
  const appended: Array<{ mode: string; source: string }> = [];
  const pi = fakePi(appended);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gate.register(pi as any);

  await pi.fire("hi");        // default mode (none): first badge → show once
  assert.equal(appended.length, 1);
  await pi.fire("still hi");  // same mode (none) → silent
  await pi.fire("more");      // same mode (none) → silent
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

test("after register + setSessionMode('none'), the display mode is none and event is emitted", () => {
  const { gate, dir } = harness();
  const events: Array<{ name: string; payload: unknown }> = [];
  const activeTools: string[] = ["bash", ...ALL_MODE_TOOLS];
  const pi = {
    on: () => {},
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools.splice(0, activeTools.length, ...names);
    },
    events: {
      emit: (name: string, payload: unknown) => {
        events.push({ name, payload });
      },
    },
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gate.register(pi as any);
    gate.setSessionMode("none");

    assert.equal(gate.displayMode(), "none");
    assert.deepEqual(activeTools.filter((name) => !ALL_MODE_TOOLS.includes(name)), ["bash"], "session mode sync strips the mode tools");
    const resolved = events.filter((e) => e.name === UNIPI_EVENTS.LONG_HORIZON_MODE_RESOLVED);
    assert.equal(resolved.length, 1);
    assert.deepEqual(resolved[0]?.payload, { mode: "none", source: "explicit" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── active-set sync (UNI-90: mode tools truly off in pi's tool set) ────────

function toolPi() {
  const activeTools: string[] = ["bash", "read", ...ALL_MODE_TOOLS, "sidekick"];
  const calls: string[][] = [];
  return {
    activeTools,
    calls,
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      calls.push([...names]);
      activeTools.splice(0, activeTools.length, ...names);
    },
  };
}

const modeToolsIn = (tools: string[]): string[] => tools.filter((name) => ALL_MODE_TOOLS.includes(name));

function expectExactlyModeTools(active: string[], wanted: string[]): void {
  assert.deepEqual(
    [...modeToolsIn(active)].sort(),
    [...wanted].sort(),
    `wanted ${JSON.stringify([...wanted].sort())}, got ${JSON.stringify([...modeToolsIn(active)].sort())}`,
  );
}

test("syncModeTools('none') strips all 12 mode tools, keeps other tools in order, and is a no-op when settled", () => {
  const pi = toolPi();
  assert.equal(syncModeTools(pi, "none"), true);
  assert.deepEqual(pi.activeTools, ["bash", "read", "sidekick"]);
  assert.equal(syncModeTools(pi, "none"), false);
  assert.equal(pi.calls.length, 1, "settled membership never calls setActiveTools again");
});

test("syncModeTools flips mode surfaces and never touches non-mode tools", () => {
  const pi = toolPi();
  // goal: exactly the goal control tools, non-mode tools untouched and in order.
  assert.equal(syncModeTools(pi, "goal"), true);
  expectExactlyModeTools(pi.activeTools, ["create_goal", "get_goal", "update_goal", "todowrite"]);
  assert.deepEqual(pi.activeTools.filter((n) => !ALL_MODE_TOOLS.includes(n)), ["bash", "read", "sidekick"]);

  // swarm: the swarm trio + todowrite; goal tools gone.
  assert.equal(syncModeTools(pi, "swarm"), true);
  expectExactlyModeTools(pi.activeTools, ["swarm_status", "swarm_yield", "swarm_report", "todowrite"]);
  assert.deepEqual(pi.activeTools.filter((n) => !ALL_MODE_TOOLS.includes(n)), ["bash", "read", "sidekick"]);

  // none: everything mode-owned gone again.
  assert.equal(syncModeTools(pi, "none"), true);
  assert.deepEqual(modeToolsIn(pi.activeTools), []);
  assert.deepEqual(pi.activeTools, ["bash", "read", "sidekick"]);
});

test("register(): session_start starts tools off, explicit goal turns them on, a plain turn turns them off", async () => {
  const { gate, dir } = harness();
  const appended: Array<{ mode: string; source: string }> = [];
  const pi = fakePi(appended);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gate.register(pi as any);

  // Fresh session: every mode tool off before any turn.
  gate.resetModeTools();
  assert.deepEqual(modeToolsIn(pi.activeTools), [], "a fresh session starts with mode tools off");
  assert.deepEqual(pi.activeTools.filter((n) => !ALL_MODE_TOOLS.includes(n)), ["read", "bash"]);

  // Explicit goal command → that turn's resolution turns them on.
  gate.setExplicit("goal");
  await pi.fire("start pursuing the objective");
  expectExactlyModeTools(pi.activeTools, ["create_goal", "get_goal", "update_goal", "todowrite"]);

  // Next plain turn (judge off → default none) → off again.
  await pi.fire("just answer this");
  assert.deepEqual(modeToolsIn(pi.activeTools), []);
  rmSync(dir, { recursive: true, force: true });
});

test("setExplicit syncs the mode tools immediately, before any before_agent_start", () => {
  const { gate, dir } = harness();
  const appended: Array<{ mode: string; source: string }> = [];
  const pi = fakePi(appended);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gate.register(pi as any);

  gate.setExplicit("goal");
  expectExactlyModeTools(pi.activeTools, ["create_goal", "get_goal", "update_goal", "todowrite"]);
  assert.equal(appended.length, 0, "sync happens without firing a turn");
  // A second identical explicit is a settled no-op.
  gate.setExplicit("goal");
  expectExactlyModeTools(pi.activeTools, ["create_goal", "get_goal", "update_goal", "todowrite"]);
  rmSync(dir, { recursive: true, force: true });
});

test("owner activate/resume outside a turn sync the owner's mode tools", () => {
  const dir = mkdtempSync(join(tmpdir(), "lh-gate-owner-"));
  const owner = new OwnerCoordinator({
    statePath: () => join(dir, "state.json"),
    // Same single-hook wiring as index.ts: every transition goes through the gate.
    onChange: (_snapshot, event) => gate.onOwnerChanged(event),
  });
  const gate = new Gate({ owner, loadSettings: () => DEFAULT_SETTINGS, env: {} });
  const appended: Array<{ mode: string; source: string }> = [];
  const pi = fakePi(appended);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gate.register(pi as any);

  // Command-runner activation between turns (kanboard unipi:goal-start shape).
  owner.activate("swarm", "review");
  expectExactlyModeTools(pi.activeTools, ["swarm_status", "swarm_yield", "swarm_report", "todowrite"]);

  // Suspend syncs nothing (the next resolution is authoritative)...
  owner.suspend("paused(user_requested)");
  expectExactlyModeTools(pi.activeTools, ["swarm_status", "swarm_yield", "swarm_report", "todowrite"]);
  // ...and the /unipi:continue-style resume turns them back on.
  owner.resume();
  expectExactlyModeTools(pi.activeTools, ["swarm_status", "swarm_yield", "swarm_report", "todowrite"]);
  rmSync(dir, { recursive: true, force: true });
});

test("restore syncs an active owner's tools on; an ownerless restore leaves them off", () => {
  const dir = mkdtempSync(join(tmpdir(), "lh-gate-restore-"));
  const owner = new OwnerCoordinator({
    statePath: () => join(dir, "state.json"),
    onChange: (_snapshot, event) => gate.onOwnerChanged(event),
  });
  const gate = new Gate({ owner, loadSettings: () => DEFAULT_SETTINGS, env: {} });
  const appended: Array<{ mode: string; source: string }> = [];
  const pi = fakePi(appended);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gate.register(pi as any);

  // index's session_start calls resetModeTools() first; an ownerless restore
  // then keeps the tools off.
  gate.resetModeTools();
  assert.deepEqual(modeToolsIn(pi.activeTools), []);
  owner.restore();
  assert.deepEqual(modeToolsIn(pi.activeTools), []);

  // Crash recovery with a live active owner (the restore runs after the
  // reset, same order as index's single session_start handler): the owner's
  // mode tools come back immediately.
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      active: { ownerId: "o1", kind: "goal", label: "g", status: "active", revision: 0, lease: { ownerId: "o1", generation: 0 }, updatedAt: new Date().toISOString() },
      history: [],
    }),
  );
  owner.restore();
  expectExactlyModeTools(pi.activeTools, ["create_goal", "get_goal", "update_goal", "todowrite"]);
  rmSync(dir, { recursive: true, force: true });
});

