/**
 * The bridge against a fake pi over a real unix socket (temp UNIPI_BRIDGE_DIR).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "app-bridge-"));
process.env.UNIPI_BRIDGE_DIR = dir;
const { createBridge } = await import("../src/bridge.js");

type Handler = (event: any, ctx: any) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const sent: Array<{ content: unknown; opts: any }> = [];
  let idle = true;
  let thinking = "medium";
  const branch: any[] = [
    { type: "session", id: "h" },
    { type: "message", id: "m1", message: { role: "user", content: "hello" } },
    { type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "hi!" }], usage: { cost: { total: 0.01 } } } },
  ];
  const model = { provider: "p", id: "m", name: "Model M", reasoning: true };
  const ui = {
    select: (_t: string, _o: string[], opts?: { signal?: AbortSignal }) =>
      new Promise<string | undefined>((resolve) => opts?.signal?.addEventListener("abort", () => resolve(undefined))),
    notify: () => {},
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui,
    cwd: "/tmp/proj",
    model,
    scopedModels: [],
    modelRegistry: { getAvailable: () => [model, { provider: "q", id: "n", reasoning: false }], find: (p: string, id: string) => (p === "q" && id === "n" ? { provider: "q", id: "n" } : undefined) },
    sessionManager: {
      getSessionFile: () => "/tmp/proj/s.jsonl",
      getSessionId: () => "sid",
      getBranch: () => branch,
      getEntries: () => branch,
      getLeafEntry: () => branch.at(-1),
    },
    isIdle: () => idle,
    abort: () => {},
    getContextUsage: () => ({ tokens: 1000, contextWindow: 10000, percent: 10 }),
    compact: () => {},
  };
  const pi = {
    on: (name: string, h: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), h]);
      return () => {};
    },
    sendUserMessage: (content: unknown, opts: any) => sent.push({ content, opts }),
    getCommands: () => [{ name: "unipi:goal", description: "Set a goal", source: "extension" }],
    getSessionName: () => "my session",
    getThinkingLevel: () => thinking,
    setThinkingLevel: (l: string) => (thinking = l),
    setModel: async () => true,
  };
  const emit = async (name: string, event: any = {}) => {
    for (const h of handlers.get(name) ?? []) await h(event, ctx);
  };
  return { pi, ctx, emit, sent, branch, setIdle: (v: boolean) => (idle = v) };
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
  const next = (pred: (m: any) => boolean, ms = 2000) =>
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
  return { sock, next, send, msgs };
}

describe("app bridge over a unix socket", () => {
  const f = fakePi();
  const bridge = createBridge(f.pi as never);
  let c: ReturnType<typeof client>;

  before(async () => {
    await f.emit("session_start", { reason: "startup" });
    const sockPath = join(dir, `${process.pid}.sock`);
    for (let i = 0; i < 50 && !existsSync(join(dir, `${process.pid}.json`)); i++) await new Promise((r) => setTimeout(r, 20));
    c = client(sockPath);
  });
  after(() => {
    c?.sock.destroy();
    bridge._debug.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the discovery record", () => {
    const rec = JSON.parse(readFileSync(join(dir, `${process.pid}.json`), "utf8"));
    assert.equal(rec.sessionFile, "/tmp/proj/s.jsonl");
    assert.equal(rec.sessionName, "my session");
    assert.equal(rec.pid, process.pid);
    assert.equal(rec.socket, join(dir, `${process.pid}.sock`));
  });

  it("greets with a snapshot", async () => {
    const hello = await c.next((m) => m.t === "hello");
    assert.equal(hello.session.name, "my session");
    assert.deepEqual(hello.entries.map((e: any) => e.id), ["h", "m1", "m2"]);
    assert.equal(hello.state.model.id, "m");
    assert.equal(hello.state.context.percent, 10);
    assert.equal(hello.state.cost, 0.01);
    assert.ok(hello.commands.some((x: any) => x.name === "model" && x.source === "builtin"));
    assert.ok(hello.commands.some((x: any) => x.name === "unipi:goal"));
    assert.equal(hello.models.length, 2);
  });

  it("idle prompt goes straight in; busy prompt steers or follows up", async () => {
    c.send({ t: "prompt", text: "do it", ref: "a" });
    await c.next((m) => m.t === "ack" && m.ref === "a");
    assert.deepEqual(f.sent.at(-1), { content: "do it", opts: { deliverAs: undefined, expandPromptTemplates: true } });
    f.setIdle(false);
    c.send({ t: "prompt", text: "change course", ref: "b" });
    await c.next((m) => m.t === "ack" && m.ref === "b");
    assert.equal(f.sent.at(-1)!.opts.deliverAs, "steer");
    c.send({ t: "prompt", text: "later", mode: "followUp", ref: "c" });
    await c.next((m) => m.t === "ack" && m.ref === "c");
    assert.equal(f.sent.at(-1)!.opts.deliverAs, "followUp");
    f.setIdle(true);
  });

  it("mirrors input, the queue and streaming deltas (coalesced)", async () => {
    await f.emit("input", { text: "from tui", source: "interactive", streamingBehavior: "steer" });
    assert.deepEqual(await c.next((m) => m.t === "queue"), { t: "queue", items: [{ text: "from tui", mode: "steer" }] });
    assert.equal((await c.next((m) => m.t === "input")).source, "interactive");
    await f.emit("message_start", { message: { role: "user", content: "from tui" } });
    assert.deepEqual((await c.next((m) => m.t === "queue")).items, []);

    await f.emit("agent_start");
    assert.equal((await c.next((m) => m.t === "state")).running, true);
    await f.emit("message_start", { message: { role: "assistant", content: [] } });
    const start = await c.next((m) => m.t === "msg_start");
    for (const d of ["Hel", "lo", " there"]) await f.emit("message_update", { assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: d, partial: { content: [] } } });
    const delta = await c.next((m) => m.t === "delta");
    assert.deepEqual(delta, { t: "delta", id: start.id, kind: "text", index: 0, text: "Hello there" });
    const msg = { role: "assistant", content: [{ type: "text", text: "Hello there" }], usage: { cost: { total: 0.02 } } };
    f.branch.push({ type: "message", id: "m3", message: msg });
    await f.emit("message_end", { message: msg });
    assert.equal((await c.next((m) => m.t === "msg_end")).id, start.id);
    assert.equal((await c.next((m) => m.t === "entry")).entry.id, "m3");
  });

  it("streams tool lifecycle", async () => {
    await f.emit("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
    assert.deepEqual(await c.next((m) => m.t === "tool_start"), { t: "tool_start", callId: "t1", name: "bash", args: { command: "ls" } });
    await f.emit("tool_execution_update", { toolCallId: "t1", partialResult: { content: [{ type: "text", text: "a\nb" }] } });
    assert.equal((await c.next((m) => m.t === "tool_update")).text, "a\nb");
    await f.emit("tool_execution_end", { toolCallId: "t1", isError: false });
    assert.equal((await c.next((m) => m.t === "tool_end")).isError, false);
  });

  it("a dialog opened in pi can be answered from the phone", async () => {
    const pick = (f.ctx.ui as any).select("Pick", ["x", "y"]);
    const d = await c.next((m) => m.t === "dialog");
    assert.equal(d.kind, "select");
    assert.deepEqual(d.options, ["x", "y"]);
    c.send({ t: "answer", id: d.id, value: "y", ref: "ans" });
    assert.equal(await pick, "y");
    assert.equal((await c.next((m) => m.t === "dialog_end")).by, "phone");
    await c.next((m) => m.t === "ack" && m.ref === "ans");
    c.send({ t: "answer", id: d.id, value: "x", ref: "again" });
    assert.match((await c.next((m) => m.t === "error" && m.ref === "again")).message, /already answered/);
  });

  it("set_thinking / set_model / bad input", async () => {
    c.send({ t: "set_thinking", level: "high", ref: "th" });
    await c.next((m) => m.t === "ack" && m.ref === "th");
    assert.equal((await c.next((m) => m.t === "state" && m.thinking === "high")).thinking, "high");
    c.send({ t: "set_model", provider: "zz", model: "nope", ref: "sm" });
    assert.match((await c.next((m) => m.t === "error" && m.ref === "sm")).message, /Unknown model/);
    c.sock.write("garbage\n");
    assert.equal((await c.next((m) => m.t === "error" && !m.ref)).message, "not JSON");
  });

  it("removes its files on quit", async () => {
    await f.emit("session_shutdown", { reason: "quit" });
    assert.equal(existsSync(join(dir, `${process.pid}.json`)), false);
    assert.equal(existsSync(join(dir, `${process.pid}.sock`)), false);
  });
});
