import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  registerCommandRunner,
  resetCommandRunners,
  runCommandByName,
} from "./command-runner.js";

beforeEach(() => resetCommandRunners());

describe("command runner (hub action rows)", () => {
  it("invokes the registered runner with ctx", async () => {
    const seen: unknown[] = [];
    registerCommandRunner("unipi:test", (ctx) => {
      seen.push(ctx);
    });
    assert.equal(await runCommandByName("unipi:test", { marker: 1 }), true);
    assert.deepEqual(seen, [{ marker: 1 }]);
  });

  it("returns false for unknown commands", async () => {
    assert.equal(await runCommandByName("unipi:missing", {}), false);
  });

  it("supports async runners", async () => {
    let done = false;
    registerCommandRunner("unipi:async", async () => {
      await Promise.resolve();
      done = true;
    });
    await runCommandByName("unipi:async", {});
    assert.equal(done, true);
  });
});
