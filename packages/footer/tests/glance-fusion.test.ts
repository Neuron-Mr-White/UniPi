import { test } from "node:test";
import assert from "node:assert/strict";
import { renderFusionStatus } from "../src/glance-editor.js";

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/gu, "");

test("busy Fusion status marks the sidekick as working and shows the split", () => {
  const text = plain(renderFusionStatus({
    leadName: "Opus 5",
    leadEffort: "high",
    sidekickName: "DeepSeek Flash",
    sidekickEffort: "high",
    busy: true,
    leadToolCalls: 3,
    sidekickToolCalls: 12,
  }));
  assert.match(text, /◆ DeepSeek Flash high · working · 12\/15 calls/);
  assert.doesNotMatch(text, /working │.*calls/);
});

test("idle Fusion status omits working and zero-call split", () => {
  const text = plain(renderFusionStatus({
    leadName: "Opus 5",
    leadEffort: "high",
    sidekickName: "DeepSeek Flash",
    sidekickEffort: "high",
    busy: false,
    leadToolCalls: 0,
    sidekickToolCalls: 0,
  }));
  assert.doesNotMatch(text, /working/);
  assert.doesNotMatch(text, /calls/);
});
