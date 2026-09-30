/**
 * The monitor (src/monitor.ts): the arbiter's kanboard nudge provider.
 * Pure logic against injected deps — no binary, no pi.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { SettleInfo } from "@pi-unipi/core";
import { createKanboardMonitor, MAX_NUDGES_PER_TASK, MAX_OFFERS_PER_TASK, STALL_LIMIT, type MonitorDeps } from "../src/monitor.js";
import type { KanboardTask } from "../src/shapes.js";
import { ANTI_POISONING_SUFFIX } from "../src/reminders.js";

const SESSION = "pi-test";

function task(overrides: Partial<KanboardTask> & { id: string }): KanboardTask {
  return { title: overrides.id, status: "todo", activity: [], ...overrides } as KanboardTask;
}

function claim(id: string): KanboardTask {
  return task({ id, status: "in_progress", run: { session: SESSION } });
}

const info = (overrides: Partial<SettleInfo> = {}): SettleInfo => ({
  outcome: "completed",
  pendingMessages: 0,
  lastAssistantText: "working on it",
  lastAssistantHadToolCalls: true,
  toolCallsThisRun: 3,
  ...overrides,
});

interface Fixture {
  board: KanboardTask[];
  ready: KanboardTask[];
  notices: string[];
  autoworkOffs: number;
  ownerStatus: {
    owner?: { kind: string; status: string };
    lastStop?: { kind: string; at: number };
  } | undefined;
  clock: { now: number };
  monitor: ReturnType<typeof createKanboardMonitor>;
  setBoard(tasks: KanboardTask[]): void;
}

function fixture(options: { board?: KanboardTask[]; ready?: KanboardTask[] } = {}): Fixture {
  let board = options.board ?? [];
  let ready = options.ready ?? [];
  const notices: string[] = [];
  const autoworkOffs: number[] = [];
  let ownerStatus: Fixture["ownerStatus"];
  const clock = { now: 1_000 };
  const deps: MonitorDeps = {
    list: async () => [...board],
    listReady: async () => [...ready],
    session: () => SESSION,
    ownerStatus: () => ownerStatus,
    now: () => clock.now,
    notify: (text) => notices.push(text),
    onAutoworkOff: () => autoworkOffs.push(1),
    cliPrefix: () => "/bin/kb --actor agent --project p",
  };
  const monitor = createKanboardMonitor(deps);
  return {
    board,
    ready,
    notices,
    autoworkOffs,
    get ownerStatus() {
      return ownerStatus;
    },
    set ownerStatus(value: Fixture["ownerStatus"]) {
      ownerStatus = value;
    },
    clock,
    monitor,
    setBoard(tasks: KanboardTask[]) {
      board = tasks;
      ready = tasks.filter((t) => t.status === "todo" && t.ready);
    },
  };
}

test("not armed → null; arm enables the claims nudge", async () => {
  const f = fixture({ board: [claim("UNI-30")] });
  assert.equal(await f.monitor.propose(info()), null);
  f.monitor.arm("do");
  const nudge = await f.monitor.propose(info());
  assert.ok(nudge);
  assert.equal(nudge!.priority, 50);
  assert.equal(nudge!.customType, "unipi:kanboard-continue");
  assert.match(nudge!.content, /↻ UNI-30 still In Progress — continue, or finish\/block it \(1\/5\)/);
  assert.match(nudge!.content, /`\/bin\/kb --actor agent --project p finish UNI-30 --comment "<summary>"`/);
  assert.match(nudge!.content, /move UNI-30 blocked --comment "<what you need>"`/);
  assert.ok(nudge!.content.includes(ANTI_POISONING_SUFFIX));
});

test("a second claim rides along as `also open`", async () => {
  const f = fixture({ board: [claim("UNI-30"), claim("UNI-31")] });
  f.monitor.arm();
  const nudge = await f.monitor.propose(info());
  assert.match(nudge!.content, /↻ UNI-30 still In Progress/);
  assert.match(nudge!.content, /also open: UNI-31/);
});

test("the nudge count grows only on DELIVERY (onDelivered), capped at 5", async () => {
  const f = fixture({ board: [claim("UNI-30")] });
  f.monitor.arm();
  for (let i = 1; i <= MAX_NUDGES_PER_TASK; i += 1) {
    const nudge = await f.monitor.propose(info());
    assert.match(nudge!.content, new RegExp(`\\(${String(i)}/5\\)`), `proposal ${String(i)} shows the count`);
    // The count reflects DELIVERIES only.
    assert.equal(f.monitor.state().nudgesPerTask["UNI-30"] ?? 0, i - 1, "not counted before delivery");
    nudge!.onDelivered?.();
    assert.equal(f.monitor.state().nudgesPerTask["UNI-30"], i);
  }
  // Cap reached: stall notice + disarm.
  assert.equal(await f.monitor.propose(info()), null);
  assert.match(f.notices.at(-1) ?? "", /UNI-30 stalled — nudge cap \(5\) reached/);
  assert.equal(f.monitor.state().armed, false);
});

test("an active long-horizon owner → null (the owner drives)", async () => {
  const f = fixture({ board: [claim("UNI-30")] });
  f.monitor.arm();
  f.ownerStatus = { owner: { kind: "goal", status: "active" } };
  assert.equal(await f.monitor.propose(info()), null);
  assert.deepEqual(f.notices, []);
});

test("an owner that stopped paused/budget this run → notice + disarm; complete keeps nudging", async () => {
  const f = fixture({ board: [claim("UNI-30")] });
  f.monitor.arm();
  f.monitor.onAgentStart(); // runStartedAt = now
  f.ownerStatus = { lastStop: { kind: "paused", at: 1_500 } };
  f.clock.now = 2_000;
  assert.equal(await f.monitor.propose(info()), null);
  assert.match(f.notices.at(-1) ?? "", /goal paused — UNI-30 left In Progress/);
  assert.equal(f.monitor.state().armed, false);

  // complete → kanboard takes over again.
  const f2 = fixture({ board: [claim("UNI-31")] });
  f2.monitor.arm();
  f2.monitor.onAgentStart();
  f2.ownerStatus = { lastStop: { kind: "complete", at: 1_500 } };
  f2.clock.now = 2_000;
  const nudge = await f2.monitor.propose(info());
  assert.ok(nudge, "a completed owner hands continuation back to kanboard");
});

test("a lastStop older than the run is ignored", async () => {
  const f = fixture({ board: [claim("UNI-30")] });
  f.monitor.arm();
  f.monitor.onAgentStart(); // runStartedAt = 1000
  f.ownerStatus = { lastStop: { kind: "paused", at: 500 } };
  const nudge = await f.monitor.propose(info());
  assert.ok(nudge, "an old stop predates this run");
  assert.deepEqual(f.notices, []);
});

test("question heuristic: a final paragraph ending in ? with no tool calls → notice, no count", async () => {
  const f = fixture({ board: [claim("UNI-30")] });
  f.monitor.arm();
  const nudge = await f.monitor.propose(info({ lastAssistantHadToolCalls: false, lastAssistantText: "Progress so far.\n\nShould I drop the table before migrating?" }));
  assert.equal(nudge, null);
  assert.match(f.notices.at(-1) ?? "", /UNI-30 left In Progress — the agent asked you a question/);
  assert.equal(f.monitor.state().nudgesPerTask["UNI-30"], undefined, "questions are not counted");
  assert.equal(f.monitor.state().armed, true, "and the monitor stays armed");
  // A mid-text question does not trigger it.
  const f2 = fixture({ board: [claim("UNI-30")] });
  f2.monitor.arm();
  const nudge2 = await f2.monitor.propose(info({ lastAssistantHadToolCalls: false, lastAssistantText: "Should I? Well, done anyway." }));
  assert.ok(nudge2);
});

test("stall: two consecutive nudged runs with zero tool calls disarm with a warning", async () => {
  const f = fixture({ board: [claim("UNI-30")] });
  f.monitor.arm();
  // A working run is nudged.
  let nudge = await f.monitor.propose(info({ toolCallsThisRun: 2 }));
  nudge!.onDelivered?.();
  // The nudged run starts… and settles without a single tool call: forgiven once.
  f.monitor.onAgentStart();
  nudge = await f.monitor.propose(info({ toolCallsThisRun: 0 }));
  assert.ok(nudge, `one idle nudged run is forgiven (stall ${String(STALL_LIMIT)})`);
  assert.equal(f.monitor.state().noProgressRuns, 1);
  nudge!.onDelivered?.();
  // The second idle nudged run trips the stall guard.
  f.monitor.onAgentStart();
  assert.equal(await f.monitor.propose(info({ toolCallsThisRun: 0 })), null);
  assert.match(f.notices.at(-1) ?? "", /⚠ UNI-30 stalled — no progress after 2 nudges/);
  assert.equal(f.monitor.state().armed, false);
});

test("a productive nudged run resets the stall counter", async () => {
  const f = fixture({ board: [claim("UNI-30")] });
  f.monitor.arm();
  // Nudged, then idle once (counter 1, forgiven with another nudge).
  let nudge = await f.monitor.propose(info({ toolCallsThisRun: 1 }));
  nudge!.onDelivered?.();
  f.monitor.onAgentStart();
  nudge = await f.monitor.propose(info({ toolCallsThisRun: 0 }));
  assert.equal(f.monitor.state().noProgressRuns, 1);
  nudge!.onDelivered?.();
  // The next nudged run DOES work → the counter resets and the monitor stays armed.
  f.monitor.onAgentStart();
  await f.monitor.propose(info({ toolCallsThisRun: 4 }));
  assert.equal(f.monitor.state().noProgressRuns, 0);
  assert.ok(await f.monitor.propose(info({ toolCallsThisRun: 0 })), "still armed, no stall");
});

test("an aborted or errored run disarms", async () => {
  const f = fixture({ board: [claim("UNI-30")] });
  f.monitor.arm();
  f.monitor.onAgentEnd([{ role: "assistant", stopReason: "aborted" }]);
  assert.equal(f.monitor.state().armed, false);
  assert.equal(await f.monitor.propose(info()), null);

  const f2 = fixture({ board: [claim("UNI-30")] });
  f2.monitor.arm();
  f2.monitor.onAgentEnd([{ role: "assistant", stopReason: "error" }]);
  assert.equal(f2.monitor.state().armed, false);

  const f3 = fixture({ board: [claim("UNI-30")] });
  f3.monitor.arm();
  f3.monitor.onAgentEnd([{ role: "assistant", stopReason: "stop" }]);
  assert.equal(f3.monitor.state().armed, true, "a normal end keeps the monitor armed");
});

test("a user prompt naming one of our claims re-arms; other prompts do not", async () => {
  const f = fixture({ board: [claim("UNI-30")] });
  f.monitor.arm();
  f.monitor.onAgentEnd([{ role: "assistant", stopReason: "aborted" }]);
  assert.equal(f.monitor.state().armed, false);
  await f.monitor.onUserPrompt("also look at UNI-99 while you are at it");
  assert.equal(f.monitor.state().armed, false, "an unclaimed id is not a re-arm");
  await f.monitor.onUserPrompt("please continue UNI-30 now");
  assert.equal(f.monitor.state().armed, true, "a claimed id re-arms");
  // Our own nudge texts never re-arm (they name claimed ids).
  await f.monitor.onUserPrompt(`↻ UNI-30 still In Progress — continue ${ANTI_POISONING_SUFFIX}`);
  f.monitor.disarm();
  await f.monitor.onUserPrompt(`↻ UNI-30 still In Progress — continue ${ANTI_POISONING_SUFFIX}`);
  assert.equal(f.monitor.state().armed, false);
});

test("autowork: claims first, then the next ready task; done → notice + off", async () => {
  const f = fixture({ board: [task({ id: "UNI-40", status: "todo", ready: true })], ready: [task({ id: "UNI-40", status: "todo", ready: true })] });
  f.monitor.setAutowork(true);
  f.monitor.arm("autowork");
  // A claim beats autowork-next.
  f.setBoard([claim("UNI-30"), task({ id: "UNI-40", status: "todo", ready: true })]);
  let nudge = await f.monitor.propose(info());
  assert.equal(nudge!.priority, 50);
  assert.equal(nudge!.customType, "unipi:kanboard-continue");
  // Claims gone → the next ready task, priority 40.
  f.setBoard([task({ id: "UNI-40", status: "todo", ready: true })]);
  nudge = await f.monitor.propose(info());
  assert.equal(nudge!.priority, 40);
  assert.equal(nudge!.customType, "unipi:kanboard-next");
  assert.match(nudge!.content, /↻ next ready: UNI-40 /);
  assert.match(nudge!.content, /show it, start it, work it \(autowork\)/);
  // Nothing ready → the done notice, autowork off, disarmed.
  f.setBoard([task({ id: "UNI-9", status: "in_review" }), task({ id: "UNI-8", status: "blocked" })]);
  assert.equal(await f.monitor.propose(info()), null);
  assert.match(f.notices.at(-1) ?? "", /autowork done · 1 in review · 1 blocked/);
  assert.equal(f.monitor.state().autowork, false);
  assert.equal(f.monitor.state().armed, false);
});

test("autowork with nothing ready only fires the done notice once", async () => {
  const f = fixture({ board: [] });
  f.monitor.setAutowork(true);
  f.monitor.arm();
  assert.equal(await f.monitor.propose(info()), null);
  assert.equal(f.notices.length, 1);
  assert.equal(await f.monitor.propose(info()), null, "disarmed — no repeat");
  assert.equal(f.notices.length, 1);
});

test("K1: autowork stall — offered runs that do nothing disarm with a warning", async () => {
  const f = fixture({ ready: [task({ id: "UNI-50", status: "todo", ready: true })] });
  f.monitor.setAutowork(true);
  f.monitor.arm("autowork");
  // The first offer is delivered; the run does nothing (0 tool calls).
  let nudge = await f.monitor.propose(info({ toolCallsThisRun: 1 }));
  nudge!.onDelivered?.();
  f.monitor.onAgentStart();
  nudge = await f.monitor.propose(info({ toolCallsThisRun: 0 }));
  assert.ok(nudge, "one idle offered run is forgiven");
  nudge!.onDelivered?.();
  f.monitor.onAgentStart();
  assert.equal(await f.monitor.propose(info({ toolCallsThisRun: 0 })), null);
  assert.match(f.notices.at(-1) ?? "", /⚠ autowork stalled — no progress after 2 offers/);
  assert.equal(f.monitor.state().armed, false);
  assert.equal(f.monitor.state().autowork, false, "the monitor turned autowork off itself");
  assert.equal(f.autoworkOffs.length, 1, "K2: the guard/holder callback fired");
});

test("K1: the same ready id offered more than ${MAX_OFFERS_PER_TASK} times → stall on it", async () => {
  const f = fixture({ ready: [task({ id: "UNI-51", status: "todo", ready: true })] });
  f.monitor.setAutowork(true);
  f.monitor.arm("autowork");
  for (let i = 1; i <= MAX_OFFERS_PER_TASK; i += 1) {
    const nudge = await f.monitor.propose(info({ toolCallsThisRun: 5 }));
    assert.match(nudge!.content, /next ready: UNI-51 /, `offer ${String(i)}`);
    nudge!.onDelivered?.();
    // Each offered run works, so the stall counter stays at 0 — only the
    // per-task cap can stop it now.
    f.monitor.onAgentStart();
  }
  assert.equal(await f.monitor.propose(info({ toolCallsThisRun: 5 })), null);
  assert.match(f.notices.at(-1) ?? "", /⚠ autowork stalled on UNI-51/);
  assert.equal(f.monitor.state().armed, false);
  assert.equal(f.autoworkOffs.length, 1);
});

test("K2: the autowork-done path calls onAutoworkOff too", async () => {
  const f = fixture({ board: [] });
  f.monitor.setAutowork(true);
  f.monitor.arm();
  assert.equal(await f.monitor.propose(info()), null);
  assert.equal(f.autoworkOffs.length, 1, "done → guard + holder follow");
});

test("K1: a ready task that left the list gets a fresh offer budget", async () => {
  const f = fixture({ ready: [task({ id: "UNI-52", status: "todo", ready: true })] });
  f.monitor.setAutowork(true);
  f.monitor.arm();
  for (let i = 0; i < MAX_OFFERS_PER_TASK; i += 1) {
    const nudge = await f.monitor.propose(info({ toolCallsThisRun: 5 }));
    nudge!.onDelivered?.();
    f.monitor.onAgentStart();
  }
  // The task got started (left ready), then re-queued as ready again — a new
  // offer budget applies.
  f.setBoard([task({ id: "UNI-53", status: "todo", ready: true }), task({ id: "UNI-52", status: "todo", ready: true })]);
  const nudge = await f.monitor.propose(info({ toolCallsThisRun: 5 }));
  assert.match(nudge!.content, /next ready: UNI-53 /, "UNI-52's budget reset, UNI-53 is next");
  assert.equal(f.monitor.state().armed, true);
});

test("board errors → null, never a throw", async () => {
  const monitor = createKanboardMonitor({
    list: async () => {
      throw new Error("binary gone");
    },
    listReady: async () => [],
    session: () => SESSION,
    ownerStatus: () => undefined,
    now: () => 0,
    notify: () => undefined,
    cliPrefix: () => null,
  });
  monitor.arm();
  assert.equal(await monitor.propose(info()), null);
});
