// Regression (user report 2026-10-27): "when I ask the agent to use xxx
// subagents, only after /reload does it work."
//
// Root cause: the profile list was a module-level snapshot refreshed only in
// `before_agent_start`, which fires once per PROMPT. A profile written during
// a turn stayed invisible for the rest of that turn — run_subagent answered
// "Unknown profile" and update_agent_graph refused the work item. The next
// prompt (or /reload) picked the file up, which is why the workaround was a
// reload.
//
// Fix: re-read the agent files at spawn time (run_subagent) and when the graph
// asks for the available profiles.
import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import subagents from "../index.js";
import { SubagentManager } from "../manager.js";
import type { SidekickStep } from "@pi-unipi/core/child-agent.js";

const scratch = mkdtempSync(join(tmpdir(), "uni-profile-fresh-"));
const prevHome = process.env.HOME;
process.env.HOME = scratch;
after(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
});

const step: SidekickStep = { kind: "tool", name: "read", arg: "a.ts", output: "x", isError: false, durationMs: 1 };
const done = Promise.resolve({ id: "h", status: "completed" as const, text: "demo", usage: {}, toolCalls: 1, durationMs: 5, events: [] });

function wiredManager() {
  return new SubagentManager(() => ({
    progress: () => ({ toolCalls: 0 }),
    handoff: () => ({ id: "h", done }),
    kill: () => undefined,
    detachUi: () => undefined,
    attachUi: () => undefined,
  }) as never);
}

function fakePi() {
  const tools = new Map<string, { execute: (...a: unknown[]) => unknown }>();
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const noop = () => undefined;
  const pi = {
    on: (e: string, h: (...a: unknown[]) => unknown) => handlers.set(e, h),
    registerTool: (def: { name: string; execute: (...a: unknown[]) => unknown }) => tools.set(def.name, def),
    registerCommand: noop,
    registerMessageRenderer: noop,
    registerEntryRenderer: noop,
    registerShortcut: noop,
    registerFlag: noop,
    sendMessage: noop,
    getActiveTools: () => [] as string[],
    setActiveTools: noop,
    appendEntry: noop,
  };
  return { pi, tools, handlers };
}

/** A project workspace whose agents dir starts out empty. */
function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), "uni-profile-ws-"));
  mkdirSync(join(cwd, ".unipi", "config", "agents"), { recursive: true });
  return cwd;
}

function writeAgent(cwd: string, name: string): void {
  writeFileSync(
    join(cwd, ".unipi", "config", "agents", `${name}.md`),
    `---\nname: ${name}\ndescription: A worker that writes code.\nmodel: ollamacloud/deepseek-v4.1-flash\n---\nYou write code.\n`,
  );
}

test("a profile created mid-turn is usable in the SAME turn (no reload needed)", async () => {
  const cwd = workspace();
  const { pi, tools } = fakePi();
  subagents(pi as never, { manager: wiredManager() });

  const execute = tools.get("run_subagent")!.execute as (...a: unknown[]) => Promise<{ content?: Array<{ text?: string }>; isError?: boolean }>;
  const ctx = { cwd, hasPendingMessages: () => false };

  // The agent file is written DURING the turn — after the extension loaded.
  writeAgent(cwd, "ds-worker");

  const result = await execute("t1", { title: "demo", task: "do the thing", profile: "ds-worker" }, undefined, undefined, ctx);
  assert.notEqual(result.isError, true, "a profile written this turn must not be refused");
  const text = result.content?.map((c) => c.text ?? "").join("") ?? "";
  assert.doesNotMatch(text, /Unknown profile/, "no 'Unknown profile' refusal");
});

test("an unknown profile is still refused, and the error lists the real ones", async () => {
  const cwd = workspace();
  writeAgent(cwd, "ds-worker");
  const { pi, tools } = fakePi();
  subagents(pi as never, { manager: wiredManager() });

  const execute = tools.get("run_subagent")!.execute as (...a: unknown[]) => Promise<{ content?: Array<{ text?: string }>; isError?: boolean }>;
  const result = await execute("t2", { title: "demo", task: "x", profile: "nope" }, undefined, undefined, { cwd, hasPendingMessages: () => false });
  assert.equal(result.isError, true, "a genuinely unknown profile is refused");
  const text = result.content?.map((c) => c.text ?? "").join("") ?? "";
  assert.match(text, /Unknown profile "nope"/);
  assert.match(text, /ds-worker/, "the available list names the real profiles");
});

test("the graph run port reports the freshly-written profiles", async () => {
  const cwd = workspace();
  const { pi, handlers } = fakePi();
  subagents(pi as never, { manager: wiredManager() });
  // The port resolves profiles against the session cwd — the session_start
  // handler is what establishes it.
  await handlers.get("session_start")?.({}, { hasUI: false, cwd, sessionManager: { getSessionId: () => "s" } });

  const port = (globalThis as unknown as Record<symbol, { profiles: () => string[] } | undefined>)[
    Symbol.for("unipi.subagents.graph-run-port")
  ];
  assert.ok(port, "the graph run port is published");

  writeAgent(cwd, "ds-worker");
  assert.ok(port!.profiles().includes("ds-worker"), "the port sees a profile written after load");
});
