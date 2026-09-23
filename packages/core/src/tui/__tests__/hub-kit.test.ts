/**
 * Hub kit unit tests — key classifier, search semantics, viewport scrolling,
 * and the exact-width guarantee every hub-look overlay inherits.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hubClampScroll,
  hubExactRow,
  hubFrameTitle,
  hubHeaderBand,
  hubKey,
  hubMaxRows,
  hubMoreAbove,
  hubMoreBelow,
  hubRowColumns,
  HubSearch,
} from "../hub-kit.js";

/** Strip ANSI and measure visible width. */
const vw = (line: string): number =>
  line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").length;

describe("hubKey classifier", () => {
  it("classifies arrows in CSI/SS3 encodings and j/k mnemonics", () => {
    assert.equal(hubKey("\x1b[A"), "up");
    assert.equal(hubKey("\x1bOA"), "up");
    assert.equal(hubKey("k"), "up");
    assert.equal(hubKey("\x1b[B"), "down");
    assert.equal(hubKey("\x1bOB"), "down");
    assert.equal(hubKey("j"), "down");
  });

  it("classifies activation, quick, back, search, paging", () => {
    assert.equal(hubKey("\r"), "activate");
    assert.equal(hubKey("\n"), "activate");
    assert.equal(hubKey("\t"), "activate");
    assert.equal(hubKey(" "), "quick");
    assert.equal(hubKey("\x1b"), "back");
    assert.equal(hubKey("/"), "search");
    assert.equal(hubKey("\x1b[5~"), "pageUp");
    assert.equal(hubKey("\x1b[6~"), "pageDown");
    assert.equal(hubKey("\x1b[H"), "home");
    assert.equal(hubKey("\x1b[F"), "end");
  });

  it("passes printable chars through, control junk as other", () => {
    assert.deepEqual(hubKey("u"), { char: "u" });
    assert.deepEqual(hubKey("R"), { char: "R" });
    assert.deepEqual(hubKey("x"), { char: "x" });
    // DEL bytes flow through as chars (same as the hub's legacy detection —
    // list mode simply has no binding for them).
    assert.deepEqual(hubKey("\x7f"), { char: "\x7f" });
    assert.equal(hubKey("\x1b[200~"), "other");
  });
});

describe("HubSearch", () => {
  it("live-filters while typing, applies on enter", () => {
    const search = new HubSearch("/");
    assert.equal(search.handle("j"), "typing");
    assert.equal(search.handle("u"), "typing");
    assert.equal(search.filter, "ju");
    assert.equal(search.handle("\r"), "applied");
    assert.equal(search.filter, "ju");
  });

  it("backspace deletes while non-empty, exits on empty", () => {
    const search = new HubSearch("/");
    search.handle("j");
    search.handle("u");
    assert.equal(search.handle("\x7f"), "typing");
    assert.equal(search.getValue(), "j");
    assert.equal(search.handle("\x7f"), "typing", "input now empty but still open");
    assert.equal(search.handle("\x7f"), "exited", "backspace on empty exits");
    assert.equal(search.filter, "");
  });

  it("esc exits at any point; \\b is backspace too", () => {
    const search = new HubSearch("/");
    search.handle("ju");
    assert.equal(search.handle("\x1b"), "exited");
    const search2 = new HubSearch("/");
    search2.handle("j");
    assert.equal(search2.handle("\b"), "typing");
    assert.equal(search2.getValue(), "");
    assert.equal(search2.handle("\b"), "exited");
  });
});

describe("viewport", () => {
  const kinds = ["header", "field", "field", "field", "field", "field", "field", "field"];

  it("maxRows is relative height with floor and chrome reserve", () => {
    assert.equal(hubMaxRows(50), 25, "half the terminal (50/2) beats the chrome reserve");
    assert.equal(hubMaxRows(12), 5, "chrome reserve wins on tiny terminals");
    assert.equal(hubMaxRows(8), 3, "floor of 3 rows");
    assert.equal(hubMaxRows(50, 7), 18, "editor/picker reserve shrinks the window");
  });

  it("scrolling up to the first selectable includes the header run (scroll 0)", () => {
    // scrolled deep, cursor back at the first field (1)
    assert.equal(hubClampScroll(kinds, 1, 4, 5), 0, "header run above cursor kept visible");
    // mid-list scroll up keeps the header band directly above the cursor
    const withHeaders = ["field", "field", "header", "field", "field", "field", "field", "field"];
    assert.equal(hubClampScroll(withHeaders, 3, 5, 5), 2, "lands on the run's first header");
  });

  it("bottom clamp still pins the last page", () => {
    assert.equal(hubClampScroll(kinds, 7, 0, 5), 3);
    assert.equal(hubClampScroll(kinds, 7, 3, 5), 3, "no overshoot past the end");
  });

  it("indicators carry the hidden counts at exact width", () => {
    assert.equal(vw(hubMoreAbove(2, 40)), 40);
    assert.ok(hubMoreAbove(2, 40).includes("↑ 2 more"));
    assert.equal(vw(hubMoreBelow(9, 40)), 40);
    assert.ok(hubMoreBelow(9, 40).includes("↓ 9 more"));
  });
});

describe("exact-width primitives", () => {
  it("exactRow pads and truncates to the exact cell count", () => {
    assert.equal(vw(hubExactRow("abc", 10)), 10);
    assert.equal(vw(hubExactRow("\x1b[1mabc\x1b[0m", 10)), 10);
    assert.equal(vw(hubExactRow("a".repeat(50), 10)), 10);
  });

  it("rowColumns keeps inner width with and without the group mark", () => {
    for (const width of [40, 80, 120]) {
      // Callers exactRow() the composed line (hub renderRow does exactly that).
      const plain = hubExactRow(hubRowColumns({ inner: width, selected: false, label: "Label", value: "value" }), width);
      assert.equal(vw(plain), width);
      const marked = hubExactRow(hubRowColumns({ inner: width, selected: true, label: "Label", value: "value", markNamespace: "info" }), width);
      assert.equal(vw(marked), width);
      assert.ok(marked.includes("▌"), "colored namespace shows the mark");
    }
  });

  it("header band paints the full inner width with the mark at column 0", () => {
    for (const width of [40, 80, 120]) {
      const band = hubHeaderBand({ inner: width, text: "Hub Test — All types [GP]", namespace: "info-screen" });
      assert.equal(vw(band), width);
      assert.ok(vw(band.replace(/^.*?▌/, "▌")) === width);
      assert.ok(band.startsWith("│") === false && band.includes("▌"));
    }
    const unmarked = hubHeaderBand({ inner: 40, text: "no color" });
    assert.ok(!unmarked.includes("▌"), "unknown namespace renders no mark");
  });

  it("frame title joins base, crumbs and tail", () => {
    assert.equal(hubFrameTitle("unipi settings", [], "— global [g]"), " unipi settings — global [g] ");
    assert.equal(
      hubFrameTitle("unipi settings", ["serpapi", "Keys"], "— project [g]"),
      " unipi settings › serpapi › Keys — project [g] ",
    );
  });
});
