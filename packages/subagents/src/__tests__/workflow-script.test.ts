/**
 * workflowScript runtime tests — ported from pi-subagents
 * test/unit/scripted-workflow.test.ts (the spec). Mock launch/status/steer
 * callbacks; the runtime is the code under test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runWorkflowScript,
  WorkflowScriptError,
  previewSimpleWorkflowRun,
  formatWorkflowJsonPreview,
} from "../workflow-script.js";

type Child = {
  key: string;
  ok: boolean;
  output: string;
  error?: string;
  detached?: boolean;
  runId?: string;
  agent?: string;
  artifactPaths?: string[];
  results?: unknown[];
  structuredOutput?: unknown;
  [extra: string]: unknown;
};

const okChild = (key: string, output = "done"): Child => ({
  key,
  ok: true,
  output,
  artifactPaths: [],
});

describe("workflowScript runtime", () => {
  it("uses ordinary statement-body return semantics", async () => {
    const implicit = await runWorkflowScript({
      script: `({ answer: 42 });`,
      async launch(key) { return okChild(key); },
      async status(key) { return okChild(key); },
    });
    const explicit = await runWorkflowScript({
      script: `return ({ answer: 42 });`,
      async launch(key) { return okChild(key); },
      async status(key) { return okChild(key); },
    });
    assert.equal(implicit.value, null);
    assert.deepEqual(explicit.value, { answer: 42 });
  });

  it("guides invalid JavaScript caused by Markdown fence backticks", async () => {
    const script = [
      "const task = `Run:",
      "```bash",
      "npm test",
      "```;",
      "return task;",
    ].join("\n");
    await assert.rejects(
      runWorkflowScript({
        script,
        async launch(key) { return okChild(key, "unexpected"); },
        async status(key) { return okChild(key); },
      }),
      (error: unknown) =>
        error instanceof WorkflowScriptError &&
        error.message.includes("workflowScript must be valid JavaScript") &&
        error.message.includes('array joined with "\\n"'),
    );
  });

  it("previews only simple explicit-return child scripts", () => {
    assert.deepEqual(previewSimpleWorkflowRun(`return runs.run("scan", { agent: "scout", task: "find" });`), {
      agent: "scout",
      task: "find",
    });
    assert.equal(previewSimpleWorkflowRun(`const x = 1; return x;`), undefined);
    assert.equal(previewSimpleWorkflowRun(undefined), undefined);
  });

  it("allows scripts to run without a timeout", async () => {
    const result = await runWorkflowScript({
      script: `return "done";`,
      async launch(key) { return okChild(key); },
      async status(key) { return okChild(key); },
    });
    assert.equal(result.value, "done");
  });

  it("runs keyed children, streams progress, and exposes no host capabilities", async () => {
    const launches: Array<{ key: string; params: Record<string, unknown> }> = [];
    const traceSnapshots: number[] = [];
    const emitSnapshots: number[] = [];
    const result = await runWorkflowScript({
      onTrace: (trace) => traceSnapshots.push(trace.length),
      onEmit: (emits) => emitSnapshots.push(emits.length),
      script: `
        if (typeof process !== "undefined" || typeof require !== "undefined") throw new Error("host globals leaked");
        const scan = await runs.run("scan", { agent: "scout", task: "find targets" });
        const reviews = await runs.all(scan.structuredOutput.items.map((item) => ({ key: "review-" + item, agent: "reviewer", task: item })));
        emit({ count: reviews.length });
        console.log("reviewed", reviews.length);
        return { refs: runs.refs(reviews) };
      `,
      timeoutMs: 2_000,
      async launch(key, params) {
        launches.push({ key, params });
        return key === "scan"
          ? { key, ok: true, runId: "run-scan", output: "targets", structuredOutput: { items: ["a", "b"] }, artifactPaths: ["/tmp/scan.json"], results: [] }
          : { key, ok: true, runId: `run-${key}-complete`, output: `reviewed ${params.task}`, artifactPaths: [`/tmp/${key}.md`], results: [] };
      },
      async status(keyOrRunId) {
        return okChild(keyOrRunId, "complete");
      },
    });

    assert.deepEqual(launches.map(({ key }) => key), ["scan", "review-a", "review-b"]);
    assert.equal(launches.every(({ params }) => params.async === false), true);
    assert.deepEqual(result.emits, [{ count: 2 }]);
    assert.deepEqual(result.console, [{ level: "log", text: "reviewed 2" }]);
    assert.match(JSON.stringify(result.value), /\[run review-a; id=run-revi\]/);
    assert.equal(result.trace.filter((entry) => entry.state === "completed").length, 3);
    assert.ok(traceSnapshots.length >= 4);
    assert.deepEqual(emitSnapshots, [1]);
  });

  it("waits for every runs.all child and returns ordinary failures in input order", async () => {
    let delayedFinished = false;
    let delayedAborted = false;
    const result = await runWorkflowScript({
      script: `
        const children = await runs.all([
          { key: "fails-first", agent: "worker", task: "fail" },
          { key: "finishes-later", agent: "worker", task: "finish" }
        ]);
        return children.map(({ key, ok, error, results }) => error === undefined ? { key, ok, results } : { key, ok, error, results });
      `,
      timeoutMs: 2_000,
      launch(key, _params, signal) {
        if (key === "fails-first") {
          return Promise.resolve({
            key,
            ok: false,
            output: "acceptance rejected",
            artifactPaths: [],
            results: [{ acceptance: { status: "rejected" } }],
          });
        }
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            delayedFinished = true;
            resolve({ key, ok: true, output: "completed", artifactPaths: [], results: [] });
          }, 50);
          signal.addEventListener("abort", () => {
            delayedAborted = !delayedFinished;
            clearTimeout(timer);
            reject(signal.reason);
          }, { once: true });
        });
      },
      async status(key) { return okChild(key); },
    });

    assert.equal(delayedFinished, true);
    assert.equal(delayedAborted, false);
    assert.deepEqual(result.value, [
      { key: "fails-first", ok: false, error: "acceptance rejected", results: [{ acceptance: { status: "rejected" } }] },
      { key: "finishes-later", ok: true, results: [] },
    ]);
  });

  it("keeps runs.run fail-fast for ordinary child failures", async () => {
    await assert.rejects(
      runWorkflowScript({
        script: `return await runs.run("fails", { agent: "worker", task: "fail" });`,
        timeoutMs: 2_000,
        async launch(key) { return { key, ok: false, output: "failed", artifactPaths: [], results: [] }; },
        async status(key) { return okChild(key); },
      }),
      (error: unknown) => error instanceof WorkflowScriptError && /Run 'fails' failed: failed/.test(error.message),
    );
  });

  it("validates every runs.all item before launching children", async () => {
    let launches = 0;
    await assert.rejects(
      runWorkflowScript({
        script: `return await runs.all([{ key: "valid", agent: "worker", task: "t" }, { key: "bad key", agent: "worker", task: "t" }]);`,
        timeoutMs: 2_000,
        async launch(key) { launches++; return okChild(key); },
        async status(key) { return okChild(key); },
      }),
      (error: unknown) => error instanceof WorkflowScriptError && /bad key|invalid key/.test(error.message),
    );
    assert.equal(launches, 0);
  });

  it("rejects legacy orchestration params in runs.run", async () => {
    for (const params of [
      `tasks: [{ agent: "worker", task: "x" }]`,
      `chain: [{ agent: "worker", task: "x" }]`,
      `parallel: [{ agent: "worker", task: "x" }]`,
    ]) {
      await assert.rejects(
        runWorkflowScript({
          script: `return await runs.run("k", { agent: "worker", task: "t", ${params} });`,
          timeoutMs: 2_000,
          async launch(key) { return okChild(key); },
          async status(key) { return okChild(key); },
        }),
        (error: unknown) => error instanceof WorkflowScriptError,
      );
    }
  });

  it("rejects a duplicate key with incompatible params", async () => {
    await assert.rejects(
      runWorkflowScript({
        script: `
          const a = runs.run("dup", { agent: "worker", task: "one" });
          const b = runs.run("dup", { agent: "worker", task: "two" });
          return await Promise.all([a, b]);
        `,
        timeoutMs: 2_000,
        async launch(key) { return okChild(key); },
        async status(key) { return okChild(key); },
      }),
      (error: unknown) => error instanceof WorkflowScriptError && /Duplicate workflow key 'dup'/.test(error.message),
    );
  });

  it("reuses a duplicate key with identical params", async () => {
    let launches = 0;
    const result = await runWorkflowScript({
      script: `
        const a = runs.run("same", { agent: "worker", task: "one" });
        const b = runs.run("same", { agent: "worker", task: "one" });
        return await Promise.all([a, b]);
      `,
      timeoutMs: 2_000,
      async launch(key) { launches++; return okChild(key); },
      async status(key) { return okChild(key); },
    });
    assert.equal(launches, 1);
    assert.equal((result.value as Child[]).length, 2);
  });

  it("validates runs.steer input before calling the host", async () => {
    for (const script of [
      `return runs.steer("bad key", "guide");`,
      `return runs.steer("writer", " ");`,
      `return runs.steer("writer", "guide", { mode: "later" });`,
      `return runs.steer("writer", "guide", { runId: "raw-id" });`,
    ]) {
      let steerCalls = 0;
      await assert.rejects(
        runWorkflowScript({
          script,
          async launch(key) { return okChild(key); },
          async status(key) { return okChild(key); },
          async steer(key) { steerCalls++; return { key, state: "delivered" }; },
        }),
        (error: unknown) => error instanceof WorkflowScriptError && /runs\.steer/.test(error.message),
      );
      assert.equal(steerCalls, 0);
    }
  });

  it("steers a still-running sibling after Promise.race and awaits both children", async () => {
    let resolveSlow!: (result: Child) => void;
    const result = await runWorkflowScript({
      script: `
        const fast = runs.run("fast", { agent: "worker", task: "fast" });
        const slow = runs.run("slow", { agent: "worker", task: "slow" });
        const first = await Promise.race([fast, slow]);
        const receipt = await runs.steer("slow", "Focus on tests.", { mode: "auto", index: 0, ackTimeoutMs: 100 });
        const children = await Promise.all([fast, slow]);
        return { first: first.key, receipt, children: children.map((child) => child.key) };
      `,
      launch(key) {
        if (key === "fast") return Promise.resolve(okChild(key, "fast"));
        return new Promise((resolve) => { resolveSlow = resolve; });
      },
      async status(key) { return okChild(key); },
      async steer(key, message, options) {
        assert.equal(key, "slow");
        assert.equal(message, "Focus on tests.");
        assert.deepEqual(options, { mode: "auto", index: 0, ackTimeoutMs: 100 });
        resolveSlow(okChild(key, "slow"));
        return { key, state: "delivered", requestId: "request-1" };
      },
    });

    assert.deepEqual(result.value, {
      first: "fast",
      receipt: { key: "slow", state: "delivered", requestId: "request-1" },
      children: ["fast", "slow"],
    });
    assert.deepEqual(result.trace.filter((entry) => entry.operation === "steer").map(({ state }) => state), ["started", "delivered"]);
  });

  it("rejects nested async helpers (AST rule)", async () => {
    await assert.rejects(
      runWorkflowScript({
        script: `
          async function helper() { return runs.run("k", { agent: "worker", task: "t" }); }
          return await helper();
        `,
        timeoutMs: 2_000,
        async launch(key) { return okChild(key); },
        async status(key) { return okChild(key); },
      }),
      (error: unknown) => error instanceof WorkflowScriptError && /nested async/.test(error.message),
    );
  });

  it("accepts plain helper functions returning runs.run", async () => {
    const result = await runWorkflowScript({
      script: `
        function scan() { return runs.run("k", { agent: "scout", task: "t" }); }
        const result = await scan();
        return result.output;
      `,
      timeoutMs: 2_000,
      async launch(key) { return okChild(key, "scanned"); },
      async status(key) { return okChild(key); },
    });
    assert.equal(result.value, "scanned");
  });

  it("times out runaway scripts", async () => {
    await assert.rejects(
      runWorkflowScript({
        script: `await new Promise(() => {});`,
        timeoutMs: 100,
        async launch(key) { return okChild(key); },
        async status(key) { return okChild(key); },
      }),
      (error: unknown) => error instanceof WorkflowScriptError && /timed out/.test(error.message),
    );
  });

  it("state is unavailable without a mission adapter", async () => {
    await assert.rejects(
      runWorkflowScript({
        script: `return await state.get("k");`,
        timeoutMs: 2_000,
        async launch(key) { return okChild(key); },
        async status(key) { return okChild(key); },
      }),
      (error: unknown) => error instanceof WorkflowScriptError && /state is unavailable|ReferenceError/.test(error.message),
    );
  });

  it("state adapter works when provided", async () => {
    const store = new Map<string, unknown>([["seed", { count: 1 }]]);
    const result = await runWorkflowScript({
      script: `
        const seed = await state.get("seed");
        await state.set("double", { count: seed.count * 2 });
        return await state.get("double");
      `,
      timeoutMs: 2_000,
      async launch(key) { return okChild(key); },
      async status(key) { return okChild(key); },
      state: {
        get: (key) => store.get(key),
        set: (key, value) => void store.set(key, value),
      },
    });
    assert.deepEqual(result.value, { count: 2 });
  });

  it("emit rejects non-JSON values", async () => {
    await assert.rejects(
      runWorkflowScript({
        script: `emit(() => {}); return 1;`,
        timeoutMs: 2_000,
        async launch(key) { return okChild(key); },
        async status(key) { return okChild(key); },
      }),
      (error: unknown) => error instanceof WorkflowScriptError && /emit/.test(error.message),
    );
  });

  it("formatWorkflowJsonPreview returns undefined for non-JSON", () => {
    assert.equal(formatWorkflowJsonPreview(undefined, 100), undefined);
    assert.equal(formatWorkflowJsonPreview({ a: 1 }, 100), '{"a":1}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.equal(formatWorkflowJsonPreview(cyclic, 100), undefined);
  });
});
