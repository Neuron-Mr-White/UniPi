/**
 * Unit tests for getLastResponseText — mirrors pi's /copy extraction:
 * tool calls, thinking and empty assistant messages are skipped; the latest
 * response WITH text wins.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getLastResponseText, type SessionEntryLike } from "../src/last-response.ts";

const entry = (message: SessionEntryLike["message"]): SessionEntryLike => ({ type: "message", message });

const assistant = (
  blocks: Array<{ type: string; text?: string }>,
  stopReason = "stop",
): SessionEntryLike => entry({ role: "assistant", stopReason, content: blocks });

describe("getLastResponseText", () => {
  it("returns undefined with no entries or no assistant messages", () => {
    assert.equal(getLastResponseText(undefined), undefined);
    assert.equal(getLastResponseText([]), undefined);
    assert.equal(getLastResponseText([entry({ role: "user", content: [{ type: "text", text: "hi" }] })]), undefined);
  });

  it("picks the latest assistant response", () => {
    const text = getLastResponseText([
      assistant([{ type: "text", text: "first response" }]),
      entry({ role: "user", content: [{ type: "text", text: "and then" }] }),
      assistant([{ type: "text", text: "second response" }]),
    ]);
    assert.equal(text, "second response");
  });

  it("joins text blocks and skips thinking + tool calls", () => {
    const text = getLastResponseText([
      assistant([
        { type: "thinking", text: "should be ignored" },
        { type: "text", text: "answer part one — " },
        { type: "toolCall", text: "never copied" },
        { type: "text", text: "part two" },
      ]),
    ]);
    assert.equal(text, "answer part one — part two");
  });

  it("an assistant message with only tool calls does not stop the search", () => {
    const text = getLastResponseText([
      assistant([{ type: "text", text: "the real answer" }]),
      assistant([{ type: "toolCall" }]),
    ]);
    assert.equal(text, "the real answer");
  });

  it("skips aborted messages with no content and whitespace-only text", () => {
    const text = getLastResponseText([
      assistant([{ type: "text", text: "kept" }]),
      assistant([], "aborted"),
      assistant([{ type: "text", text: "   " }]),
    ]);
    assert.equal(text, "kept");
  });

  it("ignores non-message entries in the branch", () => {
    const text = getLastResponseText([
      { type: "model_change" },
      assistant([{ type: "text", text: "still found" }]),
      { type: "compaction" },
      { type: "label" },
    ] as unknown as SessionEntryLike[]);
    assert.equal(text, "still found");
  });
});
