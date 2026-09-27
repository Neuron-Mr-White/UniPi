import { test } from "node:test";
import assert from "node:assert/strict";
import { progressLines, progressBar } from "@pi-unipi/core";
import { goalEstimatePrompt, goalProgressData, parseEstimate, ralphProgressData } from "../progress.js";

const plain = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

test("bar: solid done, shade in progress, light for the rest", () => {
  assert.equal(progressBar(plain, 4, 2, 10, 10), "████▒▒░░░░");
  assert.equal(progressBar(plain, 10, 0, 10, 10), "██████████");
  assert.equal(progressBar(plain, 0, 1, 40, 10), "▒░░░░░░░░░", "a live slice always shows at least one shade cell");
  assert.equal(progressBar(plain, 0, 0, 0, 5), "░░░░░");
});

test("ralph bar counts checklist items; the next batch is shaded", () => {
  const ralph = {
    get: () => ({ name: "docs", iteration: 3, maxIterations: 20, itemsPerIteration: 2, status: "active" }) as never,
    progressSummary: () => ({ checked: 4, total: 10, next: ["a", "b"] }),
  };
  const d = ralphProgressData(ralph)!;
  assert.deepEqual([d.done, d.active, d.total, d.unit], [4, 2, 10, "items"]);
  const [head, next] = progressLines(plain, d, 100);
  assert.equal(head, "↻ Ralph · docs  ████████▒▒▒▒░░░░░░░░  4/10 items  iteration 3/20");
  assert.equal(next, "  next: a · b");
});

test("goal estimate: prompt carries evidence, reply parsing is tolerant", () => {
  const prompt = goalEstimatePrompt({ objective: "ship the parser", turn: 4, maxTurns: 30 }, { commands: ["npm test"], changedFiles: ["src/p.ts", "src/p.ts"], recentTail: [{ role: "assistant", text: "parser done" }] }, 40);
  assert.match(prompt, /Objective: ship the parser/);
  assert.match(prompt, /Previous estimate: 40%/);
  assert.match(prompt, /Files touched recently: src\/p\.ts$/m);
  assert.deepEqual(parseEstimate('```json\n{"percent": 55.4, "summary": " parser done "}\n```'), { percent: 55, summary: "parser done" });
  assert.deepEqual(parseEstimate('{"percent": 140}'), { percent: 100, summary: "" });
  assert.equal(parseEstimate("no idea"), undefined);
});

test("goal bar: estimated (~), shaded while live, full and plain when complete", () => {
  const live = goalProgressData({ turn: 4, maxTurns: 30, status: "active" }, 55, "parser done");
  assert.equal(progressLines(plain, live, 100)[0], "◎ Goal  ███████████▒▒░░░░░░░  ~55%  turn 4/30");
  const done = goalProgressData({ turn: 9, maxTurns: 30, status: "complete" }, 80, "");
  assert.equal(progressLines(plain, done, 100)[0], "◎ Goal  ████████████████████  100%  turn 9/30 · complete");
});
