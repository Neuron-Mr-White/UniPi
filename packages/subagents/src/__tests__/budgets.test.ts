/**
 * Budgets, spawn caps, output truncation, and child-safety tests — ported
 * from pi-subagents turn-budget/tool-budget/usage-budget/run-fanout-budget
 * semantics (their test suites are the spec).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveTurnBudgetConfig,
  turnBudgetDecision,
  appendTurnBudgetSystemPrompt,
  validateToolBudgetConfig,
  shouldBlockToolForBudget,
  validateUsageBudgetConfig,
  usageBudgetState,
  usageBudgetExceededMessage,
} from "../budgets.js";
import {
  createRunFanoutBudget,
  claimRunFanoutBatch,
  getRunFanoutBudgetSnapshot,
  validateRunFanoutBudgetDescriptor,
  RunFanoutLimitError,
} from "../run-fanout-budget.js";
import { truncateOutput, resolveMaxOutput, resolveRunTimeoutMs, resolveToolTimeoutMs } from "../output-limits.js";
import {
  withChildBoundaryInstructions,
  resolveMaxSubagentDepth,
  depthExceeded,
  childDepthEnv,
  resolveContext,
  assertForegroundContextSupported,
  ContextUnavailableError,
} from "../child-safety.js";
import { TEMP_ROOT_DIR } from "../parity-types.js";
import type { AgentConfig } from "../types.js";

const ORIGINAL_TEMP_ROOT = process.env.UNIPI_SUBAGENTS_TEMP_ROOT;

beforeEach(() => {
  // Isolate fanout budget dirs per test
  const iso = mkdtempSync(join(tmpdir(), "unipi-budget-test-"));
  process.env.UNIPI_SUBAGENTS_TEMP_ROOT = iso;
});

afterEach(() => {
  if (ORIGINAL_TEMP_ROOT === undefined) delete process.env.UNIPI_SUBAGENTS_TEMP_ROOT;
  else process.env.UNIPI_SUBAGENTS_TEMP_ROOT = ORIGINAL_TEMP_ROOT;
});

describe("turn budget", () => {
  it("validates config shapes", () => {
    assert.deepEqual(resolveTurnBudgetConfig(undefined), {});
    assert.match(resolveTurnBudgetConfig("nope").error!, /must be an object/);
    assert.match(resolveTurnBudgetConfig({ maxTurns: 0 }).error!, /maxTurns must be an integer >= 1/);
    assert.match(resolveTurnBudgetConfig({ maxTurns: 3, graceTurns: -1 }).error!, /graceTurns must be an integer >= 0/);
    assert.match(resolveTurnBudgetConfig({ maxTurns: 3, extra: 1 }).error!, /extra.*not supported/);
    assert.deepEqual(resolveTurnBudgetConfig({ maxTurns: 3 }), { turnBudget: { maxTurns: 3, graceTurns: 1 } });
    assert.deepEqual(resolveTurnBudgetConfig({ maxTurns: 3, graceTurns: 2 }), { turnBudget: { maxTurns: 3, graceTurns: 2 } });
  });

  it("decision: continue under hard limit, defer on tool work, abort at boundary", () => {
    const budget = { maxTurns: 2, graceTurns: 1 };
    assert.equal(turnBudgetDecision(budget, 1, false, false), "continue");
    assert.equal(turnBudgetDecision(budget, 2, false, false), "continue"); // < hardLimit(3)
    assert.equal(turnBudgetDecision(budget, 3, false, true), "defer"); // tool work active
    assert.equal(turnBudgetDecision(budget, 3, false, false), "abort");
    assert.equal(turnBudgetDecision(budget, 3, false, true, true), "abort"); // enforce hard limit
    assert.equal(turnBudgetDecision(budget, 99, true, true), "continue"); // terminal stop
  });

  it("appends the wrap-up block to the system prompt", () => {
    assert.equal(appendTurnBudgetSystemPrompt("base", undefined), "base");
    const withBudget = appendTurnBudgetSystemPrompt("base", { maxTurns: 2 });
    assert.ok(withBudget.startsWith("base"));
    assert.ok(withBudget.includes("## Turn budget"));
    assert.ok(withBudget.includes("soft budget of 2 assistant turns"));
  });
});

describe("tool budget", () => {
  it("validates config shapes", () => {
    assert.deepEqual(validateToolBudgetConfig(undefined), {});
    assert.match(validateToolBudgetConfig({}).error!, /hard must be an integer >= 1/);
    assert.match(validateToolBudgetConfig({ hard: 3, soft: 5 }).error!, /soft must be <=/);
    assert.match(validateToolBudgetConfig({ hard: 3, block: [] }).error!, /at least one tool/);
    const ok = validateToolBudgetConfig({ hard: 5, soft: 2 });
    assert.deepEqual(ok.budget, { hard: 5, soft: 2, block: ["read", "grep", "find", "ls"] });
    const star = validateToolBudgetConfig({ hard: 5, block: "*" });
    assert.equal(star.budget!.block, "*");
  });

  it("blocks configured tools past the hard cap; final text never blocked", () => {
    const { budget } = validateToolBudgetConfig({ hard: 3 })!;
    assert.equal(shouldBlockToolForBudget(budget!, "read", 3), false);
    assert.equal(shouldBlockToolForBudget(budget!, "read", 4), true);
    assert.equal(shouldBlockToolForBudget(budget!, "bash", 4), false); // not in default block
    const all = validateToolBudgetConfig({ hard: 1, block: "*" })!;
    assert.equal(shouldBlockToolForBudget(all.budget!, "bash", 2), true);
  });
});

describe("usage budget", () => {
  it("validates config shapes", () => {
    assert.deepEqual(validateUsageBudgetConfig(undefined), {});
    assert.match(validateUsageBudgetConfig({}).error!, /must include tokens or costUsd/);
    assert.match(validateUsageBudgetConfig({ tokens: { soft: 5 } }).error!, /tokens.hard must be/);
    const ok = validateUsageBudgetConfig({ tokens: { soft: 100, hard: 200 }, costUsd: { hard: 1 } });
    assert.ok(ok.budget);
  });

  it("state: soft/hard outcomes and exhaustion", () => {
    const { budget } = validateUsageBudgetConfig({ tokens: { soft: 100, hard: 200 } })!;
    const within = usageBudgetState(budget, { inputTokens: 50, outputTokens: 10 });
    assert.equal(within!.tokens!.outcome, "within-budget");
    assert.equal(within!.exhausted, false);
    const soft = usageBudgetState(budget, { inputTokens: 80, outputTokens: 30 });
    assert.equal(soft!.tokens!.outcome, "soft-exceeded");
    assert.equal(soft!.exhausted, false);
    const hard = usageBudgetState(budget, { inputTokens: 150, outputTokens: 80 });
    assert.equal(hard!.tokens!.outcome, "hard-exceeded");
    assert.equal(hard!.exhausted, true);
    assert.match(usageBudgetExceededMessage(hard!), /reported tokens 230 reached hard limit 200/);
  });
});

describe("run fan-out budget (maxSubagentSpawnsPerRun)", () => {
  it("claims atomically and never refunds", () => {
    const budget = createRunFanoutBudget("run-1", 3);
    const snap1 = claimRunFanoutBatch(budget, ["a", "b"]);
    assert.deepEqual(snap1, { used: 2, limit: 3, remaining: 1 });
    // claims persist — no refund on re-read
    assert.deepEqual(getRunFanoutBudgetSnapshot(budget), { used: 2, limit: 3, remaining: 1 });
    claimRunFanoutBatch(budget, ["c"]);
    assert.deepEqual(getRunFanoutBudgetSnapshot(budget), { used: 3, limit: 3, remaining: 0 });
  });

  it("rejects a group that cannot fit atomically (no partial starts)", () => {
    const budget = createRunFanoutBudget("run-2", 2);
    claimRunFanoutBatch(budget, ["a"]);
    assert.throws(
      () => claimRunFanoutBatch(budget, ["b", "c"]),
      (error: unknown) =>
        error instanceof RunFanoutLimitError &&
        /No children from this admission group were started/.test(error.message),
    );
    // nothing extra was claimed
    assert.deepEqual(getRunFanoutBudgetSnapshot(budget), { used: 1, limit: 2, remaining: 1 });
  });

  it("descriptor round-trips and rejects tampering", () => {
    const budget = createRunFanoutBudget("run-3", 5);
    const valid = validateRunFanoutBudgetDescriptor(JSON.parse(JSON.stringify(budget)));
    assert.equal(valid.limit, 5);
    assert.throws(
      () => validateRunFanoutBudgetDescriptor({ ...budget, limit: 99 }),
      /does not match its manifest/,
    );
    assert.throws(
      () => validateRunFanoutBudgetDescriptor({ ...budget, directory: "/etc" }),
      /outside the managed budget root/,
    );
  });
});

describe("output truncation + timeouts", () => {
  it("truncateOutput caps lines and bytes with a marker", () => {
    const big = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const result = truncateOutput(big, { bytes: 200 * 1024, lines: 10 });
    assert.equal(result.truncated, true);
    assert.ok(result.text.startsWith("[TRUNCATED: showing first 10 of 100 lines"));
    assert.equal(result.text.split("\n").length, 11);

    const longLine = "x".repeat(5000);
    const byteCapped = truncateOutput(longLine, { bytes: 100, lines: 5000 });
    assert.equal(byteCapped.truncated, true);
    assert.ok(Buffer.byteLength(byteCapped.text) < 100 + 200);

    const small = truncateOutput("ok", { bytes: 100, lines: 10 });
    assert.deepEqual(small, { text: "ok", truncated: false });
  });

  it("resolveMaxOutput: call > config > default", () => {
    assert.deepEqual(resolveMaxOutput(undefined, undefined), { bytes: 204800, lines: 5000 });
    assert.deepEqual(resolveMaxOutput({ lines: 100 }, undefined).lines, 100);
    assert.deepEqual(resolveMaxOutput(undefined, { maxOutput: { bytes: 1 } } as never).bytes, 1);
  });

  it("resolveRunTimeoutMs: call > agent > config > 30min default", () => {
    const agent = { timeoutMs: 1000 } as AgentConfig;
    assert.equal(resolveRunTimeoutMs(10, agent, undefined), 10);
    assert.equal(resolveRunTimeoutMs(undefined, agent, undefined), 1000);
    assert.equal(resolveRunTimeoutMs(undefined, undefined, { timeoutMs: 2000 } as never), 2000);
    assert.equal(resolveRunTimeoutMs(undefined, undefined, undefined), 30 * 60 * 1000);
  });

  it("resolveToolTimeoutMs: precedence + env validation", () => {
    const agent = { toolTimeoutMs: 1000 } as AgentConfig;
    assert.equal(resolveToolTimeoutMs(10, agent, undefined, {}), 10);
    assert.equal(resolveToolTimeoutMs(undefined, agent, undefined, {}), 1000);
    assert.equal(resolveToolTimeoutMs(undefined, undefined, { toolTimeoutMs: 5 } as never, {}), 5);
    assert.equal(resolveToolTimeoutMs(undefined, undefined, undefined, { UNIPI_SUBAGENT_TOOL_TIMEOUT_MS: "7" }), 7);
    assert.equal(resolveToolTimeoutMs(undefined, undefined, undefined, {}), undefined);
    assert.throws(
      () => resolveToolTimeoutMs(undefined, undefined, undefined, { UNIPI_SUBAGENT_TOOL_TIMEOUT_MS: "-1" }),
      /must be a positive integer/,
    );
  });
});

describe("child safety + depth guard + context", () => {
  const agent = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
    name: "a",
    description: "d",
    extensions: false,
    skills: false,
    systemPrompt: "p",
    promptMode: "replace",
    ...overrides,
  });

  it("boundary instructions prepend; fanout children get the fanout variant", () => {
    const plain = withChildBoundaryInstructions("do the task", agent());
    assert.ok(plain.includes("not the parent orchestrator"));
    assert.ok(plain.endsWith("do the task"));

    const fanout = withChildBoundaryInstructions("fan out", agent({ builtinToolNames: ["read", "spawn_helper"] }));
    assert.ok(fanout.includes("explicit fanout responsibility"));
    assert.ok(fanout.includes("spawn_helper"));
  });

  it("depth: inherited caps cannot be relaxed; agent can tighten", () => {
    assert.equal(resolveMaxSubagentDepth(agent(), undefined, { UNIPI_SUBAGENT_MAX_DEPTH: "1" }), 1);
    assert.equal(resolveMaxSubagentDepth(agent({ maxSubagentDepth: 0 }), undefined, { UNIPI_SUBAGENT_MAX_DEPTH: "2" }), 0);
    assert.equal(resolveMaxSubagentDepth(agent({ maxSubagentDepth: 5 }), undefined, { UNIPI_SUBAGENT_MAX_DEPTH: "2" }), 2);
    assert.equal(resolveMaxSubagentDepth(agent(), { maxSubagentDepth: 4 } as never, {}), 4);
    assert.equal(resolveMaxSubagentDepth(agent(), undefined, {}), 2);
  });

  it("depthExceeded + childDepthEnv counters", () => {
    const env = childDepthEnv({}, 2);
    assert.equal(env.UNIPI_SUBAGENT_MAX_DEPTH, "2");
    assert.equal(env.UNIPI_SUBAGENT_DEPTH, "1");
    assert.equal(depthExceeded(env, 2), false);
    const deeper = childDepthEnv(env, 2);
    assert.equal(deeper.UNIPI_SUBAGENT_DEPTH, "2");
    assert.equal(depthExceeded(deeper, 2), true);
  });

  it("context resolution: explicit > config > agent > fresh", () => {
    const forkAgent = agent({ defaultContext: "fork" });
    assert.equal(resolveContext("fork", undefined, undefined), "fork");
    assert.equal(resolveContext("fresh", forkAgent, undefined), "fresh");
    assert.equal(resolveContext("profile", forkAgent, undefined), "fork");
    assert.equal(resolveContext(undefined, undefined, { defaultSubagentContext: "fork" } as never), "fork");
    assert.equal(resolveContext(undefined, forkAgent, undefined), "fork");
    assert.equal(resolveContext(undefined, agent(), undefined), "fresh");
  });

  it("foreground fork rejects with guidance; async fork allowed (Phase 3 runner)", () => {
    assert.throws(
      () => assertForegroundContextSupported("fork", false),
      (error: unknown) => error instanceof ContextUnavailableError && /run_in_background/.test(error.message),
    );
    assert.doesNotThrow(() => assertForegroundContextSupported("fresh", false));
    assert.doesNotThrow(() => assertForegroundContextSupported("fork", true));
  });
});
