import { it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WATCHDOG_SETTINGS } from "../src/config.js";

it("watchdog defaults are enabled for bash only", () => {
  assert.deepEqual(DEFAULT_WATCHDOG_SETTINGS, {
    enabled: true, watchBash: true, watchBgTasks: false, otherTools: "off",
    action: "background", confidence: 0.5, agreeChecks: 2, firstCheckMin: 2, intervalMin: 3,
  });
});
