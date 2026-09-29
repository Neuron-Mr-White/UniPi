/**
 * Tests for buildUIPromptMessage — the Pi-native `ui_prompt_start` payload
 * projection used by the `ui_prompt` notify event.
 *
 * The fixtures use `satisfies UIPromptEventPayload` to document the shape Pi
 * emits. tsconfig excludes test files, so an editor flags drift, not CI.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildUIPromptMessage,
  UI_PROMPT_TITLE_MAX,
  type UIPromptEventPayload,
} from "../../ui-prompt-message.ts";

describe("buildUIPromptMessage", () => {
  it("includes the prompt title", () => {
    const payload = {
      type: "ui_prompt_start",
      reason: "ui_prompt",
      kind: "select",
      title: "Which model?",
    } satisfies UIPromptEventPayload;

    assert.equal(buildUIPromptMessage(payload), "Pi is waiting for your input: Which model?");
  });

  it("falls back when the prompt has no title (ctx.ui.custom)", () => {
    const payload = {
      type: "ui_prompt_start",
      reason: "ui_prompt",
      kind: "custom",
    } satisfies UIPromptEventPayload;

    assert.equal(buildUIPromptMessage(payload), "Pi is waiting for your input.");
  });

  it("falls back for an empty or whitespace-only title", () => {
    assert.equal(buildUIPromptMessage({ kind: "input", title: "" }), "Pi is waiting for your input.");
    assert.equal(buildUIPromptMessage({ kind: "input", title: "  \n\t " }), "Pi is waiting for your input.");
  });

  it("strips control characters and collapses whitespace in the title", () => {
    const payload = {
      kind: "confirm",
      title: "Delete\u001b[31m file?\n\n  (cannot\u0007 undo)\u009b",
    } satisfies Partial<UIPromptEventPayload>;

    assert.equal(
      buildUIPromptMessage(payload),
      "Pi is waiting for your input: Delete [31m file? (cannot undo)",
    );
  });

  it("truncates a long title with an ellipsis", () => {
    const title = "x".repeat(UI_PROMPT_TITLE_MAX + 50);

    const message = buildUIPromptMessage({ kind: "editor", title });

    assert.equal(message, `Pi is waiting for your input: ${"x".repeat(UI_PROMPT_TITLE_MAX - 1)}…`);
  });

  it("keeps a title of exactly the maximum length", () => {
    const title = "y".repeat(UI_PROMPT_TITLE_MAX);

    assert.equal(buildUIPromptMessage({ kind: "select", title }), `Pi is waiting for your input: ${title}`);
  });

  it("truncates by code points, never inside a surrogate pair", () => {
    const title = `${"x".repeat(UI_PROMPT_TITLE_MAX - 2)}😀😀 and more`;

    const message = buildUIPromptMessage({ kind: "select", title });

    assert.equal(message, `Pi is waiting for your input: ${"x".repeat(UI_PROMPT_TITLE_MAX - 2)}😀…`);
    assert.ok(message.isWellFormed(), "no lone surrogate");
  });

  it("counts an emoji as one character for the maximum length", () => {
    const title = `${"y".repeat(UI_PROMPT_TITLE_MAX - 1)}😀`;

    assert.equal(buildUIPromptMessage({ kind: "select", title }), `Pi is waiting for your input: ${title}`);
  });

  it("falls back for a non-string title", () => {
    assert.equal(buildUIPromptMessage({ kind: "select", title: 42 }), "Pi is waiting for your input.");
  });

  it("falls back for a missing or malformed payload", () => {
    assert.equal(buildUIPromptMessage(undefined), "Pi is waiting for your input.");
    assert.equal(buildUIPromptMessage(null), "Pi is waiting for your input.");
    assert.equal(buildUIPromptMessage("ui_prompt_start"), "Pi is waiting for your input.");
  });
});
