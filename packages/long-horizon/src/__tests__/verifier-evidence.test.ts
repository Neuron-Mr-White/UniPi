import { strict as assert } from "node:assert";
import { test } from "node:test";
import { registerEvidenceContributor } from "@pi-unipi/core";
import { verifyCompletion } from "../engine/verifier.js";

const evaluateMet = async () => '{"verdict":"met","reason":"tests pass","missing":[]}';

test("a blocking contributor forces not_met WITHOUT calling the evaluator", async () => {
  let evaluatorCalls = 0;
  const off = registerEvidenceContributor("kanboard", async () => ({
    blocking: ["UNI-30 is still In Progress"],
    notes: [],
  }));
  try {
    const verdict = await verifyCompletion(
      {
        evaluate: async () => {
          evaluatorCalls += 1;
          return evaluateMet();
        },
      },
      "all tests pass",
      "brief",
    );
    assert.equal(verdict.verdict, "not_met");
    assert.equal(verdict.reason, "board: open work remains");
    assert.deepEqual([...verdict.missing], ["UNI-30 is still In Progress"]);
    assert.equal(verdict.evaluatorFailed, false);
    assert.equal(evaluatorCalls, 0, "the evidence is already conclusive");
  } finally {
    off();
  }
});

test("notes ride the brief to the evaluator; no blocking → normal verdict", async () => {
  let prompt = "";
  const off = registerEvidenceContributor("other", async () => ({
    blocking: [],
    notes: ["3 tasks in review"],
  }));
  try {
    const verdict = await verifyCompletion(
      {
        evaluate: async (received) => {
          prompt = received;
          return evaluateMet();
        },
      },
      "all tests pass",
      "brief",
    );
    assert.equal(verdict.verdict, "met");
    assert.match(prompt, /--- MODULE EVIDENCE ---/);
    assert.match(prompt, /3 tasks in review/);
  } finally {
    off();
  }
});

test("a throwing contributor is no contribution — evaluator decides", async () => {
  const off = registerEvidenceContributor("broken", async () => {
    throw new Error("kanboard down");
  });
  try {
    const verdict = await verifyCompletion({ evaluate: evaluateMet }, "objective", "brief");
    assert.equal(verdict.verdict, "met");
  } finally {
    off();
  }
});

test("no contributors: evaluator path unchanged", async () => {
  const verdict = await verifyCompletion({ evaluate: evaluateMet }, "objective", "brief");
  assert.equal(verdict.verdict, "met");
  assert.equal(verdict.evaluatorFailed, false);
});
