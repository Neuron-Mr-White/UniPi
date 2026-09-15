import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateSavings } from "../src/savings.js";

test("manual price overrides make savings non-zero", () => {
  const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 100_000, cacheWrite: 50_000, cost: 0 };
  const lead = { input: 10, cachedInput: 0.25, output: 50 };
  const side = { input: 0.2, cachedInput: 0.02, output: 1.2 };
  assert.deepEqual(estimateSavings(usage, lead, side), {
    sidekickUsd: 1.412,
    atLeadUsd: 60.525,
    savedUsd: 59.113,
  });
});
