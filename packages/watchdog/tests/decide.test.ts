/**
 * Watchdog decision logic (pure) — agreeChecks gating, persistent veto
 * (looping overrides, stuck doesn't), confidence threshold, jev-null handling.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateTick } from "../src/decide.js";

const stuck = { answers: { status: { choice: "stuck", confidence: 0.9 }, persistent: { noul: 0.1 } } };
const looping = { answers: { status: { choice: "looping", confidence: 0.85 }, persistent: { noul: 0.0 } } };
const waiting = { answers: { status: { choice: "waiting", confidence: 0.9 }, persistent: { noul: 0.2 } } };

describe("evaluateTick", () => {
  it("null answers keep the streak unchanged and never act", () => {
    const d = evaluateTick(null, 1, { confidence: 0.8, agreeChecks: 2 });
    assert.equal(d.act, false);
    assert.equal(d.streak, 1, "streak unchanged on jev null");
    assert.equal(d.status, "unknown");
  });

  it("stuck + confidence + non-persistent increments the streak", () => {
    const d = evaluateTick(stuck.answers, 0, { confidence: 0.8, agreeChecks: 2 });
    assert.equal(d.streak, 1);
    assert.equal(d.status, "stuck");
    assert.equal(d.act, false, "streak 1 < agreeChecks 2 → not yet");
  });

  it("agreeChecks: acts only when the streak reaches the threshold", () => {
    const first = evaluateTick(stuck.answers, 0, { confidence: 0.8, agreeChecks: 2 });
    assert.equal(first.streak, 1);
    assert.equal(first.act, false, "streak 1 < agreeChecks 2");
    const second = evaluateTick(stuck.answers, first.streak, { confidence: 0.8, agreeChecks: 2 });
    assert.equal(second.act, true, "streak 2 ≥ agreeChecks 2");
    assert.equal(second.streak, 2);
  });

  it("agreeChecks 1 acts on the first agreeing check", () => {
    const d = evaluateTick(stuck.answers, 0, { confidence: 0.8, agreeChecks: 1 });
    assert.equal(d.act, true);
    assert.equal(d.streak, 1);
  });

  it("low confidence resets the streak", () => {
    const low = { answers: { status: { choice: "stuck", confidence: 0.5 }, persistent: { noul: 0.1 } } };
    const d = evaluateTick(low.answers, 1, { confidence: 0.8, agreeChecks: 2 });
    assert.equal(d.act, false);
    assert.equal(d.streak, 0, "disagreeing check resets the streak");
  });

  it("persistent veto: stuck persistent process never acts", () => {
    const persistentStuck = { answers: { status: { choice: "stuck", confidence: 0.99 }, persistent: { noul: 0.9 } } };
    const d = evaluateTick(persistentStuck.answers, 3, { confidence: 0.8, agreeChecks: 1 });
    assert.equal(d.act, false, "persistent veto on stuck");
    assert.equal(d.persistent, true);
    assert.equal(d.streak, 0);
  });

  it("looping + persistent: kill after the streak (error loop is NOT healthy)", () => {
    const persistentLooping = { answers: { status: { choice: "looping", confidence: 0.95 }, persistent: { noul: 0.9 } } };
    const d1 = evaluateTick(persistentLooping.answers, 0, { confidence: 0.8, agreeChecks: 2 });
    assert.equal(d1.act, false, "streak 1 < agreeChecks 2");
    assert.equal(d1.streak, 1);
    const d2 = evaluateTick(persistentLooping.answers, 1, { confidence: 0.8, agreeChecks: 2 });
    assert.equal(d2.act, true, "looping overrides the persistent veto");
    assert.equal(d2.streak, 2);
  });

  it("waiting status never acts and resets the streak", () => {
    const d = evaluateTick(waiting.answers, 2, { confidence: 0.8, agreeChecks: 2 });
    assert.equal(d.act, false);
    assert.equal(d.streak, 0);
  });

  it("looping counts as an agreeing status", () => {
    const d = evaluateTick(looping.answers, 1, { confidence: 0.8, agreeChecks: 2 });
    assert.equal(d.act, true);
    assert.equal(d.streak, 2);
    assert.equal(d.signal, "repeating output without progress");
  });

  it("unknown status shape → no act, streak reset", () => {
    const broken = { answers: { status: { choice: "something-else", confidence: 1 }, persistent: { noul: 0 } } };
    const d = evaluateTick(broken.answers, 1, { confidence: 0.8, agreeChecks: 2 });
    assert.equal(d.act, false);
    assert.equal(d.status, "unknown");
    assert.equal(d.streak, 0);
  });

  it("jev null with agreeChecks 1: streak unchanged (previous ≥ 1 → still enoughChecks)", () => {
    const d = evaluateTick(null, 2, { confidence: 0.8, agreeChecks: 1 });
    assert.equal(d.streak, 2, "jev null keeps the streak");
    assert.equal(d.act, false, "but does not act");
  });
});
