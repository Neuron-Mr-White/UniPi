/**
 * @pi-unipi/utility — auto-rename gate, prompt and settings migration
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, gateRequest, isChatter, sanitizeName } from "../src/rename/gate.ts";
import { renamePrompt } from "../src/rename/session.ts";
import { migrateBadgeToRename, normalizeSettings } from "../src/settings.ts";
import { projectSettingsPath } from "@pi-unipi/core";

describe("rename gate", () => {
  it("never renames on greetings, acks or commands", () => {
    for (const t of ["hi", "Hello there!", "thanks", "ok", "go ahead", "continue", "/unipi:plan", "yes."]) {
      assert.equal(isChatter(t), true, t);
      assert.equal(decide({ prompt: t, currentName: null, earlier: [] }, null).rename, false, t);
    }
    assert.equal(isChatter("fix the kanboard lane ordering"), false);
  });

  it("asks the topic question only when the session is named", () => {
    assert.deepEqual(Object.keys(gateRequest({ prompt: "fix lanes", currentName: null, earlier: [] }).questions), ["request"]);
    const named = gateRequest({ prompt: "fix lanes", currentName: "Kanboard Lanes", earlier: ["earlier ask"] });
    assert.deepEqual(Object.keys(named.questions).sort(), ["request", "topic"]);
    assert.match(named.state, /Current session title: "Kanboard Lanes"/);
    assert.match(named.state, /earlier ask/);
  });

  it("renames a first real request, and later only on a confident topic change", () => {
    const task = { choice: "task", confidence: 0.9 };
    assert.equal(decide({ prompt: "fix the lane order", currentName: null, earlier: [] }, { request: task }).rename, true);
    const named = { prompt: "now the image module", currentName: "Kanboard Lanes", earlier: [] };
    assert.equal(decide(named, { request: task, topic: { choice: "new", confidence: 0.85 } }).rename, true);
    assert.equal(decide(named, { request: task, topic: { choice: "new", confidence: 0.5 } }).rename, false);
    assert.equal(decide(named, { request: task, topic: { choice: "same", confidence: 0.95 } }).rename, false);
    assert.equal(decide(named, { request: { choice: "chatter", confidence: 0.9 }, topic: { choice: "new", confidence: 0.9 } }).rename, false);
  });

  it("falls back without jev: only an unnamed session on a 4+ word prompt", () => {
    assert.equal(decide({ prompt: "fix the lane order please", currentName: null, earlier: [] }, null).rename, true);
    assert.equal(decide({ prompt: "fix lanes", currentName: null, earlier: [] }, null).rename, false);
    assert.equal(decide({ prompt: "a totally different task now", currentName: "Old", earlier: [] }, null).rename, false);
  });

  it("sanitizes model titles", () => {
    assert.equal(sanitizeName('"Kanboard Lane Ordering."\nextra'), "Kanboard Lane Ordering");
    assert.equal(sanitizeName("one two three four five six seven eight"), "one two three four five six");
  });

  it("builds a prompt from the current name and recent requests only", () => {
    const p = renamePrompt({ currentName: "Old Name", requests: ["a", "b", "c", "d", "e"], model: "" });
    assert.match(p, /Current title: Old Name/);
    assert.doesNotMatch(p, /- a\n/);
    assert.match(p, /- e$/);
    const moved = renamePrompt({ currentName: "Kanboard Lanes", requests: ["kanboard stuff", "bash one-liner for big files"], model: "", topicChanged: true });
    assert.match(moved, /no longer fits/);
    assert.doesNotMatch(moved, /kanboard stuff/);
    assert.match(moved, /bash one-liner/);
  });
});

describe("utility settings migration", () => {
  it("maps badge.* onto rename.*", () => {
    const s = normalizeSettings({ badge: { autoGen: false, herdrSync: false, generationModel: "openrouter/x" } });
    assert.deepEqual(s.rename, { auto: false, model: "openrouter/x", herdrSync: false });
    assert.equal(normalizeSettings({ badge: { generationModel: "inherit" } }).rename.model, "");
  });

  it("rewrites a project layer's badge block in place", () => {
    const cwd = mkdtempSync(join(tmpdir(), "unipi-util-settings-"));
    const file = projectSettingsPath(cwd, "utility");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ badge: { autoGen: false, badgeEnabled: false, agentTool: false }, skills: { mode: "judged" } }));
    migrateBadgeToRename(cwd);
    const out = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(out, { skills: { mode: "judged" }, rename: { auto: false } });
  });
});

describe("rounds, not just prompts", () => {
  it("a vague opener that turned into real work can name the session", async () => {
    const { decide, isIdleRound, gateRequest } = await import("../src/rename/gate.ts");
    const input = { prompt: "Hi, lets discuss about what we have", currentName: null, earlier: [], reply: "Here's the full picture of pi-test: a sandbox project…", toolCalls: 6 };
    assert.equal(isIdleRound(input), false);
    assert.match(gateRequest(input).state, /Assistant's reply this round \(6 tool calls\)/);
    assert.equal(decide(input, { request: { choice: "task", confidence: 0.8 } } as never).rename, true);
    assert.equal(isIdleRound({ prompt: "hi", currentName: null, earlier: [], toolCalls: 0 }), true);
    assert.equal(decide({ ...input, prompt: "hi" }, null).rename, true, "jev down: tool work still counts");
  });
  it("extracts the last reply and counts tool calls", async () => {
    const { lastReplyText, countToolCalls } = await import("../src/rename/index.ts");
    const msgs = [
      { role: "assistant", content: [{ type: "toolCall" }, { type: "toolCall" }] },
      { role: "toolResult", content: [] },
      { role: "assistant", content: [{ type: "text", text: "<summary>\nDone: overview\n</summary>" }] },
    ];
    assert.equal(lastReplyText(msgs), "Done: overview");
    assert.equal(countToolCalls(msgs), 2);
  });
});
