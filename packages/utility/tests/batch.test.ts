/**
 * @pi-unipi/utility — Batch execution tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeBatch, BatchBuilder } from "../src/tools/batch.ts";
import type { BatchCommand } from "../src/types.ts";

describe("executeBatch", () => {
  it("executes all commands successfully", async () => {
    const commands: BatchCommand[] = [
      { type: "command", name: "echo" },
      { type: "command", name: "echo" },
    ];

    const executor = async () => "ok";
    const report = await executeBatch(commands, executor);

    assert.equal(report.success, true);
    assert.equal(report.results.length, 2);
    assert.ok(report.results.every((r) => r.success));
  });

  it("fails fast by default", async () => {
    const commands: BatchCommand[] = [
      { type: "command", name: "ok" },
      { type: "command", name: "fail" },
      { type: "command", name: "skipped" },
    ];

    let callCount = 0;
    const executor = async (cmd: BatchCommand) => {
      callCount++;
      if (cmd.name === "fail") throw new Error("boom");
      return "ok";
    };

    const report = await executeBatch(commands, executor);
    assert.equal(report.success, false);
    assert.equal(report.rolledBack, false);
    assert.equal(callCount, 2); // Third command not executed
  });

  it("continues on error when failFast is false", async () => {
    const commands: BatchCommand[] = [
      { type: "command", name: "ok" },
      { type: "command", name: "fail" },
      { type: "command", name: "ok2" },
    ];

    const executor = async (cmd: BatchCommand) => {
      if (cmd.name === "fail") throw new Error("boom");
      return "ok";
    };

    const report = await executeBatch(commands, executor, { failFast: false });
    assert.equal(report.results.length, 3);
    assert.equal(report.results.filter((r) => r.success).length, 2);
  });

  it("calls rollback on failure", async () => {
    const commands: BatchCommand[] = [{ type: "command", name: "fail" }];
    let rollbackCalled = false;

    const report = await executeBatch(
      commands,
      async () => {
        throw new Error("boom");
      },
      {},
      async () => {
        rollbackCalled = true;
      },
    );

    assert.equal(report.rolledBack, true);
    assert.equal(rollbackCalled, true);
  });

  it("respects command timeout", async () => {
    const commands: BatchCommand[] = [{ type: "command", name: "slow" }];

    const report = await executeBatch(
      commands,
      async () => {
        await new Promise((r) => setTimeout(r, 1000));
        return "ok";
      },
      { commandTimeoutMs: 50 },
    );

    assert.equal(report.success, false);
    assert.ok(report.results[0].error?.includes("timeout"));
  });
});

describe("BatchBuilder", () => {
  it("builds and executes batches fluently", async () => {
    const report = await new BatchBuilder()
      .addCommand("echo", { text: "hello" })
      .addTool("search", { query: "test" })
      .withOptions({ failFast: true })
      .execute(async () => "ok");

    assert.equal(report.success, true);
    assert.equal(report.results.length, 2);
  });
});
