import { test } from "node:test";
import assert from "node:assert/strict";
import { Text } from "@earendil-works/pi-tui";
import { renderSidekickTranscript, primaryArg } from "../src/transcript.js";
import type { SidekickEvent } from "../src/sidekick-runtime.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const renderText = (text: string) => new Text(text, 0, 0);
const output = (events: SidekickEvent[], expanded: boolean, partial = true, report?: { text: string }) => renderSidekickTranscript(theme, {
  events,
  header: "HEADER",
  expanded,
  isPartial: partial,
  report,
  renderText,
}).render(120).join("\n");

test("separates assistant text around tool events", () => {
  const events: SidekickEvent[] = [
    { kind: "text", text: "Plan.", open: false },
    { kind: "tool", toolCallId: "1", name: "bash", args: { command: "ls" }, output: "file", isError: false, done: true, startedAt: 0 },
    { kind: "text", text: "Done.", open: false },
  ];
  const text = output(events, true);
  assert.match(text, /Plan\.[\s\S]*bash/);
  assert.match(text, /file[\s\S]*Done\./);
  assert.doesNotMatch(text, /Plan\.Done\./);
});

test("collapsed partial transcript keeps the last eight events", () => {
  const events: SidekickEvent[] = Array.from({ length: 12 }, (_, i) => ({ kind: "text", text: `step-${i}`, open: false }));
  const text = output(events, false);
  assert.match(text, /… 4 earlier steps/);
  assert.doesNotMatch(text, /step-0/);
  assert.match(text, /step-11/);
  assert.equal(output(events, true).includes("step-0"), true);
});

test("tool output and running state respect collapsed and expanded limits", () => {
  const outputLines = Array.from({ length: 5 }, (_, i) => `line-${i}`).join("\n");
  const running: SidekickEvent = { kind: "tool", toolCallId: "run", name: "bash", args: { command: "npm test" }, output: "", isError: false, done: false, startedAt: 0 };
  const done: SidekickEvent = { kind: "tool", toolCallId: "done", name: "bash", args: { command: "cat" }, output: outputLines, isError: false, done: true, startedAt: 0 };
  const collapsed = output([running, done], false);
  assert.match(collapsed, /running/);
  assert.doesNotMatch(collapsed, /line-0/);
  assert.match(collapsed, /line-4/);
  assert.match(output([running, done], true), /line-0/);
});

test("primaryArg selects the tool's main argument", () => {
  assert.equal(primaryArg("bash", { command: "npm test\nsecond" }), "npm test");
  assert.equal(primaryArg("read", { path: "/a/b" }), "/a/b");
});

test("final collapsed transcript shows report while expanded shows events", () => {
  const events: SidekickEvent[] = [{ kind: "text", text: "hidden transcript", open: false }];
  assert.match(output(events, false, false, { text: "final report" }), /final report/);
  assert.doesNotMatch(output(events, false, false, { text: "final report" }), /hidden transcript/);
  assert.match(output(events, true, false, { text: "final report" }), /hidden transcript/);
  assert.match(output(events, true, false, { text: "final report" }), /── report ──/);
});
