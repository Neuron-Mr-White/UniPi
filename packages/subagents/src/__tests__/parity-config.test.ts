/**
 * Parity config validation tests (ported from pi-subagents configuration.md
 * semantics: strict keys reject invalid values with visible errors;
 * best-effort keys fall back to defaults).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateParityConfig, initConfig } from "../config.js";
import type { SubagentsConfig } from "../types.js";

function base(overrides: Partial<SubagentsConfig> = {}): SubagentsConfig {
  return {
    maxConcurrent: 4,
    enabled: true,
    types: { explore: { enabled: true }, work: { enabled: true } },
    ...overrides,
  };
}

describe("validateParityConfig", () => {
  it("accepts an empty parity surface", () => {
    assert.deepEqual(validateParityConfig(base()), []);
  });

  it("accepts all documented parity keys with valid values", () => {
    const problems = validateParityConfig(
      base({
        asyncByDefault: true,
        defaultSubagentContext: "fork",
        forceTopLevelAsync: false,
        timeoutMs: 3600000,
        toolTimeoutMs: 600000,
        globalConcurrencyLimit: 20,
        maxSubagentSpawnsPerSession: 100,
        maxSubagentSpawnsPerRun: 64,
        maxActiveAsyncRunsPerSession: 4,
        maxSubagentDepth: 1,
        parallel: { maxTasks: 12, concurrency: 6 },
        maxOutput: { bytes: 204800, lines: 5000 },
        fleetView: true,
        fleetViewPlacement: "aboveEditor",
        inlineToolDisplay: "summary",
        resultScanLogging: "activity",
        waitTool: { enabled: false },
      }),
    );
    assert.deepEqual(problems, []);
  });

  it("rejects non-positive timeoutMs", () => {
    const problems = validateParityConfig(base({ timeoutMs: 0 }));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /timeoutMs/);
  });

  it("rejects non-integer toolTimeoutMs", () => {
    const problems = validateParityConfig(base({ toolTimeoutMs: 1.5 }));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /toolTimeoutMs/);
  });

  it("rejects timeoutMs above the timer ceiling", () => {
    const problems = validateParityConfig(base({ timeoutMs: 2147483648 }));
    assert.equal(problems.length, 1);
  });

  it("allows zero for spawn caps (zero = unlimited semantics)", () => {
    assert.deepEqual(
      validateParityConfig(
        base({
          maxSubagentSpawnsPerSession: 0,
          maxSubagentSpawnsPerRun: 0,
          maxActiveAsyncRunsPerSession: 0,
        }),
      ),
      [],
    );
  });

  it("rejects invalid defaultSubagentContext", () => {
    const problems = validateParityConfig(
      base({ defaultSubagentContext: "branched" as unknown as "fresh" | "fork" }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /defaultSubagentContext/);
  });

  it("rejects invalid fleetViewPlacement with fallback note", () => {
    const problems = validateParityConfig(
      base({ fleetViewPlacement: "middle" as unknown as "belowEditor" | "aboveEditor" }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /falling back/);
  });

  it("rejects invalid resultScanLogging", () => {
    const problems = validateParityConfig(
      base({ resultScanLogging: "verbose" as unknown as "all" | "activity" | "off" }),
    );
    assert.equal(problems.length, 1);
  });

  it("rejects invalid parallel sub-keys", () => {
    const problems = validateParityConfig(base({ parallel: { maxTasks: -1, concurrency: 0 } }));
    assert.equal(problems.length, 2);
  });

  it("rejects invalid maxOutput sub-keys", () => {
    const problems = validateParityConfig(base({ maxOutput: { bytes: 0 } }));
    assert.equal(problems.length, 1);
  });
});

describe("initConfig parity surface", () => {
  it("preserves our enablement semantics (types merge global+workspace)", () => {
    // The legacy contract: workspace types override global types per-key.
    const config = initConfig(process.cwd());
    assert.equal(typeof config.maxConcurrent, "number");
    assert.ok(config.types);
    assert.notEqual(config.types.explore?.enabled, false);
  });
});
