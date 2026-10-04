/**
 * viz kit — every piece must return exactly the width asked for, in both
 * colour modes, at awkward sizes. A line one cell too wide crashes pi-tui.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  Paint, CRAB, bigText, bigTextWidth, brailleArea, centerTo, chip, chipWidth, columns, compact, duration, fitTo,
  gauge, grid, money, resample, rgbTo256, rightTo, shareBar, sideBySide, spark, splitWidth, spreadTo,
} from "../viz.js";

const S = [CRAB.gold, CRAB.orange, CRAB.red];
const VALUES = [0, 3, 2, 5, 8, 0, 9, 12, 7, 3, 2, 6, 10, 14, 9, 4];

for (const trueColor of [true, false]) {
  const p = new Paint(undefined, trueColor);
  describe(`viz widths (${trueColor ? "truecolor" : "256"})`, () => {
    for (const w of [1, 2, 7, 13, 40, 97]) {
      it(`charts are exactly ${w} cells`, () => {
        assert.equal(visibleWidth(spark(p, VALUES, w, S)), w);
        assert.equal(visibleWidth(gauge(p, 0.37, w, S)), w);
        assert.equal(visibleWidth(gauge(p, 1, w, S)), w);
        assert.equal(visibleWidth(gauge(p, 0, w, S)), w);
        assert.equal(visibleWidth(shareBar(p, [{ value: 9, color: CRAB.red }, { value: 1, color: CRAB.gold }, { value: 0.01, color: CRAB.cream }], w)), w);
        for (const l of columns(p, VALUES, w, 3, S)) assert.equal(visibleWidth(l), w);
        for (const l of brailleArea(p, VALUES, w, 2, S)) assert.equal(visibleWidth(l), w);
      });
    }
    it("empty data still fills the width", () => {
      assert.equal(visibleWidth(spark(p, [], 10, S)), 10);
      for (const l of columns(p, [], 10, 2, S)) assert.equal(visibleWidth(l), 10);
      assert.equal(visibleWidth(shareBar(p, [], 10)), 10);
    });
    it("chip width is label + 2", () => {
      assert.equal(visibleWidth(chip(p, "LIVE", CRAB.orange)), chipWidth("LIVE"));
    });
  });
}

describe("viz layout", () => {
  it("fit/center/right/spread are exact", () => {
    for (const w of [1, 5, 20]) {
      assert.equal(visibleWidth(fitTo("hello world", w)), w);
      assert.equal(visibleWidth(centerTo("hi", w)), Math.max(w, 0));
      assert.equal(visibleWidth(rightTo("hi", w)), w);
      assert.equal(visibleWidth(spreadTo("left", "right", w, "·")), w);
    }
  });
  it("sideBySide pads every row", () => {
    const rows = sideBySide([{ lines: ["a", "b", "c"], width: 4 }, { lines: ["x"], width: 6 }], 2);
    assert.equal(rows.length, 3);
    for (const r of rows) assert.equal(visibleWidth(r), 12);
  });
  it("splitWidth sums to total minus gaps", () => {
    for (const [t, n] of [[80, 3], [41, 2], [10, 4]] as const) {
      assert.equal(splitWidth(t, n, 2).reduce((a, b) => a + b, 0), t - 2 * (n - 1));
    }
  });
  it("grid lines are exact and reports hidden items", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ text: `tool_${i}`, plain: `tool_${i}`.length }));
    const g = grid(items, 50, 12, 2);
    for (const l of g.lines) assert.equal(visibleWidth(l), 50);
    assert.equal(g.lines.length, 2);
    assert.ok(g.hidden > 0);
  });
});

describe("viz big text + numbers", () => {
  it("big text rows share one width", () => {
    for (const s of ["0", "$12.48", "1.2M", "99%", "3m 05s"]) {
      const rows = bigText(s);
      assert.equal(new Set(rows.map((r) => visibleWidth(r))).size, 1, s);
      assert.equal(bigTextWidth(s), visibleWidth(rows[0]));
    }
  });
  it("resample keeps length", () => {
    assert.equal(resample([1, 2, 3], 10).length, 10);
    assert.equal(resample(VALUES, 5).length, 5);
    assert.deepEqual(resample([1, 9, 2, 3], 2), [9, 3]);
  });
  it("formats", () => {
    assert.equal(compact(999), "999");
    assert.equal(compact(1234), "1.2k");
    assert.equal(compact(1_500_000), "1.5M");
    assert.equal(money(0), "$0");
    assert.equal(money(3.4), "$3.40");
    assert.equal(money(0.0042), "$0.004");
    assert.equal(duration(95_000), "1m 35s");
    assert.equal(duration(3_700_000), "1h 01m");
    assert.ok(rgbTo256([240, 24, 24]) >= 16);
  });
});
