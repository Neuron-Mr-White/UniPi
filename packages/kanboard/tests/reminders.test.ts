/**
 * Progress reminders (src/reminders.ts) and the free `start`/`finish` writes.
 * Scripted tool sequences against a fake board, then one end-to-end pass
 * against the real debug binary in a temp UNIPI_KANBOARD_HOME.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ANTI_POISONING_SUFFIX,
  MAX_REMINDERS_PER_TASK,
  REMINDER_CUSTOM_TYPE,
  createProgressTracker,
  isFileChangingCall,
  registerProgressReminders,
  sendReminder,
  shellChangesFiles,
  taskIdsIn,
  type TrackerDeps,
} from "../src/reminders.js";
import { createWriteGuard, isFreeWrite, kanboardInvocations, WRITE_CREDITS_USED_UP } from "../src/guard.js";
import { doText } from "../src/commands.js";
import { setSettings } from "@pi-unipi/core";
import { DEFAULT_SETTINGS, readKanboardSettings, registerKanboardSettings } from "../src/settings.js";
import { asTask, asTaskList, type KanboardTask } from "../src/shapes.js";

const SESSION = "sess-1";
const BIN = "/abs/unipi-kanboard";

/** A mutable fake board: tasks keyed by id. */
function fakeBoard(initial: Record<string, string>) {
  const tasks = new Map<string, KanboardTask>();
  for (const [id, status] of Object.entries(initial)) tasks.set(id, { id, title: id, status });
  return {
    tasks,
    lists: 0,
    start(id: string, session = SESSION, owner = "agent") {
      const task = tasks.get(id)!;
      task.status = "in_progress";
      task.run = { session, owner } as KanboardTask["run"];
    },
    finish(id: string) {
      const task = tasks.get(id)!;
      task.status = "in_review";
      task.run = null;
    },
  };
}

function tracker(board: ReturnType<typeof fakeBoard>, extra: Partial<TrackerDeps> = {}) {
  return createProgressTracker({
    enabled: () => true,
    runnerOwned: () => false,
    session: () => SESSION,
    list: async () => {
      board.lists += 1;
      return [...board.tasks.values()].map((task) => ({ ...task }));
    },
    cliPrefix: () => `${BIN} --actor agent --project p`,
    ...extra,
  });
}

const edit = { toolName: "edit", input: { path: "a.ts" }, content: [{ type: "text", text: "edited" }] };
const bash = (command: string, isError = false) => ({
  toolName: "bash",
  input: { command },
  content: [{ type: "text", text: "out" }],
  isError,
});
const read = { toolName: "read", input: { path: "a.ts" }, content: [{ type: "text", text: "file" }] };
const textOf = (result: { content: Array<{ text?: string }> } | undefined): string =>
  (result?.content ?? []).map((part) => part.text ?? "").join("");

describe("detection helpers", () => {
  it("finds board ids in prompts", () => {
    assert.deepEqual(taskIdsIn("do UNI-5 and UNI-8, then UNI-5 again"), ["UNI-5", "UNI-8"]);
    assert.deepEqual(taskIdsIn("utf-8 and x-1 are not ids; FIX2-10 is"), ["FIX2-10"]);
  });

  it("classifies file-changing calls", () => {
    assert.ok(isFileChangingCall("edit", {}));
    assert.ok(isFileChangingCall("write", {}));
    assert.ok(!isFileChangingCall("read", {}));
    assert.ok(!isFileChangingCall("grep", {}));
    for (const cmd of ["ls -la", "git status", "rg foo src", "cat a | head -3", "cd x && git diff", "echo hi 2>&1", "grep x a >/dev/null"]) {
      assert.ok(!shellChangesFiles(cmd), cmd);
    }
    for (const cmd of ["npm test", "echo x > a.txt", "sed -i s/a/b/ f", "git commit -m x", "rm -rf build", "cat a >> b", "python3 fix.py"]) {
      assert.ok(shellChangesFiles(cmd), cmd);
    }
    // Board calls are not file changes (reads and writes alike).
    assert.ok(!shellChangesFiles(`${BIN} --actor agent start UNI-5`));
    assert.ok(!shellChangesFiles(`${BIN} show UNI-5 --json`));
  });
});

describe("R1: steer on the first file-changing call", () => {
  it("fires once per turn, naming the mentioned Todo ids", async () => {
    const board = fakeBoard({ "UNI-5": "todo", "UNI-8": "todo", "UNI-9": "todo" });
    const t = tracker(board);
    t.onPrompt("do UNI-5 and UNI-8");
    t.onTurnStart();
    assert.equal(await t.onToolResult(read), undefined, "reads never check");
    assert.equal(await t.onToolResult(bash("rg foo")), undefined, "read-only shell never checks");
    assert.equal(board.lists, 0, "no board call before a file change");
    const first = await t.onToolResult(edit);
    const text = textOf(first);
    assert.match(text, /^edited/, "appended to the original tool result");
    assert.match(text, /UNI-5, UNI-8 are still Todo/);
    assert.doesNotMatch(text, /UNI-9/, "unmentioned tasks are not named");
    assert.match(text, /start <ID>/);
    assert.ok(text.includes(ANTI_POISONING_SUFFIX));
    // Same turn: later edits stay quiet (and don't hit the board).
    const lists = board.lists;
    assert.equal(await t.onToolResult(edit), undefined);
    assert.equal(await t.onToolResult(bash("npm test")), undefined);
    assert.equal(board.lists, lists);
  });

  it("is silent once the session started a task", async () => {
    const board = fakeBoard({ "UNI-5": "todo", "UNI-8": "todo" });
    const t = tracker(board);
    t.onPrompt("do UNI-5 and UNI-8");
    t.onTurnStart();
    board.start("UNI-5");
    await t.onToolResult(bash(`${BIN} --actor agent --project p start UNI-5`));
    assert.equal(await t.onToolResult(edit), undefined, "UNI-8 still todo, but a task is started");
  });

  it("counts another session's or the runner's claim as not started", async () => {
    const board = fakeBoard({ "UNI-5": "todo", "UNI-7": "todo" });
    board.start("UNI-7", "other-session");
    const t = tracker(board);
    t.onPrompt("do UNI-5");
    t.onTurnStart();
    assert.match(textOf(await t.onToolResult(edit)), /UNI-5 is still Todo/);
  });

  it("is silent without mentions, with the setting off, in runner runs and for non-todo ids", async () => {
    const board = fakeBoard({ "UNI-5": "todo", "UNI-6": "backlog" });
    const none = tracker(board);
    none.onTurnStart();
    assert.equal(await none.onToolResult(edit), undefined, "no mention");

    const off = tracker(board, { enabled: () => false });
    off.onPrompt("do UNI-5");
    off.onTurnStart();
    assert.equal(await off.onToolResult(edit), undefined, "setting off");

    const runner = tracker(board, { runnerOwned: () => true });
    runner.onPrompt("do UNI-5");
    runner.onTurnStart();
    assert.equal(await runner.onToolResult(edit), undefined, "runner-owned run");

    const unknown = tracker(board);
    unknown.onPrompt("do UNI-6 and NOPE-1");
    unknown.onTurnStart();
    assert.equal(await unknown.onToolResult(edit), undefined, "backlog/missing ids are not Todo");
  });

  it("does not record mentions from runner prompts or its own reminders", () => {
    let owned = true;
    const t = tracker(fakeBoard({}), { runnerOwned: () => owned });
    t.onPrompt("[kanboard UNI-3] Fix it — depends on UNI-2");
    owned = false;
    t.onPrompt(`[kanboard] UNI-4 is still In Progress. ${ANTI_POISONING_SUFFIX}`);
    assert.deepEqual(t.state().mentioned, []);
  });

  it("records ids the agent `show`ed as mentions", async () => {
    const board = fakeBoard({ "UNI-5": "todo" });
    const t = tracker(board);
    t.onTurnStart();
    await t.onToolResult(bash(`${BIN} --actor agent --project p show UNI-5`));
    assert.match(textOf(await t.onToolResult(edit)), /UNI-5 is still Todo/);
  });

  it("re-arms per turn and gives up after the per-task cap", async () => {
    const board = fakeBoard({ "UNI-5": "todo" });
    const t = tracker(board);
    t.onPrompt("do UNI-5");
    let fired = 0;
    for (let turn = 0; turn < 4; turn += 1) {
      t.onTurnStart();
      if (await t.onToolResult(edit)) fired += 1;
    }
    assert.equal(fired, MAX_REMINDERS_PER_TASK);
  });

  it("survives a board error without steering", async () => {
    const t = tracker(fakeBoard({}), { list: async () => Promise.reject(new Error("boom")) });
    t.onPrompt("do UNI-5");
    t.onTurnStart();
    assert.equal(await t.onToolResult(edit), undefined);
  });
});

describe("R2: follow-up at agent_end", () => {
  it("names started tasks still In Progress, max 2 per task", async () => {
    const board = fakeBoard({ "UNI-5": "todo", "UNI-8": "todo" });
    const t = tracker(board);
    t.onPrompt("do UNI-5 and UNI-8");
    t.onTurnStart();
    for (const id of ["UNI-5", "UNI-8"]) {
      board.start(id);
      await t.onToolResult(bash(`${BIN} --actor agent --project p start ${id}`));
    }
    board.finish("UNI-5");
    const first = await t.onAgentEnd({ messages: [] });
    assert.ok(first);
    assert.match(first!, /UNI-8 is still In Progress/);
    assert.doesNotMatch(first!, /UNI-5/, "finished tasks are dropped");
    assert.match(first!, /finish UNI-8 --comment/);
    assert.match(first!, /move UNI-8 blocked --comment/);
    assert.ok(first!.includes(ANTI_POISONING_SUFFIX));
    assert.ok(await t.onAgentEnd({ messages: [] }), "second reminder");
    assert.equal(await t.onAgentEnd({ messages: [] }), null, "capped at 2");
    assert.deepEqual(t.state().r2, { "UNI-8": 2 });
  });

  it("stays quiet when nothing was started, the start failed, the turn was aborted or the runner owns it", async () => {
    const board = fakeBoard({ "UNI-5": "todo" });
    const t = tracker(board);
    assert.equal(await t.onAgentEnd({ messages: [] }), null, "nothing started");
    await t.onToolResult(bash(`${BIN} start UNI-5`, true));
    assert.equal(await t.onAgentEnd({ messages: [] }), null, "a refused start is not a start");

    board.start("UNI-5");
    await t.onToolResult(bash(`${BIN} start UNI-5`));
    assert.equal(
      await t.onAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] }),
      null,
      "user abort",
    );
    let owned = true;
    const runner = tracker(board, { runnerOwned: () => owned });
    await runner.onToolResult(bash(`${BIN} start UNI-5`));
    assert.equal(await runner.onAgentEnd({ messages: [] }), null, "runner run");
    owned = false;
    assert.ok(await runner.onAgentEnd({ messages: [] }), "fires once the runner is idle");
  });

  it("drops tasks that were blocked or reaped", async () => {
    const board = fakeBoard({ "UNI-5": "todo" });
    const t = tracker(board);
    board.start("UNI-5");
    await t.onToolResult(bash(`${BIN} start UNI-5`));
    board.tasks.get("UNI-5")!.status = "blocked";
    board.tasks.get("UNI-5")!.run = null;
    assert.equal(await t.onAgentEnd({ messages: [] }), null);
    assert.deepEqual(t.state().started, []);
  });
});

describe("pi wiring", () => {
  it("steers through tool_result and delivers R2 only when taken", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const sent: Array<{ message: { customType: string; content: string; display: boolean }; options: unknown }> = [];
    const pi = {
      on: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler),
      sendMessage: (message: never, options: unknown) => sent.push({ message, options }),
    } as never;
    const board = fakeBoard({ "UNI-5": "todo" });
    const wired = registerProgressReminders(pi, tracker(board));
    await handlers.get("before_agent_start")!({ prompt: "please do UNI-5" });
    await handlers.get("agent_start")!({});
    const steered = (await handlers.get("tool_result")!(edit)) as { content: Array<{ text?: string }> };
    assert.match(textOf(steered), /UNI-5 is still Todo/);
    board.start("UNI-5");
    await handlers.get("tool_result")!(bash(`${BIN} start UNI-5`));
    await handlers.get("agent_end")!({ messages: [] });
    assert.equal(sent.length, 0, "nothing is sent from agent_end itself");
    const text = wired.takePending();
    assert.match(text ?? "", /UNI-5 is still In Progress/);
    assert.equal(wired.takePending(), null);
    sendReminder(pi, text!);
    assert.equal(sent[0]!.message.customType, REMINDER_CUSTOM_TYPE);
    assert.deepEqual(sent[0]!.options, { triggerTurn: true });
  });
});

describe("the write window: start/finish are free", () => {
  it("passes start/finish without a -do window and without spending credits", () => {
    const guard = createWriteGuard(() => null, () => 20, () => 10);
    assert.ok(isFreeWrite(kanboardInvocations(`${BIN} --actor agent start UNI-5`)[0]!));
    assert.equal(guard.check(`${BIN} --actor agent --project p start UNI-5`), null);
    assert.equal(guard.check(`${BIN} --actor agent --project p finish UNI-5 --comment "done"`), null);
    assert.equal(guard.remaining(), 0);
    assert.equal(guard.check(`${BIN} note UNI-5 x`), WRITE_CREDITS_USED_UP, "other writes still need credits");
    guard.open();
    assert.equal(guard.check(`${BIN} start UNI-6 && ${BIN} finish UNI-6 --comment ok && ${BIN} note UNI-6 x`), null);
    assert.equal(guard.remaining(), 9, "only the note cost a credit");
  });
});

describe("settings + prompt text", () => {
  it("reminders default on; only an explicit false turns them off", () => {
    assert.equal(DEFAULT_SETTINGS.reminders, true);
    registerKanboardSettings();
    const cwd = mkdtempSync(join(tmpdir(), "kb-rem-set-"));
    try {
      setSettings("kanboard", { reminders: "nope" }, "project", cwd);
      assert.equal(readKanboardSettings(cwd).reminders, true, "garbage → default on");
      setSettings("kanboard", { reminders: false }, "project", cwd);
      assert.equal(readKanboardSettings(cwd).reminders, false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("the -do text tells the agent to start and finish", () => {
    const text = doText("slug", BIN, "do UNI-5");
    assert.match(text, /`start <ID>` it before working on it/);
    assert.match(text, /`finish <ID> --comment "<summary>"` it when done/);
    assert.match(text, /queue <IDs>/);
  });
});

// ─── real binary ────────────────────────────────────────────────────────────

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const binary = join(repoRoot, "crates", "kanboard", "target", "debug", "unipi-kanboard");

describe("start/finish against the real binary", { skip: !existsSync(binary) }, () => {
  let home: string;
  let workspace: string;

  const run = (args: string[], env: Record<string, string> = {}): unknown => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("UNIPI_KANBOARD_")));
    return JSON.parse(
      execFileSync(binary, [...args, "--json"], {
        cwd: workspace,
        encoding: "utf-8",
        env: { ...clean, UNIPI_KANBOARD_HOME: home, UNIPI_KANBOARD_ACTOR: "user", ...env },
      }),
    );
  };
  const agent = { UNIPI_KANBOARD_ACTOR: "agent", UNIPI_KANBOARD_SESSION: SESSION, UNIPI_KANBOARD_PID: String(process.pid) };

  before(() => {
    home = mkdtempSync(join(tmpdir(), "kb-rem-home-"));
    workspace = mkdtempSync(join(tmpdir(), "kb-rem-ws-"));
    run(["project", "add", "--name", "Rem", "--prefix", "REM"]);
  });
  after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("R1 → start → R2 → finish on a real board", async () => {
    const a = asTask("add", run(["add", "first", "--status", "todo"]));
    const b = asTask("add", run(["add", "second", "--status", "todo"]));
    const t = createProgressTracker({
      enabled: () => true,
      runnerOwned: () => false,
      session: () => SESSION,
      list: async () => asTaskList(run(["list"])).tasks,
      cliPrefix: () => null,
    });
    t.onPrompt(`do ${a.id} and ${b.id}`);
    t.onTurnStart();
    assert.match(textOf(await t.onToolResult(edit)), new RegExp(`${a.id}, ${b.id} are still Todo`));

    const started = asTask("start", run(["start", a.id], agent));
    assert.equal(started.status, "in_progress");
    assert.equal((started.run as { owner?: string }).owner, "agent");
    await t.onToolResult(bash(`unipi-kanboard --actor agent start ${a.id}`));
    t.onTurnStart();
    assert.equal(await t.onToolResult(edit), undefined, "silent after start");
    assert.match((await t.onAgentEnd({ messages: [] })) ?? "", new RegExp(`${a.id} is still In Progress`));

    // Another session can't finish it; this one can.
    assert.throws(() => run(["finish", a.id, "--comment", "x"], { ...agent, UNIPI_KANBOARD_SESSION: "other" }));
    const done = asTask("finish", run(["finish", a.id, "--comment", "did it"], agent));
    assert.equal(done.status, "in_review");
    assert.equal(await t.onAgentEnd({ messages: [] }), null, "nothing left in progress");
  });
});
