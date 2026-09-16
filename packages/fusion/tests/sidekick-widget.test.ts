import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldShowSidekickWidget } from "../src/sidekick-widget.js";

test("sidekick widget only shows for detached busy handoffs", () => {
  assert.equal(shouldShowSidekickWidget(true, false), true);
  assert.equal(shouldShowSidekickWidget(true, true), false);
  assert.equal(shouldShowSidekickWidget(false, false), false);
});
