/**
 * saveMode gating, recall-once + reload detection, save-session tool stubs.
 *
 * Run with a scratch HOME:  HOME=$(mktemp -d) npx tsx --test tests/save-mode.test.ts
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildSaveTools,
  buildSeedEntries,
  shouldRunSideSave,
  SAVE_CARD_TYPE,
  SAVE_PROMPT,
} from "../save-session.js";
import memoryExtension, { branchHasRecallReminder } from "../index.js";
import { MEMORY_TOOLS } from "../tools.js";
import { projectName } from "../paths.js";

const RECALL_TYPE = "unipi-memory-recall-reminder";
const RETRO_TYPE = "unipi-memory-retro-reminder";

// ── shouldRunSideSave ───────────────────────────────────────────────────────

const baseSide = {
  write: true,
  hooksEnabled: true,
  storeActive: true,
  runToolCalls: 3,
  runHadWrite: false,
  runStoredMemory: false,
  running: false,
};

test("side save gates", () => {
  assert.equal(shouldRunSideSave(baseSide), true);
  // substantive threshold: <3 tool calls and no write → skip
  assert.equal(shouldRunSideSave({ ...baseSide, runToolCalls: 2 }), false);
  // …unless a write/edit happened
  assert.equal(shouldRunSideSave({ ...baseSide, runToolCalls: 0, runHadWrite: true }), true);
  // main agent already stored
  assert.equal(shouldRunSideSave({ ...baseSide, runStoredMemory: true }), false);
  // one at a time
  assert.equal(shouldRunSideSave({ ...baseSide, running: true }), false);
  // write off / override off / hooks off / tool inactive
  assert.equal(shouldRunSideSave({ ...baseSide, write: false }), false);
  assert.equal(shouldRunSideSave({ ...baseSide, writeOverride: false }), false);
  assert.equal(shouldRunSideSave({ ...baseSide, hooksEnabled: false }), false);
  assert.equal(shouldRunSideSave({ ...baseSide, storeActive: false }), false);
});

// ── branchHasRecallReminder ─────────────────────────────────────────────────

test("recall reminder detected only after the last compaction", () => {
  const reminder = { type: "custom_message", customType: RECALL_TYPE };
  const other = { type: "custom_message", customType: "other" };
  const msg = { type: "message" };
  assert.equal(branchHasRecallReminder([]), false);
  assert.equal(branchHasRecallReminder([msg, other]), false);
  assert.equal(branchHasRecallReminder([msg, reminder, msg]), true);
  // A reminder from BEFORE the last compaction doesn't count — a fresh one
  // should be injected for the new segment.
  assert.equal(
    branchHasRecallReminder([reminder, { type: "compaction" }, msg, other]),
    false,
  );
  assert.equal(
    branchHasRecallReminder([reminder, { type: "compaction" }, reminder]),
    true,
  );
});

// ── buildSaveTools ──────────────────────────────────────────────────────────

function fakePiTools() {
  const mk = (name: string, description = `${name} tool`) => ({
    name,
    description,
    parameters: { type: "object", properties: { p: { type: "string" } } },
    promptGuidelines: [`use ${name}`],
  });
  const all = [mk("read"), mk("bash"), mk(MEMORY_TOOLS.STORE), mk(MEMORY_TOOLS.SEARCH), mk("edit")];
  return {
    getAllTools: () => all,
    getActiveTools: () => ["read", "bash", MEMORY_TOOLS.STORE, MEMORY_TOOLS.SEARCH],
    events: { emit() {}, on() {} },
  };
}

test("save tools mirror the active list and refuse non-memory calls", async () => {
  const pi = fakePiTools();
  const stored: string[] = [];
  const tools = buildSaveTools(pi as never, () => null, (t) => stored.push(t));
  // Only active tools, in getAllTools order, identical name/description/schema.
  assert.deepEqual(
    tools.map((t) => t.name),
    ["read", "bash", MEMORY_TOOLS.STORE, MEMORY_TOOLS.SEARCH],
  );
  assert.equal(tools[0].description, "read tool");
  assert.deepEqual(tools[0].parameters, {
    type: "object",
    properties: { p: { type: "string" } },
  });
  // Non-memory stub refuses.
  const refused = await tools[0].execute("c1", {}, undefined, undefined, {} as never);
  assert.match(refused.content[0].text, /Not available in the memory save session/);
  // memory_search hits the real executor (backend null → graceful text, not the stub).
  const search = tools.find((t) => t.name === MEMORY_TOOLS.SEARCH)!;
  const res = await search.execute("c2", { query: "x" }, undefined, undefined, {} as never);
  assert.match(res.content[0].text, /backend isn't running|unavailable/i);
  // memory_store with no backend → unavailable details, nothing recorded.
  const store = tools.find((t) => t.name === MEMORY_TOOLS.STORE)!;
  const stored_res = await store.execute(
    "c3",
    { title: "t", content: "c" },
    undefined,
    undefined,
    { cwd: process.cwd() } as never,
  );
  assert.equal((stored_res.details as { action?: string }).action, "unavailable");
  assert.deepEqual(stored, []);
});

test("seed entries carry header + branch verbatim", () => {
  const ctx = {
    sessionManager: {
      getHeader: () => ({ type: "session", id: "h" }),
      getBranch: () => [{ type: "message" }, { type: "custom_message", customType: "x" }],
    },
  };
  const entries = buildSeedEntries(ctx as never);
  assert.equal(entries.length, 3);
  assert.equal((entries[0] as { type: string }).type, "session");
  // No header → branch only.
  const noHeader = buildSeedEntries({
    sessionManager: { getHeader: () => null, getBranch: () => [{ type: "message" }] },
  } as never);
  assert.equal(noHeader.length, 1);
});

// ── mounted extension: recall-once, reload detection, saveMode gating ───────

type Handler = (event: never, ctx: never) => unknown;

function fakePi(activeTools: string[]) {
  const handlers = new Map<string, Handler[]>();
  const sent: { message: { customType?: string }; options?: unknown }[] = [];
  const entries: { type: string; data: unknown }[] = [];
  const unipiEvents = new Map<string, ((payload: unknown) => void)[]>();
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    getActiveTools: () => activeTools,
    setActiveTools() {},
    getAllTools: () => [],
    getThinkingLevel: () => "medium",
    sendMessage: (message: { customType?: string }, options?: unknown) => {
      sent.push({ message, options });
    },
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
    events: {
      emit() {},
      on(name: string, handler: (payload: unknown) => void) {
        unipiEvents.set(name, [...(unipiEvents.get(name) ?? []), handler]);
      },
    },
  };
  return { pi, handlers, sent, entries, unipiEvents };
}

const MEM_TOOLS = [
  MEMORY_TOOLS.STORE,
  MEMORY_TOOLS.SEARCH,
  MEMORY_TOOLS.LIST,
];

async function fire(
  handlers: Map<string, Handler[]>,
  name: string,
  event: unknown,
  ctx: unknown,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const h of handlers.get(name) ?? []) {
    out.push(await h(event as never, ctx as never));
  }
  return out;
}

/**
 * session_start creates the real backend (createSessionBackend →
 * ensureMempalace). On a dev machine uv/mempalace are installed, which would
 * spawn `uv tool install` and a warm MCP reader subprocess — a live child
 * pins the event loop and the test run never exits. Stub PATH only for the
 * session_start fire so install detection fast-paths to "not installed"
 * (markdown-only mode, no subprocesses, no reader).
 */
async function fireSessionStartNoMempalace(
  handlers: Map<string, Handler[]>,
  ctx: unknown,
): Promise<void> {
  const realPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    await fire(handlers, "session_start", {}, ctx);
  } finally {
    process.env.PATH = realPath;
  }
}

/** Shut down every mounted backend at the end of the file (reader/timer). */
const mounts: { handlers: Map<string, Handler[]>; ctx: unknown }[] = [];
after(async () => {
  for (const m of mounts) await fire(m.handlers, "session_shutdown", {}, m.ctx);
});

function fakeCtx(cwd: string, branch: Array<Record<string, unknown>> = []) {
  return {
    cwd,
    hasUI: false,
    mode: "rpc",
    sessionManager: {
      getBranch: () => branch,
      getHeader: () => null,
      getCwd: () => cwd,
    },
    model: undefined,
    ui: { notify() {}, setStatus() {}, setWidget() {} },
    getSystemPrompt: () => "sys",
    getContextUsage: () => undefined,
    isIdle: () => true,
  };
}

function writeTestMemory(cwd: string): void {
  const dir = path.join(
    os.homedir(),
    ".unipi",
    "memory",
    projectName(cwd),
    "summary",
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "m1.md"),
    "---\nid: m1\ntitle: test memory\ntype: summary\n---\n\ncontent\n",
  );
}

test("recall reminder is injected once per session", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mem-save-"));
  writeTestMemory(cwd);
  const { pi, handlers } = fakePi(MEM_TOOLS);
  memoryExtension(pi as never);
  const ctx = fakeCtx(cwd);
  mounts.push({ handlers, ctx });
  await fireSessionStartNoMempalace(handlers, ctx);
  const first = await fire(handlers, "before_agent_start", { prompt: "hi" }, ctx);
  const injected = first.find(
    (r) => (r as { message?: { customType?: string } } | undefined)?.message?.customType === RECALL_TYPE,
  );
  assert.ok(injected, "first turn injects the recall reminder");
  const second = await fire(handlers, "before_agent_start", { prompt: "next" }, ctx);
  assert.equal(
    second.filter(
      (r) => (r as { message?: { customType?: string } } | undefined)?.message?.customType === RECALL_TYPE,
    ).length,
    0,
    "second turn injects nothing",
  );
});

test("reload keeps recallDone when the reminder is already in the branch", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mem-save-"));
  writeTestMemory(cwd);
  const { pi, handlers } = fakePi(MEM_TOOLS);
  memoryExtension(pi as never);
  const ctx = fakeCtx(cwd, [
    { type: "session" },
    { type: "custom_message", customType: RECALL_TYPE },
    { type: "message" },
  ]);
  mounts.push({ handlers, ctx });
  await fireSessionStartNoMempalace(handlers, ctx);
  const res = await fire(handlers, "before_agent_start", { prompt: "hi" }, ctx);
  assert.equal(
    res.filter(
      (r) => (r as { message?: { customType?: string } } | undefined)?.message?.customType === RECALL_TYPE,
    ).length,
    0,
    "no second injection on reload",
  );
});

test("session_compact re-arms the recall reminder", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mem-save-"));
  writeTestMemory(cwd);
  const { pi, handlers } = fakePi(MEM_TOOLS);
  memoryExtension(pi as never);
  const ctx = fakeCtx(cwd);
  mounts.push({ handlers, ctx });
  await fireSessionStartNoMempalace(handlers, ctx);
  await fire(handlers, "before_agent_start", { prompt: "hi" }, ctx);
  await fire(handlers, "session_compact", {}, ctx);
  const res = await fire(handlers, "before_agent_start", { prompt: "after" }, ctx);
  assert.ok(
    res.some(
      (r) => (r as { message?: { customType?: string } } | undefined)?.message?.customType === RECALL_TYPE,
    ),
    "compaction re-injects once",
  );
});

test("saveMode reminder keeps the nextTurn nudge; side mode never sends it", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mem-save-"));
  writeTestMemory(cwd);

  // reminder mode
  const memDir = path.join(os.homedir(), ".unipi", "config", "memory");
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(
    path.join(memDir, "config.json"),
    JSON.stringify({ saveMode: "reminder" }),
  );
  {
    const { pi, handlers, sent } = fakePi(MEM_TOOLS);
    memoryExtension(pi as never);
    const ctx = fakeCtx(cwd);
    mounts.push({ handlers, ctx });
    await fireSessionStartNoMempalace(handlers, ctx);
    await fire(handlers, "before_agent_start", { prompt: "hi" }, ctx);
    await fire(handlers, "agent_end", {}, ctx);
    const retro = sent.find((s) => s.message.customType === RETRO_TYPE);
    assert.ok(retro, "reminder mode queues the nextTurn nudge");
    assert.equal((retro.options as { deliverAs?: string }).deliverAs, "nextTurn");
  }

  // side mode (default): a substantive run starts a save pass — observable via
  // the debug log (no model → the run ends with an error line, no sendMessage,
  // no card).
  fs.writeFileSync(path.join(memDir, "config.json"), JSON.stringify({ saveMode: "side" }));
  process.env.UNIPI_DEBUG_MEMORY = "1";
  const logFile = path.join(os.homedir(), ".unipi", "logs", "memory.log");
  {
    const { pi, handlers, sent, entries } = fakePi(MEM_TOOLS);
    memoryExtension(pi as never);
    const ctx = fakeCtx(cwd);
    mounts.push({ handlers, ctx });
    await fireSessionStartNoMempalace(handlers, ctx);
    await fire(handlers, "before_agent_start", { prompt: "hi" }, ctx);
    await fire(handlers, "agent_start", {}, ctx);
    for (const toolName of ["read", "read", "bash"]) {
      await fire(handlers, "tool_call", { toolName }, ctx);
    }
    await fire(handlers, "agent_end", {}, ctx);
    // The save pass runs async; wait for its debug line.
    let logged = "";
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        logged = fs.readFileSync(logFile, "utf-8");
      } catch {
        /* not yet */
      }
      if (logged.includes("save:")) break;
    }
    assert.match(logged, /save:.*error=no active model/, "side pass started");
    assert.equal(
      sent.filter((s) => s.message.customType === RETRO_TYPE).length,
      0,
      "no nextTurn reminder in side mode",
    );
    assert.equal(
      entries.filter((e) => e.type === SAVE_CARD_TYPE).length,
      0,
      "no card when nothing stored",
    );
  }
});

test("side mode skips non-substantive runs and runs where the agent stored", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mem-save-"));
  writeTestMemory(cwd);
  const memDir = path.join(os.homedir(), ".unipi", "config", "memory");
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, "config.json"), JSON.stringify({ saveMode: "side" }));
  process.env.UNIPI_DEBUG_MEMORY = "1";
  const logFile = path.join(os.homedir(), ".unipi", "logs", "memory.log");
  try {
    fs.unlinkSync(logFile);
  } catch {
    /* fresh */
  }

  const { pi, handlers } = fakePi(MEM_TOOLS);
  memoryExtension(pi as never);
  const ctx = fakeCtx(cwd);
  mounts.push({ handlers, ctx });
  await fireSessionStartNoMempalace(handlers, ctx);
  await fire(handlers, "before_agent_start", { prompt: "hi" }, ctx);

  // 1 tool call, no write → not substantive
  await fire(handlers, "agent_start", {}, ctx);
  await fire(handlers, "tool_call", { toolName: "read" }, ctx);
  await fire(handlers, "agent_end", {}, ctx);

  // agent stored itself → skip
  await fire(handlers, "agent_start", {}, ctx);
  for (const toolName of ["read", MEMORY_TOOLS.STORE, "read"]) {
    await fire(handlers, "tool_call", { toolName }, ctx);
  }
  await fire(handlers, "agent_end", {}, ctx);

  await new Promise((r) => setTimeout(r, 300));
  let logged = "";
  try {
    logged = fs.readFileSync(logFile, "utf-8");
  } catch {
    /* may not exist at all */
  }
  assert.equal(logged.includes("save:"), false, `no save pass started: ${logged}`);
});

/** UNI-56 — save-card usage line is humanized (UI only, raw usage untouched). */
test("saveUsageLine humanizes token counts, keeps zeros readable, does not mutate usage", async () => {
  const { saveUsageLine } = await import("../index.ts");
  const usage = { input: 729296, cacheRead: 17416192, cacheWrite: 0, output: 41994 };
  const snapshot = { ...usage };
  assert.equal(
    saveUsageLine(usage),
    "save pass · input 729k · cache read 17M / write 0 · output 42k tokens",
  );
  assert.equal(saveUsageLine({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }), "save pass · input 0 · cache read 0 / write 0 · output 0 tokens");
  assert.deepEqual(usage, snapshot, "usage object must not be mutated");
});
