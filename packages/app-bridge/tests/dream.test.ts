/**
 * UNI-118: Dream over the bridge — hello.dream, dream_get, dream_detail,
 * dream_action (run/stop/approve/reject/dismiss) and the coalesced
 * dream_status push — against a fake pi + a fake dream API on globalThis.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "app-bridge-dream-"));
process.env.UNIPI_BRIDGE_DIR = dir;
const { createBridge } = await import("../src/bridge.js");
const { resetBusForTests } = await import("@pi-unipi/core");
const { parseIn } = await import("../src/wire.js");

type Handler = (event: any, ctx: any) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const branch: any[] = [{ type: "session", id: "h" }];
  const model = { provider: "p", id: "m", name: "M", reasoning: false };
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
    getContextUsage: () => ({ tokens: 1, contextWindow: 10, percent: 10 }),
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
    getThinkingLevel: () => "off",
    setThinkingLevel: () => {},
    setModel: async () => true,
  };
  const emit = async (name: string, event: any = {}) => {
    for (const h of handlers.get(name) ?? []) await h(event, ctx);
  };
  return { pi, emit };
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
      const timer = setTimeout(() => reject(new Error("timeout; got " + JSON.stringify(msgs.map((m) => m.t)))), ms);
      waiters.push({ pred, resolve: (m) => (clearTimeout(timer), msgs.splice(msgs.indexOf(m), 1), resolve(m)) });
    });
  const send = (m: object) => sock.write(JSON.stringify(m) + "\n");
  return { sock, next, send };
}

/** A fake @pi-unipi/dream controller. */
function fakeDream() {
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  const status = {
    v: 1 as const,
    enabled: false,
    minSessions: 5,
    minGapHours: 12,
    lastRunAt: 0,
    running: false,
    runs: [] as any[],
  };
  const emit = () => listeners.forEach((l) => l());
  const api = {
    status: () => structuredClone(status),
    detail: (id: string) => (id === "staging-1" ? { id, report: "# Dream\n## Memory edits\n- a", steps: [{ kind: "tool", text: "read x" }], log: ["ok"] } : undefined),
    run: () => {
      calls.push("run");
      if (status.running) return { ok: false, message: "A dream is already running (pid 1)." };
      status.running = true;
      status.runs.unshift({ id: "staging-1", status: "running", startedAt: 1, manual: true, sessions: 2, events: 3, pending: 0, hasReport: false, proposals: [] });
      emit();
      return { ok: true, message: "started" };
    },
    stop: (id?: string) => (calls.push(`stop:${id ?? ""}`), { ok: true, message: "stopped" }),
    approve: (r: string, p: string) => (calls.push(`approve:${r}:${p}`), { ok: false, message: "Approval failed (not recorded): FAIL" }),
    reject: (r: string, p: string) => (calls.push(`reject:${r}:${p}`), { ok: true, message: "Rejected" }),
    dismiss: (r: string) => (calls.push(`dismiss:${r}`), { ok: true, message: "Dismissed" }),
    subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
  };
  return { api, calls, status, listeners };
}

const KEY = Symbol.for("unipi.dream.api");

describe("parseIn dream_*", () => {
  it("parses dream_get / dream_detail / dream_action and rejects bad ones", () => {
    assert.deepEqual(parseIn('{"t":"dream_get","ref":"r"}'), { t: "dream_get", ref: "r" });
    assert.deepEqual(parseIn('{"t":"dream_detail","id":"staging-1"}'), { t: "dream_detail", id: "staging-1", ref: undefined });
    assert.ok("bad" in (parseIn('{"t":"dream_detail"}') as object));
    assert.deepEqual(parseIn('{"t":"dream_action","action":"run"}'), { t: "dream_action", action: "run", ref: undefined });
    assert.deepEqual(parseIn('{"t":"dream_action","action":"approve","id":"s","proposal":"s/p"}'), { t: "dream_action", action: "approve", id: "s", proposal: "s/p", ref: undefined });
    assert.ok("bad" in (parseIn('{"t":"dream_action","action":"approve","id":"s"}') as object));
    assert.ok("bad" in (parseIn('{"t":"dream_action","action":"dismiss"}') as object));
    assert.ok("bad" in (parseIn('{"t":"dream_action","action":"explode"}') as object));
  });
});

describe("bridge without the dream module", () => {
  let f: ReturnType<typeof fakePi>;
  let bridge: ReturnType<typeof createBridge>;
  let c: ReturnType<typeof client>;
  before(async () => {
    delete (globalThis as any)[KEY];
    resetBusForTests();
    f = fakePi();
    bridge = createBridge(f.pi as never, { listSessions: async () => [], listAllSessions: async () => [] });
    await f.emit("session_start", { reason: "startup" });
    for (let i = 0; i < 50 && !existsSync(join(dir, `${process.pid}.json`)); i++) await new Promise((r) => setTimeout(r, 20));
    c = client(join(dir, `${process.pid}.sock`));
  });
  after(async () => {
    c.sock.destroy();
    bridge._debug.close();
    await f.emit("session_shutdown", { reason: "quit" });
  });

  it("hello has no dream; dream_get answers undefined; actions answer error", async () => {
    const hello = await c.next((m) => m.t === "hello");
    assert.equal("dream" in hello, false);
    c.send({ t: "dream_get", ref: "g" });
    const r = await c.next((m) => m.t === "dream_status" && m.ref === "g");
    assert.equal(r.status, undefined);
    c.send({ t: "dream_action", action: "run", ref: "a" });
    const e = await c.next((m) => m.t === "error" && m.ref === "a");
    assert.match(e.message, /not installed/);
  });
});

describe("bridge with the dream module", () => {
  let f: ReturnType<typeof fakePi>;
  let bridge: ReturnType<typeof createBridge>;
  let c: ReturnType<typeof client>;
  let d: ReturnType<typeof fakeDream>;
  before(async () => {
    d = fakeDream();
    (globalThis as any)[KEY] = d.api;
    resetBusForTests();
    f = fakePi();
    bridge = createBridge(f.pi as never, { listSessions: async () => [], listAllSessions: async () => [] });
    await f.emit("session_start", { reason: "startup" });
    for (let i = 0; i < 50 && !existsSync(join(dir, `${process.pid}.json`)); i++) await new Promise((r) => setTimeout(r, 20));
    c = client(join(dir, `${process.pid}.sock`));
  });
  after(async () => {
    c.sock.destroy();
    bridge._debug.close();
    await f.emit("session_shutdown", { reason: "quit" });
    delete (globalThis as any)[KEY];
    resetBusForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it("hello carries dream status; the bridge subscribed to changes", async () => {
    const hello = await c.next((m) => m.t === "hello");
    assert.equal(hello.dream.enabled, false);
    assert.deepEqual(hello.dream.runs, []);
    assert.equal(d.listeners.size, 1);
  });

  it("dream_action run → ack + one coalesced dream_status push with the running run", async () => {
    c.send({ t: "dream_action", action: "run", ref: "r1" });
    await c.next((m) => m.t === "ack" && m.ref === "r1");
    const push = await c.next((m) => m.t === "dream_status" && !m.ref);
    assert.equal(push.status.running, true);
    assert.equal(push.status.runs[0].id, "staging-1");
    await assert.rejects(c.next((m) => m.t === "dream_status" && !m.ref, 400), /timeout/, "same status → no second push");
    c.send({ t: "dream_action", action: "run", ref: "r2" });
    const e = await c.next((m) => m.t === "error" && m.ref === "r2");
    assert.match(e.message, /already running/);
  });

  it("dream_detail returns report + trajectory; unknown id → error", async () => {
    c.send({ t: "dream_detail", id: "staging-1", ref: "d1" });
    const r = await c.next((m) => m.t === "dream_detail" && m.ref === "d1");
    assert.match(r.detail.report, /Memory edits/);
    assert.deepEqual(r.detail.steps, [{ kind: "tool", text: "read x" }]);
    c.send({ t: "dream_detail", id: "nope", ref: "d2" });
    await c.next((m) => m.t === "error" && m.ref === "d2");
  });

  it("stop / reject / dismiss forward ids; a failed approve answers error with the reason", async () => {
    c.send({ t: "dream_action", action: "stop", id: "staging-1", ref: "s" });
    await c.next((m) => m.t === "ack" && m.ref === "s");
    c.send({ t: "dream_action", action: "reject", id: "staging-1", proposal: "staging-1/p", ref: "x" });
    await c.next((m) => m.t === "ack" && m.ref === "x");
    c.send({ t: "dream_action", action: "approve", id: "staging-1", proposal: "staging-1/p", ref: "a" });
    const e = await c.next((m) => m.t === "error" && m.ref === "a");
    assert.match(e.message, /Approval failed/);
    c.send({ t: "dream_action", action: "dismiss", id: "staging-1", ref: "dd" });
    await c.next((m) => m.t === "ack" && m.ref === "dd");
    assert.deepEqual(d.calls.slice(-4), ["stop:staging-1", "reject:staging-1:staging-1/p", "approve:staging-1:staging-1/p", "dismiss:staging-1"]);
  });
});
