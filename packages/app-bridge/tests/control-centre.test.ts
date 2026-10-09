/**
 * UNI-160 "session control centre": fusion get/apply/push, the work list
 * (bg tasks + subagents + sidekick) + log paging + stop, and stats/info
 * watch — against a fake pi over a real unix socket, with fake producers
 * published on globalThis the same way the real packages do.
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "app-bridge-cc-"));
process.env.UNIPI_BRIDGE_DIR = dir;
const { createBridge } = await import("../src/bridge.js");

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

// ── fake producers, published the same way the real packages do ──────────

function fakeFusionApi(picker: unknown, applyResult: { ok: true } | { ok: false; message: string } = { ok: true }) {
  const api = {
    getPicker: () => picker,
    apply: async (_result: unknown) => applyResult,
  };
  (globalThis as any)[Symbol.for("unipi.fusion.api")] = api;
  return api;
}

function fakeBgRegistry() {
  const tasks = new Map<string, any>();
  const registry = {
    allTasks: () => [...tasks.values()],
    snapshot: (t: any) => ({ ...t }),
    resolveTask: (id: string) => {
      const t = tasks.get(id);
      if (!t) throw new Error(`Unknown background task ID: ${id}`);
      return t;
    },
    stopTask: async (t: any) => {
      t.status = "killed";
      return t;
    },
    getTaskLogs: async (t: any, maxBytes: number, _tail: boolean) => {
      const full = t.log ?? "";
      const truncated = full.length > maxBytes;
      const text = truncated ? full.slice(-maxBytes) : full;
      return { text, details: { truncated } };
    },
  };
  (globalThis as any)[Symbol.for("unipi.background-tasks.shared-registry")] = registry;
  return { registry, tasks };
}

function fakeSubagents() {
  const records = new Map<string, any>();
  const manager = {
    run: (id: string) => (records.get(id)?.status === "running" ? {} : undefined),
    cancel: (id: string) => {
      const r = records.get(id);
      if (!r || r.status !== "running") return false;
      r.status = "cancelled";
      return true;
    },
    setBackground: (id: string, bg: boolean) => {
      const r = records.get(id);
      if (r) r.background = bg;
    },
  };
  (globalThis as any)[Symbol.for("unipi.subagents.shared-manager")] = manager;
  (globalThis as any)[Symbol.for("unipi.subagents.shared-list")] = () => [...records.values()];
  return { manager, records };
}

function fakeInfoRegistry() {
  const registry = {
    getAllGroups: () => [{ id: "session", name: "Session" }],
    getGroupData: async () => ({ turns: { value: "3" }, cost: { value: "$0.01" } }),
    getVisibleStats: () => [{ id: "turns", label: "Turns" }, { id: "cost", label: "Cost" }],
  };
  (globalThis as any).__unipi_info_registry = registry;
  return registry;
}

function fakeTps(value: number) {
  (globalThis as any)[Symbol.for("unipi.footer.shared-tps")] = { getSessionAvgTps: () => value };
}

function clearGlobals() {
  delete (globalThis as any)[Symbol.for("unipi.fusion.api")];
  delete (globalThis as any)[Symbol.for("unipi.background-tasks.shared-registry")];
  delete (globalThis as any)[Symbol.for("unipi.subagents.shared-manager")];
  delete (globalThis as any)[Symbol.for("unipi.subagents.shared-list")];
  delete (globalThis as any).__unipi_info_registry;
  delete (globalThis as any)[Symbol.for("unipi.footer.shared-tps")];
}

describe("UNI-160 control centre: fusion / work / stats / info", () => {
  let f: ReturnType<typeof fakePi>;
  let bridge: ReturnType<typeof createBridge>;
  let c: ReturnType<typeof client>;

  before(async () => {
    clearGlobals();
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
    clearGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    clearGlobals();
  });

  it("hello.fusion is undefined when Fusion isn't installed, and hello.work is empty", async () => {
    const hello = await c.next((m) => m.t === "hello");
    assert.equal(hello.fusion, undefined);
    assert.deepEqual(hello.work, []);
  });

  it("set_fusion with an unknown picker fails cleanly (no Fusion installed)", async () => {
    c.send({ t: "set_fusion", single: "p/m", effort: "high", ref: "sf1" });
    const err = await c.next((m) => m.t === "error" && m.ref === "sf1");
    assert.match(err.message, /not installed/);
  });

  it("set_fusion single: forwards to the Fusion API's apply() and pushes state with the fusion preset (UNI-176)", async () => {
    fakeFusionApi({ leads: [], sidekicks: [], default: {}, effort: {}, active: undefined });
    c.send({ t: "set_fusion", single: "p/m", effort: "high", ref: "sf2" });
    assert.deepEqual(await c.next((m) => m.t === "ack" && m.ref === "sf2"), { t: "ack", ref: "sf2" });
    const state = await c.next((m) => m.t === "state");
    assert.ok(state.fusion, "the state push after set_fusion carries the fusion preset");
  });

  it("set_fusion fusion pair: an apply() failure surfaces as an error", async () => {
    fakeFusionApi({ leads: [], sidekicks: [], default: {}, effort: {}, active: undefined }, { ok: false, message: "lead unavailable" });
    c.send({ t: "set_fusion", lead: "p/lead", sidekick: "p/side", leadEffort: "high", sidekickEffort: "low", ref: "sf3" });
    const err = await c.next((m) => m.t === "error" && m.ref === "sf3");
    assert.equal(err.message, "lead unavailable");
  });

  it("resync's hello.fusion reflects the fake picker once Fusion is installed", async () => {
    fakeFusionApi({
      leads: [{ key: "p/lead", name: "Lead" }],
      sidekicks: [{ key: "p/side", name: "Side" }],
      default: { lead: "p/lead", sidekick: "p/side" },
      effort: { "p/lead": "high" },
      active: { kind: "fusion", lead: "p/lead", sidekick: "p/side", leadEffort: "high", sidekickEffort: "low" },
    });
    c.send({ t: "resync" });
    const hello = await c.next((m) => m.t === "hello");
    assert.deepEqual(hello.fusion.leads, [{ key: "p/lead", name: "Lead" }]);
    assert.equal(hello.fusion.active.kind, "fusion");
  });

  it("fusion push: FUSION_STATUS changes reach the phone as t:'fusion'", async () => {
    const { bus, UNIPI_EVENTS } = await import("@pi-unipi/core");
    bus.emit(UNIPI_EVENTS.FUSION_STATUS, {
      leadName: "Lead", leadKey: "p/lead", sidekickKey: "p/side", leadEffort: "high", sidekickName: "Side", sidekickEffort: "low", busy: true,
    } as never);
    const msg = await c.next((m) => m.t === "fusion");
    assert.equal(msg.status.leadName, "Lead");
    assert.equal(msg.status.busy, true);
    bus.emit(UNIPI_EVENTS.FUSION_STATUS, undefined as never);
    const cleared = await c.next((m) => m.t === "fusion");
    assert.equal(cleared.status, undefined);
  });

  it("UNI-212: leaving Fusion (FUSION_STATUS cleared / a model_select) pushes a state with the fresh preset, so the phone stops marking Fusion current", async () => {
    const { bus, UNIPI_EVENTS } = await import("@pi-unipi/core");
    const picker: any = { leads: [], sidekicks: [], default: {}, effort: {}, active: { kind: "fusion", lead: "p/lead", sidekick: "p/side" } };
    fakeFusionApi(picker);
    picker.active = { kind: "single", model: "p/m" };
    bus.emit(UNIPI_EVENTS.FUSION_STATUS, undefined as never);
    const state = await c.next((m) => m.t === "state" && m.fusion);
    assert.deepEqual(state.fusion.active, { kind: "single", model: "p/m" });
    picker.active = { kind: "single", model: "q/n" };
    await f.emit("model_select", { model: { provider: "q", id: "n" } });
    const again = await c.next((m) => m.t === "state" && m.fusion?.active?.model === "q/n");
    assert.equal(again.fusion.active.kind, "single");
  });

  it("UNI-212: no Fusion installed — a model_select state push carries no fusion key", async () => {
    delete (globalThis as any)[Symbol.for("unipi.fusion.api")];
    await f.emit("model_select", { model: { provider: "q", id: "n" } });
    const state = await c.next((m) => m.t === "state");
    assert.equal("fusion" in state, false);
  });

  it("work list: bg tasks + subagents + sidekick merge into one list, running pinned first", async () => {
    const { tasks } = fakeBgRegistry();
    tasks.set("b1", { id: "b1", name: "build", command: "npm run build", status: "completed", startTime: 1000, endTime: 2000, log: "done\n" });
    tasks.set("b2", { id: "b2", name: "watch", command: "npm run watch", status: "running", startTime: 5000, log: "watching\n" });
    const { records } = fakeSubagents();
    records.set("a1", { id: "a1", title: "explorer", status: "failed", startedAt: 500, endedAt: 900, error: "boom", background: false });
    c.send({ t: "resync" });
    const hello = await c.next((m) => m.t === "hello");
    const ids = hello.work.map((w: any) => w.id);
    assert.deepEqual(ids, ["bg-b2", "bg-b1", "agent-a1"]);
    assert.equal(hello.work[0].dot, "running");
    assert.equal(hello.work.find((w: any) => w.id === "bg-b1").dot, "done");
    assert.equal(hello.work.find((w: any) => w.id === "agent-a1").dot, "failed");
  });

  it("work_log: pages a bg task's output, tail-first, and errors on an unknown id", async () => {
    const { tasks } = fakeBgRegistry();
    tasks.set("b3", { id: "b3", name: "logtask", command: "echo", status: "running", startTime: 1000, log: "line one\nline two\n" });
    c.send({ t: "work_log", id: "bg-b3", ref: "wl1" });
    const page = await c.next((m) => m.t === "work_log" && m.ref === "wl1");
    assert.match(page.text, /line two/);
    assert.equal(page.more, false);

    c.send({ t: "work_log", id: "bg-nope", ref: "wl2" });
    const err = await c.next((m) => m.t === "error" && m.ref === "wl2");
    assert.match(err.message, /Unknown background task/);
  });

  it("work_stop: stops a running bg task; stopping a subagent cancels it; sidekick refuses", async () => {
    const { tasks } = fakeBgRegistry();
    tasks.set("b4", { id: "b4", name: "server", command: "serve", status: "running", startTime: 1000 });
    const { records } = fakeSubagents();
    records.set("a2", { id: "a2", title: "worker", status: "running", startedAt: 1000, background: false });

    c.send({ t: "work_stop", id: "bg-b4", ref: "ws1" });
    assert.deepEqual(await c.next((m) => m.t === "ack" && m.ref === "ws1"), { t: "ack", ref: "ws1" });
    assert.equal(tasks.get("b4").status, "killed");

    c.send({ t: "work_stop", id: "agent-a2", ref: "ws2" });
    assert.deepEqual(await c.next((m) => m.t === "ack" && m.ref === "ws2"), { t: "ack", ref: "ws2" });
    assert.equal(records.get("a2").status, "cancelled");

    c.send({ t: "work_stop", id: "sidekick", ref: "ws3" });
    const err = await c.next((m) => m.t === "error" && m.ref === "ws3");
    assert.match(err.message, /can't be stopped/);
  });

  it("work_background: sends a running foreground subagent to the background", async () => {
    const { records } = fakeSubagents();
    records.set("a3", { id: "a3", title: "worker", status: "running", startedAt: 1000, background: false });
    c.send({ t: "work_background", id: "agent-a3", ref: "wb1" });
    assert.deepEqual(await c.next((m) => m.t === "ack" && m.ref === "wb1"), { t: "ack", ref: "wb1" });
    assert.equal(records.get("a3").background, true);
  });

  it("watch{stats:true} gets an immediate stats snapshot (tokens, cost, tps)", async () => {
    fakeTps(42);
    c.send({ t: "watch", stats: true, ref: "w1" });
    assert.deepEqual(await c.next((m) => m.t === "ack" && m.ref === "w1"), { t: "ack", ref: "w1" });
    const stats = await c.next((m) => m.t === "stats");
    assert.equal(stats.stats.tokensIn, 100);
    assert.equal(stats.stats.tokensOut, 50);
    assert.equal(stats.stats.cacheHit, 20);
    assert.equal(stats.stats.tps, 42);
    c.send({ t: "watch", stats: false });
  });

  it("watch{info:true} gets an immediate info snapshot from the registry", async () => {
    fakeInfoRegistry();
    c.send({ t: "watch", info: true, ref: "w2" });
    assert.deepEqual(await c.next((m) => m.t === "ack" && m.ref === "w2"), { t: "ack", ref: "w2" });
    const info = await c.next((m) => m.t === "info");
    assert.deepEqual(info.groups, [{ id: "session", label: "Session", stats: [{ label: "Turns", value: "3" }, { label: "Cost", value: "$0.01" }] }]);
    c.send({ t: "watch", info: false });
  });
});
