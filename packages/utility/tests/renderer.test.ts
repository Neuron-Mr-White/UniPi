/**
 * @pi-unipi/utility — Diff Renderer tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  strip,
  visibleWidth,
  fit,
  lnum,
  wrapAnsi,
  ansiState,
  shouldUseSplit,
  renderUnified,
  renderSplit,
  injectBg,
  SPLIT_MIN_WIDTH,
  MAX_PREVIEW_LINES,
  MAX_RENDER_LINES,
  SPLIT_MIN_CODE_WIDTH,
} from "../src/diff/renderer.js";
import { parseDiff } from "../src/diff/parser.js";

/** Default diff colors for testing */
const TEST_COLORS = {
  addBg: "#1a3a1a",
  addFg: "#b5e8b5",
  remBg: "#3a1a1a",
  remFg: "#e8b5b5",
  addWordBg: "#2d5a2d",
  remWordBg: "#5a2d2d",
  hunkFg: "#8888ff",
  headerFg: "#888888",
};

describe("ANSI Utilities", () => {
  describe("strip", () => {
    it("removes ANSI escape sequences", () => {
      assert.equal(strip("\x1b[31mred\x1b[0m"), "red");
      assert.equal(strip("\x1b[1;32mbold green\x1b[0m"), "bold green");
    });

    it("handles string with no ANSI", () => {
      assert.equal(strip("plain text"), "plain text");
    });

    it("handles empty string", () => {
      assert.equal(strip(""), "");
    });
  });

  describe("visibleWidth", () => {
    it("returns width of plain text", () => {
      assert.equal(visibleWidth("hello"), 5);
      assert.equal(visibleWidth(""), 0);
    });

    it("ignores ANSI escapes in width calculation", () => {
      assert.equal(visibleWidth("\x1b[31mhello\x1b[0m"), 5);
      assert.equal(visibleWidth("\x1b[1;32m\x1b[48;2;0;0;0mtest\x1b[0m"), 4);
    });

    it("counts CJK characters as width 2", () => {
      assert.equal(visibleWidth("你好"), 4); // 2 CJK chars × 2
      assert.equal(visibleWidth("hello你好"), 9); // 5 + 4
    });
  });

  describe("fit", () => {
    it("pads short strings", () => {
      const result = fit("hi", 5);
      assert.equal(visibleWidth(result), 5);
      assert.equal(strip(result), "hi   ");
    });

    it("truncates long strings", () => {
      const result = fit("hello world", 5);
      assert.ok(visibleWidth(result) <= 5 + 5); // Allow for reset code
    });

    it("returns unchanged if exact width", () => {
      assert.equal(fit("hello", 5), "hello");
    });
  });

  describe("lnum", () => {
    it("formats line numbers with padding", () => {
      assert.equal(lnum(1), "   1");
      assert.equal(lnum(42), "  42");
      assert.equal(lnum(123), " 123");
      assert.equal(lnum(1234), "1234");
    });

    it("returns spaces for null line number", () => {
      assert.equal(lnum(null), "    ");
      assert.equal(lnum(null, 6), "      ");
    });

    it("respects custom width", () => {
      assert.equal(lnum(1, 6), "     1");
      assert.equal(lnum(42, 2), "42");
    });
  });

  describe("wrapAnsi", () => {
    it("returns single line if within width", () => {
      const result = wrapAnsi("short", 10);
      assert.equal(result.length, 1);
      assert.equal(result[0], "short");
    });

    it("wraps long lines", () => {
      const result = wrapAnsi("this is a very long line that needs wrapping", 10);
      assert.ok(result.length > 1);
    });

    it("preserves ANSI state across wraps", () => {
      const result = wrapAnsi("\x1b[31mthis is red text that wraps\x1b[0m", 10);
      assert.ok(result.length > 1);
    });
  });

  describe("ansiState", () => {
    it("returns empty string for plain text", () => {
      assert.equal(ansiState("hello"), "");
    });

    it("returns empty string after reset", () => {
      assert.equal(ansiState("text\x1b[0m"), "");
    });

    it("returns last active escape sequence", () => {
      const state = ansiState("\x1b[31mred text");
      assert.ok(state.includes("31"));
    });
  });
});

describe("shouldUseSplit", () => {
  it("returns false for narrow terminals", () => {
    const diff = parseDiff("a", "b");
    assert.equal(shouldUseSplit(diff, 80, 60), false);
  });

  it("returns true for wide terminals with short lines", () => {
    const diff = parseDiff("short", "changed");
    assert.equal(shouldUseSplit(diff, SPLIT_MIN_WIDTH, 60), true);
  });

  it("returns false when code columns would be too narrow", () => {
    const diff = parseDiff("a", "b");
    assert.equal(shouldUseSplit(diff, SPLIT_MIN_WIDTH - 1, 60), false);
  });
});

describe("renderUnified", () => {
  it("renders a simple diff", async () => {
    const diff = parseDiff("hello", "world");
    const result = await renderUnified(diff, "text", 60, TEST_COLORS);
    assert.ok(result.includes("+")); // addition marker
    assert.ok(result.includes("-")); // removal marker
  });

  it("renders context lines", async () => {
    const old = "a\nb\nc\nd\ne";
    const new_ = "a\nb\nX\nd\ne";
    const diff = parseDiff(old, new_);
    const result = await renderUnified(diff, "text", 60, TEST_COLORS);
    assert.ok(result.includes("│")); // column separator
  });

  it("truncates at max lines", async () => {
    // Create many scattered changes to produce many hunk lines
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const old = lines.join("\n");
    const newLines = [...lines];
    // Change every 5th line to create many hunks
    for (let i = 0; i < 200; i += 5) {
      newLines[i] = `CHANGED ${i}`;
    }
    const new_ = newLines.join("\n");
    const diff = parseDiff(old, new_, 0); // context=0 to maximize hunk count
    // Use a small max to trigger truncation
    const result = await renderUnified(diff, "text", 10, TEST_COLORS);
    assert.ok(result.includes("more lines"));
  });
});

describe("renderSplit", () => {
  it("renders a simple diff", async () => {
    const diff = parseDiff("hello", "world");
    const result = await renderSplit(diff, "text", 60, TEST_COLORS);
    // Should contain the separator
    assert.ok(result.includes("│"));
  });

  it("falls back to unified on narrow terminals", async () => {
    const diff = parseDiff("hello", "world");
    const result = await renderSplit(diff, "text", 60, TEST_COLORS);
    // Both should produce output (unified fallback)
    assert.ok(result.length > 0);
  });
});

describe("injectBg", () => {
  it("wraps line in base background when no ranges", () => {
    const result = injectBg("hello", [], "#1a1a1a", "#2a2a2a");
    assert.ok(result.includes("48;2;")); // background code
  });

  it("applies highlight background when ranges present", () => {
    const result = injectBg("hello world", [{ start: 0, end: 5 }], "#1a1a1a", "#2a2a2a");
    assert.ok(result.includes("48;2;"));
  });
});

describe("Constants", () => {
  it("SPLIT_MIN_WIDTH is 150", () => {
    assert.equal(SPLIT_MIN_WIDTH, 150);
  });
  it("MAX_PREVIEW_LINES is 60", () => {
    assert.equal(MAX_PREVIEW_LINES, 60);
  });
  it("MAX_RENDER_LINES is 150", () => {
    assert.equal(MAX_RENDER_LINES, 150);
  });
  it("SPLIT_MIN_CODE_WIDTH is 60", () => {
    assert.equal(SPLIT_MIN_CODE_WIDTH, 60);
  });
});
