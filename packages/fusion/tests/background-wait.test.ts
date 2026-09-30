import { strict as assert } from "node:assert";
import { test } from "node:test";
import { BackgroundHandoffTracker } from "../src/tools.js";
import type { HandoffReport } from "./sidekick-runtime.js";

function report(id: string): HandoffReport {
  return {
    id,
    status: "completed",
    text: "done",
    toolCalls: 1,
    usage: { input: 1, output: 1 },
    durationMs: 10,
    events: [],
  } as unknown as HandoffReport;
}

test("background handoff tracker: in flight → reason; resolved → null", async () => {
  const tracker = new BackgroundHandoffTracker();
  assert.equal(tracker.reason(), null);
  let resolveDone: (r: HandoffReport) => void = () => undefined;
  const done = new Promise<HandoffReport>((resolve) => {
    resolveDone = resolve;
  });
  tracker.track("h1", done);
  assert.equal(tracker.size, 1);
  assert.equal(tracker.reason(), "sidekick working");
  resolveDone(report("h1"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(tracker.size, 0, "resolved handoff leaves the tracker");
  assert.equal(tracker.reason(), null);
});

test("background handoff tracker: a rejected handoff also clears", async () => {
  const tracker = new BackgroundHandoffTracker();
  let rejectDone: (error: Error) => void = () => undefined;
  const done = new Promise<HandoffReport>((_resolve, reject) => {
    rejectDone = reject;
  });
  tracker.track("h1", done);
  rejectDone(new Error("sidekick died"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(tracker.size, 0);
  assert.equal(tracker.reason(), null);
});

test("background handoff tracker: several in flight stay tracked", () => {
  const tracker = new BackgroundHandoffTracker();
  tracker.track("h1", new Promise(() => undefined));
  tracker.track("h2", new Promise(() => undefined));
  assert.equal(tracker.size, 2);
  assert.equal(tracker.reason(), "sidekick working");
});
