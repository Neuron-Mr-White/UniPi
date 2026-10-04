/**
 * Tests for buildInputNeededMessage — the pi `ui_prompt_start` payload
 * projection used by the `input_needed` notify event.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildInputNeededMessage,
  INPUT_TITLE_MAX_CHARS,
} from "../../input-needed-message.ts";

describe("buildInputNeededMessage", () => {
  it("uses the prompt title when present", () => {
    assert.equal(
      buildInputNeededMessage({ kind: "select", title: "Pick a colour" }),
      "Waiting for your input: Pick a colour",
    );
  });

  it("collapses whitespace in the title", () => {
    assert.equal(
      buildInputNeededMessage({ kind: "input", title: "  Pick \t a  colour\n" }),
      "Waiting for your input: Pick a colour",
    );
  });

  it("falls back to the kind when the title is missing", () => {
    assert.equal(buildInputNeededMessage({ kind: "editor" }), "Waiting for your input (editor)");
  });

  it("falls back to the kind when the title is only whitespace", () => {
    assert.equal(buildInputNeededMessage({ kind: "confirm", title: "   " }), "Waiting for your input (confirm)");
  });

  it("falls back to a generic kind when the payload is empty", () => {
    assert.equal(buildInputNeededMessage(undefined), "Waiting for your input (prompt)");
    assert.equal(buildInputNeededMessage({}), "Waiting for your input (prompt)");
  });

  it("keeps a title at the limit verbatim", () => {
    const title = "a".repeat(INPUT_TITLE_MAX_CHARS);
    assert.equal(
      buildInputNeededMessage({ kind: "input", title }),
      `Waiting for your input: ${title}`,
    );
  });

  it("truncates at 120 code points with an ellipsis, without splitting an emoji", () => {
    const title = `${"a".repeat(INPUT_TITLE_MAX_CHARS - 1)}🎉🎉`; // 121 code points
    const message = buildInputNeededMessage({ kind: "select", title });
    assert.equal(
      message,
      `Waiting for your input: ${"a".repeat(INPUT_TITLE_MAX_CHARS - 1)}🎉…`,
    );
    assert.equal(Array.from(message).length, INPUT_TITLE_MAX_CHARS + "Waiting for your input: ".length + 1);
  });
});
