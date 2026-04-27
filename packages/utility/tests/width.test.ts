/**
 * @pi-unipi/utility — Width utilities tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  stripAnsi,
  visualWidth,
  clampWidth,
  wrapLines,
  collapseLines,
  padWidth,
  centerWidth,
} from "../src/display/width.ts";

describe("stripAnsi", () => {
  it("removes color codes", () => {
    assert.equal(stripAnsi("\u001b[31mred\u001b[0m"), "red");
  });

  it("leaves plain text alone", () => {
    assert.equal(stripAnsi("hello world"), "hello world");
  });
});

describe("visualWidth", () => {
  it("counts visual characters excluding ANSI", () => {
    assert.equal(visualWidth("\u001b[1mbold\u001b[0m"), 4);
  });
});

describe("clampWidth", () => {
  it("returns short text unchanged", () => {
    assert.equal(clampWidth("hi", 10), "hi");
  });

  it("truncates long text with ellipsis", () => {
    const result = clampWidth("hello world", 8);
    assert.ok(result.includes("…"));
    assert.equal(stripAnsi(result).length, 8);
  });

  it("preserves ANSI in truncated text", () => {
    const result = clampWidth("\u001b[31mhello world\u001b[0m", 8);
    assert.ok(result.includes("\u001b[31m"));
    assert.ok(result.includes("\u001b[0m"));
  });
});

describe("wrapLines", () => {
  it("wraps text into multiple lines", () => {
    const lines = wrapLines("hello world foo bar", 10);
    assert.ok(lines.length > 1);
  });

  it("respects existing newlines", () => {
    const lines = wrapLines("line1\nline2", 20);
    assert.ok(lines.includes("line1"));
    assert.ok(lines.includes("line2"));
  });
});

describe("collapseLines", () => {
  it("collapses consecutive empty lines", () => {
    const lines = ["a", "", "", "", "b"];
    const result = collapseLines(lines, 1);
    assert.deepEqual(result, ["a", "", "b"]);
  });
});

describe("padWidth", () => {
  it("pads text to target width", () => {
    assert.equal(padWidth("hi", 5), "hi   ");
  });

  it("returns text unchanged if already wide enough", () => {
    assert.equal(padWidth("hello", 3), "hello");
  });
});

describe("centerWidth", () => {
  it("centers text within width", () => {
    const result = centerWidth("hi", 6);
    assert.equal(result.length, 6);
    assert.equal(result.trim(), "hi");
  });
});
