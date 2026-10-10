/**
 * UNI-222: long-horizon progress over the bridge — hello.lhProgress, the
 * coalesced `lh_progress` push on LH_PROGRESS, and `lh_progress_get` —
 * against a fake pi over a real unix socket and the real core bus.
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "app-bridge-lhp-"));
process.env.UNIPI_BRIDGE_DIR = dir;
const { createBridge } = await import("../src/bridge.js");
const { bus, resetBusForTests, UNIPI_EVENTS } = await import("@pi-unipi/core");
const { parseIn } = await import("../src/wire.js");

type Handler = (event: any, ctx: any) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  let idle = true;
  const branch: any[] = [
    { type: "session", id: "h" },
    { type: "message", id: "m1", message: { role: "user", content: "hello" } },
    {
      type: "message",
      id: "m2",
      message: { role: "assistant", content: [{ type: "text", text: "hi!" }], usage: { cost: { total: 0.01 }, input: 100, output: 50, cacheRead: 20 } },
    },
  ];
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
    isIdle: () => idle,
    abort: () => (idle = true),
    getContextUsage: () => ({ tokens: 1000, contextWindow: 10000, percent: 10 }),
    compact: () => {},
  };
  const pi = {
    on: (name: string, h: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), h]);
      return () => {};
    },
    sendUserMessage: () => {},
    registerCommand: (name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => commands.set(name, options),
    getCommands: () => [],
    getSessionName: () => "cc session",
    setSessionName: () => {},
    getThinkingLevel: () => "medium",
    setThinkingLevel: () => {},
    setModel: async () => true,
  };
  const emit = async (name: string, event: any = {}) => {
    for (const h of handlers.get(name) ?? []) await h(event, ctx);
  };
  return { pi, ctx, emit, branch };
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
      const timer = setTimeout(() => reject(new Error("timeout waiting for message; got " + JSON.stringify(msgs.map((m) => m.t)))), ms);
      waiters.push({ pred, resolve: (m) => (clearTimeout(timer), msgs.splice(msgs.indexOf(m), 1), resolve(m)) });
    });
  const send = (m: object) => sock.write(JSON.stringify(m) + "\n");
  return { sock, next, send };
}

const snap = (done: number, updatedAt: number) => ({
  v: 1 as const,
  mode: "graph" as const,
  current: {
    mode: "graph",
    title: "Health",
    status: "running",
    items: [
      { id: "a", label: "Scan", status: done > 0 ? "done" : "running", deps: [], wave: 0 },
      { id: "b", label: "Merge", status: "queued", deps: ["a"], wave: 1 },
    ],
    counts: { total: 2, done, running: done > 0 ? 0 : 1, failed: 0, queued: 1 },
  },
  log: [{ at: updatedAt, text: "a running", item: "a", status: "running" }],
  updatedAt,
});

describe("parseIn lh_progress_get", () => {
  it("parses with and without ref", () => {
    assert.deepEqual(parseIn('{"t":"lh_progress_get","ref":"x"}'), { t: "lh_progress_get", ref: "x" });
    assert.deepEqual(parseIn('{"t":"lh_progress_get"}'), { t: "lh_progress_get", ref: undefined });
  });
});

describe("UNI-222 lh_progress", () => {
  let f: ReturnType<typeof fakePi>;
  let bridge: ReturnType<typeof createBridge>;
  let c: ReturnType<typeof client>;

  before(async () => {
    resetBusForTests();
    f = fakePi();
    bridge = createBridge(f.pi as never, { listSessions: async () => [], listAllSessions: async () => [] });
    await f.emit("session_start", { reason: "startup" });
    const sockPath = join(dir, `${process.pid}.sock`);
    for (let i = 0; i < 50 && !existsSync(join(dir, `${process.pid}.json`)); i++) await new Promise((r) => setTimeout(r, 20));
    c = client(sockPath);
  });

  after(() => {
    c?.sock.destroy();
    bridge._debug.close();
    resetBusForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it("hello has no lhProgress before long-horizon publishes; lh_progress_get answers undefined", async () => {
    const hello = await c.next((m) => m.t === "hello");
    assert.equal("lhProgress" in hello, false);
    c.send({ t: "lh_progress_get", ref: "g0" });
    const reply = await c.next((m) => m.t === "lh_progress" && m.ref === "g0");
    assert.equal(reply.progress, undefined);
  });

  it("LH_PROGRESS changes push one coalesced lh_progress with the latest snapshot", async () => {
    bus.emit(UNIPI_EVENTS.LH_PROGRESS, snap(0, 1) as never);
    bus.emit(UNIPI_EVENTS.LH_PROGRESS, snap(1, 2) as never);
    const push = await c.next((m) => m.t === "lh_progress");
    assert.equal(push.ref, undefined);
    assert.deepEqual(push.progress, snap(1, 2));
    await new Promise((r) => setTimeout(r, 400));
    await assert.rejects(c.next((m) => m.t === "lh_progress", 50), /timeout/, "two emits inside the window → one push");
  });

  it("lh_progress_get replies with the sticky snapshot to the asking socket only", async () => {
    c.send({ t: "lh_progress_get", ref: "g1" });
    const reply = await c.next((m) => m.t === "lh_progress" && m.ref === "g1");
    assert.deepEqual(reply.progress, snap(1, 2));
  });

  it("a fresh hello carries lhProgress", async () => {
    c.send({ t: "resync" });
    const hello = await c.next((m) => m.t === "hello");
    assert.deepEqual(hello.lhProgress, snap(1, 2));
  });
});
