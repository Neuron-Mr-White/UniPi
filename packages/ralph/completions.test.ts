import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRalphArgumentCompletions, type LoopSummary } from "./completions.ts";

const loops: LoopSummary[] = [
  { name: "alpha", status: "active", iteration: 2, maxIterations: 50 },
  { name: "beta", status: "paused", iteration: 5, maxIterations: 0 },
  { name: "gamma", status: "completed", iteration: 9, maxIterations: 10 },
];
const completions = (text: string) => buildRalphArgumentCompletions(text, () => loops);

describe("ralph argument completions", () => {
  it("suggests all subcommands for empty input", () => {
    const items = completions("");
    assert.ok(items);
    assert.deepEqual(items.map((i) => i.value), [
      "start",
      "stop",
      "resume",
      "status",
      "list",
      "cancel",
      "archive",
      "clean",
      "nuke",
    ]);
    assert.ok(items.every((i) => i.description));
  });

  it("filters subcommands by prefix", () => {
    assert.deepEqual(completions("re")?.map((i) => i.value), ["resume"]);
    assert.deepEqual(completions("s")?.map((i) => i.value), ["start", "stop", "status"]);
  });

  it("suggests loop names for resume, excluding completed loops", () => {
    const items = completions("resume ");
    assert.ok(items);
    assert.deepEqual(items.map((i) => i.value), ["resume alpha", "resume beta"]);
    assert.match(items[0].description!, /active/);
    assert.match(items[1].description!, /paused/);
  });

  it("suggests loop names while typing a partial name", () => {
    assert.deepEqual(completions("resume be")?.map((i) => i.value), ["resume beta"]);
  });

  it("archive excludes active loops; cancel includes all", () => {
    assert.deepEqual(completions("archive ")?.map((i) => i.label), ["beta", "gamma"]);
    assert.deepEqual(completions("cancel ")?.map((i) => i.label), ["alpha", "beta", "gamma"]);
  });

  it("returns no suggestions for a fully typed loop name", () => {
    assert.equal(completions("resume alpha"), null);
    assert.equal(completions("resume alpha "), null);
  });

  it("start suggests flags after the name, preserving the typed prefix", () => {
    const items = completions("start mytask ");
    assert.ok(items);
    assert.deepEqual(items.map((i) => i.value), [
      "start mytask --max-iterations",
      "start mytask --items-per-iteration",
      "start mytask --reflect-every",
    ]);
    assert.ok(items.every((i) => i.description));
  });

  it("start excludes already-used flags", () => {
    const items = completions("start mytask --max-iterations 50 ");
    assert.deepEqual(items?.map((i) => i.label), ["--items-per-iteration", "--reflect-every"]);
    assert.deepEqual(items?.map((i) => i.value), [
      "start mytask --max-iterations 50 --items-per-iteration",
      "start mytask --max-iterations 50 --reflect-every",
    ]);
  });

  it("start returns null while typing a flag value or the free-form name", () => {
    assert.equal(completions("start "), null);
    assert.equal(completions("start my"), null);
    assert.equal(completions("start mytask --max-iterations "), null);
  });

  it("list/clean/nuke suggest their flag exactly once", () => {
    assert.deepEqual(completions("list ")?.map((i) => i.value), ["list --archived"]);
    assert.deepEqual(completions("list --archived"), null);
    assert.deepEqual(completions("list --archived "), null);
    assert.deepEqual(completions("clean ")?.map((i) => i.value), ["clean --all"]);
    assert.deepEqual(completions("clean --all "), null);
    assert.deepEqual(completions("nuke ")?.map((i) => i.value), ["nuke --yes"]);
  });

  it("no suggestions for argument-less or unknown subcommands", () => {
    assert.equal(completions("stop "), null);
    assert.equal(completions("status "), null);
    assert.equal(completions("bogus "), null);
  });

  it("returns null when nothing matches the prefix", () => {
    assert.equal(completions("zzz"), null);
    assert.equal(completions("resume zzz"), null);
  });
});
