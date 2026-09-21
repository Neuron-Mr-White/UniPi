import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GraphLedger, registerGraphTools, GRAPH_ORCHESTRATION_PROMPT } from "../tools/graph.js";
import { OwnerCoordinator } from "../owner.js";

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "lh-graph-"));
  const owner = new OwnerCoordinator({ statePath: () => join(dir, "owner.json") });
  const ledger = new GraphLedger(owner);
  return { ledger, owner, dir };
}

const DAG = [
  { itemId: "scan-a", instruction: "scan package a" },
  { itemId: "scan-b", instruction: "scan package b" },
  { itemId: "synthesize", instruction: "compare findings", dependsOn: ["scan-a", "scan-b"] },
];

test("declare computes waves, refuses cycles and unknown deps, activates owner", () => {
  const { ledger, owner, dir } = rig();
  const declared = ledger.declare("audit", DAG);
  assert.equal(declared.ok, true);
  if (declared.ok) {
    assert.deepEqual(
      declared.roots.map((root) => root.itemId).sort(),
      ["scan-a", "scan-b"],
    );
  }
  assert.equal(owner.getActive()?.kind, "graph");
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.waves.length, 2);
  assert.deepEqual(snapshot.waves[0]?.map((item) => item.itemId), ["scan-a", "scan-b"]);

  // Declare-time validation is owner-independent: fresh coordinator.
  const fresh = rig();
  const cycle = fresh.ledger.declare("bad", [
    { itemId: "x", dependsOn: ["y"] },
    { itemId: "y", dependsOn: ["x"] },
  ]);
  assert.equal(cycle.ok, false);
  if (!cycle.ok) assert.match(cycle.reason, /cycle/);

  const unknown = fresh.ledger.declare("bad", [{ itemId: "x", dependsOn: ["ghost"] }]);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.reason, /unknown item ghost/);
  rmSync(fresh.dir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

test("input frontiers: completing deps hands downstream items the committed summaries", () => {
  const { ledger, owner, dir } = rig();
  ledger.declare("audit", DAG);
  ledger.markDispatched("scan-a");
  const aDone = ledger.report("scan-a", "completed", "package a clean, 3 findings");
  assert.equal(aDone.ok, true);
  if (aDone.ok) {
    assert.equal(aDone.newlyReady.length, 0); // scan-b still open
    assert.equal(aDone.settled, false);
  }
  ledger.markDispatched("scan-b");
  const bDone = ledger.report("scan-b", "completed", "package b has 1 stale invariant");
  assert.equal(bDone.ok, true);
  if (bDone.ok) {
    assert.equal(bDone.newlyReady.length, 1);
    const handoff = bDone.newlyReady[0];
    assert.equal(handoff.itemId, "synthesize");
    assert.deepEqual(
      handoff.inputs.map((input) => [input.from, input.summary]),
      [
        ["scan-a", "package a clean, 3 findings"],
        ["scan-b", "package b has 1 stale invariant"],
      ],
    );
  }
  ledger.markDispatched("synthesize");
  const done = ledger.report("synthesize", "completed", "final audit report");
  assert.equal(done.ok, true);
  if (done.ok) assert.equal(done.settled, true);
  assert.equal(owner.getActive(), undefined); // auto-closed
  rmSync(dir, { recursive: true, force: true });
});

test("failure blocks dependents until replaced or aborted; abort cascades", () => {
  const { ledger, owner, dir } = rig();
  ledger.declare("audit", DAG);
  ledger.markDispatched("scan-a");
  ledger.report("scan-a", "failed", "provider 500");
  // scan-a can be re-dispatched after failure recorded.
  assert.equal(ledger.markDispatched("scan-a").ok, true);
  // Meanwhile scan-b completes; synthesize stays blocked on scan-a.
  ledger.markDispatched("scan-b");
  const bDone = ledger.report("scan-b", "completed", "ok");
  if (bDone.ok) assert.equal(bDone.newlyReady.length, 0);
  // Abort scan-a cascades to synthesize; graph settles with failures.
  const aborted = ledger.abort("scan-a");
  assert.equal(aborted.ok, true);
  if (aborted.ok) assert.deepEqual(aborted.aborted.sort(), ["scan-a", "synthesize"]);
  assert.equal(owner.getActive(), undefined);
  assert.equal(ledger.snapshot().settled, true);
  rmSync(dir, { recursive: true, force: true });
});

test("only ready items dispatch; terminal re-reports refused", () => {
  const { ledger, dir } = rig();
  ledger.declare("audit", DAG);
  assert.equal(ledger.markDispatched("synthesize").ok, false); // queued, not ready
  ledger.markDispatched("scan-a");
  ledger.report("scan-a", "completed", "ok");
  const dup = ledger.report("scan-a", "completed", "again");
  assert.equal(dup.ok, false);
  rmSync(dir, { recursive: true, force: true });
});

test("graph orchestration prompt carries frontier discipline", () => {
  assert.match(GRAPH_ORCHESTRATION_PROMPT, /input frontiers/);
  assert.match(GRAPH_ORCHESTRATION_PROMPT, /dependencies complete/);
  assert.match(GRAPH_ORCHESTRATION_PROMPT, /restating conclusions|instead of restating/);
});

test("tools register; declare + report flow through the tool surface", async () => {
  const { ledger, owner, dir } = rig();
  const registered: Array<{ name: string; execute: (p: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }> = [];
  const pi = {
    registerTool: (tool: { name: string; execute: (id: string, p: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }) =>
      registered.push({ name: tool.name, execute: (p) => tool.execute("id", p) }),
  } as never;
  registerGraphTools(pi, { ledger });
  assert.deepEqual(
    registered.map((tool) => tool.name).sort(),
    ["graph_output", "update_agent_graph", "view_agent_graph"],
  );

  const declare = await registered.find((tool) => tool.name === "update_agent_graph")!.execute({
    task: "audit",
    items: [
      { item_id: "scan-a", instruction: "scan a" },
      { item_id: "scan-b", instruction: "scan b" },
      { item_id: "synthesize", instruction: "compare", depends_on: ["scan-a", "scan-b"] },
    ],
  });
  assert.match(declare.content[0]?.text ?? "", /Ready now/);
  assert.match(declare.content[0]?.text ?? "", /scan-a/);

  const output = registered.find((tool) => tool.name === "graph_output")!;
  await output.execute({ item_id: "scan-a", status: "completed", summary: "a ok", dispatched: true });
  const handoff = await output.execute({ item_id: "scan-b", status: "completed", summary: "b ok", dispatched: true });
  assert.match(handoff.content[0]?.text ?? "", /inputs:/);
  assert.match(handoff.content[0]?.text ?? "", /\[scan-a\] a ok/);
  const settle = await output.execute({ item_id: "synthesize", status: "completed", summary: "report", dispatched: true });
  assert.match(settle.content[0]?.text ?? "", /Graph settled/);
  assert.equal(owner.getActive(), undefined);
  rmSync(dir, { recursive: true, force: true });
});
