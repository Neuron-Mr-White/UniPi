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
const { createBridge, SESSION_COMMAND } = await import("../src/bridge.js");

type Handler = (event: any, ctx: any) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const sent: Array<{ content: unknown; opts: any }> = [];
  let idle = true;
  let thinking = "medium";
  let sessionName: string | undefined = "my session";
  const branch: any[] = [
    { type: "session", id: "h" },
    { type: "message", id: "m1", message: { role: "user", content: "hello" } },
    { type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "hi!" }], usage: { cost: { total: 0.01 } } } },
  ];
  const tree = [
    {
      entry: { id: "m1", parentId: null, type: "message", timestamp: "t1", message: { role: "user", content: "hello" } },
      children: [
        {
          entry: { id: "m2", parentId: "m1", type: "message", timestamp: "t2", message: { role: "assistant", content: [{ type: "text", text: "hi!" }] } },
          children: [],
        },
        { entry: { id: "m3", parentId: "m1", type: "message", timestamp: "t3", message: { role: "user", content: "a branch" } }, children: [] },
      ],
    },
  ];
  const model = { provider: "p", id: "m", name: "Model M", reasoning: true };
  const ui = {
    select: (_t: string, _o: string[], opts?: { signal?: AbortSignal }) =>
      new Promise<string | undefined>((resolve) => opts?.signal?.addEventListener("abort", () => resolve(undefined))),
    notify: () => {},
  };
  // What the hidden command's calls return (tests can override per-case).
  const sessionOps = {
    newSession: async () => ({ cancelled: false }),
    fork: async (_entryId: string) => ({ cancelled: false }),
    navigateTree: async (_id: string, _opts?: unknown) => ({ cancelled: false }),
    switchSession: async (_path: string) => ({ cancelled: false }),
  };
  const calls: Array<{ op: string; args: unknown[] }> = [];
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
      getLeafId: () => branch.at(-1)?.id ?? null,
      getTree: () => tree,
    },
    isIdle: () => idle,
    abort: () => (idle = true),
    getContextUsage: () => ({ tokens: 1000, contextWindow: 10000, percent: 10 }),
    compact: () => {},
  };
  const cctx = {
    ...ctx,
    waitForIdle: async () => {},
    newSession: async (...args: unknown[]) => {
      calls.push({ op: "newSession", args });
      return sessionOps.newSession();
    },
    fork: async (...args: unknown[]) => {
      calls.push({ op: "fork", args });
      return sessionOps.fork(args[0] as string);
    },
    navigateTree: async (...args: unknown[]) => {
      calls.push({ op: "navigateTree", args });
      return sessionOps.navigateTree(args[0] as string, args[1]);
    },
    switchSession: async (...args: unknown[]) => {
      calls.push({ op: "switchSession", args });
      return sessionOps.switchSession(args[0] as string);
    },
  };
  const pi = {
    on: (name: string, h: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), h]);
      return () => {};
    },
    sendUserMessage: (content: unknown, opts: any) => {
      sent.push({ content, opts });
      // The bridge's hidden command: run it with a command-capable context,
      // the only way to reach newSession/fork/navigateTree/switchSession.
      if (typeof content === "string" && content === `/${SESSION_COMMAND}`) {
        const cmd = commands.get(SESSION_COMMAND);
        if (cmd) void cmd.handler("", cctx);
      }
    },
    registerCommand: (name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => commands.set(name, options),
    getCommands: () => [
      { name: "unipi:goal", description: "Set a goal", source: "extension" },
      ...[...commands.keys()].map((name) => ({ name, source: "extension" as const })),
    ],
    getSessionName: () => sessionName,
    setSessionName: (name: string) => (sessionName = name),
    getThinkingLevel: () => thinking,
    setThinkingLevel: (l: string) => (thinking = l),
    setModel: async () => true,
  };
  const emit = async (name: string, event: any = {}) => {
    for (const h of handlers.get(name) ?? []) await h(event, ctx);
  };
  return { pi, ctx, emit, sent, branch, calls, sessionOps, setIdle: (v: boolean) => (idle = v) };
}

/** Fake SessionManager.list/listAll deps for `sessions{}` (the real bridge talks to disk). */
function fakeDeps() {
  const cwdSessions = [
    { path: "/tmp/proj/s.jsonl", id: "sid", cwd: "/tmp/proj", name: "my session", created: new Date(1000), modified: new Date(3000), messageCount: 4, firstMessage: "hello there", allMessagesText: "hello there general kenobi" },
    { path: "/tmp/proj/old.jsonl", id: "old", cwd: "/tmp/proj", created: new Date(500), modified: new Date(1500), messageCount: 2, firstMessage: "fix the bug", allMessagesText: "fix the bug thanks" },
  ];
  const allSessions = [...cwdSessions, { path: "/other/x.jsonl", id: "x", cwd: "/other", created: new Date(900), modified: new Date(2500), messageCount: 1, firstMessage: "other project", allMessagesText: "other project" }];
  return {
    listSessions: async (_cwd: string) => cwdSessions as never,
    listAllSessions: async () => allSessions as never,
  };
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
  const bridge = createBridge(f.pi as never, fakeDeps());
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
    assert.deepEqual(hello.entries.map((e: any) => e.id), ["m1", "m2"], "session header is not sent");
    assert.equal(hello.state.model.id, "m");
    assert.equal(hello.state.context.percent, 10);
    assert.equal(hello.state.cost, 0.01);
    assert.ok(hello.commands.some((x: any) => x.name === "model" && x.source === "builtin"));
    assert.ok(hello.commands.some((x: any) => x.name === "unipi:goal"));
    assert.equal(hello.models.length, 2);
    assert.ok(hello.commands.some((x: any) => x.name === "new" && x.source === "builtin"));
    assert.ok(hello.commands.some((x: any) => x.name === "tree" && x.source === "builtin"));
    assert.ok(!hello.commands.some((x: any) => x.name === SESSION_COMMAND), "the hidden session command never reaches the phone");
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

  it("an extension command acks as a command; a phone prompt's input event names its ref; notify reaches the phone (UNI-143)", async () => {
    c.send({ t: "prompt", text: "/unipi:goal", ref: "cmd" });
    assert.deepEqual(await c.next((m) => m.t === "ack" && m.ref === "cmd"), { t: "ack", ref: "cmd", as: "command" });
    c.send({ t: "prompt", text: "plain words", ref: "p1" });
    assert.deepEqual(await c.next((m) => m.t === "ack" && m.ref === "p1"), { t: "ack", ref: "p1" });
    await f.emit("input", { text: "plain words", source: "extension" });
    const input = await c.next((m) => m.t === "input" && m.text === "plain words");
    assert.equal(input.ref, "p1");
    await f.emit("input", { text: "plain words", source: "interactive" });
    assert.equal((await c.next((m) => m.t === "input" && m.source === "interactive")).ref, undefined, "the same text typed in the TUI is not the phone's");
    f.ctx.ui.notify("kanboard: -do needs a request", "warning");
    assert.deepEqual(await c.next((m) => m.t === "notify"), { t: "notify", text: "kanboard: -do needs a request", level: "warning" });
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

  it("session_rename sets the display name", async () => {
    c.send({ t: "session_rename", name: "renamed chat", ref: "rn" });
    await c.next((m) => m.t === "ack" && m.ref === "rn");
    assert.equal(f.pi.getSessionName(), "renamed chat");
  });

  it("sessions{scope} lists this project's or every project's sessions, newest first, with the current one marked", async () => {
    c.send({ t: "sessions", scope: "cwd", ref: "s1" });
    const cwd = await c.next((m) => m.t === "sessions" && m.ref === "s1");
    assert.deepEqual(cwd.items.map((i: any) => i.path), ["/tmp/proj/s.jsonl", "/tmp/proj/old.jsonl"], "newest modified first");
    assert.equal(cwd.items[0].current, true);
    assert.equal(cwd.items[1].current, false);
    assert.equal(cwd.more, false);

    c.send({ t: "sessions", scope: "all", ref: "s2" });
    const all = await c.next((m) => m.t === "sessions" && m.ref === "s2");
    assert.equal(all.items.length, 3);

    c.send({ t: "sessions", scope: "cwd", query: "bug", ref: "s3" });
    const filtered = await c.next((m) => m.t === "sessions" && m.ref === "s3");
    assert.deepEqual(filtered.items.map((i: any) => i.path), ["/tmp/proj/old.jsonl"], "matches firstMessage/allMessagesText case-insensitively");
  });

  it("tree{} lists every branch, previews only, marking the current branch and leaf", async () => {
    c.send({ t: "tree", ref: "tr1" });
    const tree = await c.next((m) => m.t === "tree" && m.ref === "tr1");
    assert.deepEqual(tree.nodes.map((n: any) => n.id), ["m1", "m2", "m3"]);
    assert.equal(tree.nodes.find((n: any) => n.id === "m1").kind, "user");
    assert.equal(tree.nodes.find((n: any) => n.id === "m2").preview, "hi!");
    // The fake session's branch (getBranch) holds m1, m2 and the m3 an
    // earlier test appended: all three are "on the current path"; only the
    // leaf (m3) is "current".
    assert.equal(tree.nodes.find((n: any) => n.id === "m2").onPath, true);
    assert.equal(tree.nodes.find((n: any) => n.id === "m2").current, false);
    assert.equal(tree.nodes.find((n: any) => n.id === "m3").onPath, true);
    assert.equal(tree.nodes.find((n: any) => n.id === "m3").current, true);
  });

  it("session_new / session_resume / session_fork / tree_go run through the hidden command with a real command context", async () => {
    c.send({ t: "session_new", ref: "n1" });
    await c.next((m) => m.t === "ack" && m.ref === "n1");
    assert.deepEqual(f.calls.at(-1), { op: "newSession", args: [] });

    c.send({ t: "session_resume", path: "/tmp/other.jsonl", ref: "r1" });
    await c.next((m) => m.t === "ack" && m.ref === "r1");
    assert.deepEqual(f.calls.at(-1), { op: "switchSession", args: ["/tmp/other.jsonl"] });

    c.send({ t: "session_fork", entryId: "m2", ref: "f1" });
    await c.next((m) => m.t === "ack" && m.ref === "f1");
    assert.deepEqual(f.calls.at(-1), { op: "fork", args: ["m2"] });

    c.send({ t: "tree_go", id: "m1", summarize: true, ref: "g1" });
    await c.next((m) => m.t === "ack" && m.ref === "g1");
    assert.deepEqual(f.calls.at(-1), { op: "navigateTree", args: ["m1", { summarize: true }] });
  });

  it("while pi is busy, new/resume/fork/tree_go answer a busy error; force:true aborts, waits for idle, then runs", async () => {
    f.setIdle(false);
    c.send({ t: "session_new", ref: "busy1" });
    const err = await c.next((m) => m.t === "error" && m.ref === "busy1");
    assert.equal(err.code, "busy");
    assert.equal(f.calls.some((x) => x.op === "newSession"), true, "earlier calls from the previous test still there");
    const before = f.calls.length;

    c.send({ t: "session_new", force: true, ref: "busy2" });
    await c.next((m) => m.t === "ack" && m.ref === "busy2");
    assert.equal(f.calls.length, before + 1);
    assert.equal(f.calls.at(-1)!.op, "newSession");
    f.setIdle(true);
  });

  it("removes its files on quit", async () => {
    await f.emit("session_shutdown", { reason: "quit" });
    assert.equal(existsSync(join(dir, `${process.pid}.json`)), false);
    assert.equal(existsSync(join(dir, `${process.pid}.sock`)), false);
  });
});
