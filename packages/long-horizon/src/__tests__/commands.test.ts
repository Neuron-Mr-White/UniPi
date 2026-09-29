import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GoalMachine } from "../engine/goal-state.js";
import { GoalToolset } from "../tools/goal.js";
import { OwnerCoordinator } from "../owner.js";
import { Gate } from "../gate.js";
import { GoalContinuation } from "../engine/continuation.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import { registerLongHorizonCommands } from "../commands.js";

interface Handler {
  handler: (args: string, ctx: never) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => unknown;
}

interface Rig {
  machine: GoalMachine;
  owner: OwnerCoordinator;
  toolset: GoalToolset;
  gate: Gate;
  continuation: GoalContinuation;
  notifications: string[];
  sent: string[];
  events: Array<{ name: string; payload: Record<string, unknown> }>;
  run: (command: string, args?: string) => Promise<void>;
  tool: (name: string, params: Record<string, unknown>) => Promise<string>;
  completions: (command: string, prefix: string) => unknown;
}

function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "lh-cmds-"));
  const machine = new GoalMachine({ statePath: () => join(dir, "goal.json") });
  const owner = new OwnerCoordinator({ statePath: () => join(dir, "owner.json") });
  const toolset = new GoalToolset({ machine, owner });
  const gate = new Gate({ owner, loadSettings: () => DEFAULT_SETTINGS, env: {} });
  const notifications: string[] = [];
  const sent: string[] = [];
  const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const commands = new Map<string, Handler>();
  const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }>();
  const pi = {
    registerCommand: (name: string, options: Handler) => {
      commands.set(name, options);
    },
    registerTool: (definition: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }) => {
      tools.set(definition.name, definition);
    },
    on: () => () => undefined,
    sendUserMessage: (text: string) => {
      sent.push(text);
    },
    events: { emit: (name: string, payload: Record<string, unknown>) => events.push({ name, payload }) },
  } as never;
  toolset.register(pi as Parameters<GoalToolset["register"]>[0]);
  registerLongHorizonCommands(pi, gate, owner, undefined, undefined, machine, toolset);
  const continuation = new GoalContinuation({
    machine,
    toolset,
    owner,
    verifier: { evaluate: async () => { throw new Error("verifier unbound"); } },
    send: (message: string) => {
      sent.push(message);
    },
  });
  const ctx = { hasUI: true, ui: { notify: (text: string) => notifications.push(text) } } as never;
  return {
    machine,
    owner,
    toolset,
    gate,
    continuation,
    notifications,
    sent,
    events,
    run: async (command: string, args = "") => {
      const handler = commands.get(command)?.handler;
      assert.ok(handler, `command ${command} not registered`);
      await handler(args, ctx);
    },
    tool: async (name: string, params: Record<string, unknown>) => {
      const definition = tools.get(name);
      assert.ok(definition, `tool ${name} not registered`);
      const result = await definition.execute("test-call", params);
      return result.content.map((part) => part.text).join("");
    },
    completions: (command: string, prefix: string) => commands.get(command)?.getArgumentCompletions?.(prefix),
  };
}

/** Start a goal + its owner the way create_goal does. */
function startGoal(rig: Rig, objective = "ship the fix"): void {
  rig.machine.create(objective);
  rig.owner.activate("goal", objective);
}

function ownerChangedEvents(rig: Rig): Array<Record<string, unknown>> {
  return rig.events.filter((event) => event.name === "unipi:long-horizon:owner:changed").map((event) => event.payload);
}

test("stop ends the active goal terminally, drops the pending proposal, and the loop stays quiet", async () => {
  const r = rig();
  startGoal(r);
  assert.equal((await r.tool("update_goal", { mode: "status", status: "complete" })).includes("Completion proposed"), true);
  assert.notEqual(r.toolset.peekProposal(), null);

  await r.run("unipi:goal", "stop");

  assert.deepEqual(r.notifications, ["Goal stopped."]);
  assert.equal(r.owner.getActive(), undefined);
  assert.equal(r.owner.snapshot().history[0]?.terminalReason, "stopped(user_requested)");
  const goal = r.machine.get();
  assert.equal(goal?.status, "complete");
  assert.equal(goal?.reason, "complete(user_requested)");
  assert.equal(r.toolset.peekProposal(), null, "pending completion proposal discarded");
  assert.equal(r.sent.length, 0, "no chat message and no continuation follow-up");
  const stopped = ownerChangedEvents(r).at(-1);
  assert.equal(stopped?.event, "stopped");
  assert.equal(stopped?.kind, "goal");

  // The continuation driver has nothing to drive: settle a turn anyway.
  const decision = await r.continuation.onTurnEnd({ toolCalls: 3, changedFiles: [], commands: [], recentTail: [] });
  assert.deepEqual(decision, { action: "none", reason: "no-active-goal" });
  assert.equal(r.sent.length, 0);
});

test("stop with nothing active only notifies", async () => {
  const r = rig();
  await r.run("unipi:goal", "stop");
  assert.deepEqual(r.notifications, ["No active goal."]);
  assert.equal(ownerChangedEvents(r).length, 0);
  assert.equal(r.sent.length, 0, "stop is never sent as a chat message");
});

test("stop only ends an owner of its own mode; swarm stop leaves a goal alone", async () => {
  const r = rig();
  startGoal(r);
  await r.run("unipi:swarm", "stop");
  assert.deepEqual(r.notifications, ["No active swarm."]);
  assert.notEqual(r.owner.getActive(), undefined);
});

test("stop works for swarm owners and pins regular mode", async () => {
  const r = rig();
  r.owner.activate("swarm", "fan out");
  await r.run("unipi:swarm", "stop");
  assert.deepEqual(r.notifications, ["Swarm stopped."]);
  assert.equal(r.owner.getActive(), undefined);
  const state = await r.gate.resolveForTurn("hello");
  assert.equal(state.mode, "none");
  assert.equal(state.source, "explicit");
  assert.equal(state.sticky, true);
});

test("stop is a subcommand, not a prompt — it never reaches sendUserMessage", async () => {
  const r = rig();
  startGoal(r);
  await r.run("unipi:goal", "stop");
  await r.run("unipi:graph", "stop");
  await r.run("unipi:swarm", "stop");
  assert.equal(r.sent.length, 0);
});

test("clear while an owner is active only hints and clears nothing", async () => {
  const r = rig();
  startGoal(r);
  await r.run("unipi:goal", "clear");
  assert.match(r.notifications[0] ?? "", /A goal is running — use \/unipi:goal stop to end it\./);
  assert.notEqual(r.owner.getActive(), undefined, "active owner untouched");
  assert.deepEqual(ownerChangedEvents(r), []);
});

test("clear with nothing anywhere says so", async () => {
  const r = rig();
  await r.run("unipi:goal", "clear");
  assert.deepEqual(r.notifications, ["Nothing to clear."]);
});

test("clear still drops a parked owner", async () => {
  const r = rig();
  startGoal(r);
  assert.notEqual(r.owner.suspend("paused(user_requested)"), undefined);
  await r.run("unipi:goal", "clear");
  assert.match(r.notifications[0] ?? "", /^Cleared parked goal/);
  assert.equal(r.owner.getParked(), undefined);
});

test("/unipi:regular stops any active owner (including ralph-loop) and pins none for the session", async () => {
  const r = rig();
  r.owner.activate("ralph-loop", "grind");
  assert.equal(r.owner.getActive()?.kind, "ralph-loop");

  await r.run("unipi:regular");

  assert.deepEqual(r.notifications, ["Regular mode."]);
  assert.equal(r.owner.getActive(), undefined);
  assert.equal(r.owner.snapshot().history[0]?.kind, "ralph-loop");
  const first = await r.gate.resolveForTurn("fix the bug");
  assert.equal(first.mode, "none");
  assert.equal(first.source, "explicit");
  // Sticky: later turns stay regular without a new command.
  const second = await r.gate.resolveForTurn("another prompt");
  assert.equal(second.mode, "none");
  assert.equal(second.source, "explicit");
});

test("an explicit mode command escapes the regular latch", async () => {
  const r = rig();
  await r.run("unipi:regular");
  await r.run("unipi:goal", "work on the thing");
  const state = await r.gate.resolveForTurn("continue");
  assert.equal(state.mode, "goal");
  assert.equal(state.sticky, undefined);
});

test("goal completions advertise stop", () => {
  const r = rig();
  const items = r.completions("unipi:goal", "s") as Array<{ value: string }>;
  assert.ok(items.some((item) => item.value === "stop"), "stop offered among s* subcommands");
});
