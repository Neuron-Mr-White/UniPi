import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox ~/.unipi for the manager's state writes.
const HOME = mkdtempSync(join(tmpdir(), "sa4-home-"));
process.env.HOME = HOME;

import { SubagentManager, recordStatusFor, getSharedSubagents } from "../manager.js";
import { buildTranscript, itemsFromSessionFile, itemsFromEvents } from "../transcript.js";
import { SubagentDock, stripText, renderItems, profileLabel, elapsed } from "../ui.js";
import { agentMarkdown, validateName, agentFile } from "../agents.js";
import { loadProfiles } from "../profiles.js";
import { cardOutcome } from "../index.js";
import { ChildAgentRuntime, DENY_WITH_NOTE, BACKGROUND_DENY_NOTE } from "@pi-unipi/core/child-agent.js";

const tmp = () => mkdtempSync(join(tmpdir(), "sa4-"));
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;

type Settle = (r: unknown) => void;
function fakeManager() {
  const runtimes: Array<{ settle: Settle; aborted: number; killed: boolean; events: unknown[] }> = [];
  const factory = () => {
    let settle!: Settle;
    const done = new Promise((r) => (settle = r));
    const rt = {
      aborted: 0,
      killed: false,
      events: [] as unknown[],
      settle: (r: unknown) => settle(r),
      reports: new Map(),
      attachUi() {},
      detachUi() {},
      kill() { rt.killed = true; },
      async abort() { rt.aborted += 1; },
      progress: () => ({ toolCalls: 2, events: rt.events }),
      handoff: () => ({ id: "h", done }),
    };
    runtimes.push(rt);
    return rt as never;
  };
  return { manager: new SubagentManager(factory as never), runtimes };
}
const profile = { id: "subagent_explore", description: "e", systemPrompt: "p", source: "builtin" as const, tools: ["read"] };
const report = (status: string, extra: Record<string, unknown> = {}) => ({ id: "h", status, text: "partial", toolCalls: 3, durationMs: 1200, events: [], usage: {}, ...extra });
const flush = () => new Promise((r) => setImmediate(r));

// ── status mapping + cancel ────────────────────────────────────────────────

test("status: aborted/interrupted/user-cancel → cancelled; error → failed", () => {
  assert.equal(recordStatusFor({ status: "completed" }), "completed");
  assert.equal(recordStatusFor({ status: "aborted" }), "cancelled");
  assert.equal(recordStatusFor({ status: "interrupted" }), "cancelled");
  assert.equal(recordStatusFor({ status: "error" }), "failed");
  assert.equal(recordStatusFor({ status: "error" }, "user"), "cancelled", "a forced kill after cancel is still a cancel");
});

test("cancel: aborts the child, marks cancelledBy, settles as cancelled", async () => {
  const { manager, runtimes } = fakeManager();
  const cwd = tmp();
  const r = manager.start({ title: "t", task: "look", profile, model: "a/b", thinking: "low", cwd, leadSessionId: "c1", background: true });
  assert.ok("run" in r);
  const id = r.run.record.id;
  assert.equal(manager.cancel(id), true);
  assert.equal(runtimes[0]!.aborted, 1);
  assert.equal(manager.record(id)?.cancelledBy, "user");
  runtimes[0]!.settle(report("error", { error: "killed" }));
  const settled = await r.run.done;
  assert.equal(settled.id, id, "reports carry the subagent id, not the runtime handoff id");
  await flush();
  assert.equal(manager.record(id)?.status, "cancelled");
  assert.equal(manager.cancel(id), false, "not running any more");
  assert.equal(runtimes[0]!.killed, true);
  rmSync(cwd, { recursive: true, force: true });
});

test("shutdown records running agents as cancelled (persisted) before killing", () => {
  const { manager, runtimes } = fakeManager();
  const cwd = tmp();
  const r = manager.start({ title: "t", task: "x", profile, model: "a/b", thinking: "low", cwd, leadSessionId: "sd", background: true });
  assert.ok("run" in r);
  manager.shutdown();
  assert.equal(runtimes[0]!.killed, true);
  const { manager: m2 } = fakeManager();
  m2.restore(cwd, "sd");
  const rec = m2.record(r.run.record.id);
  assert.equal(rec?.status, "cancelled");
  assert.equal(rec?.cancelledBy, "session");
  rmSync(cwd, { recursive: true, force: true });
});

test("state dir is keyed by the lead session, not the process (survives restart)", () => {
  const { manager } = fakeManager();
  const cwd = tmp();
  const dir = manager.sessionDir(cwd, "lead-1");
  assert.ok(dir.endsWith(join("subagents", "sessions", "lead-1")));
  assert.ok(!dir.includes(`-${String(process.pid)}`), "no pid in the path");
  rmSync(cwd, { recursive: true, force: true });
});

test("resume keeps the session file and title; task stored on the record; maxConcurrent honoured", async () => {
  const { manager, runtimes } = fakeManager();
  const cwd = tmp();
  const r = manager.start({ title: "first", task: "one", profile, model: "a/b", thinking: "low", cwd, leadSessionId: "rs", background: true });
  assert.ok("run" in r);
  const { id, sessionFile } = r.run.record;
  runtimes[0]!.settle(report("completed"));
  await flush();
  const again = manager.start({ title: "", task: "two", profile, model: "a/b", thinking: "low", cwd, leadSessionId: "rs", background: false, resume: id });
  assert.ok("run" in again);
  assert.equal(again.run.record.sessionFile, sessionFile);
  assert.equal(again.run.record.title, "first");
  assert.equal(again.run.record.task, "two");
  const capped = manager.start({ title: "x", task: "x", profile, model: "a/b", thinking: "low", cwd, leadSessionId: "rs", background: true, maxConcurrent: 1 });
  assert.ok("error" in capped);
  assert.match(capped.error, /Maximum 1/);
  rmSync(cwd, { recursive: true, force: true });
});

// ── transcript ─────────────────────────────────────────────────────────────

function sessionFile(dir: string, lines: unknown[]): string {
  const f = join(dir, "s.jsonl");
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return f;
}
const msg = (message: unknown) => ({ type: "message", message });

test("session file → task, tool with output/error, text", () => {
  const dir = tmp();
  const f = sessionFile(dir, [
    { type: "session" },
    msg({ role: "user", content: [{ type: "text", text: "Find the config" }] }),
    msg({ role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.json" } }] }),
    msg({ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "{}" }], isError: true }),
    msg({ role: "assistant", content: [{ type: "text", text: "Done." }] }),
  ]);
  const items = itemsFromSessionFile(f);
  assert.deepEqual(items.map((i) => i.kind), ["task", "tool", "text"]);
  const tool = items[1] as { arg: string; output: string; isError: boolean; running: boolean };
  assert.equal(tool.arg, "a.json");
  assert.equal(tool.output, "{}");
  assert.equal(tool.isError, true);
  assert.equal(tool.running, false);
  rmSync(dir, { recursive: true, force: true });
});

test("running transcript: file history up to the current task, then live events (no duplicates)", () => {
  const dir = tmp();
  const f = sessionFile(dir, [
    msg({ role: "user", content: "old task" }),
    msg({ role: "assistant", content: [{ type: "text", text: "old answer" }] }),
    msg({ role: "user", content: "new task" }),
    msg({ role: "assistant", content: [{ type: "toolCall", id: "x", name: "ls", arguments: {} }] }),
  ]);
  const live = [{ kind: "tool" as const, toolCallId: "x", name: "ls", args: {}, output: "", isError: false, done: false, startedAt: 0 }];
  const items = buildTranscript({ sessionFile: f, task: "new task", running: true, events: live });
  assert.deepEqual(items.map((i) => (i.kind === "task" || i.kind === "text" ? i.text : `tool:${i.name}:${String(i.running)}`)), ["old task", "old answer", "new task", "tool:ls:true"]);
  // The file doesn't have the current prompt yet (resume just started).
  const early = buildTranscript({ sessionFile: f, task: "third", running: true, events: [] });
  assert.equal((early.at(-1) as { text: string }).text, "third");
  assert.equal(early.length, 5);
  // Finished: file wins; no file → task + events.
  assert.equal(buildTranscript({ sessionFile: f, running: false, events: live }).length, 4);
  assert.deepEqual(buildTranscript({ sessionFile: join(dir, "none.jsonl"), task: "t", running: false, events: live }).map((i) => i.kind), ["task", "tool"]);
  rmSync(dir, { recursive: true, force: true });
});

test("itemsFromEvents drops empty text; tool args → primary arg", () => {
  const items = itemsFromEvents([
    { kind: "text", text: "  ", open: false },
    { kind: "tool", toolCallId: "1", name: "bash", args: { command: "npm test\n--watch" }, output: "ok", isError: false, done: true, startedAt: 0, endedAt: 2000 },
  ]);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], { kind: "tool", name: "bash", arg: "npm test", output: "ok", isError: false, running: false, durationMs: 2000 });
});

// ── UI ─────────────────────────────────────────────────────────────────────

const rec = (over: Record<string, unknown> = {}) => ({
  id: "abcd1234", title: "Read config", profile: "subagent_explore", model: "ds/deepseek-flash", status: "completed",
  background: false, startedAt: Date.now() - 7000, endedAt: Date.now(), toolCalls: 1, lastActivity: 0, sessionFile: "/nope", depth: 1, ...over,
}) as never;

test("strip: Devin wording, running count only while running, hidden when empty", () => {
  assert.equal(stripText([], theme), undefined);
  assert.equal(stripText([rec(), rec({ status: "running" })], theme), "2 subagents (1 running) · ↓ select");
  assert.equal(stripText([rec()], theme), "1 subagent · ↓ select");
});

test("labels + durations", () => {
  assert.equal(profileLabel("subagent_explore"), "Explore");
  assert.equal(profileLabel("reviewer"), "Reviewer");
  assert.equal(elapsed(7_400), "7s");
  assert.equal(elapsed(169_000), "2m49s");
});

test("card outcome lines", () => {
  assert.equal(cardOutcome({ owner: "subagents", phase: "started" }, theme), "└ Background subagent started.");
  assert.equal(cardOutcome({ owner: "subagents", phase: "done", status: "completed", durationMs: 7000, toolCalls: 1 }, theme), "└ Completed · 7s · 1 tool call");
  assert.equal(cardOutcome({ owner: "subagents", phase: "done", status: "cancelled", cancelledBy: "user" }, theme), "└ Cancelled by you");
  assert.match(cardOutcome({ owner: "subagents", phase: "done", status: "failed", error: "boom" }, theme), /Failed: boom/);
});

test("renderItems: tool output collapsed to 3 lines unless full", () => {
  const items = [{ kind: "tool" as const, name: "bash", arg: "ls", output: "1\n2\n3\n4\n5", isError: false, running: false }];
  const collapsed = renderItems(items, 60, theme);
  assert.ok(collapsed.some((l) => l.includes("2 earlier lines")));
  assert.equal(renderItems(items, 60, theme, { fullOutput: true }).length, 6);
});

function dock(records: unknown[], calls: string[]) {
  let closed = false;
  const tui = { requestRender() {} } as never;
  const d = new SubagentDock(tui, theme, {
    records: () => records as never,
    transcript: () => [{ kind: "task", text: "the task" }, { kind: "text", text: "found it" }],
    toolCalls: () => 1,
    subscribe: () => () => {},
    foreground: (id) => {
      calls.push(`f:${id}`);
      return undefined;
    },
    cancel: (id) => {
      calls.push(`x:${id}`);
      return "Not running.";
    },
  }, () => { closed = true; });
  return { d, isClosed: () => closed };
}

test("dock: list → view → back; f foregrounds + closes; x cancels and flashes the reason", () => {
  const calls: string[] = [];
  const { d, isClosed } = dock([rec({ id: "old", startedAt: 1 }), rec({ id: "new", status: "running", title: "Newest" })], calls);
  const list = d.render(100).join("\n");
  assert.match(list, /Subagents/);
  assert.match(list, /❭ .*Newest/, "newest first + selected (running)");
  assert.match(list, /↑↓ navigate · ↵ view · f foreground · x cancel · esc close/);
  d.handleInput("\r");
  const view = d.render(100).join("\n");
  assert.match(view, /Model: ds\/deepseek-flash/);
  assert.match(view, /the task/);
  d.handleInput("\x1b");
  assert.match(d.render(100).join("\n"), /navigate/, "esc from view → list");
  d.handleInput("j");
  d.handleInput("x");
  assert.deepEqual(calls, ["x:old"]);
  assert.match(d.render(100).join("\n"), /Not running\./);
  d.handleInput("k");
  d.handleInput("f");
  assert.deepEqual(calls, ["x:old", "f:new"]);
  assert.equal(isClosed(), true);
  d.dispose();
});

// ── background approvals: deny WITH a reason ──────────────────────────────

test("background permission prompt → 'Deny with note…' then the background note; other prompts cancel", () => {
  const rt = new ChildAgentRuntime({ cwd: "/", model: "a/b" as never, thinking: "low" as never, sessionFile: "/tmp/x.jsonl", systemPrompt: "" });
  const sent: Array<Record<string, unknown>> = [];
  (rt as unknown as { child: unknown }).child = { stdin: { writable: true, write: (s: string) => sent.push(JSON.parse(s)) } };
  const handle = (m: unknown) => (rt as unknown as { handleMessage: (m: unknown) => void }).handleMessage(m);
  handle({ type: "extension_ui_request", id: "1", method: "select", title: "Allow bash?", options: ["Allow once", "Always allow `x`", "Deny", DENY_WITH_NOTE] });
  handle({ type: "extension_ui_request", id: "2", method: "input", title: "Why deny? (sent to the agent)" });
  handle({ type: "extension_ui_request", id: "3", method: "select", title: "Pick", options: ["a", "b"] });
  assert.deepEqual(sent[0], { type: "extension_ui_response", id: "1", value: DENY_WITH_NOTE });
  assert.deepEqual(sent[1], { type: "extension_ui_response", id: "2", value: BACKGROUND_DENY_NOTE });
  assert.deepEqual(sent[2], { type: "extension_ui_response", id: "3", cancelled: true });
});

test("the permission gate still offers the exact 'Deny with note…' label", () => {
  const src = readFileSync(join(import.meta.dirname, "../../../workflow/src/permission/prompt.ts"), "utf8");
  assert.ok(src.includes(`"${DENY_WITH_NOTE}"`));
});

// ── /unipi:agents ──────────────────────────────────────────────────────────

test("agent file written by the manager loads back as a profile", () => {
  const dir = tmp();
  const cwd = join(dir, "proj");
  const agents = join(cwd, ".unipi/config/agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, "reviewer.md"), agentMarkdown({ name: "reviewer", description: "Reviews: diffs & plans", model: "ds/deepseek-flash", tools: ["read", "grep"], thinking: "high", prompt: "Review it." }));
  const p = loadProfiles(cwd, join(dir, "home")).profiles.find((x) => x.id === "reviewer");
  assert.equal(p?.description, "Reviews: diffs & plans");
  assert.equal(p?.model, "ds/deepseek-flash");
  assert.deepEqual(p?.tools, ["read", "grep"]);
  assert.equal(p?.thinking, "high");
  assert.equal(p?.systemPrompt, "Review it.");
  assert.equal(agentFile(p!, cwd, join(dir, "home")), join(agents, "reviewer.md"));
  rmSync(dir, { recursive: true, force: true });
});

test("agent names: format, built-in clash, duplicates", () => {
  assert.equal(validateName("reviewer", []), null);
  assert.match(validateName("Bad Name", []) ?? "", /lowercase/);
  assert.match(validateName("subagent_explore", []) ?? "", /built-in/);
  assert.match(validateName("reviewer", ["reviewer"]) ?? "", /already exists/);
});

test("shared registry is sorted oldest first for the strip", () => {
  assert.ok(Array.isArray(getSharedSubagents()));
});

process.on("exit", () => rmSync(HOME, { recursive: true, force: true }));
