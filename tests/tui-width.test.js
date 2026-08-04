/**
 * Tests for the shared TUI width helpers in @pi-unipi/core.
 *
 * These encode the invariant that prevents the narrow-terminal crash:
 * a bordered line must never be wider than the terminal it is drawn in.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MIN_BORDERED_WIDTH,
  adaptiveInnerWidth,
  boxInnerWidth,
  contentWidth,
  normalizeWidth,
  safeRepeat,
  safeRepeatCount,
  shouldRenderBorder,
  WidthKeyedCache,
} from "../packages/core/tui-width.ts";

describe("normalizeWidth", () => {
  it("clamps to at least 1", () => {
    for (const w of [1, 0, -1, -1000]) {
      assert.ok(normalizeWidth(w) >= 1, `width ${w} should normalize to >= 1`);
    }
  });

  it("floors fractional widths", () => {
    assert.equal(normalizeWidth(10.9), 10);
  });

  it("handles NaN and Infinity", () => {
    assert.equal(normalizeWidth(Number.NaN), 1);
    assert.equal(normalizeWidth(Number.POSITIVE_INFINITY), 1);
    assert.equal(normalizeWidth(Number.NEGATIVE_INFINITY), 1);
  });

  it("passes through normal widths", () => {
    assert.equal(normalizeWidth(80), 80);
  });
});

describe("boxInnerWidth", () => {
  it("always leaves room for both border columns", () => {
    for (let width = 3; width <= 300; width++) {
      assert.equal(
        boxInnerWidth(width) + 2,
        width,
        `bordered line must be exactly ${width} columns`,
      );
    }
  });

  it("never returns less than 1", () => {
    for (const w of [1, 2, 0, -5, Number.NaN]) {
      assert.ok(boxInnerWidth(w) >= 1, `boxInnerWidth(${w}) should be >= 1`);
    }
  });
});

describe("shouldRenderBorder / adaptiveInnerWidth", () => {
  it("drops the border below the threshold", () => {
    assert.equal(shouldRenderBorder(MIN_BORDERED_WIDTH - 1), false);
    assert.equal(shouldRenderBorder(MIN_BORDERED_WIDTH), true);
  });

  it("keeps total line width within the terminal at every width", () => {
    for (let width = 1; width <= 300; width++) {
      const inner = adaptiveInnerWidth(width);
      const total = shouldRenderBorder(width) ? inner + 2 : inner;
      assert.ok(
        total <= width,
        `total ${total} exceeds terminal width ${width} — pi-tui would throw`,
      );
      assert.ok(inner >= 1, `inner width must stay usable at width ${width}`);
    }
  });
});

describe("contentWidth", () => {
  it("subtracts the reserved columns", () => {
    assert.equal(contentWidth(80, 5), 75);
  });

  it("never returns less than 1, even when over-reserved", () => {
    for (const [avail, reserved] of [[10, 20], [1, 5], [5, 5], [0, 0]]) {
      assert.ok(
        contentWidth(avail, reserved) >= 1,
        `contentWidth(${avail}, ${reserved}) must be >= 1`,
      );
    }
  });

  it("ignores negative reservations", () => {
    assert.equal(contentWidth(40, -10), 40);
  });
});

describe("safeRepeat", () => {
  it("never throws on negative or non-finite counts", () => {
    for (const n of [-1, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(safeRepeat(" ", n), "");
      assert.equal(safeRepeatCount(n), 0);
    }
  });

  it("repeats normally for valid counts", () => {
    assert.equal(safeRepeat("-", 4), "----");
    assert.equal(safeRepeat(" ", 3.7), "   ");
  });
});

describe("WidthKeyedCache", () => {
  it("misses on a different width", () => {
    const cache = new WidthKeyedCache();
    cache.set(80, ["wide"]);
    assert.equal(cache.get(80)?.[0], "wide");
    assert.equal(cache.get(30), null, "must miss after a resize");
  });

  it("clears on demand", () => {
    const cache = new WidthKeyedCache();
    cache.set(80, ["a"]);
    cache.clear();
    assert.equal(cache.get(80), null);
  });

  it("normalizes the key so fractional widths hit", () => {
    const cache = new WidthKeyedCache();
    cache.set(80, ["a"]);
    assert.deepEqual(cache.get(80.4), ["a"]);
  });

  it("caches empty line arrays correctly", () => {
    const cache = new WidthKeyedCache();
    cache.set(40, []);
    assert.deepEqual(cache.get(40), [], "an empty render is still a cache hit");
  });
});
