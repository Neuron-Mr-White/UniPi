import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GraphEngine, HANDOFF_MAX_CONCLUSION_BYTES, OPERATOR_HANDOFF_PROTOCOL, type Checkpoint, type GraphRunner, type WorkOutcome } from "../graph/engine.js";
import { GRAPH_ORCHESTRATION_PROMPT, SWARM_ORCHESTRATION_PROMPT, registerGraphTools } from "../tools/graph.js";
import { OwnerCoordinator } from "../owner.js";

interface Started {
  graphId: string;
  workId: string;
  task: string;
  subagentId: string;
  resumeOperatorId?: string;
  operatorId: string;
}

/** Fake runner: records starts, refuses past `capacity`, completes on demand. */
function fakeRunner(capacity = 16) {
  const started: Started[] = [];
  const stopped: string[] = [];
  let next = 0;
  const running = new Set<string>();
  const runner: GraphRunner = {
    start(request) {
      if (running.size >= capacity) return { error: "Maximum concurrent subagents running", retryable: true };
      next += 1;
      const operatorId = request.resumeOperatorId ?? `op${next}`;
      running.add(operatorId);
      started.push({ ...request, operatorId });
      return { operatorId };
    },
    stop(operatorId) {
      stopped.push(operatorId);
      running.delete(operatorId);
    },
  };
  return { runner, started, stopped, release: (operatorId: string) => running.delete(operatorId) };
}

function rig(options: { capacity?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lh-graph-"));
  const owner = new OwnerCoordinator({ statePath: () => join(dir, "owner.json") });
  const checkpoints: Checkpoint[] = [];
  const engine = new GraphEngine({
    openOwner: (mode, task) => {
      const active = owner.getActive();
      if (active) return active.kind === mode ? undefined : `owned by ${active.kind}`;
      return owner.activate(mode, task) ? undefined : "could not open";
    },
    closeOwner: (reason) => {
      const kind = owner.getActive()?.kind;
      if (kind === "graph" || kind === "swarm") owner.finish(reason);
    },
    canRun: () => owner.getActive()?.kind === "graph" || owner.getActive()?.kind === "swarm",
    onCheckpoint: (c) => checkpoints.push(c),
  });
  engine.wakeDelayMs = 0;
  engine.retryDelayMs = 0;
  const path = join(dir, "graph.json");
  engine.bind(path);
  const fake = fakeRunner(options.capacity);
  engine.setRunner(fake.runner);
  const complete = (workId: string, text = `${workId} done`, status: WorkOutcome["status"] = "completed") => {
    const graph = engine.current()!;
    const work = graph.work.find((w) => w.workId === workId)!;
    fake.release(work.operatorId!);
    engine.settle(graph.graphId, workId, { status, text, ...(status === "failed" ? { error: text } : {}) });
  };
  return { dir, path, owner, engine, checkpoints, complete, ...fake };
}

const DAG = [
  { workId: "scan-a", instruction: "scan package a" },
  { workId: "scan-b", instruction: "scan package b", target: { kind: "new_preset" as const, subagentId: "subagent_explore" } },
  { workId: "synthesize", instruction: "compare findings", inputIds: ["scan-a", "r-scan-b"] },
];

test("add_work opens a graph + owner, starts roots, waits dependents, computes waves", () => {
  const r = rig();
  const res = r.engine.update({ mode: "graph", task: "audit", addWork: DAG });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.opened, true);
  assert.deepEqual(res.started, ["scan-a", "scan-b"]);
  assert.equal(r.owner.getActive()?.kind, "graph");
  const graph = r.engine.current()!;
  assert.deepEqual(graph.work.map((w) => [w.workId, w.status, w.wave]), [["scan-a", "running", 0], ["scan-b", "running", 0], ["synthesize", "queued", 1]]);
  assert.equal(r.started[1]?.subagentId, "subagent_explore");
  assert.equal(r.started[0]?.subagentId, "subagent_general");
  assert.match(r.started[0]!.task, /agent_graph_handoff_protocol/);
  rmSync(r.dir, { recursive: true, force: true });
});

test("validation: unknown input, cycle, self-dependency, reserved id, finish+add_work — nothing opened", () => {
  const r = rig();
  const bad = [
    [{ workId: "a", instruction: "x", inputIds: ["nope"] }],
    [{ workId: "a", instruction: "x", inputIds: ["b"] }, { workId: "b", instruction: "y", inputIds: ["a"] }],
    [{ workId: "a", instruction: "x", inputIds: ["a"] }],
    [{ workId: "r-a", instruction: "x" }],
    [{ workId: "a", instruction: "  " }],
  ];
  for (const addWork of bad) {
    const res = r.engine.update({ mode: "graph", addWork });
    assert.equal(res.ok, false, JSON.stringify(addWork));
  }
  assert.equal(r.owner.getActive(), undefined);
  assert.equal(r.engine.current(), undefined);
  const both = r.engine.update({ mode: "graph", addWork: [{ instruction: "x" }], finish: { resultIds: ["r-x"], reason: "y" } });
  assert.equal(both.ok, false);
  rmSync(r.dir, { recursive: true, force: true });
});

test("completion commits a result, hands bounded upstream conclusions to dependents", () => {
  const r = rig();
  r.engine.update({ mode: "graph", task: "audit", addWork: DAG });
  r.complete("scan-a", "A found 3 issues");
  assert.equal(r.started.length, 2, "synthesize still waits for scan-b");
  r.complete("scan-b", "B".repeat(HANDOFF_MAX_CONCLUSION_BYTES + 500));
  const synth = r.started.find((s) => s.workId === "synthesize")!;
  assert.ok(synth);
  assert.match(synth.task, /### Input r-scan-a \(work scan-a\)\nA found 3 issues/);
  assert.match(synth.task, /\[…truncated\]/);
  assert.match(synth.task, /compare findings/);
  const graph = r.engine.current()!;
  assert.equal(graph.work[0]?.resultId, "r-scan-a");
  rmSync(r.dir, { recursive: true, force: true });
});

test("failure blocks dependents and wakes once with needs_attention; replace unblocks", () => {
  const r = rig();
  r.engine.update({ mode: "graph", task: "audit", addWork: DAG });
  r.complete("scan-a");
  r.complete("scan-b", "network down", "failed");
  const graph = r.engine.current()!;
  const synth = graph.work.find((w) => w.workId === "synthesize")!;
  assert.equal(r.engine.viewStatus(graph, synth), "blocked");
  assert.equal(r.checkpoints.length, 1);
  assert.equal(r.checkpoints[0]?.kind, "needs_attention");
  assert.deepEqual([...r.checkpoints[0]!.attention].sort(), ["scan-b", "synthesize"]);
  const replaced = r.engine.update({ mode: "graph", addWork: [{ workId: "scan-b2", instruction: "scan package b again", replaces: "scan-b" }] });
  assert.equal(replaced.ok, true);
  assert.equal(graph.work.find((w) => w.workId === "scan-b")?.status, "superseded");
  assert.equal(r.engine.viewStatus(graph, synth), "queued", "input follows the supersession chain");
  r.complete("scan-b2", "B ok");
  assert.ok(r.started.some((s) => s.workId === "synthesize"));
  assert.match(r.started.find((s) => s.workId === "synthesize")!.task, /B ok/);
  rmSync(r.dir, { recursive: true, force: true });
});

test("settled wakes once; finish requires committed results and closes graph + owner", () => {
  const r = rig();
  r.engine.update({ mode: "graph", task: "audit", addWork: DAG });
  r.complete("scan-a");
  r.complete("scan-b");
  assert.equal(r.checkpoints.length, 0, "no wake while work keeps flowing");
  const early = r.engine.update({ mode: "graph", finish: { resultIds: ["r-synthesize"], reason: "done" } });
  assert.equal(early.ok, false, "synthesize is not committed yet");
  r.complete("synthesize", "final report");
  assert.equal(r.checkpoints.length, 1);
  assert.equal(r.checkpoints[0]?.kind, "settled");
  assert.match(r.checkpoints[0]!.text, /r-synthesize/);
  assert.equal(r.owner.getActive()?.kind, "graph", "nothing runnable is not done");
  const fin = r.engine.update({ mode: "graph", finish: { resultIds: ["r-synthesize"], reason: "report ready" } });
  assert.equal(fin.ok, true);
  assert.equal(r.owner.getActive(), undefined);
  assert.equal(r.owner.snapshot().history[0]?.terminalReason, "complete(finish)");
  assert.equal(r.engine.open(), undefined);
  assert.deepEqual(r.engine.current()?.finish?.resultIds, ["r-synthesize"]);
  rmSync(r.dir, { recursive: true, force: true });
});

test("stop cancels queued work and stops running children", () => {
  const r = rig();
  r.engine.update({ mode: "graph", task: "audit", addWork: DAG });
  const res = r.engine.update({ mode: "graph", stop: [{ targetId: "scan-a", reason: "obsolete" }, { targetId: "synthesize", reason: "not needed" }] });
  assert.equal(res.ok, true);
  const graph = r.engine.current()!;
  assert.equal(graph.work.find((w) => w.workId === "scan-a")?.status, "stopped");
  assert.equal(graph.work.find((w) => w.workId === "synthesize")?.status, "cancelled");
  assert.deepEqual(r.stopped, ["op1"]);
  rmSync(r.dir, { recursive: true, force: true });
});

test("follow-up on an existing operator resumes its session after it settles", () => {
  const r = rig();
  r.engine.update({ mode: "graph", task: "t", addWork: [{ workId: "draft", instruction: "write draft" }] });
  r.engine.update({ mode: "graph", addWork: [{ workId: "polish", instruction: "polish it", target: { kind: "existing_operator", operatorId: "op1" } }] });
  assert.equal(r.started.length, 1, "operator busy: follow-up queues behind it");
  r.complete("draft");
  const polish = r.started.find((s) => s.workId === "polish")!;
  assert.equal(polish.resumeOperatorId, "op1");
  rmSync(r.dir, { recursive: true, force: true });
});

test("capacity refusal leaves work queued; the next settle admits it", () => {
  const r = rig({ capacity: 1 });
  r.engine.update({ mode: "swarm", task: "s", addWork: [{ workId: "a", instruction: "a" }, { workId: "b", instruction: "b" }] });
  assert.deepEqual(r.started.map((s) => s.workId), ["a"]);
  r.complete("a");
  assert.deepEqual(r.started.map((s) => s.workId), ["a", "b"]);
  rmSync(r.dir, { recursive: true, force: true });
});

test("durable: state survives a rebind; interrupted running work resumes once in its session", () => {
  const r = rig();
  r.engine.update({ mode: "graph", task: "audit", addWork: DAG });
  r.complete("scan-a", "A ok");
  const saved = JSON.parse(readFileSync(r.path, "utf8"));
  assert.equal(saved.current.work[0].result, "A ok");

  // "Restart": a fresh engine on the same file + owner.
  const fresh = rig();
  const owner2 = new OwnerCoordinator({ statePath: () => join(r.dir, "owner.json") });
  owner2.restore();
  const engine2 = new GraphEngine({
    openOwner: () => undefined,
    closeOwner: () => undefined,
    canRun: () => owner2.getActive()?.kind === "graph",
  });
  engine2.bind(r.path);
  const g2 = engine2.current()!;
  const b = g2.work.find((w) => w.workId === "scan-b")!;
  assert.equal(b.status, "queued");
  assert.equal(b.resumeOperatorId, "op2");
  engine2.setRunner(fresh.runner);
  engine2.reconcile();
  assert.equal(fresh.started[0]?.workId, "scan-b");
  assert.equal(fresh.started[0]?.resumeOperatorId, "op2");
  assert.match(fresh.started[0]!.task, /interrupted by a restart/);

  // A second interruption fails it instead of looping.
  const engine3 = new GraphEngine({ openOwner: () => undefined, closeOwner: () => undefined, canRun: () => true });
  engine3.bind(r.path);
  assert.equal(engine3.current()!.work.find((w) => w.workId === "scan-b")?.status, "failed");
  rmSync(r.dir, { recursive: true, force: true });
  rmSync(fresh.dir, { recursive: true, force: true });
});

test("history: a new graph archives the finished one; selected_result_inputs reuse its results", () => {
  const r = rig();
  r.engine.update({ mode: "graph", task: "first", addWork: [{ workId: "a", instruction: "a" }] });
  r.complete("a", "first result");
  const first = r.engine.current()!.graphId;
  r.engine.update({ mode: "graph", finish: { resultIds: ["r-a"], reason: "ok" } });
  const unselected = r.engine.update({ mode: "graph", task: "second", addWork: [{ instruction: "x", selectedResultInputs: [{ sourceGraphId: first, resultId: "r-zzz" }] }] });
  assert.equal(unselected.ok, false);
  const res = r.engine.update({ mode: "graph", task: "second", addWork: [{ workId: "b", instruction: "use it", selectedResultInputs: [{ sourceGraphId: first, resultId: "r-a" }] }] });
  assert.equal(res.ok, true);
  assert.equal(r.engine.history()[0]?.graphId, first);
  const started = r.started.find((s) => s.workId === "b")!;
  assert.match(started.task, new RegExp(`graph ${first}`));
  assert.match(started.task, /first result/);
  assert.equal(r.engine.readResult("r-a", first)?.work.result, "first result");
  rmSync(r.dir, { recursive: true, force: true });
});

test("abandon (owner stopped) closes the graph and stops running children", () => {
  const r = rig();
  r.engine.update({ mode: "graph", task: "audit", addWork: DAG });
  r.engine.abandon("owner stopped(user_requested)");
  const graph = r.engine.current()!;
  assert.equal(graph.abandoned?.reason, "owner stopped(user_requested)");
  assert.deepEqual(r.stopped.sort(), ["op1", "op2"]);
  assert.equal(r.engine.open(), undefined);
  rmSync(r.dir, { recursive: true, force: true });
});

test("prompts follow Maka: yield, no polling, finish selects results, small requests may skip", () => {
  for (const prompt of [GRAPH_ORCHESTRATION_PROMPT, SWARM_ORCHESTRATION_PROMPT]) {
    assert.match(prompt, /yield_agent_graph/);
    assert.match(prompt, /update_agent_graph/);
    assert.match(prompt, /continue directly when the request is small/);
    assert.match(prompt, /do not call run_subagent/i);
  }
  assert.match(SWARM_ORCHESTRATION_PROMPT, /agent_swarm_status/);
  assert.match(SWARM_ORCHESTRATION_PROMPT, /Do not manufacture parallelism/);
  assert.match(OPERATOR_HANDOFF_PROTOCOL, /Outcome, Findings, Evidence/);
});

test("tool surface: register, add_work, view, swarm status, output, yield terminates, finish", async () => {
  const r = rig();
  const tools: Record<string, (p: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean; terminate?: boolean }>> = {};
  const pi = { registerTool: (tool: { name: string; execute: (id: string, p: unknown) => Promise<never> }) => (tools[tool.name] = (p) => tool.execute("id", p)) } as never;
  registerGraphTools(pi, { engine: r.engine, mode: () => "swarm", profiles: () => ["subagent_general", "subagent_explore"] });
  assert.deepEqual(Object.keys(tools).sort(), ["agent_output", "agent_swarm_status", "update_agent_graph", "view_agent_graph", "yield_agent_graph"]);

  const badProfile = await tools.update_agent_graph!({ operation: "add_work", add_work: [{ instruction: "x", profile: "nope" }] });
  assert.equal(badProfile.isError, true);
  const ambiguous = await tools.update_agent_graph!({});
  assert.equal(ambiguous.isError, true);
  // operation omitted (live models do this): inferred from the one field set.
  const add = await tools.update_agent_graph!({
    task: "review",
    add_work: [{ work_id: "a", instruction: "review a", profile: "subagent_explore" }, { work_id: "b", instruction: "review b" }],
  });
  assert.match(add.content[0]!.text, /Opened swarm .* "review"/);
  assert.match(add.content[0]!.text, /Started now: a, b/);
  assert.equal(r.owner.getActive()?.kind, "swarm");

  const y = await tools.yield_agent_graph!({});
  assert.equal(y.terminate, true);

  r.complete("a", "A report");
  r.complete("b", "boom", "failed");
  const status = JSON.parse((await tools.agent_swarm_status!({})).content[0]!.text);
  assert.equal(status.status, "settled");
  assert.deepEqual(status.items.map((i: { status: string }) => i.status), ["completed", "failed"]);
  const view = JSON.parse((await tools.view_agent_graph!({})).content[0]!.text);
  assert.equal(view.work[0].result_id, "r-a");
  assert.equal(view.work[0].operator_id, "op1");
  const out = await tools.agent_output!({ id: "r-a" });
  assert.match(out.content[0]!.text, /A report/);
  const fail = await tools.agent_output!({ id: "b" });
  assert.match(fail.content[0]!.text, /Failure: boom/);

  const noYield = await tools.yield_agent_graph!({});
  assert.equal(noYield.isError, true, "nothing in flight: yield refused");
  const fin = await tools.update_agent_graph!({ operation: "finish", finish: { result_ids: ["r-a"], reason: "a is enough" } });
  assert.match(fin.content[0]!.text, /finished with 1 selected result/);
  assert.equal(r.owner.getActive(), undefined);
  rmSync(r.dir, { recursive: true, force: true });
});

test("without a runner the tools refuse clearly", async () => {
  const r = rig();
  r.engine.setRunner(undefined);
  let update: ((p: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>) | undefined;
  const pi = { registerTool: (tool: { name: string; execute: (id: string, p: unknown) => Promise<never> }) => { if (tool.name === "update_agent_graph") update = (p) => tool.execute("id", p); } } as never;
  registerGraphTools(pi, { engine: r.engine, mode: () => "graph", profiles: () => [] });
  const res = await update!({ operation: "add_work", add_work: [{ instruction: "x" }] });
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /subagents are not loaded/);
  rmSync(r.dir, { recursive: true, force: true });
});

test("shutdown freezes: late cancellations don't settle; the next bind resumes the work", () => {
  const r = rig();
  r.engine.update({ mode: "graph", task: "audit", addWork: DAG });
  r.engine.shutdown();
  const graph = r.engine.current()!;
  r.engine.settle(graph.graphId, "scan-a", { status: "cancelled", text: "" });
  assert.equal(graph.work.find((w) => w.workId === "scan-a")?.status, "running", "frozen: cancellation ignored");
  r.engine.bind(r.path);
  const again = r.engine.current()!.work.find((w) => w.workId === "scan-a")!;
  assert.equal(again.status, "queued");
  assert.equal(again.resumeOperatorId, "op1");
  rmSync(r.dir, { recursive: true, force: true });
});
