/**
 * UNI-276: commands bubbled to the chat — `arg_completions` answers with the
 * command's own completer (captured by core's withCommandEcho), and a
 * command's ui.notify reply is recorded as a unipi-command-output entry.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "app-bridge-cmd-"));
process.env.UNIPI_BRIDGE_DIR = dir;
const { createBridge } = await import("../src/bridge.js");
const { resetBusForTests, withCommandEcho } = await import("@pi-unipi/core");
const { parseIn } = await import("../src/wire.js");

type Handler = (event: any, ctx: any) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const appended: Array<{ customType: string; data: any }> = [];
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
    registerCommand: (name: string, options: any) => commands.set(name, options),
    getCommands: () => [...commands.keys()].map((name) => ({ name, source: "extension" })),
    appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
    registerEntryRenderer: () => {},
    getSessionName: () => "s",
    setSessionName: () => {},
    getThinkingLevel: () => "medium",
    setThinkingLevel: () => {},
    setModel: async () => true,
  };
  const emit = async (name: string, event: any = {}) => {
    for (const h of handlers.get(name) ?? []) await h(event, ctx);
  };
  return { pi, ctx, emit, commands, appended };
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

describe("UNI-276 commands", () => {
  let f: ReturnType<typeof fakePi>;
  let c: ReturnType<typeof client>;

  before(async () => {
    resetBusForTests();
    f = fakePi();
    const api = withCommandEcho(f.pi as never);
    api.registerCommand("unipi:dream", {
      description: "Dream",
      getArgumentCompletions: (p: string) => [{ value: "status", label: "status" }, { value: "report", label: "report", description: "the latest report" }].filter((x) => x.value.startsWith(p)),
      handler: async (_a: string, ctx: any) => ctx.ui.notify("No dream yet", "info"),
    });
    api.registerCommand("unipi:plain", { handler: async () => {} });
    createBridge(f.pi as never, { listSessions: async () => [], listAllSessions: async () => [] });
    await f.emit("session_start", { reason: "startup" });
    for (let i = 0; i < 50 && !existsSync(join(dir, `${process.pid}.json`)); i++) await new Promise((r) => setTimeout(r, 20));
    c = client(join(dir, `${process.pid}.sock`));
    await c.next((m) => m.t === "hello");
  });
  after(() => {
    c.sock.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it("arg_completions answers with the command's own completer", async () => {
    c.send({ t: "arg_completions", command: "unipi:dream", prefix: "re", ref: "a1" });
    const m = await c.next((x) => x.t === "arg_completions" && x.ref === "a1");
    assert.deepEqual(m.items, [{ value: "report", label: "report", description: "the latest report" }]);
    c.send({ t: "arg_completions", command: "unipi:plain", prefix: "", ref: "a2" });
    assert.deepEqual((await c.next((x) => x.t === "arg_completions" && x.ref === "a2")).items, []);
    c.send({ t: "arg_completions", command: "nope", prefix: "", ref: "a3" });
    assert.deepEqual((await c.next((x) => x.t === "arg_completions" && x.ref === "a3")).items, []);
  });

  it("a command's notify is recorded under its echo", async () => {
    await f.commands.get("unipi:dream").handler("status", f.ctx);
    assert.deepEqual(f.appended.map((a) => a.customType), ["unipi-command-echo", "unipi-command-output"]);
    assert.deepEqual(f.appended[1]!.data, { command: "/unipi:dream", text: "No dream yet", level: "info" });
  });
});
