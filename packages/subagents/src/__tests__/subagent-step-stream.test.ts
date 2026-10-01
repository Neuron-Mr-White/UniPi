// UNI-48: completed subagent steps stream into the transcript as delegated
// panels. Manager forwards onStep to the runtime with the local record; the
// index-side append is UI-only, guarded, and never carries the final report.
// All state goes to a scratch HOME/cwd and every fake run settles, so nothing
// persists or keeps running after the suite.
import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SubagentManager, type SubagentRecord } from "../manager.js";
import { appendSubagentStep } from "../index.js";
import type { SidekickStep } from "@pi-unipi/core/child-agent.js";

const scratch = mkdtempSync(join(tmpdir(), "uni-subagent-step-"));
const prevEnv: Array<[string, string | undefined]> = [["HOME", process.env.HOME]];
process.env.HOME = scratch;
after(() => {
  for (const [name, value] of prevEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const step: SidekickStep = { kind: "tool", name: "bash", arg: "pwd", output: "/x", isError: false, durationMs: 9, args: { command: "pwd" } };

function record(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "agent-1",
    title: "spike",
    profile: "explore",
    model: "zai/glm-5.3-flash",
    status: "running",
    background: true,
    startedAt: 1_700_000_000_000,
    toolCalls: 0,
    lastActivity: Date.now(),
    sessionFile: join(scratch, "agent-1.jsonl"),
    depth: 1,
    ...overrides,
  };
}

const done = Promise.resolve({
  id: "h",
  status: "completed" as const,
  text: "demo",
  usage: {},
  toolCalls: 1,
  durationMs: 5,
  events: [],
});
const fakeRuntime = {
  progress: () => ({ toolCalls: 0 }),
  handoff: () => ({ id: "h", done }),
  kill: () => undefined,
  detachUi: () => undefined,
} as never;

/** Manager whose runtime factory emits one step, exactly like the real child. */
const capturingManager = () =>
  new SubagentManager((opts) => {
    (opts as { onStep?: (s: SidekickStep) => void }).onStep?.(step);
    return fakeRuntime;
  });

function startOpts(over: Partial<Parameters<SubagentManager["start"]>[0]> = {}): Parameters<SubagentManager["start"]>[0] {
  return {
    title: "spike",
    task: "do things",
    profile: { id: "explore", description: "d", systemPrompt: "p" } as never,
    model: "zai/glm-5.3-flash",
    thinking: "medium",
    cwd: join(scratch, "run"),
    leadSessionId: "s",
    background: true,
    ...over,
  };
}

test("manager.start forwards onStep; callback receives the local record", async () => {
  const manager = capturingManager();
  const seen: Array<{ record: SubagentRecord; step: SidekickStep }> = [];
  const started = manager.start(startOpts({ onStep: (rec, s) => seen.push({ record: rec, step: s }) }));
  assert.ok(!("error" in started), "start succeeds");
  assert.equal(seen.length, 1, "step forwarded");
  assert.equal(seen[0]!.record.id, started.run.record.id);
  assert.equal(seen[0]!.step.name, "bash");
  await started.run.done;
});

test("a throwing onStep callback never breaks the run", async () => {
  const manager = capturingManager();
  const started = manager.start(startOpts({
    cwd: join(scratch, "run2"),
    onStep: () => {
      throw new Error("ui blew up");
    },
  }));
  assert.ok(!("error" in started));
  await started.run.done;
});

test("appendSubagentStep payload: per-run group, label, ids; errors isolated", () => {
  const rec = record();
  const appended: Array<{ type: string; data: Record<string, unknown> }> = [];
  appendSubagentStep((type, data) => appended.push({ type, data }), rec, step);
  assert.equal(appended.length, 1);
  const { type, data } = appended[0]!;
  assert.equal(type, "subagent-step");
  assert.equal(data.agentId, "agent-1");
  assert.equal(data.id, "agent-1");
  assert.equal(data.title, "spike");
  assert.equal(data.profile, "explore");
  assert.equal(data.group, `subagent:agent-1:${String(rec.startedAt)}`, "group unique per agent run");
  assert.equal(data.label, "Explore subagent · spike");
  assert.equal(data.name, "bash", "step fields carried through");

  let broken = 0;
  assert.doesNotThrow(() => appendSubagentStep(() => { broken += 1; throw new Error("no ui"); }, rec, step));
  assert.equal(broken, 1, "append attempted exactly once; error swallowed");
});
