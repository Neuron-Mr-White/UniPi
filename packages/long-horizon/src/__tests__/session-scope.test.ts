/**
 * UNI-followup: long-horizon state belongs to the session that started it.
 *
 * Drives the real extension's session_start handler against temp HOME/cwd
 * with a fake pi (same convention as scenarios.test.ts), asserting:
 *  - a new session neither adopts nor wakes another session's graph, and gets
 *    exactly one ui.notify naming the graph task;
 *  - resuming the owning session binds + repairs its graph as before;
 *  - two sessions' graph files stay independent;
 *  - legacy adoption follows the continued-session rule (once);
 *  - the history aggregate includes a sibling's finished graph but never its
 *    open one, and readResult reaches a sibling's finished result;
 *  - a child process neither binds nor warns.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, test } from "node:test";
import { callCommandRunner, resetBusForTests, resetCommandRunners, stateDir } from "@pi-unipi/core";
import longHorizon from "../../index.ts";

const originalHome = process.env.HOME;
const originalCwd = process.cwd();

let home: string;
let project: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lh-session-home-"));
  project = mkdtempSync(join(tmpdir(), "lh-session-proj-"));
  process.env.HOME = home;
  process.chdir(project);
  for (const key of ["UNIPI_FUSION_CHILD", "UNIPI_SUBAGENT_CHILD", "UNIPI_KANBOARD_CHILD", "UNIPI_LH_ALLOW_CHILD"]) delete process.env[key];
});

afterEach(() => {
  process.env.HOME = originalHome;
  process.chdir(originalCwd);
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

// ── fixtures ─────────────────────────────────────────────────────────────────

const GRAPH_V = 1;

function graphFixture(graphId: string, opts: { open?: boolean; running?: boolean; task?: string; withResult?: boolean } = {}): Record<string, unknown> {
  const now = Date.now();
  const work: Record<string, unknown> = {
    workId: "w1",
    instruction: "Investigate the thing",
    target: { kind: "subagent", profile: "subagent_general" },
    inputIds: [],
    selectedResultInputs: [],
    wave: 0,
    revision: 0,
    attempts: 1,
    status: opts.running ? "running" : "completed",
    operatorId: "op-1",
  };
  if (opts.withResult) {
    work.result = "The investigation found the answer.";
    work.resultId = `r-${graphId}-w1`;
  }
  if (opts.running) {
    work.startedAt = now - 1000;
  } else {
    work.endedAt = now - 500;
  }
  const graph: Record<string, unknown> = {
    v: GRAPH_V,
    graphId,
    mode: "graph",
    task: opts.task ?? `task-${graphId}`,
    createdAt: now - 5000,
    revision: 3,
    updatedAt: now - 100,
    work: [work],
  };
  if (!opts.open) graph.finish = { resultIds: opts.withResult ? [`r-${graphId}-w1`] : [], reason: "complete(finish)", at: now - 200 };
  return graph;
}

function ownerFixture(sessionId: string, task: string, pid?: number): Record<string, unknown> {
  return {
    version: 1,
    active: {
      ownerId: `owner-${sessionId}`,
      kind: "graph",
      label: task,
      status: "active",
      revision: 1,
      lease: { ownerId: `owner-${sessionId}`, generation: 1 },
      updatedAt: new Date().toISOString(),
      sessionId,
      ...(pid !== undefined ? { pid } : {}),
    },
    parked: undefined,
    history: [],
  };
}

function writeJson(path: string, body: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(body, null, 2));
}

// ── fake pi + session driving ────────────────────────────────────────────────

interface Ctx {
  hasUI: boolean;
  sessionManager: { getSessionId: () => string; getEntries: () => unknown[] };
  ui: { notify: (message: string, level?: string) => void };
}

function fakePi() {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const sent: string[] = [];
  const runners = new Map<string, (ctx: unknown, args: unknown) => unknown>();
  const target: Record<string | symbol, unknown> = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendUserMessage: (content: string) => {
      sent.push(content);
      return content;
    },
    registerCommandRunner: (name: string, fn: (ctx: unknown, args: unknown) => unknown) => {
      runners.set(name, fn);
    },
    getSessionName: () => undefined,
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerEntryRenderer: () => undefined,
    registerShortcut: () => undefined,
    registerFlag: () => undefined,
    registerNudgeProvider: () => undefined,
    registerCompactionContext: () => undefined,
    registerVisualizeProgressCommand: () => undefined,
    events: { on: () => undefined, emit: () => undefined, get: () => undefined },
  };
  target["sent"] = sent;
  target["runners"] = runners;
  target["handlers"] = handlers;
  const pi = new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      return () => undefined;
    },
  }) as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI & { sent: string[]; runners: Map<string, (ctx: unknown, args: unknown) => unknown>; handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>> };
  return pi;
}

function ctxFor(
  sessionId: string,
  opts: { hasUI?: boolean; entries?: number; notifications: Array<[string, string | undefined]>; entryText?: string },
): Ctx {
  return {
    hasUI: opts.hasUI ?? true,
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () =>
        Array.from({ length: opts.entries ?? 0 }, (_, i) => ({
          type: "message",
          message: { role: i % 2 === 0 ? "assistant" : "user", content: `${opts.entryText ?? "session work"} (entry ${i})` },
        })),
    },
    ui: { notify: (message: string, level?: string) => opts.notifications.push([message, level]) },
  };
}

function fireSessionStart(pi: ReturnType<typeof fakePi>, reason: string, ctx: Ctx): void {
  for (const handler of pi.handlers.get("session_start") ?? []) handler({ reason }, ctx);
}

/** The dirs index.ts computes — stateDir() is the same call the extension makes. */
function lhDir(): string {
  return stateDir("long-horizon", "state");
}
function sessionDir(sessionId: string): string {
  return join(lhDir(), "sessions", sessionId);
}
function workspaceLhDir(): string {
  return lhDir();
}

// ── tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetBusForTests();
  resetCommandRunners();
});

test("new session: empty owner, sibling graph untouched byte-for-byte, no wake, exactly one notify", async () => {
  const pi = fakePi();
  longHorizon(pi);
  const notifyA: Array<[string, string | undefined]> = [];
  const ctxA = ctxFor("session-aaa", { notifications: notifyA, entries: 3 });
  fireSessionStart(pi, "startup", ctxA);

  // Session A owns a graph with RUNNING work (state + graph on disk).
  const aDir = sessionDir("session-aaa");
  mkdirSync(aDir, { recursive: true });
  writeJson(join(aDir, "state.json"), ownerFixture("session-aaa", "Ship the parser", process.pid));
  const graphBytes = JSON.stringify(graphFixture("graph-A", { open: true, running: true, task: "Ship the parser" }), null, 2);
  writeJson(join(aDir, "graph.json"), { v: GRAPH_V, current: JSON.parse(graphBytes), history: [] });
  const before = readFileSync(join(aDir, "graph.json"));

  // Session B: a brand-new session (/new).
  const notificationsB: Array<[string, string | undefined]> = [];
  const ctxB = ctxFor("session-bbb", { notifications: notificationsB, entries: 0 });
  fireSessionStart(pi, "new", ctxB);

  const bDir = sessionDir("session-bbb");
  assert.ok(!existsSync(join(bDir, "state.json")), "B's owner slot stays empty");
  const afterBytes = readFileSync(join(aDir, "graph.json"), "utf8");
  if (afterBytes !== before.toString()) {
    console.log('BEFORE:', before.slice(0, 400));
    console.log('AFTER:', afterBytes.slice(0, 400));
  }
  assert.equal(afterBytes, before.toString(), "A's graph.json untouched byte-for-byte");
  assert.deepEqual(pi.sent, [], "no sendUserMessage wake in B");
  assert.equal(notificationsB.length, 1, "exactly one ui.notify");
  assert.match(notificationsB[0]![0], /Ship the parser/);
  assert.match(notificationsB[0]![0], /another session/);
  if (notificationsB[0]![1] !== "info") throw new Error("notify must be info level");
});

test("resuming the owning session binds its graph and repairs running work", async () => {
  const pi = fakePi();
  longHorizon(pi);
  const ctxA = ctxFor("session-aaa", { notifications: [], entries: 3 });
  fireSessionStart(pi, "startup", ctxA);
  const aDir = sessionDir("session-aaa");
  mkdirSync(aDir, { recursive: true });
  writeJson(join(aDir, "state.json"), ownerFixture("session-aaa", "Ship the parser", process.pid));
  writeJson(join(aDir, "graph.json"), { v: GRAPH_V, current: graphFixture("graph-A", { open: true, running: true, task: "Ship the parser" }), history: [] });

  // A resumes: the graph binds and the interrupted work is repaired.
  const ctxResume = ctxFor("session-aaa", { notifications: [], entries: 5 });
  fireSessionStart(pi, "resume", ctxResume);
  const graph = JSON.parse(readFileSync(join(aDir, "graph.json"), "utf8")) as { current?: { work: Array<{ status: string; resumeOperatorId?: string; restartResumes?: number }> } };
  if (graph.current?.work[0]?.status !== "queued") console.log('FILE AFTER RESUME:', readFileSync(join(aDir, 'graph.json'), 'utf8').slice(0, 500));
  assert.equal(graph.current?.work[0]?.status, "queued", "running work repaired to queued");
  assert.equal(graph.current?.work[0]?.resumeOperatorId, "op-1", "resume keeps the operator");
});

test("two sessions run independent graphs", async () => {
  const pi = fakePi();
  longHorizon(pi);
  const ctxA = ctxFor("session-aaa", { notifications: [], entries: 3 });
  fireSessionStart(pi, "startup", ctxA);
  const aDir = sessionDir("session-aaa");
  mkdirSync(aDir, { recursive: true });
  writeJson(join(aDir, "state.json"), ownerFixture("session-aaa", "A task", process.pid));
  writeJson(join(aDir, "graph.json"), { v: GRAPH_V, current: graphFixture("graph-A", { open: true, running: true, task: "A task" }), history: [] });

  const notificationsB: Array<[string, string | undefined]> = [];
  const ctxB = ctxFor("session-bbb", { notifications: notificationsB, entries: 0 });
  fireSessionStart(pi, "new", ctxB);
  const bDir = sessionDir("session-bbb");
  mkdirSync(bDir, { recursive: true });
  writeJson(join(bDir, "state.json"), ownerFixture("session-bbb", "B task", process.pid));
  writeJson(join(bDir, "graph.json"), { v: GRAPH_V, current: graphFixture("graph-B", { open: true, running: true, task: "B task" }), history: [] });

  const aGraph = JSON.parse(readFileSync(join(aDir, "graph.json"), "utf8")) as { current?: { graphId: string } };
  const bGraph = JSON.parse(readFileSync(join(bDir, "graph.json"), "utf8")) as { current?: { graphId: string } };
  assert.equal(aGraph.current?.graphId, "graph-A");
  assert.equal(bGraph.current?.graphId, "graph-B");
  assert.notEqual(aGraph.current?.graphId, bGraph.current?.graphId);
  // B resuming itself does not touch A.
  fireSessionStart(pi, "resume", ctxB);
  assert.equal((JSON.parse(readFileSync(join(aDir, "graph.json"), "utf8")) as { current?: { graphId: string } }).current?.graphId, "graph-A");
});

test("legacy adoption: only the OWNING continued session adopts — unrelated resume leaves it; new session still gets the note", async () => {
  const pi = fakePi();
  longHorizon(pi);
  // Legacy state at the pre-split workspace level AND the older in-repo dir:
  // a GOAL run (workspace level) and a GRAPH run (in-repo).
  const wsDir = workspaceLhDir();
  mkdirSync(wsDir, { recursive: true });
  writeJson(join(wsDir, "goal.json"), { goalId: "g-legacy", objective: "Old goal", status: "paused" });
  const inRepo = join(project, ".unipi", "long-horizon");
  mkdirSync(inRepo, { recursive: true });
  writeJson(join(inRepo, "state.json"), ownerFixture("session-old", "Old owner task"));
  writeJson(join(inRepo, "graph.json"), { v: GRAPH_V, current: graphFixture("graph-old", { open: true, running: true, task: "Old owner task" }), history: [] });

  // 1. A brand-new session never adopts (and gets the sibling-owner note:
  //    the legacy graph is exactly what the note is for).
  const notificationsNew: Array<[string, string | undefined]> = [];
  const ctxNew = ctxFor("session-new", { notifications: notificationsNew, entries: 0 });
  fireSessionStart(pi, "new", ctxNew);
  assert.ok(existsSync(join(wsDir, "goal.json")), "workspace-level goal untouched");
  assert.ok(existsSync(join(inRepo, "state.json")), "in-repo state untouched");
  assert.ok(notificationsNew.some(([msg]) => msg.includes("Old owner task")), "new session warned about the legacy graph");

  // 2. An UNRELATED continued session does not adopt: its entries never
  //    mention the legacy goal/graph. The first `pi -r` of anything must
  //    not capture the old run.
  const ctxUnrelated = ctxFor("session-unrelated", { notifications: [], entries: 2, entryText: "planning some unrelated refactoring" });
  fireSessionStart(pi, "resume", ctxUnrelated);
  assert.ok(existsSync(join(wsDir, "goal.json")), "unrelated resume leaves the legacy goal");
  assert.ok(existsSync(join(inRepo, "graph.json")), "unrelated resume leaves the legacy graph");
  assert.ok(!existsSync(join(sessionDir("session-unrelated"), "goal.json")), "unrelated session dir stays empty");

  // 3. The OWNING continued session adopts: its entries prove ownership.
  const ctxOwner = ctxFor("session-owner", { notifications: [], entries: 3, entryText: "continuing goal g-legacy (Old goal); graph-old checkpoint noted" });
  fireSessionStart(pi, "resume", ctxOwner);
  const ownerDir = sessionDir("session-owner");
  if (!existsSync(join(ownerDir, "goal.json"))) {
    console.log('ADOPT-DBG ownerDir exists:', existsSync(ownerDir), 'contents:', existsSync(ownerDir) ? readdirSync(ownerDir) : '-', '| wsDir:', readdirSync(wsDir), '| inRepo:', readdirSync(inRepo), '| sessions:', readdirSync(join(lhDir(), 'sessions')));
    console.log('ADOPT-DBG evidence recheck: entries:', JSON.stringify([{ type: 'message', message: { role: 'assistant', content: 'continuing goal g-legacy (Old goal); graph-old checkpoint noted (entry 0)' } }]).includes('g-legacy'));
  }
  assert.ok(existsSync(join(ownerDir, "goal.json")), "goal.json adopted by the owning session");
  assert.ok(existsSync(join(ownerDir, "state.json")), "state.json adopted");
  assert.ok(existsSync(join(ownerDir, "graph.json")), "graph.json adopted");
  assert.ok(!existsSync(join(wsDir, "goal.json")), "workspace-level source gone after adoption");
  assert.ok(!existsSync(join(inRepo, "state.json")) && !existsSync(join(inRepo, "graph.json")), "in-repo sources gone after adoption");

  // 4. A second continued session finds nothing left to adopt.
  const ctxSecond = ctxFor("session-second", { notifications: [], entries: 4, entryText: "g-legacy follow-up" });
  fireSessionStart(pi, "resume", ctxSecond);
  assert.ok(!existsSync(join(sessionDir("session-second"), "goal.json")), "second continued session starts clean");
});
test("history aggregate: sibling finished graph in, sibling open graph out; readResult reaches a sibling result", async () => {
  const pi = fakePi();
  longHorizon(pi);
  // My own finished graph — on disk BEFORE session_start (as after a resume).
  const meDir = sessionDir("session-me");
  mkdirSync(meDir, { recursive: true });
  writeJson(join(meDir, "graph.json"), { v: GRAPH_V, current: undefined, history: [graphFixture("graph-mine", { open: false, task: "mine done", withResult: true })] });

  const ctxMe = ctxFor("session-me", { notifications: [], entries: 3 });
  fireSessionStart(pi, "startup", ctxMe);

  // Sibling: a FINISHED graph (should appear) + an OPEN one (must not).
  const sDir = sessionDir("session-sib");
  mkdirSync(sDir, { recursive: true });
  const sibOpen = graphFixture("graph-sib-open", { open: true, running: true, task: "sibling open" });
  const sibDone = graphFixture("graph-sib-done", { open: false, task: "sibling done", withResult: true });
  writeJson(join(sDir, "graph.json"), { v: GRAPH_V, current: sibOpen, history: [sibDone] });

  const history = (await callCommandRunner<{ runs: Array<{ label?: string }> }>("unipi:lh-graph", {}, { op: "history" })) as { found: boolean; result?: { ok: boolean; runs: Array<{ label?: string }> } };
  if (!history.found || !history.result?.ok) console.log('HISTORY RESULT:', JSON.stringify(history).slice(0, 600));
  assert.ok(history.found && history.result!.ok);
  const labels = history.result!.runs.map((r) => r.title ?? "");

  assert.ok(labels.some((l) => l.includes("mine done")), "own history listed");
  assert.ok(labels.some((l) => l.includes("sibling done")), "sibling finished graph included");
  assert.ok(!labels.some((l) => l.includes("sibling open")), "sibling OPEN graph excluded");

  // THIS session's own step: the bound engine found it — served directly.
  // Regression: `found` used to fall through to "That step is gone." because
  // the sibling lookup only ran when !found.
  const own = (await callCommandRunner<{ ok: boolean; output?: { text?: string; graphId?: string } }>("unipi:lh-graph", {}, { op: "output", id: "w1", graphId: "graph-mine" })) as { found: boolean; result?: { ok: boolean; output?: { text?: string; graphId?: string } } };
  assert.ok(own.found && own.result!.ok, "own result served");
  assert.equal(own.result!.output?.text, "The investigation found the answer.");
  assert.equal(own.result!.output?.graphId, "graph-mine");
  // Also without an explicit graphId (readResult searches current + history).
  const ownNoId = (await callCommandRunner<{ ok: boolean; output?: { graphId?: string } }>("unipi:lh-graph", {}, { op: "output", id: "w1" })) as { found: boolean; result?: { ok: boolean; output?: { graphId?: string } } };
  assert.ok(ownNoId.found && ownNoId.result!.ok && ownNoId.result!.output?.graphId === "graph-mine", "own result found without graphId too");

  // readResult with an explicit graphId reaches the sibling's finished result.
  const out = (await callCommandRunner<{ ok: boolean; output?: { text?: string } }>("unipi:lh-graph", {}, { op: "output", id: "w1", graphId: "graph-sib-done" })) as { found: boolean; result?: { ok: boolean; output?: { text?: string } } };
  assert.ok(out.found && out.result!.ok, "sibling finished result found");
  assert.equal(out.result!.output?.text, "The investigation found the answer.");
  const outOpen = (await callCommandRunner<{ ok: boolean }>("unipi:lh-graph", {}, { op: "output", id: "w1", graphId: "graph-sib-open" })) as { found: boolean; result?: { ok: boolean } };
  assert.ok(outOpen.found && !outOpen.result!.ok, "a sibling's OPEN graph result is not served");
});

test("child process: no bind, no adoption, no warning", async () => {
  const pi = fakePi();
  longHorizon(pi);
  const notifyA: Array<[string, string | undefined]> = [];
  const ctxA = ctxFor("session-aaa", { notifications: notifyA, entries: 3 });
  fireSessionStart(pi, "startup", ctxA);
  const aDir = sessionDir("session-aaa");
  mkdirSync(aDir, { recursive: true });
  writeJson(join(aDir, "state.json"), ownerFixture("session-aaa", "A task", process.pid));
  const graphFile = { v: GRAPH_V, current: graphFixture("graph-A", { open: true, running: true, task: "A task" }), history: [] };
  writeJson(join(aDir, "graph.json"), graphFile);
  const before = readFileSync(join(aDir, "graph.json"), "utf8");

  // Legacy workspace-level state present: a child must not adopt it either.
  const wsDir = workspaceLhDir();
  mkdirSync(wsDir, { recursive: true });
  writeJson(join(wsDir, "goal.json"), { goalId: "g-legacy", objective: "Old", status: "paused" });

  process.env.UNIPI_SUBAGENT_CHILD = "1";
  try {
    const notificationsK: Array<[string, string | undefined]> = [];
    const ctxK = ctxFor("session-kid", { notifications: notificationsK, entries: 0 });
    fireSessionStart(pi, "startup", ctxK);
    assert.equal(notificationsK.length, 0, "child gets no warning");
    assert.equal(readFileSync(join(aDir, "graph.json"), "utf8"), before, "A's graph untouched (no bind repair from the child)");
    assert.ok(existsSync(join(wsDir, "goal.json")), "child does not adopt legacy state");
    const kDir = sessionDir("session-kid");
    assert.ok(!existsSync(join(kDir, "goal.json")), "child's own dir stays empty");
  } finally {
    delete process.env.UNIPI_SUBAGENT_CHILD;
  }
});

test("housekeeping: stale empty sibling dirs are pruned; owned/open ones stay", async () => {
  const pi = fakePi();
  longHorizon(pi);
  const ctxMe = ctxFor("session-me", { notifications: [], entries: 3 });
  fireSessionStart(pi, "startup", ctxMe);

  const sessionsRoot = join(workspaceLhDir(), "sessions");
  const stale = join(sessionsRoot, "session-stale");
  const owned = join(sessionsRoot, "session-owned");
  mkdirSync(stale, { recursive: true });
  mkdirSync(join(owned, "ralph"), { recursive: true });
  // age the dirs beyond 30 days
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  utimesSync(stale, old, old);
  utimesSync(owned, old, old);
  writeJson(join(owned, "state.json"), ownerFixture("session-owned", "Still mine", process.pid));

  // The prune runs as part of session_start (housekeeping) — drive one more.
  const ctxNext = ctxFor("session-next", { notifications: [], entries: 0 });
  fireSessionStart(pi, "new", ctxNext);
  assert.ok(!existsSync(stale), "stale empty dir pruned");
  assert.ok(existsSync(owned), "owned dir stays");
});
