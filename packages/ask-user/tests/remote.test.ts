/** ask_user answered from the UniPi phone app (through core's remote dialog racer). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { raceRemote, setRemoteDialogRacer } from "@pi-unipi/core";
import { phoneAnswer } from "../tools.js";

const questions = [
  { question: "Which DB?", header: "DB", options: [{ label: "Postgres" }, { label: "SQLite", value: "sqlite" }] },
  { question: "Extras?", header: "Extras", multi_select: true, options: [{ label: "Auth" }, { label: "Cache" }] },
  { question: "Stop?", header: "Stop", other: false, options: [{ label: "Go on" }, { label: "End turn", action: "end_turn" as const }] },
];

test("phoneAnswer keeps known options, pads skips and honours single vs multi", () => {
  const r = phoneAnswer({ type: "answered", answers: [{ selected: ["sqlite", "Postgres"] }, { selected: ["Auth", "nope", "Cache"] }] }, questions);
  assert.deepEqual(r, {
    type: "answered",
    answers: [
      { selected: ["sqlite"], skipped: false },
      { selected: ["Auth", "Cache"], skipped: false },
      { selected: [], skipped: true },
    ],
    attachments: [],
  });
});

test("phoneAnswer: free text, skipped, cancel and garbage", () => {
  const r = phoneAnswer({ type: "answered", answers: [{ selected: [], custom_text: " MySQL " }, { skipped: true }, { selected: [], custom_text: "x" }] }, questions);
  assert.equal(r.type, "answered");
  if (r.type !== "answered") return;
  assert.deepEqual(r.answers[0], { selected: [], custom_text: "MySQL", skipped: false });
  assert.deepEqual(r.answers[1], { selected: [], skipped: true });
  assert.deepEqual(r.answers[2], { selected: [], skipped: true }, "other:false ignores free text");
  assert.deepEqual(phoneAnswer({ type: "cancel" }, questions), { type: "cancel" });
  assert.deepEqual(phoneAnswer(null, questions), { type: "cancel" });
  assert.deepEqual(phoneAnswer("??", questions), { type: "cancel" });
});

test("phoneAnswer: an action option acts like the TUI", () => {
  const r = phoneAnswer({ type: "answered", answers: [{ selected: ["Postgres"] }, { skipped: true }, { selected: ["End turn"] }] }, questions);
  assert.equal(r.type, "action");
  if (r.type === "action") {
    assert.equal(r.question, 2);
    assert.equal(r.option.action, "end_turn");
  }
});

test("raceRemote without the bridge just runs the TUI", async () => {
  setRemoteDialogRacer(undefined);
  assert.equal(await raceRemote({ kind: "ask_user" }, async () => "tui", () => "phone"), "tui");
});

test("raceRemote with a racer: phone answer closes the TUI side", async () => {
  let tuiClosed = false;
  let answer: ((v: unknown) => void) | undefined;
  setRemoteDialogRacer({
    race: (_spec, runTui, fromPhone) =>
      new Promise((resolve) => {
        const abort = new AbortController();
        runTui(abort.signal).then(resolve);
        answer = (v) => {
          abort.abort();
          resolve(fromPhone(v));
        };
      }),
  });
  const p = raceRemote(
    { kind: "ask_user", questions },
    (signal) => new Promise<string>((r) => signal.addEventListener("abort", () => ((tuiClosed = true), r("tui-cancel")))),
    (v) => `phone:${String(v)}`,
  );
  answer!("yes");
  assert.equal(await p, "phone:yes");
  assert.equal(tuiClosed, true);
  setRemoteDialogRacer(undefined);
});
