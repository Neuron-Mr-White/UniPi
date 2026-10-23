/**
 * UNI-222: lhProgressSnapshot (pure), the derived log (one truth), the
 * LH_PROGRESS publish through the real ledgers, and the TUI renderer.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { bus, resetBusForTests, UNIPI_EVENTS, type LhProgressEvent } from "@pi-unipi/core";
import { visibleWidth } from "@earendil-works/pi-tui";
import { finishedStatus, lhProgressSnapshot, LOG_MAX, progressLogLines, sameProgress, withProgressLog, type LhProgressInput } from "../progress-snapshot.js";
import { frameWidthOk, progressViewHeight, renderProgressView } from "../progress-view.js";
import { viewHeight } from "../visualize.js";
import { OwnerCoordinator } from "../owner.js";
import { GraphEngine, type GraphState, type WorkStatus } from "../graph/engine.js";

const plain = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

/** Old ledger words → durable work statuses (fixtures stay readable). */
const STATUS: Record<string, WorkStatus> = { queued: "queued", ready: "queued", dispatched: "running", running: "running", completed: "completed", failed: "failed", aborted: "stopped" };

function graphState(
  mode: "graph" | "swarm",
  task: string,
  items: ReadonlyArray<{ itemId: string; instruction: string; dependsOn?: string[]; wave?: number; status?: string; attempts?: number; summary?: string }>,
): GraphState {
  return {
    v: 1,
    graphId: `g-${task}`,
    mode,
    task,
    createdAt: 0,
    revision: 1,
    updatedAt: 0,
    work: items.map((i) => {
      const status = STATUS[i.status ?? "queued"]!;
      return {
        workId: i.itemId,
        instruction: i.instruction,
        target: { kind: "new_preset" as const, subagentId: "subagent_general" },
        inputIds: i.dependsOn ?? [],
        selectedResultInputs: [],
        wave: i.wave ?? 0,
        revision: 1,
        status,
        attempts: i.attempts ?? 0,
        ...(i.summary && status === "completed" ? { result: i.summary, resultId: `r-${i.itemId}` } : {}),
        ...(i.summary && status === "failed" ? { failure: i.summary } : {}),
      };
    }),
  };
}

function graphInput(statuses: Record<string, string> = {}): LhProgressInput {
  const items = [
    { itemId: "a", instruction: "Scan", dependsOn: [] as string[], wave: 0 },
    { itemId: "b", instruction: "List deps", dependsOn: [] as string[], wave: 0 },
    { itemId: "c", instruction: "Merge", dependsOn: ["a", "b"], wave: 1 },
  ];
  return {
    owner: { kind: "graph", label: "Health", status: "active" },
    graph: graphState("graph", "Health", items.map((i) => ({ ...i, status: statuses[i.itemId] ?? "queued" }))),
    now: 1000,
  };
}

beforeEach(() => resetBusForTests());

test("idle: no owner, no history → mode none, no runs", () => {
  const snap = lhProgressSnapshot({ now: 5 });
  assert.deepEqual(snap, { v: 1, mode: "none", log: [], updatedAt: 5 });
});

test("graph: items carry id/label/status/deps/wave; dispatched → running; counts", () => {
  const snap = lhProgressSnapshot(graphInput({ a: "completed", b: "dispatched", c: "queued" }));
  assert.equal(snap.mode, "graph");
  const run = snap.current!;
  assert.equal(run.status, "running");
  assert.deepEqual(run.items.map((i) => [i.id, i.status, i.deps, i.wave]), [
    ["a", "done", [], 0],
    ["b", "running", [], 0],
    ["c", "queued", ["a", "b"], 1],
  ]);
  assert.deepEqual(run.counts, { total: 3, done: 1, running: 1, failed: 0, queued: 1 });
});

test("graph ledger of another task is not shown under this owner", () => {
  const input = graphInput();
  const snap = lhProgressSnapshot({ ...input, graph: { ...input.graph!, task: "Other" } });
  assert.equal(snap.current!.items.length, 0);
});

test("swarm: statuses map, labels clipped to one line", () => {
  const long = "x ".repeat(200);
  const snap = lhProgressSnapshot({
    owner: { kind: "swarm", label: "Review", status: "active" },
    graph: graphState("swarm", "Review", [{ itemId: "s1", instruction: long, status: "failed", attempts: 2, summary: "boom" }, { itemId: "s2", instruction: "ok\nnext", status: "completed", attempts: 1 }]),
    now: 1,
  });
  const [s1, s2] = snap.current!.items;
  assert.equal(s1!.status, "failed");
  assert.ok(s1!.label.length <= 160 && s1!.label.endsWith("…"));
  assert.equal(s2!.label, "ok next");
  assert.equal(snap.current!.counts.failed, 1);
});

test("ralph: checklist rows, the next itemsPerIteration unchecked rows are running, iteration block", () => {
  const snap = lhProgressSnapshot({
    owner: { kind: "ralph-loop", label: "docs", status: "active" },
    ralph: {
      state: { name: "docs", iteration: 3, maxIterations: 10, itemsPerIteration: 2, status: "active" },
      checklist: [{ text: "a", checked: true }, { text: "b", checked: false }, { text: "c", checked: false }, { text: "d", checked: false }],
    },
    now: 1,
  });
  assert.equal(snap.mode, "ralph");
  assert.deepEqual(snap.current!.items.map((i) => i.status), ["done", "running", "running", "queued"]);
  assert.deepEqual(snap.current!.ralph, { name: "docs", iteration: 3, maxIterations: 10, checked: 1, total: 4 });
});

test("goal: percent/summary only from an estimate of THIS goal; complete = 100", () => {
  const base = { owner: { kind: "goal" as const, label: "Ship", status: "active" as const }, goal: { goalId: "g1", objective: "Ship", status: "active" as const, turn: 2, maxTurns: 30 }, now: 1 };
  assert.equal(lhProgressSnapshot(base).current!.goal!.percent, undefined);
  const other = lhProgressSnapshot({ ...base, goalEstimate: { goalId: "g0", percent: 90, summary: "old", at: 0 } });
  assert.equal(other.current!.goal!.percent, undefined);
  const est = lhProgressSnapshot({ ...base, goalEstimate: { goalId: "g1", percent: 40, summary: "half", at: 7 } });
  assert.deepEqual(est.current!.goal, { objective: "Ship", status: "active", turn: 2, maxTurns: 30, percent: 40, summary: "half", estimatedAt: 7 });
  const done = lhProgressSnapshot({ ...base, goal: { ...base.goal, status: "complete" } });
  assert.equal(done.current!.goal!.percent, 100);
});

test("parked owner → current paused, mode none; finished owner → last with status from reason", () => {
  const parked = lhProgressSnapshot({ owner: { kind: "goal", label: "x", status: "parked", reason: "paused(user_requested)" }, now: 1 });
  assert.equal(parked.mode, "none");
  assert.equal(parked.current!.status, "paused");
  assert.equal(parked.current!.reason, "paused(user_requested)");
  const last = lhProgressSnapshot({ finished: { kind: "swarm", label: "R", terminalReason: "settled", endedAt: new Date(50).toISOString() }, now: 99 });
  assert.equal(last.current, undefined);
  assert.deepEqual([last.last!.mode, last.last!.status, last.last!.endedAt], ["swarm", "done", 50]);
  assert.equal(finishedStatus("settled(with_failures)"), "failed");
  assert.equal(finishedStatus("complete(verifier_met)"), "done");
  assert.equal(finishedStatus("stopped(user_requested)"), "stopped");
});

test("log is derived from transitions only: start, item flips, finish", () => {
  const s0 = withProgressLog(undefined, lhProgressSnapshot(graphInput()));
  assert.deepEqual(s0.log.map((l) => l.text), ["Graph started — Health · 3 items in 2 waves"]);
  const s1 = withProgressLog(s0, lhProgressSnapshot({ ...graphInput({ a: "dispatched" }), now: 2000 }));
  assert.deepEqual(s1.log.slice(1).map((l) => [l.text, l.item, l.status]), [["a running", "a", "running"]]);
  // Nothing changed → no new line.
  assert.deepEqual(progressLogLines(s1, lhProgressSnapshot({ ...graphInput({ a: "dispatched" }), now: 3000 })), []);
  // Finish: the last flips are still logged, then the finish line.
  const input = graphInput({ a: "completed", b: "completed", c: "completed" });
  const s2 = withProgressLog(s1, lhProgressSnapshot({ ...input, owner: undefined, finished: { kind: "graph", label: "Health", terminalReason: "settled", endedAt: new Date(4000).toISOString() }, now: 4000 }));
  assert.deepEqual(s2.log.slice(2).map((l) => l.text), ["a done", "b done", "c done", "Graph finished (settled) — 3/3 settled"]);
});

test("log: ralph iteration and goal turn/estimate lines; bounded to LOG_MAX", () => {
  const r = (iteration: number, checked: boolean) =>
    lhProgressSnapshot({
      owner: { kind: "ralph-loop", label: "docs", status: "active" },
      ralph: { state: { name: "docs", iteration, maxIterations: 5, itemsPerIteration: 1, status: "active" }, checklist: [{ text: "a", checked }, { text: "b", checked: false }] },
      now: iteration,
    });
  const lines = progressLogLines(r(1, false), r(2, true)).map((l) => l.text);
  assert.ok(lines.includes("iteration 2/5 · 1/2 checked"), lines.join("|"));
  assert.ok(lines.includes("#1 a done"));
  let ev: LhProgressEvent | undefined;
  for (let i = 0; i < LOG_MAX + 10; i++) ev = withProgressLog(ev, r(i + 1, i % 2 === 0));
  assert.equal(ev!.log.length, LOG_MAX);
});

test("sameProgress ignores updatedAt/log", () => {
  const a = withProgressLog(undefined, lhProgressSnapshot(graphInput()));
  assert.ok(sameProgress(a, lhProgressSnapshot({ ...graphInput(), now: 99 })));
  assert.ok(!sameProgress(a, lhProgressSnapshot(graphInput({ a: "dispatched" }))));
  assert.ok(!sameProgress(undefined, a));
});

test("the durable graph fires onChange on every change (wired to the LH_PROGRESS publish)", () => {
  const dir = mkdtempSync(join(tmpdir(), "lh-progress-"));
  const owner = new OwnerCoordinator({ statePath: () => join(dir, "state.json") });
  let engine!: GraphEngine;
  const publish = () => {
    const active = owner.getActive();
    const prev = bus.get(UNIPI_EVENTS.LH_PROGRESS);
    const next = lhProgressSnapshot({ ...(active ? { owner: active } : {}), ...(owner.snapshot().history[0] ? { finished: owner.snapshot().history[0] } : {}), graph: engine.current() ?? null, graphEngine: engine, now: Date.now() });
    if (!sameProgress(prev, next)) bus.emit(UNIPI_EVENTS.LH_PROGRESS, withProgressLog(prev, next));
  };
  engine = new GraphEngine({
    openOwner: (mode, task) => (owner.activate(mode, task) ? undefined : "busy"),
    closeOwner: (reason) => {
      owner.finish(reason);
      publish();
    },
    canRun: () => owner.getActive() !== undefined,
    onChange: publish,
  });
  engine.wakeDelayMs = 0;
  engine.bind(join(dir, "graph.json"));
  let n = 0;
  engine.setRunner({ start: () => ({ operatorId: `op${++n}` }), stop: () => undefined });
  engine.update({ mode: "graph", task: "Health", addWork: [{ workId: "a", instruction: "Scan" }, { workId: "c", instruction: "Merge", inputIds: ["a"] }] });
  assert.equal(bus.get(UNIPI_EVENTS.LH_PROGRESS)?.current?.items.length, 2);
  assert.equal(bus.get(UNIPI_EVENTS.LH_PROGRESS)?.current?.items[0]?.status, "running");
  assert.deepEqual(bus.get(UNIPI_EVENTS.LH_PROGRESS)?.current?.items[1]?.deps, ["a"]);
  const graphId = engine.current()!.graphId;
  engine.settle(graphId, "a", { status: "completed", text: "found 3" });
  engine.settle(graphId, "c", { status: "completed", text: "merged" });
  engine.update({ mode: "graph", finish: { resultIds: ["r-c"], reason: "done" } });
  const final = bus.get(UNIPI_EVENTS.LH_PROGRESS)!;
  assert.equal(final.current, undefined);
  assert.equal(final.last?.status, "done");
  assert.deepEqual(final.last?.items.map((i) => i.summary), ["found 3", "merged"]);
  assert.ok(final.log.some((l) => l.text.startsWith("Graph finished")));
  engine.dispose();
});

// ── renderer ────────────────────────────────────────────────────────────────

const running = withProgressLog(withProgressLog(undefined, lhProgressSnapshot(graphInput())), lhProgressSnapshot({ ...graphInput({ a: "completed", b: "dispatched" }), now: 2000 }));

test("view: every line is exactly the frame width; height is fixed", () => {
  for (const width of [40, 64, 100, 160]) {
    const h = progressViewHeight(running, width, 40);
    const lines = renderProgressView(plain, running, width, h, 3000);
    assert.equal(lines.length, h);
    assert.ok(frameWidthOk(lines, width), `width ${width}: ${lines.map((l) => visibleWidth(l)).join(",")}`);
  }
});

test("view: layout never moves while state changes (only glyphs/words differ)", () => {
  const later = withProgressLog(running, lhProgressSnapshot({ ...graphInput({ a: "completed", b: "completed", c: "dispatched" }), now: 2500 }));
  const h = progressViewHeight(running, 100, 40);
  assert.equal(progressViewHeight(later, 100, 40), h, "height depends on structure, not state");
  const a = renderProgressView(plain, running, 100, h, 3000);
  const b = renderProgressView(plain, later, 100, h, 3000);
  // Box corners stay at the same coordinates.
  const corners = (lines: string[]) => lines.flatMap((l, y) => [...l].flatMap((ch, x) => (ch === "┌" || ch === "┘" ? [`${x},${y}`] : [])));
  assert.deepEqual(corners(a), corners(b));
});

test("view: graph draws wave columns, item boxes and dependency arrows", () => {
  const text = renderProgressView(plain, running, 100, 30, 3000).join("\n");
  assert.match(text, /wave 1 {2}1\/2/);
  assert.match(text, /wave 2 {2}0\/1/);
  assert.match(text, /┌─ a ─/);
  assert.match(text, /▶│/, "arrow into the dependent box");
  assert.match(text, /a done/, "log line from the same state");
  assert.match(text, /Graph · running/);
  assert.match(text, /1\/3 · 1 done · 1 running · 1 waiting/);
});

test("view: running item spins (frame differs over time), settled items don't", () => {
  const f1 = renderProgressView(plain, running, 100, 30, 0);
  const f2 = renderProgressView(plain, running, 100, 30, 450);
  assert.notDeepEqual(f1, f2);
  const done = lhProgressSnapshot({ finished: { kind: "graph", label: "Health", terminalReason: "settled", endedAt: new Date(0).toISOString() }, graph: graphInput({ a: "completed", b: "completed", c: "completed" }).graph, now: 0 });
  const g1 = renderProgressView(plain, done, 100, 30, 100_000);
  const g2 = renderProgressView(plain, done, 100, 30, 100_450);
  assert.deepEqual(g1, g2);
});

test("view: idle shows 'no long-horizon mode active' and the last run when any", () => {
  const none = renderProgressView(plain, undefined, 60, 12, 0).join("\n");
  assert.match(none, /No long-horizon mode active/);
  const last = lhProgressSnapshot({ finished: { kind: "swarm", label: "Review", terminalReason: "settled(with_failures)", endedAt: new Date(0).toISOString() }, now: 0 });
  const text = renderProgressView(plain, last, 110, 20, 120_000).join("\n");
  assert.match(text, /No long-horizon mode active/);
  assert.match(text, /last run · ended 2m ago · settled\(with_failures\)/);
  assert.match(text, /Swarm · last run · failed/);
});

test("view: ralph checklist + iteration bar; goal % bar + turns + estimate", () => {
  const ralph = lhProgressSnapshot({
    owner: { kind: "ralph-loop", label: "docs", status: "active" },
    ralph: { state: { name: "docs", iteration: 2, maxIterations: 5, itemsPerIteration: 1, status: "active" }, checklist: [{ text: "Write intro", checked: true }, { text: "Fix links", checked: false }] },
    now: 0,
  });
  const r = renderProgressView(plain, ralph, 80, progressViewHeight(ralph, 80, 40), 0).join("\n");
  assert.match(r, /iteration 2 of 5  ·  1 of 2 checked/);
  assert.match(r, /✓ {2}Write intro/);
  const goal = lhProgressSnapshot({
    owner: { kind: "goal", label: "Ship", status: "active" },
    goal: { goalId: "g", objective: "Ship the parser", status: "active", turn: 4, maxTurns: 30 },
    goalEstimate: { goalId: "g", percent: 55, summary: "Parser done; tests left.", at: 0 },
    now: 0,
  });
  const g = renderProgressView(plain, goal, 80, progressViewHeight(goal, 80, 40), 30_000).join("\n");
  assert.match(g, /~55%/);
  assert.match(g, /turn 4 of 30/);
  assert.match(g, /\(30s ago\)/);
  assert.match(g, /Parser done; tests left\./);
});

test("view: many items degrade to '+N more' instead of overflowing", () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ itemId: `i${i}`, instruction: `task ${i}`, dependsOn: [] as string[], wave: 0, status: "queued" as const, attempts: 0 }));
  const snap = lhProgressSnapshot({ owner: { kind: "graph", label: "Big", status: "active" }, graph: graphState("graph", "Big", items), now: 0 });
  const lines = renderProgressView(plain, snap, 90, 30, 0);
  assert.equal(lines.length, 30);
  assert.ok(frameWidthOk(lines, 90));
  assert.match(lines.join("\n"), /\+\d+ more/);
});

test("viewHeight clamps to the terminal", () => {
  assert.equal(viewHeight(24), 22);
  assert.equal(viewHeight(200), 48);
  assert.equal(viewHeight(5), 8);
});
