import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bus, isUnipiEventName, resetBusForTests, type FusionStatusEvent, type UnipiEventName, type WorkflowStatusEvent } from "./bus.js";
import { UNIPI_EVENTS } from "./events.js";

/**
 * Bus test notes:
 * - Test 7 uses the raw globalThis holder instead of a double import via
 *   `./bus.ts?copy=2`: tsx mangles query-string specifiers (ERR_MODULE_NOT_FOUND),
 *   so the singleton is asserted through Symbol.for("unipi.bus") directly.
 * - Test 3 documents that emitting `undefined` on a sticky key still stores the
 *   key (sticky.has(key) stays true), so a late subscriber IS replayed — with
 *   undefined. Callers that want "cleared, not replayed" semantics must wait
 *   for the next real value.
 */

function fakePi() {
  const handlers: Record<string, Array<(event?: unknown) => void>> = {};
  const pi = {
    on: (event: string, handler: (event?: unknown) => void) => {
      (handlers[event] ??= []).push(handler);
      return () => {};
    },
  } as unknown as Pick<ExtensionAPI, "on">;
  return { pi, handlers };
}

beforeEach(() => resetBusForTests());

test("one-shot: listener receives payload; get() undefined; late subscriber gets no replay", () => {
  const { pi } = fakePi();
  const got: Array<{ name: string }> = [];
  bus.on(pi, UNIPI_EVENTS.MODULE_READY, (p) => got.push(p));

  bus.emit(UNIPI_EVENTS.MODULE_READY, { name: "@unipi/workflow", version: "3.0.0", commands: ["x"], tools: [] });
  assert.deepEqual(got, [{ name: "@unipi/workflow", version: "3.0.0", commands: ["x"], tools: [] }]);

  assert.equal(bus.get(UNIPI_EVENTS.MODULE_READY), undefined, "one-shot keys are never stored");

  const late: unknown[] = [];
  bus.on(pi, UNIPI_EVENTS.MODULE_READY, (p) => late.push(p));
  assert.equal(late.length, 0, "no replay for one-shot keys");
});

test("sticky: get returns last; late subscriber replayed once synchronously; later emits delivered", () => {
  const { pi } = fakePi();
  const first: WorkflowStatusEvent = { planMode: true, permissionMode: "auto" };
  bus.emit(UNIPI_EVENTS.WORKFLOW_STATUS, first);
  assert.deepEqual(bus.get(UNIPI_EVENTS.WORKFLOW_STATUS), first);

  bus.emit(UNIPI_EVENTS.WORKFLOW_STATUS, { planMode: true, permissionMode: "full" });
  bus.emit(UNIPI_EVENTS.WORKFLOW_STATUS, { planMode: false, permissionMode: "ask" });

  const seen: WorkflowStatusEvent[] = [];
  bus.on(pi, UNIPI_EVENTS.WORKFLOW_STATUS, (p) => seen.push(p));
  assert.deepEqual(seen, [{ planMode: false, permissionMode: "ask" }], "replayed exactly once with latest value, synchronously in on()");
  assert.deepEqual(bus.get(UNIPI_EVENTS.WORKFLOW_STATUS), { planMode: false, permissionMode: "ask" });

  bus.emit(UNIPI_EVENTS.WORKFLOW_STATUS, { planMode: false, permissionMode: null });
  assert.deepEqual(seen, [{ planMode: false, permissionMode: "ask" }, { planMode: false, permissionMode: null }]);
});

test("sticky undefined (FUSION_STATUS): get undefined, listeners called with undefined, late subscriber replayed with undefined", () => {
  const { pi } = fakePi();
  const got: Array<FusionStatusEvent | undefined> = [];
  bus.on(pi, UNIPI_EVENTS.FUSION_STATUS, (p) => got.push(p));

  bus.emit(UNIPI_EVENTS.FUSION_STATUS, undefined);
  assert.equal(bus.get(UNIPI_EVENTS.FUSION_STATUS), undefined);
  assert.deepEqual(got, [undefined], "listeners called with undefined");

  // Documented: the key is still present after an undefined emit (Map.set stores
  // the value), so a late subscriber IS replayed — with undefined. Only a
  // session_shutdown (or resetBusForTests) removes the key entirely.
  const lateGot: Array<FusionStatusEvent | undefined> = [];
  bus.on(pi, UNIPI_EVENTS.FUSION_STATUS, (p) => lateGot.push(p));
  assert.deepEqual(lateGot, [undefined], "late subscriber replayed with undefined because sticky.has(key)");
});

test("throwing listener is isolated: second listener still called, emit does not throw", () => {
  const { pi } = fakePi();
  const seen: string[] = [];
  bus.on(pi, UNIPI_EVENTS.SKILLS_REVEAL, () => {
    throw new Error("boom");
  });
  bus.on(pi, UNIPI_EVENTS.SKILLS_REVEAL, (p) => seen.push((p as { names: string[] }).names.join(",")));

  assert.doesNotThrow(() => bus.emit(UNIPI_EVENTS.SKILLS_REVEAL, { names: ["kanboard"] }));
  assert.deepEqual(seen, ["kanboard"], "second listener unaffected by the first one throwing");

  // Same isolation for the synchronous replay path of sticky keys.
  const seen2: string[] = [];
  bus.on(pi, UNIPI_EVENTS.KANBOARD_STATUS, () => {
    throw new Error("boom");
  });
  bus.on(pi, UNIPI_EVENTS.KANBOARD_STATUS, (p) => seen2.push(`autowork=${p.autowork}`));
  assert.doesNotThrow(() => bus.emit(UNIPI_EVENTS.KANBOARD_STATUS, { claims: [], autowork: true }));
  assert.deepEqual(seen2, ["autowork=true"]);
});

test("unsubscribe works, including unsubscribing inside its own callback during emit", () => {
  const { pi } = fakePi();
  const seen: string[] = [];
  const off = bus.on(pi, UNIPI_EVENTS.MODULE_READY, () => {
    seen.push("a");
    off();
  });
  bus.on(pi, UNIPI_EVENTS.MODULE_READY, () => seen.push("b"));

  bus.emit(UNIPI_EVENTS.MODULE_READY, { name: "m", version: "1", commands: [], tools: [] });
  assert.deepEqual(seen, ["a", "b"], "unsubscribed-inside-callback listener still ran for this emit");

  bus.emit(UNIPI_EVENTS.MODULE_READY, { name: "m", version: "1", commands: [], tools: [] });
  assert.deepEqual(seen, ["a", "b", "b"], "self-unsubscribed listener is gone for later emits");
});

test("session_shutdown: removes that pi's listeners, clears all sticky values, one handler per pi", () => {
  const a = fakePi();
  const b = fakePi();
  const aSeen: string[] = [];
  const bSeen: string[] = [];

  bus.on(a.pi, UNIPI_EVENTS.LH_STATE, (p) => aSeen.push(`lh:${(p as { mode: string }).mode}`));
  bus.on(a.pi, UNIPI_EVENTS.KANBOARD_STATUS, (p) => aSeen.push(`kb:${(p as { autowork: boolean }).autowork}`));
  bus.on(b.pi, UNIPI_EVENTS.LH_STATE, (p) => bSeen.push(`lh:${(p as { mode: string }).mode}`));

  assert.equal(a.handlers.session_shutdown?.length, 1, "many listeners on one pi register exactly ONE session_shutdown handler");
  assert.equal(b.handlers.session_shutdown?.length, 1);

  bus.emit(UNIPI_EVENTS.LH_STATE, { mode: "exec" });
  bus.emit(UNIPI_EVENTS.KANBOARD_STATUS, { claims: ["c1"], autowork: false });
  assert.deepEqual(aSeen, ["lh:exec", "kb:false"]);
  assert.deepEqual(bSeen, ["lh:exec"]);
  assert.deepEqual(bus.get(UNIPI_EVENTS.LH_STATE), { mode: "exec" });

  for (const h of a.handlers.session_shutdown ?? []) h({ type: "session_shutdown", reason: "new" });

  assert.equal(bus.get(UNIPI_EVENTS.LH_STATE), undefined, "sticky cleared on shutdown");
  assert.equal(bus.get(UNIPI_EVENTS.KANBOARD_STATUS), undefined, "sticky cleared on shutdown");
  assert.equal(bus.get(UNIPI_EVENTS.FUSION_STATUS), undefined, "ALL sticky cleared, even keys piA never touched");

  bus.emit(UNIPI_EVENTS.LH_STATE, { mode: "plan" });
  assert.deepEqual(aSeen, ["lh:exec", "kb:false"], "piA listeners removed by shutdown");
  assert.deepEqual(bSeen, ["lh:exec", "lh:plan"], "piB listener still fires");
});

test("singleton: holder lives on globalThis under Symbol.for('unipi.bus'); emits visible through the raw holder", () => {
  bus.emit(UNIPI_EVENTS.KANBOARD_STATUS, { claims: ["x"], autowork: true });

  const raw = (globalThis as Record<symbol, { sticky: Map<string, unknown> } | undefined>)[Symbol.for("unipi.bus")];
  assert.ok(raw, "bus holder must exist on globalThis under Symbol.for('unipi.bus')");
  assert.deepEqual(raw.sticky.get(UNIPI_EVENTS.KANBOARD_STATUS), { claims: ["x"], autowork: true });

  raw.sticky.set(UNIPI_EVENTS.KANBOARD_STATUS, { claims: [], autowork: false });
  assert.deepEqual(bus.get(UNIPI_EVENTS.KANBOARD_STATUS), { claims: [], autowork: false }, "writes through the raw holder are visible via bus.get()");

  resetBusForTests();
  assert.equal(bus.get(UNIPI_EVENTS.KANBOARD_STATUS), undefined, "resetBusForTests swaps in a fresh holder");
});

test("isUnipiEventName: true for known event names, false for foreign ones", () => {
  assert.equal(isUnipiEventName("unipi:module:ready"), true);
  assert.equal(isUnipiEventName("unipi:skills:reveal"), true, "existing literal-string event is a valid bus name");
  assert.equal(isUnipiEventName("unipi:long-horizon:state"), true);
  assert.equal(isUnipiEventName("herdr:blocked"), false);
  assert.equal(isUnipiEventName(""), false);

  const name: string = "unipi:workflow:start";
  if (isUnipiEventName(name)) {
    const _narrowed: UnipiEventName = name;
    void _narrowed;
  } else {
    assert.fail("known name should narrow");
  }
});
