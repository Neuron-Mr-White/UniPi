import { test } from "node:test";
import assert from "node:assert/strict";
import { clearedLines, clearedText } from "../src/cleared-input.ts";

const plain = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const editor = (text: string) => ({ getText: () => text, addToHistory() {} });

test("only Ctrl+C on a non-empty editor is recorded", () => {
  assert.equal(clearedText("\x03", editor("fix the test")), "fix the test");
  assert.equal(clearedText("\x03", editor("   ")), undefined, "blank editor: nothing to keep");
  assert.equal(clearedText("a", editor("fix")), undefined, "other keys ignored");
  assert.equal(clearedText("\x03", { render: () => [] }), undefined, "a dialog has focus, not the editor");
});

test("cleared text renders struck through with the restore hint", () => {
  const [line] = clearedLines(plain, "fix the test", 80);
  assert.equal(line, "⌫ \x1b[9mfix the test\x1b[29m  ↑ restores");
  const many = clearedLines(plain, "a\nb\nc\nd\ne", 80);
  assert.equal(many.length, 4);
  assert.equal(many[3], "  … 2 more lines");
});
