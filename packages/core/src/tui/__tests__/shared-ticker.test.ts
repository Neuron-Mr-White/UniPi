import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { subscribeTick, sharedTickerSubscriberCount, resetSharedTickerForTests } from "../shared-ticker.js";

beforeEach(() => {
  resetSharedTickerForTests();
});

afterEach(() => {
  resetSharedTickerForTests();
});

describe("subscribeTick", () => {
  test("one timer serves every subscriber (UNI-133: was one setInterval per card/widget)", async () => {
    let a = 0;
    let b = 0;
    const unsubA = subscribeTick(() => {
      a += 1;
    }, 5);
    const unsubB = subscribeTick(() => {
      b += 1;
    }, 5);
    assert.equal(sharedTickerSubscriberCount(), 2);
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(a > 0, "subscriber A ticked");
    assert.ok(b > 0, "subscriber B ticked");
    unsubA();
    unsubB();
  });

  test("the timer stops once the last subscriber unsubscribes", async () => {
    const unsub = subscribeTick(() => {}, 5);
    assert.equal(sharedTickerSubscriberCount(), 1);
    unsub();
    assert.equal(sharedTickerSubscriberCount(), 0);
  });

  test("a throwing subscriber never stops the others' animation", async () => {
    let ticks = 0;
    const unsubBroken = subscribeTick(() => {
      throw new Error("boom");
    }, 5);
    const unsubOk = subscribeTick(() => {
      ticks += 1;
    }, 5);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(ticks > 0);
    unsubBroken();
    unsubOk();
  });
});
