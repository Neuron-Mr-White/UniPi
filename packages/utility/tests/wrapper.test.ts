/**
 * @pi-unipi/utility — Tool Wrapper tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getEditOperations, summarizeEditOperations } from "../src/diff/wrapper.js";

describe("getEditOperations", () => {
  it("extracts operations from multi-edit format", () => {
    const input = {
      path: "test.ts",
      edits: [
        { oldText: "old1", newText: "new1" },
        { oldText: "old2", newText: "new2" },
      ],
    };
    const ops = getEditOperations(input);
    assert.equal(ops.length, 2);
    assert.equal(ops[0].oldText, "old1");
    assert.equal(ops[0].newText, "new1");
    assert.equal(ops[1].oldText, "old2");
    assert.equal(ops[1].newText, "new2");
  });

  it("extracts single edit operation", () => {
    const input = {
      path: "test.ts",
      oldText: "old",
      newText: "new",
    };
    const ops = getEditOperations(input);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].oldText, "old");
    assert.equal(ops[0].newText, "new");
  });

  it("handles old_text/new_text snake_case format", () => {
    const input = {
      path: "test.ts",
      old_text: "old",
      new_text: "new",
    };
    const ops = getEditOperations(input);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].oldText, "old");
    assert.equal(ops[0].newText, "new");
  });

  it("handles mixed format in edits array", () => {
    const input = {
      path: "test.ts",
      edits: [
        { old_text: "old1", new_text: "new1" },
        { oldText: "old2", newText: "new2" },
      ],
    };
    const ops = getEditOperations(input);
    assert.equal(ops.length, 2);
    assert.equal(ops[0].oldText, "old1");
    assert.equal(ops[1].oldText, "old2");
  });

  it("returns empty array for invalid input", () => {
    assert.deepEqual(getEditOperations(null), []);
    assert.deepEqual(getEditOperations(undefined), []);
    assert.deepEqual(getEditOperations({}), []);
    assert.deepEqual(getEditOperations({ path: "test.ts" }), []);
  });
});

describe("summarizeEditOperations", () => {
  it("summarizes a single operation", () => {
    const ops = [{ oldText: "a\nb", newText: "a\nc\nd" }];
    const result = summarizeEditOperations(ops);
    assert.equal(result.totalEdits, 1);
    assert.equal(result.totalDeletions, 2); // a, b
    assert.equal(result.totalAdditions, 3); // a, c, d
  });

  it("summarizes multiple operations", () => {
    const ops = [
      { oldText: "old1", newText: "new1\nnew2" },
      { oldText: "old3\nold4", newText: "new3" },
    ];
    const result = summarizeEditOperations(ops);
    assert.equal(result.totalEdits, 2);
    assert.equal(result.totalDeletions, 3); // old1, old3, old4
    assert.equal(result.totalAdditions, 3); // new1, new2, new3
  });

  it("handles empty operations", () => {
    const result = summarizeEditOperations([]);
    assert.equal(result.totalEdits, 0);
    assert.equal(result.totalDeletions, 0);
    assert.equal(result.totalAdditions, 0);
  });

  it("handles empty old text (insertion)", () => {
    const ops = [{ oldText: "", newText: "new content" }];
    const result = summarizeEditOperations(ops);
    assert.equal(result.totalEdits, 1);
    assert.equal(result.totalDeletions, 1); // empty string still counts as 1 line
    assert.equal(result.totalAdditions, 1);
  });

  it("handles empty new text (deletion)", () => {
    const ops = [{ oldText: "deleted content", newText: "" }];
    const result = summarizeEditOperations(ops);
    assert.equal(result.totalEdits, 1);
    assert.equal(result.totalDeletions, 1);
    assert.equal(result.totalAdditions, 1);
  });
});
