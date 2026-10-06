import { test } from "node:test";
import assert from "node:assert/strict";
import { lhModeLabel } from "../src/segments/long-horizon.js";
import type { LhStateEvent } from "@pi-unipi/core";

test("lhModeLabel: the four glance shapes", () => {
	assert.equal(lhModeLabel({ mode: "goal" }), "Goal Mode");
	assert.equal(lhModeLabel({ mode: "none", paused: "goal" }), "Goal Mode · paused", "parked owner while regular");
	assert.equal(lhModeLabel({ mode: "none" }), "Regular Mode");
	assert.equal(lhModeLabel(undefined), null);
});

test("lhModeLabel: unknown mode ids pass through raw", () => {
	assert.equal(lhModeLabel({ mode: "custom" } as LhStateEvent), "custom");
	assert.equal(lhModeLabel({ mode: "none", paused: "custom" }), "custom · paused");
});
