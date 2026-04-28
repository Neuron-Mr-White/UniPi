/**
 * @pi-unipi/utility — Diff Parser tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDiff, wordDiffAnalysis } from "../src/diff/parser.js";

describe("parseDiff", () => {
  it("returns empty diff for identical content", () => {
    const result = parseDiff("hello\nworld", "hello\nworld");
    assert.equal(result.lines.length, 0);
    assert.equal(result.additions, 0);
    assert.equal(result.deletions, 0);
  });

  it("parses a simple single-line change", () => {
    const result = parseDiff("hello", "world");
    assert.ok(result.lines.length > 0);
    assert.equal(result.additions, 1);
    assert.equal(result.deletions, 1);
    // Should have hunk + remove + add
    const hunkLines = result.lines.filter((l) => l.type === "hunk");
    assert.equal(hunkLines.length, 1);
  });

  it("parses multi-line changes", () => {
    const old = "line 1\nline 2\nline 3\nline 4\nline 5";
    const new_ = "line 1\nmodified 2\nline 3\nline 4\nnew line 5\nline 6";
    const result = parseDiff(old, new_);
    assert.ok(result.additions > 0);
    assert.ok(result.deletions > 0);
  });

  it("handles new file (empty old content)", () => {
    const result = parseDiff("", "new file\nwith lines");
    assert.equal(result.additions, 2);
    assert.equal(result.deletions, 0);
    assert.ok(result.lines.every((l) => l.type === "add"));
    assert.equal(result.lines[0].newLine, 1);
    assert.equal(result.lines[1].newLine, 2);
  });

  it("handles deleted file (empty new content)", () => {
    const result = parseDiff("old file\nwith lines", "");
    assert.equal(result.additions, 0);
    assert.equal(result.deletions, 2);
    assert.ok(result.lines.every((l) => l.type === "remove"));
    assert.equal(result.lines[0].oldLine, 1);
  });

  it("handles both empty strings", () => {
    const result = parseDiff("", "");
    assert.equal(result.lines.length, 0);
    assert.equal(result.additions, 0);
    assert.equal(result.deletions, 0);
  });

  it("preserves line numbers correctly", () => {
    const old = "a\nb\nc\nd\ne";
    const new_ = "a\nb\nX\nd\ne";
    const result = parseDiff(old, new_);
    // Context lines should have both old and new line numbers
    const contextLines = result.lines.filter((l) => l.type === "context");
    for (const line of contextLines) {
      assert.ok(line.oldLine !== null);
      assert.ok(line.newLine !== null);
    }
    // Removed line should have old line number only
    const removeLines = result.lines.filter((l) => l.type === "remove");
    for (const line of removeLines) {
      assert.ok(line.oldLine !== null);
      assert.equal(line.newLine, null);
    }
  });

  it("respects context parameter", () => {
    const old = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj";
    const new_ = "a\nb\nc\nd\nX\nf\ng\nh\ni\nj";
    const result = parseDiff(old, new_, 1);
    // With context=1, fewer context lines should appear
    const contextCount = result.lines.filter((l) => l.type === "context").length;
    assert.ok(contextCount <= 2); // At most 1 before + 1 after
  });

  it("uses custom file names in hunk header", () => {
    const result = parseDiff("old", "new", 3, "file-a.ts", "file-b.ts");
    assert.equal(result.oldName, "file-a.ts");
    assert.equal(result.newName, "file-b.ts");
    if (result.lines.length > 0 && result.lines[0].type === "hunk") {
      assert.ok(result.lines[0].content.includes("@@"));
    }
  });

  it("handles very large content gracefully", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`);
    const old = lines.join("\n");
    const newLines = [...lines];
    newLines[500] = "modified line 500";
    const new_ = newLines.join("\n");
    const result = parseDiff(old, new_);
    assert.equal(result.additions, 1);
    assert.equal(result.deletions, 1);
  });
});

describe("wordDiffAnalysis", () => {
  it("returns similarity 1 for identical strings", () => {
    const result = wordDiffAnalysis("hello world", "hello world");
    assert.equal(result.similarity, 1);
    assert.equal(result.addedRanges.length, 0);
    assert.equal(result.removedRanges.length, 0);
  });

  it("returns similarity 0 for completely different strings", () => {
    const result = wordDiffAnalysis("aaa", "bbb");
    assert.ok(result.similarity < 0.5);
    assert.equal(result.removedRanges.length, 1);
    assert.equal(result.addedRanges.length, 1);
  });

  it("detects partial changes", () => {
    const result = wordDiffAnalysis("hello world", "hello earth");
    assert.ok(result.similarity > 0.5);
    assert.ok(result.similarity < 1);
    assert.equal(result.removedRanges.length, 1);
    assert.equal(result.addedRanges.length, 1);
  });

  it("handles empty strings", () => {
    const result1 = wordDiffAnalysis("", "");
    assert.equal(result1.similarity, 1);

    const result2 = wordDiffAnalysis("", "hello");
    assert.equal(result2.similarity, 0);
    assert.equal(result2.addedRanges.length, 1);

    const result3 = wordDiffAnalysis("hello", "");
    assert.equal(result3.similarity, 0);
    assert.equal(result3.removedRanges.length, 1);
  });

  it("handles single character changes", () => {
    const result = wordDiffAnalysis("the quick brown fox", "the quick braun fox");
    assert.ok(result.similarity > 0.5);
    assert.equal(result.removedRanges.length, 1);
    assert.equal(result.addedRanges.length, 1);
  });

  it("ranges have correct positions", () => {
    const result = wordDiffAnalysis("hello world foo", "hello earth foo");
    // "world" removed at position 6-11
    assert.equal(result.removedRanges[0].start, 6);
    assert.equal(result.removedRanges[0].end, 11);
    // "earth" added at position 6-11
    assert.equal(result.addedRanges[0].start, 6);
    assert.equal(result.addedRanges[0].end, 11);
  });
});
