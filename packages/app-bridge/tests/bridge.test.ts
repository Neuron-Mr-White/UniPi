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
    confirm: (_t: string, _m: string, opts?: { signal?: AbortSignal }) =>
      new Promise<boolean>((resolve) => opts?.signal?.addEventListener("abort", () => resolve(false))),
    input: (_t: string, _p?: string, opts?: { signal?: AbortSignal }) =>
      new Promise<string | undefined>((resolve) => opts?.signal?.addEventListener("abort", () => resolve(undefined))),
    editor: (_t: string, _p?: string) => new Promise<string | undefined>(() => {}),
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
  return { pi, ctx, emit, sent, branch, tree, calls, sessionOps, setIdle: (v: boolean) => (idle = v) };
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
    const q0 = await c.next((m) => m.t === "queue");
    assert.deepEqual(q0.items, [{ id: q0.items[0].id, text: "from tui", mode: "steer", source: "tui", editable: true }]);
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

  it("compact{instructions} (UNI-205) forwards free text through to ctx.compact as customInstructions, same as pi's own /compact <text>", async () => {
    const seen: Array<string | undefined> = [];
    f.ctx.compact = (opts: { customInstructions?: string; onComplete?: () => void }) => {
      seen.push(opts.customInstructions);
      opts.onComplete?.();
    };
    c.send({ t: "compact", instructions: "focus on the login bug", ref: "cp1" });
    await c.next((m) => m.t === "ack" && m.ref === "cp1");
    assert.deepEqual(seen, ["focus on the login bug"]);

    c.send({ t: "compact", ref: "cp2" });
    await c.next((m) => m.t === "ack" && m.ref === "cp2");
    assert.deepEqual(seen, ["focus on the login bug", undefined]);
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

  it("tree{} survives a 20k-deep session and fits one line (UNI-194: stack overflow + oversized line)", async () => {
    const saved = f.tree.splice(0, f.tree.length);
    let parent: any = null;
    const root: any[] = [];
    for (let i = 0; i < 20000; i++) {
      const kind = i % 5;
      const entry =
        kind === 0
          ? { id: `d${i}`, parentId: parent?.entry.id ?? null, type: "message", timestamp: "t", message: { role: "user", content: `ask ${i} ${"x".repeat(150)}` } }
          : kind === 1
            ? { id: `d${i}`, parentId: parent.entry.id, type: "message", timestamp: "t", message: { role: "assistant", content: [{ type: "toolCall" }] } }
            : kind === 2
              ? { id: `d${i}`, parentId: parent.entry.id, type: "message", timestamp: "t", message: { role: "toolResult", content: "y".repeat(400) } }
              : { id: `d${i}`, parentId: parent.entry.id, type: "custom", timestamp: "t", customType: "footer" };
      const node = { entry, children: [] as any[] };
      if (parent) parent.children.push(node);
      else root.push(node);
      parent = node;
    }
    f.tree.push(...root);
    try {
      c.send({ t: "tree", ref: "deep" });
      const reply = await c.next((m) => (m.t === "tree" || m.t === "error") && m.ref === "deep");
      assert.equal(reply.t, "tree", reply.message);
      assert.ok(reply.nodes.length > 1000, `kept ${reply.nodes.length}`);
      assert.ok(Buffer.byteLength(JSON.stringify(reply)) < 900 * 1024);
      assert.ok(!reply.nodes.some((n: any) => n.kind === "custom"), "bookkeeping rows dropped");
      const ids = new Set(reply.nodes.map((n: any) => n.id));
      assert.ok(reply.nodes.every((n: any) => n.parentId === null || ids.has(n.parentId)), "parents re-attached to kept rows");
    } finally {
      f.tree.splice(0, f.tree.length, ...saved);
    }
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

  it("prompt modes: steer (busy), now (abort+wait+send), after (bridge queue, idle delivers immediately)", async () => {
    // busy + mode steer: delivered right away as a steer.
    f.setIdle(false);
    c.send({ t: "prompt", text: "steer this", mode: "steer", ref: "pm1" });
    await c.next((m) => m.t === "ack" && m.ref === "pm1");
    assert.equal(f.sent.at(-1)!.opts.deliverAs, "steer");

    // busy + mode now: aborts, waits for idle (the fake's abort() sets idle=true), then sends as a plain prompt.
    const beforeSent = f.sent.length;
    c.send({ t: "prompt", text: "do it now", mode: "now", ref: "pm2" });
    await c.next((m) => m.t === "ack" && m.ref === "pm2");
    assert.equal(f.sent.length, beforeSent + 1);
    assert.deepEqual(f.sent.at(-1), { content: "do it now", opts: { expandPromptTemplates: true } });

    // idle + mode after, nothing else queued: delivered immediately (nothing to wait for).
    f.setIdle(true);
    const beforeSent2 = f.sent.length;
    c.send({ t: "prompt", text: "after, idle", mode: "after", ref: "pm3" });
    await c.next((m) => m.t === "ack" && m.ref === "pm3");
    assert.equal(f.sent.length, beforeSent2 + 1);
    assert.deepEqual(f.sent.at(-1), { content: "after, idle", opts: { expandPromptTemplates: true } });
  });

  it("bridge queue: after-it-ends items wait, are editable/removable/reorderable, deliver one at a time on agent_end", async () => {
    f.setIdle(false);
    c.send({ t: "prompt", text: "first after", mode: "after", ref: "aq1" });
    await c.next((m) => m.t === "ack" && m.ref === "aq1");
    let q = await c.next((m) => m.t === "queue");
    assert.deepEqual(q.items, [{ id: q.items[0].id, text: "first after", mode: "after", source: "phone", editable: true }]);
    const id1 = q.items[0].id as string;

    c.send({ t: "prompt", text: "second after", mode: "after", ref: "aq2" });
    await c.next((m) => m.t === "ack" && m.ref === "aq2");
    q = await c.next((m) => m.t === "queue");
    assert.equal(q.items.length, 2);
    const id2 = q.items[1].id as string;

    // Edit the first item's text.
    c.send({ t: "queue_edit", id: id1, text: "first after (edited)", ref: "qe1" });
    await c.next((m) => m.t === "ack" && m.ref === "qe1");
    q = await c.next((m) => m.t === "queue");
    assert.equal(q.items.find((x: any) => x.id === id1)!.text, "first after (edited)");

    // Reorder: move the second item to the front.
    c.send({ t: "queue_move", id: id2, index: 0, ref: "qm1" });
    await c.next((m) => m.t === "ack" && m.ref === "qm1");
    q = await c.next((m) => m.t === "queue");
    assert.deepEqual(q.items.map((x: any) => x.id), [id2, id1]);

    // Remove the (now first) item.
    c.send({ t: "queue_remove", id: id2, ref: "qr1" });
    await c.next((m) => m.t === "ack" && m.ref === "qr1");
    q = await c.next((m) => m.t === "queue");
    assert.deepEqual(q.items.map((x: any) => x.id), [id1]);

    // agent_end delivers the one remaining item as a fresh prompt.
    const beforeSent = f.sent.length;
    await f.emit("agent_end", { messages: [] });
    q = await c.next((m) => m.t === "queue");
    assert.deepEqual(q.items, []);
    assert.equal(f.sent.length, beforeSent + 1);
    assert.deepEqual(f.sent.at(-1), { content: "first after (edited)", opts: { expandPromptTemplates: true } });

    // A second agent_end with nothing queued sends nothing new.
    const beforeSent2 = f.sent.length;
    await f.emit("agent_end", { messages: [] });
    assert.equal(f.sent.length, beforeSent2);
    f.setIdle(true);
  });

  it("bridge queue: only the first item delivers per agent_end; the user starting something new clears the rest", async () => {
    f.setIdle(false);
    c.send({ t: "prompt", text: "one", mode: "after", ref: "nq1" });
    await c.next((m) => m.t === "ack" && m.ref === "nq1");
    c.send({ t: "prompt", text: "two", mode: "after", ref: "nq2" });
    await c.next((m) => m.t === "ack" && m.ref === "nq2");
    await c.next((m) => m.t === "queue");
    await c.next((m) => m.t === "queue");

    const beforeSent = f.sent.length;
    await f.emit("agent_end", { messages: [] });
    const q1 = await c.next((m) => m.t === "queue");
    assert.equal(q1.items.length, 1, "only one item left: the second waits for the next agent_end");
    assert.equal(f.sent.length, beforeSent + 1);

    // The user starts something new (TUI input) before the next agent_end: the rest is dropped.
    await f.emit("input", { text: "user typed something else", source: "interactive" });
    const q2 = await c.next((m) => m.t === "queue");
    assert.deepEqual(q2.items, []);
    f.setIdle(true);
  });

  it("queue_promote: 'steer' sends right away as a steer, 'now' aborts/waits/sends as a prompt", async () => {
    f.setIdle(false);
    c.send({ t: "prompt", text: "promote me (steer)", mode: "after", ref: "qp1" });
    await c.next((m) => m.t === "ack" && m.ref === "qp1");
    let q = await c.next((m) => m.t === "queue");
    const id1 = q.items[0].id as string;
    c.send({ t: "queue_promote", id: id1, to: "steer", ref: "qp1a" });
    await c.next((m) => m.t === "ack" && m.ref === "qp1a");
    assert.equal(f.sent.at(-1)!.opts.deliverAs, "steer");
    q = await c.next((m) => m.t === "queue");
    assert.deepEqual(q.items, []);

    c.send({ t: "prompt", text: "promote me (now)", mode: "after", ref: "qp2" });
    await c.next((m) => m.t === "ack" && m.ref === "qp2");
    q = await c.next((m) => m.t === "queue");
    const id2 = q.items[0].id as string;
    const beforeSent = f.sent.length;
    c.send({ t: "queue_promote", id: id2, to: "now", ref: "qp2a" });
    await c.next((m) => m.t === "ack" && m.ref === "qp2a");
    assert.equal(f.sent.length, beforeSent + 1);
    assert.deepEqual(f.sent.at(-1), { content: "promote me (now)", opts: { expandPromptTemplates: true } });
    f.setIdle(true);
  });

  it("bridge queue survives a phone reconnect (sent in hello)", async () => {
    f.setIdle(false);
    c.send({ t: "prompt", text: "still waiting", mode: "after", ref: "rc1" });
    await c.next((m) => m.t === "ack" && m.ref === "rc1");
    await c.next((m) => m.t === "queue");

    c.send({ t: "resync", ref: "rc-sync" });
    const hello = await c.next((m) => m.t === "hello");
    assert.deepEqual(hello.queue.map((x: any) => ({ text: x.text, mode: x.mode, source: x.source, editable: x.editable })), [
      { text: "still waiting", mode: "after", source: "phone", editable: true },
    ]);

    // Clean up: remove it so later tests start from an empty bridge queue.
    c.send({ t: "queue_remove", id: hello.queue[0].id, ref: "rc-clean" });
    await c.next((m) => m.t === "ack" && m.ref === "rc-clean");
    await c.next((m) => m.t === "queue");
    f.setIdle(true);
  });

  it("UNI-202: a pi-owned (tui-*) queued item is editable/removable/promotable too — no clearQueue() API, so it aborts and re-sends what's left", async () => {
    f.setIdle(false);
    await f.emit("input", { text: "steer A", source: "interactive", streamingBehavior: "steer" });
    await c.next((m) => m.t === "input" && m.text === "steer A");
    let q = await c.next((m) => m.t === "queue" && m.items.some((x: any) => x.text === "steer A"));
    const idA = q.items.find((x: any) => x.text === "steer A")!.id as string;

    await f.emit("input", { text: "follow B", source: "interactive", streamingBehavior: "followUp" });
    await c.next((m) => m.t === "input" && m.text === "follow B");
    q = await c.next((m) => m.t === "queue" && m.items.some((x: any) => x.text === "follow B"));
    const idB = q.items.find((x: any) => x.text === "follow B")!.id as string;
    assert.ok(idA.startsWith("tui-"));
    assert.ok(idB.startsWith("tui-"));

    // Edit A's text: aborts (fake's abort() sets idle=true), re-sends B
    // (unedited, same mode) and the edited A, each via sendUserMessage.
    const beforeSent = f.sent.length;
    c.send({ t: "queue_edit", id: idA, text: "steer A (edited)", ref: "te1" });
    await c.next((m) => m.t === "ack" && m.ref === "te1");
    const resent = f.sent.slice(beforeSent);
    assert.deepEqual(
      resent.map((s) => ({ content: s.content, deliverAs: s.opts.deliverAs })),
      [
        { content: "follow B", deliverAs: "followUp" },
        { content: "steer A (edited)", deliverAs: "steer" },
      ],
    );
    q = await c.next((m) => m.t === "queue" && m.items.length === 0);

    // Remove: drops the target, re-sends the rest.
    await f.emit("input", { text: "steer C", source: "interactive", streamingBehavior: "steer" });
    await c.next((m) => m.t === "input" && m.text === "steer C");
    q = await c.next((m) => m.t === "queue" && m.items.some((x: any) => x.text === "steer C"));
    const idC = q.items.find((x: any) => x.text === "steer C")!.id as string;
    const beforeSent2 = f.sent.length;
    c.send({ t: "queue_remove", id: idC, ref: "tr1" });
    await c.next((m) => m.t === "ack" && m.ref === "tr1");
    assert.equal(f.sent.length, beforeSent2, "nothing else was queued: removing the only item re-sends nothing");

    // Promote: sends right away (no deliverAs — idle after the abort).
    await f.emit("input", { text: "steer D", source: "interactive", streamingBehavior: "steer" });
    await c.next((m) => m.t === "input" && m.text === "steer D");
    q = await c.next((m) => m.t === "queue" && m.items.some((x: any) => x.text === "steer D"));
    const idD = q.items.find((x: any) => x.text === "steer D")!.id as string;
    const beforeSent3 = f.sent.length;
    c.send({ t: "queue_promote", id: idD, to: "steer", ref: "tp1" });
    await c.next((m) => m.t === "ack" && m.ref === "tp1");
    assert.deepEqual(f.sent.at(-1), { content: "steer D", opts: { expandPromptTemplates: true } });
    assert.equal(f.sent.length, beforeSent3 + 1);

    // Reordering a pi-owned item is refused (only bridge items are reorderable).
    await f.emit("input", { text: "steer E", source: "interactive", streamingBehavior: "steer" });
    await c.next((m) => m.t === "input" && m.text === "steer E");
    q = await c.next((m) => m.t === "queue" && m.items.some((x: any) => x.text === "steer E"));
    const idE = q.items.find((x: any) => x.text === "steer E")!.id as string;
    c.send({ t: "queue_move", id: idE, index: 0, ref: "tm1" });
    assert.match((await c.next((m) => m.t === "error" && m.ref === "tm1")).message, /isn't reorderable/);
    // Clean up: this run left "steer E" in tuiQueue — abort so the next test starts clean.
    c.send({ t: "abort", ref: "ta-clean" });
    await c.next((m) => m.t === "ack" && m.ref === "ta-clean");
    await c.next((m) => m.t === "restored");
    f.setIdle(true);
  });

  it("UNI-202/211: abort pulls pi's own queued messages back (matching the TUI's own Stop) and the phone gets `restored`; the bridge's own 'after' queue is untouched", async () => {
    f.setIdle(false);
    await f.emit("input", { text: "steer X", source: "interactive", streamingBehavior: "steer" });
    await c.next((m) => m.t === "input" && m.text === "steer X");
    await c.next((m) => m.t === "queue" && m.items.some((x: any) => x.text === "steer X"));
    await f.emit("input", { text: "follow Y", source: "interactive", streamingBehavior: "followUp" });
    await c.next((m) => m.t === "input" && m.text === "follow Y");
    await c.next((m) => m.t === "queue" && m.items.some((x: any) => x.text === "follow Y"));
    c.send({ t: "prompt", text: "after it ends", mode: "after", ref: "ab-after" });
    await c.next((m) => m.t === "ack" && m.ref === "ab-after");
    const qBefore = await c.next((m) => m.t === "queue" && m.items.some((x: any) => x.text === "after it ends"));
    assert.equal(qBefore.items.length, 3);

    c.send({ t: "abort", ref: "ab1" });
    const restored = await c.next((m) => m.t === "restored");
    assert.deepEqual(restored.texts, ["steer X", "follow Y"]);
    await c.next((m) => m.t === "ack" && m.ref === "ab1");
    const qAfter = await c.next((m) => m.t === "queue" && m.items.length === 1);
    assert.deepEqual(qAfter.items.map((x: any) => x.text), ["after it ends"]);

    // Clean up the bridge's own queue item so later tests see an empty one.
    c.send({ t: "queue_remove", id: qAfter.items[0].id, ref: "ab-clean" });
    await c.next((m) => m.t === "ack" && m.ref === "ab-clean");
    await c.next((m) => m.t === "queue" && m.items.length === 0);
    f.setIdle(true);
  });

  it("UNI-211: a settle with nothing pending leaves no stray queue rows (agent_settled still sweeps an empty-run mirror)", async () => {
    await f.emit("input", { text: "steer Z", source: "interactive", streamingBehavior: "steer" });
    await c.next((m) => m.t === "input" && m.text === "steer Z");
    const q = await c.next((m) => m.t === "queue" && m.items.some((x: any) => x.text === "steer Z"));
    assert.equal(q.items.length, 1);
    await f.emit("agent_settled");
    assert.deepEqual((await c.next((m) => m.t === "queue" && m.items.length === 0)).items, []);
  });

  it("btw: forwards to @pi-unipi/btw's UI-free API (globalThis), streaming deltas to the requesting phone only", async () => {
    const BTW_API_KEY = Symbol.for("unipi.btw.api");
    const events: any[] = [];
    (globalThis as any)[BTW_API_KEY] = {
      ask(_cctx: unknown, question: string, onEvent: (e: any) => void) {
        events.push(question);
        const finished = (async () => {
          onEvent({ type: "delta", kind: "text", text: "Pela" });
          onEvent({ type: "delta", kind: "text", text: "can." });
          onEvent({ type: "end", answer: "Pelican.", usage: { input: 10, output: 2, totalTokens: 12 } });
        })();
        return { id: "btw-1", finished };
      },
      list: () => [{ question: "earlier q", answer: "earlier a" }],
    };
    try {
      c.send({ t: "btw", question: "what's the codename?", ref: "bq1" });
      const d1 = await c.next((m) => m.t === "btw_delta" && m.ref === "bq1");
      assert.equal(d1.kind, "text");
      assert.equal(d1.text, "Pela");
      const d2 = await c.next((m) => m.t === "btw_delta" && m.ref === "bq1");
      assert.equal(d2.text, "can.");
      const end = await c.next((m) => m.t === "btw_end" && m.ref === "bq1");
      assert.equal(end.answer, "Pelican.");
      assert.deepEqual(end.usage, { input: 10, output: 2, totalTokens: 12 });
      assert.deepEqual(events, ["what's the codename?"]);

      c.send({ t: "btw_list", ref: "bl1" });
      const list = await c.next((m) => m.t === "btw_list" && m.ref === "bl1");
      assert.deepEqual(list.pages, [{ question: "earlier q", answer: "earlier a" }]);
    } finally {
      delete (globalThis as any)[BTW_API_KEY];
    }
  });

  it("btw: a pi without @pi-unipi/btw loaded answers an error, and an empty page list", async () => {
    c.send({ t: "btw", question: "anything?", ref: "nobtw1" });
    const err = await c.next((m) => m.t === "error" && m.ref === "nobtw1");
    assert.match(err.message, /not installed/);
    c.send({ t: "btw_list", ref: "nobtw2" });
    const list = await c.next((m) => m.t === "btw_list" && m.ref === "nobtw2");
    assert.deepEqual(list.pages, []);
  });

  it("every wrapped ui.* dialog kind can be answered from the phone (select/confirm/input/editor)", async () => {
    const confirmP = (f.ctx.ui as any).confirm("Sure?", "Really do it?");
    const d1 = await c.next((m) => m.t === "dialog" && m.kind === "confirm");
    assert.equal(d1.message, "Really do it?");
    c.send({ t: "answer", id: d1.id, value: true, ref: "cf1" });
    assert.equal(await confirmP, true);
    await c.next((m) => m.t === "dialog_end" && m.id === d1.id);

    const inputP = (f.ctx.ui as any).input("Name?", "placeholder");
    const d2 = await c.next((m) => m.t === "dialog" && m.kind === "input");
    assert.equal(d2.placeholder, "placeholder");
    c.send({ t: "answer", id: d2.id, value: "Ada", ref: "in1" });
    assert.equal(await inputP, "Ada");
    await c.next((m) => m.t === "dialog_end" && m.id === d2.id);

    const editorP = (f.ctx.ui as any).editor("Edit", "prefill text");
    const d3 = await c.next((m) => m.t === "dialog" && m.kind === "editor");
    assert.equal(d3.prefill, "prefill text");
    c.send({ t: "answer", id: d3.id, value: "edited text", ref: "ed1" });
    assert.equal(await editorP, "edited text");
    await c.next((m) => m.t === "dialog_end" && m.id === d3.id);
  });

  it("ask_user: every outcome shape the phone can send (answered, cancel, action end_turn, action new_session+prefill)", async () => {
    const { raceRemote } = await import("@pi-unipi/core");
    const questions = [
      {
        question: "Pick one",
        header: "Pick",
        options: [
          { label: "Keep going", value: "keep" },
          { label: "Stop here", value: "stop", action: "end_turn" },
          { label: "Start fresh", value: "fresh", action: "new_session", prefill: "/new continue the plan" },
        ],
      },
    ];

    const race = () =>
      raceRemote<unknown>(
        { kind: "ask_user", title: "Pick one", questions },
        () => new Promise(() => {}),
        (v) => v,
      );

    // 1) a plain answered shape.
    const p1 = race();
    const dq1 = await c.next((m) => m.t === "dialog" && m.kind === "ask_user");
    assert.deepEqual(dq1.questions, questions);
    c.send({ t: "answer", id: dq1.id, value: { type: "answered", answers: [{ selected: ["keep"], skipped: false }] }, ref: "aq-ans" });
    assert.deepEqual(await p1, { type: "answered", answers: [{ selected: ["keep"], skipped: false }] });
    await c.next((m) => m.t === "dialog_end" && m.id === dq1.id);

    // 2) cancel.
    const p2 = race();
    const dq2 = await c.next((m) => m.t === "dialog" && m.kind === "ask_user");
    c.send({ t: "answer", id: dq2.id, value: { type: "cancel" }, ref: "aq-cancel" });
    assert.deepEqual(await p2, { type: "cancel" });
    await c.next((m) => m.t === "dialog_end" && m.id === dq2.id);

    // 3) an action option (end_turn) — the phone sends the option's value as selected.
    const p3 = race();
    const dq3 = await c.next((m) => m.t === "dialog" && m.kind === "ask_user");
    c.send({ t: "answer", id: dq3.id, value: { type: "answered", answers: [{ selected: ["stop"], skipped: false }] }, ref: "aq-end" });
    assert.deepEqual(await p3, { type: "answered", answers: [{ selected: ["stop"], skipped: false }] });
    await c.next((m) => m.t === "dialog_end" && m.id === dq3.id);

    // 4) an action option (new_session) with a prefill — same wire shape;
    // ask-user's tools.ts phoneAnswer() is what turns the picked option into
    // a {type:"action"} PanelResult (covered by ask-user's own tests).
    const p4 = race();
    const dq4 = await c.next((m) => m.t === "dialog" && m.kind === "ask_user");
    c.send({ t: "answer", id: dq4.id, value: { type: "answered", answers: [{ selected: ["fresh"], skipped: false }] }, ref: "aq-fresh" });
    assert.deepEqual(await p4, { type: "answered", answers: [{ selected: ["fresh"], skipped: false }] });
    await c.next((m) => m.t === "dialog_end" && m.id === dq4.id);
  });

  it("a custom dialog (another extension's own ctx.ui.custom) reaches the phone; the app shows no answer UI for it, but a phone answer still closes it", async () => {
    const { raceRemote } = await import("@pi-unipi/core");
    const tuiDone = raceRemote<string>(
      { kind: "custom", title: "Some other extension's own UI" },
      (signal) => new Promise<string>((res) => signal.addEventListener("abort", () => res("tui-done"))),
      (v) => String(v),
    );
    const d = await c.next((m) => m.t === "dialog" && m.kind === "custom");
    assert.equal(d.title, "Some other extension's own UI");
    assert.equal(d.options, undefined);
    // The hub itself doesn't special-case "custom" -- it's the app's DialogCard
    // that renders "Answer in the terminal" instead of an answer UI
    // (docs/m5/PROTOCOL.md section 3). A phone answer still closes the dialog.
    c.send({ t: "answer", id: d.id, value: "phone-sent", ref: "cu1" });
    assert.equal(await tuiDone, "phone-sent");
    assert.equal((await c.next((m) => m.t === "dialog_end" && m.id === d.id)).by, "phone");
  });

  it("reconnect restores every open dialog (hello.dialogs)", async () => {
    const { raceRemote } = await import("@pi-unipi/core");
    const p = raceRemote<string | undefined>(
      { kind: "select", title: "Still open?", questions: undefined },
      () => new Promise(() => {}),
      (v) => (typeof v === "string" ? v : undefined),
    );
    const opened = await c.next((m) => m.t === "dialog" && m.kind === "select" && m.title === "Still open?");
    c.sock.destroy();
    c = client(join(dir, `${process.pid}.sock`));
    const hello = await c.next((m) => m.t === "hello");
    assert.ok(hello.dialogs.some((x: any) => x.id === opened.id && x.kind === "select"), "the still-open dialog is in hello.dialogs");
    c.send({ t: "answer", id: opened.id, value: "ok", ref: "reopen" });
    assert.equal(await p, "ok");
  });

  it('"needs you" (UNI-161): the discovery record carries `waiting` while a dialog is open, and clears once it closes', async () => {
    const pick = (f.ctx.ui as any).select("Pick a path", ["a", "b"]);
    const d = await c.next((m) => m.t === "dialog" && m.kind === "select" && m.title === "Pick a path");
    for (let i = 0; i < 50; i++) {
      const rec = JSON.parse(readFileSync(join(dir, `${process.pid}.json`), "utf8"));
      if (rec.waiting) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    let rec = JSON.parse(readFileSync(join(dir, `${process.pid}.json`), "utf8"));
    assert.equal(rec.waiting.kind, "select");
    assert.equal(rec.waiting.title, "Pick a path");
    assert.equal(typeof rec.waiting.since, "number");

    c.send({ t: "answer", id: d.id, value: "a", ref: "needs-you-1" });
    assert.equal(await pick, "a");
    await c.next((m) => m.t === "dialog_end" && m.id === d.id);
    for (let i = 0; i < 50; i++) {
      rec = JSON.parse(readFileSync(join(dir, `${process.pid}.json`), "utf8"));
      if (!rec.waiting) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(rec.waiting, null);
  });

  it('"needs you": idle right after an agent_end with no phone connected also marks `waiting`, cleared once a phone (re)connects', async () => {
    c.sock.destroy();
    // No socket connected now — give the server a tick to drop it.
    await new Promise((r) => setTimeout(r, 50));
    await f.emit("agent_end", { messages: [] });
    let rec = JSON.parse(readFileSync(join(dir, `${process.pid}.json`), "utf8"));
    assert.equal(rec.waiting.kind, "agent_end");
    assert.equal(typeof rec.waiting.since, "number");

    // Reconnecting clears it (the phone has now seen the state in `hello`).
    c = client(join(dir, `${process.pid}.sock`));
    await c.next((m) => m.t === "hello");
    for (let i = 0; i < 50; i++) {
      rec = JSON.parse(readFileSync(join(dir, `${process.pid}.json`), "utf8"));
      if (!rec.waiting) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(rec.waiting, null);
  });

  it("UNI-162: agent_end with no phone connected does NOT mark `waiting` while a wait source has a reason", async () => {
    const { registerWaitSource, resetArbiterForTests } = await import("@pi-unipi/core");
    c.sock.destroy();
    await new Promise((r) => setTimeout(r, 50));
    const unregister = registerWaitSource("subagents", () => "subagent running");
    try {
      await f.emit("agent_end", { messages: [] });
      const rec = JSON.parse(readFileSync(join(dir, `${process.pid}.json`), "utf8"));
      assert.equal(rec.waiting, null, "a pending wait source means the session isn't really idle yet");
    } finally {
      unregister();
      resetArbiterForTests();
      // Reconnect so later tests in this file see a normal socket.
      c = client(join(dir, `${process.pid}.sock`));
      await c.next((m) => m.t === "hello");
    }
  });

  it("UNI-162: state.waiting carries the pending-work label while idle, and is absent once clear", async () => {
    const { registerWaitSource, resetArbiterForTests } = await import("@pi-unipi/core");
    const unregister = registerWaitSource("subagents", () => "subagent running");
    try {
      await f.emit("agent_settled", {});
      const state = await c.next((m) => m.t === "state");
      assert.equal(state.waiting, "subagent running");
    } finally {
      unregister();
      resetArbiterForTests();
    }
    await f.emit("agent_settled", {});
    const cleared = await c.next((m) => m.t === "state");
    assert.equal(cleared.waiting, undefined);
  });

  it("a session switch tells phones to reconnect and frees the socket for the next instance", async () => {
    const extra = client(join(dir, `${process.pid}.sock`));
    await extra.next((m) => m.t === "hello");
    await f.emit("session_shutdown", { reason: "resume" });
    assert.deepEqual(await extra.next((m) => m.t === "reconnect"), { t: "reconnect", reason: "resume" });
    await new Promise((r) => extra.sock.once("close", r));
    // The next instance (pi reloads extensions) listens again on session_start.
    await f.emit("session_start", { reason: "resume" });
    for (let i = 0; i < 50 && !existsSync(join(dir, `${process.pid}.sock`)); i++) await new Promise((r) => setTimeout(r, 20));
    const again = client(join(dir, `${process.pid}.sock`));
    assert.equal((await again.next((m) => m.t === "hello")).t, "hello");
    again.sock.destroy();
    c = client(join(dir, `${process.pid}.sock`));
    await c.next((m) => m.t === "hello");
  });

  it("removes its files on quit", async () => {
    await f.emit("session_shutdown", { reason: "quit" });
    assert.equal(existsSync(join(dir, `${process.pid}.json`)), false);
    assert.equal(existsSync(join(dir, `${process.pid}.sock`)), false);
  });
});
