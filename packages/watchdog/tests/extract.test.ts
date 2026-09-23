/** extractText — pi AgentToolResult text extraction tests. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractText } from "../src/extract.js";

describe("extractText", () => {
  it("extracts text parts from a real AgentToolResult content array", () => {
    const partial = {
      content: [
        { type: "text", text: "Error: connection refused, retrying\n" },
        { type: "text", text: "Error: connection refused, retrying\n" },
      ],
    };
    const result = extractText(partial);
    assert.ok(result.includes("Error: connection refused, retrying"), "contains the text");
  });

  it("passes through plain strings", () => {
    assert.equal(extractText("raw output"), "raw output");
  });

  it("returns empty for null/undefined/objects without content", () => {
    assert.equal(extractText(null), "");
    assert.equal(extractText(undefined), "");
    assert.equal(extractText({}), "");
  });
});
