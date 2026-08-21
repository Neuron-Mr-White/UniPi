/**
 * spawn_helper parity handler tests — routing, preflight, budgets, depth,
 * context policy, spawn accounting, truncation (mocked manager deps).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { handleSpawnHelper, type HandlerDeps } from "../tool-handler.js";
import { AgentManager } from "../agent-manager.js";
import type { SubagentsConfig } from "../types.js";

const managers: AgentManager[] = [];
after(() => {
  for (const manager of managers) manager.dispose();
});

function makeDeps(overrides: Partial<HandlerDeps> = {}, configOverrides: Partial<SubagentsConfig> = {}): HandlerDeps {
  const calls: Array<{ agent: string; prompt: string; background?: boolean }> = [];
  const config: SubagentsConfig = {
    maxConcurrent: 4,
    enabled: true,
    types: {},
    ...configOverrides,
  };
  let sessionUsed = 0;
  const manager = new AgentManager(undefined, 4, undefined, {}, process.env.TMPDIR ?? "/tmp", { user: {}, project: {} });
  managers.push(manager);
  const deps: HandlerDeps = {
    pi: {} as never,
    manager,
    config,
    spawnForeground: async (_ctx, agent, prompt) => {
      calls.push({ agent, prompt });
      return { ok: true, output: `ran ${agent}`, toolUses: 2, durationMs: 10 };
    },
    spawnBackground: (_ctx, agent, prompt) => {
      calls.push({ agent, prompt, background: true });
      return "helper-1";
    },
    spawnAccounting: {
      used: () => sessionUsed,
      cap: () => config.maxSubagentSpawnsPerSession,
      consume: (count) => {
        sessionUsed += count;
      },
    },
    env: {},
    ...overrides,
  };
  (deps as HandlerDeps & { __calls: typeof calls }).__calls = calls;
  return deps;
}

const ctx = {} as never;

describe("action routing", () => {
  it("list shows builtin file agents + code builtins with aliases and enablement", async () => {
    const deps = makeDeps();
    const result = await handleSpawnHelper(deps, ctx, { action: "list" });
    const text = result.content[0]!.text;
    assert.ok(text.includes("scout"));
    assert.ok(text.includes("explore"));
    assert.ok(text.includes("advisor")); // oracle's alias
    assert.ok(text.includes("builtin"));
  });

  it("get resolves aliases and shows resolved config", async () => {
    const deps = makeDeps();
    const result = await handleSpawnHelper(deps, ctx, { action: "get", agent: "advisor" });
    const text = result.content[0]!.text;
    assert.ok(text.startsWith("Agent: oracle"));
    assert.ok(text.includes("Aliases: advisor"));
  });

  it("unknown action errors with the full action list", async () => {
    const deps = makeDeps();
    const result = await handleSpawnHelper(deps, ctx, { action: "teleport" });
    assert.match(result.content[0]!.text, /Unknown action "teleport"/);
    assert.match(result.content[0]!.text, /grant-spawn-budget/);
  });

  it("doctor reports config + capacity", async () => {
    const deps = makeDeps();
    const result = await handleSpawnHelper(deps, ctx, { action: "doctor" });
    assert.match(result.content[0]!.text, /maxConcurrent=4/);
    assert.match(result.content[0]!.text, /run=64/);
  });

  it("status reports the session spawn budget", async () => {
    const deps = makeDeps({}, { maxSubagentSpawnsPerSession: 10 });
    // consume 3
    await handleSpawnHelper(deps, ctx, { agent: "scout", task: "t1" });
    await handleSpawnHelper(deps, ctx, { agent: "scout", task: "t2" });
    await handleSpawnHelper(deps, ctx, { agent: "scout", task: "t3" });
    const result = await handleSpawnHelper(deps, ctx, { action: "status" });
    assert.match(result.content[0]!.text, /Session spawn budget: 3\/10 used/);
  });
});

describe("single-child preflight", () => {
  it("rejects unknown agent with known types listed", async () => {
    const deps = makeDeps();
    const result = await handleSpawnHelper(deps, ctx, { agent: "nonexistent", task: "x" });
    assert.match(result.content[0]!.text, /Unknown agent type "nonexistent"/);
    assert.match(result.content[0]!.text, /scout/);
  });

  it("legacy params still work (type/prompt aliases)", async () => {
    const deps = makeDeps();
    const result = await handleSpawnHelper(deps, ctx, { type: "explore", prompt: "read files" });
    assert.match(result.content[0]!.text, /Agent completed/);
    const calls = (deps as HandlerDeps & { __calls: Array<{ agent: string; prompt: string }> }).__calls;
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.agent, "explore");
    assert.ok(calls[0]!.prompt.includes("read files"));
    assert.ok(calls[0]!.prompt.includes("not the parent orchestrator")); // boundary instructions
  });

  it("aliases resolve (developer → worker)", async () => {
    const deps = makeDeps();
    const result = await handleSpawnHelper(deps, ctx, { agent: "developer", task: "code it" });
    const calls = (deps as HandlerDeps & { __calls: Array<{ agent: string }> }).__calls;
    assert.equal(calls[0]!.agent, "worker");
    assert.match(result.content[0]!.text, /Agent completed/);
  });

  it("missing task errors", async () => {
    const deps = makeDeps();
    const result = await handleSpawnHelper(deps, ctx, { agent: "scout" });
    assert.match(result.content[0]!.text, /requires a task/);
  });

  it("depth guard blocks nested spawns at the cap", async () => {
    const deps = makeDeps({}, { maxSubagentDepth: 1 });
    deps.env = { UNIPI_SUBAGENT_MAX_DEPTH: "1", UNIPI_SUBAGENT_DEPTH: "1" };
    const result = await handleSpawnHelper(deps, ctx, { agent: "scout", task: "x" });
    assert.match(result.content[0]!.text, /depth cap reached/);
  });
});

describe("context policy", () => {
  it("foreground fork rejects with run_in_background guidance", async () => {
    const deps = makeDeps();
    const result = await handleSpawnHelper(deps, ctx, { agent: "scout", task: "x", context: "fork" });
    assert.match(result.content[0]!.text, /run_in_background: true/);
  });

  it("background fork (async process runner not yet built) errors clearly", async () => {
    const deps = makeDeps();
    const result = await handleSpawnHelper(deps, ctx, {
      agent: "scout", task: "x", context: "fork", run_in_background: true,
    });
    assert.match(result.content[0]!.text, /background runner \(planned phase\)/);
  });

  it("fresh context passes", async () => {
    const deps = makeDeps();
    const result = await handleSpawnHelper(deps, ctx, { agent: "scout", task: "x", context: "fresh" });
    assert.match(result.content[0]!.text, /Agent completed/);
  });
});

describe("budget enforcement", () => {
  it("invalid turnBudget errors before spawn", async () => {
    const deps = makeDeps();
    const result = await handleSpawnHelper(deps, ctx, {
      agent: "scout", task: "x", turnBudget: { maxTurns: 0 },
    });
    assert.match(result.content[0]!.text, /maxTurns must be an integer >= 1/);
  });

  it("turnBudget appends the wrap-up block to the child prompt", async () => {
    const deps = makeDeps();
    await handleSpawnHelper(deps, ctx, {
      agent: "scout", task: "do it", turnBudget: { maxTurns: 3, graceTurns: 1 },
    });
    const calls = (deps as HandlerDeps & { __calls: Array<{ prompt: string }> }).__calls;
    assert.ok(calls[0]!.prompt.includes("## Turn budget"));
    assert.ok(calls[0]!.prompt.includes("soft budget of 3 assistant turns"));
  });

  it("session spawn budget blocks launches when exhausted", async () => {
    const deps = makeDeps({}, { maxSubagentSpawnsPerSession: 2 });
    const r1 = await handleSpawnHelper(deps, ctx, { agent: "scout", task: "one" });
    const r2 = await handleSpawnHelper(deps, ctx, { agent: "scout", task: "two" });
    const r3 = await handleSpawnHelper(deps, ctx, { agent: "scout", task: "three" });
    assert.match(r1.content[0]!.text, /Agent completed/);
    assert.match(r2.content[0]!.text, /Agent completed/);
    assert.match(r3.content[0]!.text, /Session spawn budget exhausted: 2\/2/);
  });

  it("unlimited session budget never blocks", async () => {
    const deps = makeDeps();
    for (let i = 0; i < 5; i++) {
      await handleSpawnHelper(deps, ctx, { agent: "scout", task: `t${i}` });
    }
    const calls = (deps as HandlerDeps & { __calls: unknown[] }).__calls;
    assert.equal(calls.length, 5);
  });
});

describe("workflowScript execution", () => {
  it("runs a sequential + parallel workflow in-process (async: false)", async () => {
    const deps = makeDeps();
    const result = await handleSpawnHelper(deps, ctx, {
      workflowScript: `
        const scan = await runs.run("scan", { agent: "scout", task: "find targets" });
        const reviews = await runs.all([
          { key: "r1", agent: "reviewer", task: "review " + scan.output },
          { key: "r2", agent: "reviewer", task: "review tests" }
        ]);
        return { scan: scan.output, reviews: reviews.length };
      `,
      async: false,
    });
    const text = result.content[0]!.text;
    assert.ok(text.includes("ran scout") || text.includes("scan"), `unexpected: ${text}`);
    const calls = (deps as HandlerDeps & { __calls: Array<{ agent: string }> }).__calls;
    assert.deepEqual(calls.map((c) => c.agent), ["scout", "reviewer", "reviewer"]);
  });

  it("workflow children get boundary instructions", async () => {
    const deps = makeDeps();
    await handleSpawnHelper(deps, ctx, {
      workflowScript: `return await runs.run("s", { agent: "scout", task: "x" });`,
      async: false,
    });
    const calls = (deps as HandlerDeps & { __calls: Array<{ prompt: string }> }).__calls;
    assert.ok(calls[0]!.prompt.includes("not the parent orchestrator"));
  });

  it("default async workflows report the pending background runner", async () => {
    const deps = makeDeps();
    const result = await handleSpawnHelper(deps, ctx, {
      workflowScript: `return 1;`,
    });
    assert.match(result.content[0]!.text, /background runner \(planned phase\)/);
  });

  it("fanout budget caps workflow children atomically (failures collected, nothing started)", async () => {
    const deps = makeDeps({}, { maxSubagentSpawnsPerRun: 2 });
    const result = await handleSpawnHelper(deps, ctx, {
      workflowScript: `
        const kids = await runs.all([
          { key: "a", agent: "scout", task: "1" },
          { key: "b", agent: "scout", task: "2" },
          { key: "c", agent: "scout", task: "3" }
        ]);
        return kids.map((k) => ({ key: k.key, ok: k.ok, error: k.error }));
      `,
      async: false,
    });
    // Batch of 3 doesn't fit cap 2 → every child fails with the rejection; nothing started
    const text = result.content[0]!.text;
    assert.match(text, /Run fan-out limit reached/);
    const calls = (deps as HandlerDeps & { __calls: unknown[] }).__calls;
    assert.equal(calls.length, 0); // nothing started
  });

  it("workflow script errors return with partial children info", async () => {
    const deps = makeDeps();
    const result = await handleSpawnHelper(deps, ctx, {
      workflowScript: `throw new Error("manual hard failure");`,
      async: false,
    });
    assert.match(result.content[0]!.text, /Workflow failed:.*manual hard failure/);
  });
});
