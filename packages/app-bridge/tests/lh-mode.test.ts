/**
 * UNI-269: the long-horizon working mode over the bridge — hello.lhMode, the
 * coalesced change-only `lh_mode` push on LH_STATE, and `set_lh_mode` through
 * long-horizon's `unipi:lh-mode` command runner — against a fake pi over a
 * real unix socket and the real core bus.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "app-bridge-lhm-"));
process.env.UNIPI_BRIDGE_DIR = dir;
const { createBridge, LH_MODE_RUNNER, recordLhMode } = await import("../src/bridge.js");
const { readFileSync } = await import("node:fs");
const { bus, resetBusForTests, resetCommandRunners, registerCommandRunner, UNIPI_EVENTS } = await import("@pi-unipi/core");
const { parseIn } = await import("../src/wire.js");

type Handler = (event: any, ctx: any) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const branch: any[] = [{ type: "session", id: "h" }];
  const model = { provider: "p", id: "m", name: "Model M", reasoning: true };
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: { notify: () => {} },
    cwd: "/tmp/proj",
    model,
    scopedModels: [],
    modelRegistry: { getAvailable: () => [model], find: () => undefined },
    sessionManager: {
      getSessionFile: () => "/tmp/proj/s.jsonl",
      getSessionId: () => "sid",
      getBranch: () => branch,
      getEntries: () => branch,
      getLeafEntry: () => branch.at(-1),
      getLeafId: () => branch.at(-1)?.id ?? null,
      getTree: () => [],
    },
    isIdle: () => true,
    abort: () => {},
    getContextUsage: () => ({ tokens: 1000, contextWindow: 10000, percent: 10 }),
    compact: () => {},
  };
  const pi = {
    on: (name: string, h: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), h]);
      return () => {};
    },
    sendUserMessage: () => {},
    registerCommand: () => {},
    getCommands: () => [],
    getSessionName: () => "s",
    setSessionName: () => {},
    getThinkingLevel: () => "medium",
    setThinkingLevel: () => {},
    setModel: async () => true,
  };
  const emit = async (name: string, event: any = {}) => {
    for (const h of handlers.get(name) ?? []) await h(event, ctx);
  };
  return { pi, ctx, emit };
}

function client(path: string) {
  const sock: Socket = connect(path);
  sock.setEncoding("utf8");
  const msgs: any[] = [];
  let buf = "";
  const waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
  sock.on("data", (chunk: string) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      msgs.push(m);
      for (const w of [...waiters]) if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  });
  const next = (pred: (m: any) => boolean, ms = 3000) =>
    new Promise<any>((resolve, reject) => {
      const found = msgs.find(pred);
      if (found) {
        msgs.splice(msgs.indexOf(found), 1);
        return resolve(found);
      }
      const waiter = { pred, resolve: (m: any) => (clearTimeout(timer), msgs.splice(msgs.indexOf(m), 1), resolve(m)) };
      // A timed-out waiter must not linger and swallow a later message.
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error("timeout waiting for message; got " + JSON.stringify(msgs.map((m) => m.t))));
      }, ms);
      waiters.push(waiter);
    });
  const send = (m: object) => sock.write(JSON.stringify(m) + "\n");
  return { sock, next, send };
}

describe("parseIn set_lh_mode", () => {
  it("accepts the five modes and refuses anything else", () => {
    for (const mode of ["goal", "ralph", "swarm", "graph", "none"]) {
      assert.deepEqual(parseIn(JSON.stringify({ t: "set_lh_mode", mode, ref: "r" })), { t: "set_lh_mode", mode, ref: "r" });
    }
    assert.deepEqual(parseIn('{"t":"set_lh_mode","mode":"plan","ref":"r"}'), { bad: "set_lh_mode.mode must be goal|ralph|swarm|graph|none", ref: "r" });
    assert.deepEqual(parseIn('{"t":"set_lh_mode","ref":"r"}'), { bad: "set_lh_mode.mode must be goal|ralph|swarm|graph|none", ref: "r" });
  });
});

describe("recordLhMode", () => {
  it("maps LH_STATE onto the discovery record's lhMode/lhPaused", () => {
    assert.deepEqual(recordLhMode(undefined), { lhMode: null, lhPaused: null });
    assert.deepEqual(recordLhMode({ mode: "none" }), { lhMode: null, lhPaused: null });
    assert.deepEqual(recordLhMode({ mode: "graph" }), { lhMode: "graph", lhPaused: null });
    assert.deepEqual(recordLhMode({ mode: "none", paused: "goal" }), { lhMode: null, lhPaused: "goal" });
    assert.deepEqual(recordLhMode({ mode: "swarm", paused: "goal" }), { lhMode: "swarm", lhPaused: "goal" });
  });
});

describe("UNI-269 lh_mode", () => {
  let f: ReturnType<typeof fakePi>;
  let bridge: ReturnType<typeof createBridge>;
  let c: ReturnType<typeof client>;

  before(async () => {
    resetBusForTests();
    resetCommandRunners();
    f = fakePi();
    bridge = createBridge(f.pi as never, { listSessions: async () => [], listAllSessions: async () => [] });
    await f.emit("session_start", { reason: "startup" });
    for (let i = 0; i < 50 && !existsSync(join(dir, `${process.pid}.json`)); i++) await new Promise((r) => setTimeout(r, 20));
    c = client(join(dir, `${process.pid}.sock`));
  });

  after(() => {
    c?.sock.destroy();
    bridge._debug.close();
    resetBusForTests();
    resetCommandRunners();
    rmSync(dir, { recursive: true, force: true });
  });

  it("hello has no lhMode before long-horizon publishes", async () => {
    const hello = await c.next((m) => m.t === "hello");
    assert.equal("lhMode" in hello, false);
  });

  it("set_lh_mode without long-horizon answers a plain error", async () => {
    c.send({ t: "set_lh_mode", mode: "graph", ref: "s0" });
    const err = await c.next((m) => m.t === "error" && m.ref === "s0");
    assert.match(err.message, /newer unipi/);
  });

  it("LH_STATE changes push one coalesced lh_mode; a same-value republish pushes nothing", async () => {
    bus.emit(UNIPI_EVENTS.LH_STATE, { mode: "none" });
    bus.emit(UNIPI_EVENTS.LH_STATE, { mode: "graph", owner: { kind: "graph", status: "active" } });
    const push = await c.next((m) => m.t === "lh_mode");
    assert.deepEqual(push.mode, { mode: "graph", owner: { kind: "graph", status: "active" } });
    await new Promise((r) => setTimeout(r, 350));
    await assert.rejects(c.next((m) => m.t === "lh_mode", 50), /timeout/, "two emits inside the window → one push");
    bus.emit(UNIPI_EVENTS.LH_STATE, { mode: "graph", owner: { kind: "graph", status: "active" } });
    await new Promise((r) => setTimeout(r, 350));
    await assert.rejects(c.next((m) => m.t === "lh_mode", 50), /timeout/, "unchanged → no push");
  });

  it("set_lh_mode calls the runner with the mode, acks, and pushes the fresh mode", async () => {
    const calls: unknown[] = [];
    registerCommandRunner(LH_MODE_RUNNER, async (_ctx, args) => {
      calls.push(args);
      bus.emit(UNIPI_EVENTS.LH_STATE, { mode: "swarm", paused: "graph", owner: { kind: "graph", status: "parked" } });
      return { ok: true, mode: "swarm" };
    });
    c.send({ t: "set_lh_mode", mode: "swarm", ref: "s1" });
    await c.next((m) => m.t === "ack" && m.ref === "s1");
    const push = await c.next((m) => m.t === "lh_mode");
    assert.deepEqual(push.mode, { mode: "swarm", paused: "graph", owner: { kind: "graph", status: "parked" } });
    assert.deepEqual(calls, [{ mode: "swarm" }]);
    const record = JSON.parse(readFileSync(join(dir, `${process.pid}.json`), "utf8"));
    assert.equal(record.lhMode, "swarm", "the discovery record carries the mode for chat_list");
    assert.equal(record.lhPaused, "graph");
    await new Promise((r) => setTimeout(r, 350));
    await assert.rejects(c.next((m) => m.t === "lh_mode", 50), /timeout/, "the coalesced push is not repeated");
  });

  it("a refusing runner surfaces its reason as error", async () => {
    registerCommandRunner(LH_MODE_RUNNER, async () => ({ ok: false, reason: "A graph is already parked — resume or clear it first." }));
    c.send({ t: "set_lh_mode", mode: "goal", ref: "s2" });
    const err = await c.next((m) => m.t === "error" && m.ref === "s2");
    assert.equal(err.message, "A graph is already parked — resume or clear it first.");
  });

  it("a fresh hello carries lhMode", async () => {
    c.send({ t: "resync" });
    const hello = await c.next((m) => m.t === "hello");
    assert.deepEqual(hello.lhMode, { mode: "swarm", paused: "graph", owner: { kind: "graph", status: "parked" } });
  });
});
