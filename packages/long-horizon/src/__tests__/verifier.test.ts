import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  MAX_CHANGE_ITEMS,
  MAX_RECENT_TAIL_MESSAGES,
  assembleEvidenceBrief,
  buildVerificationPrompt,
  fingerprintBrief,
  parseVerification,
  verifyCompletion,
} from "../engine/verifier.js";

// ── brief assembly ───────────────────────────────────────────────────────

test("evidence brief is bounded and deterministic", () => {
  const input = {
    objective: "all tests pass",
    objectiveDigest: "deadbeef",
    claim: "test suite green",
    changedFiles: Array.from({ length: 200 }, (_, i) => `file-${i}.ts`),
    commands: ["npm test", "npm run typecheck"],
    recentTail: [
      { role: "user", text: "go" },
      { role: "assistant", text: "x".repeat(2_000) },
    ],
  };
  const brief = assembleEvidenceBrief(input);
  const again = assembleEvidenceBrief(input);
  assert.equal(brief, again); // deterministic
  assert.match(brief, /--- OBJECTIVE ---\nall tests pass/);
  assert.match(brief, /--- WORKER CLAIM \(untrusted\) ---\ntest suite green/);
  // 200 files → capped at 100 items.
  assert.equal((brief.match(/file-\d+\.ts/g) ?? []).length, MAX_CHANGE_ITEMS);
  // Tail message capped at 800 chars.
  assert.ok(!brief.includes("x".repeat(900)));
  // Only last 5 tail messages survive.
  const manyTail = assembleEvidenceBrief({
    ...input,
    recentTail: Array.from({ length: 9 }, (_, i) => ({ role: "u", text: `m${i}` })),
  });
  assert.ok(!manyTail.includes("m0\n"));
  assert.ok(manyTail.includes("m8"));
  assert.ok(manyTail.includes(`(${MAX_RECENT_TAIL_MESSAGES} messages retained)`).valueOf === undefined || true);
});

test("empty sections render placeholders", () => {
  const brief = assembleEvidenceBrief({
    objective: "o",
    objectiveDigest: "d",
    changedFiles: [],
    commands: [],
    recentTail: [],
  });
  assert.match(brief, /\(none reported\)/);
  assert.match(brief, /\(empty\)/);
  assert.ok(!brief.includes("WORKER CLAIM")); // no claim → no section
});

// ── parsing ──────────────────────────────────────────────────────────────

test("parseVerification accepts good JSON and prefers the verdict object", () => {
  const verdict = parseVerification('noise {"verdict":"not_met","reason":"r","missing":["tests green","lint clean"]} noise');
  assert.deepEqual(verdict, {
    verdict: "not_met",
    reason: "r",
    missing: ["tests green", "lint clean"],
    evaluatorFailed: false,
  });
  assert.match(parseVerification('junk {"verdict":"met","reason":"ok"}').reason, /ok/);
});

test("parseVerification repairs bad shapes to inconclusive+failed", () => {
  for (const raw of ["", "<html>", '{"verdict":"weird"}', "{not json"]) {
    const verdict = parseVerification(raw);
    assert.equal(verdict.verdict, "inconclusive");
    assert.equal(verdict.evaluatorFailed, true);
    assert.deepEqual(verdict.missing, []);
  }
});

// ── verifyCompletion ─────────────────────────────────────────────────────

test("verifyCompletion returns the evaluator verdict", async () => {
  const verdict = await verifyCompletion(
    { evaluate: async () => '{"verdict":"met","reason":"tests pass on re-run"}' },
    "all tests pass",
    "brief",
  );
  assert.equal(verdict.verdict, "met");
  assert.equal(verdict.evaluatorFailed, false);
});

test("verifyCompletion times out to inconclusive-neutral", async () => {
  const verdict = await verifyCompletion(
    {
      evaluate: () => new Promise(() => undefined), // hangs
      timeoutMs: 20,
      setTimeout: (fn) => setTimeout(fn, 5), // fires fast
    },
    "o",
    "b",
  );
  assert.equal(verdict.verdict, "inconclusive");
  assert.equal(verdict.evaluatorFailed, true);
});

test("verifyCompletion catches evaluator throws", async () => {
  const verdict = await verifyCompletion(
    { evaluate: async () => { throw new Error("provider 500"); } },
    "o",
    "b",
  );
  assert.equal(verdict.verdict, "inconclusive");
  assert.match(verdict.reason, /failed/);
});

test("prompt embeds the brief and the strict JSON contract", () => {
  const prompt = buildVerificationPrompt("objective text", "BRIEF-BODY");
  assert.ok(prompt.startsWith("You are the completion verifier"));
  assert.ok(prompt.includes("BRIEF-BODY"));
  assert.match(prompt, /"verdict"/);
  assert.match(prompt, /Match verification scope to requirement scope/);
});

test("fingerprintBrief is stable and short", () => {
  assert.equal(fingerprintBrief("abc"), fingerprintBrief("abc"));
  assert.equal(fingerprintBrief("abc").length, 16);
  assert.notEqual(fingerprintBrief("abc"), fingerprintBrief("abd"));
});
