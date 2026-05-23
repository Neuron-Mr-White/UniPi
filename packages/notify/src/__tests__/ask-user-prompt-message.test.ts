/**
 * Test: Notify — buildAskUserPromptMessage
 *
 * Tests the internal helper directly by importing from its module.
 * The test fixtures use `satisfies AskUserPromptEventPayload` to
 * enforce compile-time alignment with the upstream event contract.
 *
 * Run: node --experimental-strip-types --test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAskUserPromptMessage,
  type AskUserPromptEventPayload,
} from "../../ask-user-prompt-message.ts";

describe("buildAskUserPromptMessage", () => {
  it("standard lossless payload", () => {
    const payload = {
      questions: [
        {
          question: "Which library?",
          header: "Lib",
          multiSelect: false,
          options: [
            { label: "React", description: "UI library", hasPreview: false },
            { label: "Vue", description: "Another UI library", hasPreview: false },
          ],
        },
      ],
    } satisfies AskUserPromptEventPayload;

    assert.equal(buildAskUserPromptMessage(payload), "Agent asks: Which library? — React, Vue");
  });

  it("multiple questions appends (+N more) suffix", () => {
    const payload = {
      questions: [
        {
          question: "First question",
          header: "Q1",
          multiSelect: false,
          options: [{ label: "A", description: "Option A", hasPreview: false }],
        },
        {
          question: "Second question",
          header: "Q2",
          multiSelect: false,
          options: [{ label: "B", description: "Option B", hasPreview: false }],
        },
      ],
    } satisfies AskUserPromptEventPayload;

    assert.equal(buildAskUserPromptMessage(payload), "Agent asks: First question (+1 more) — A");
  });

  it("malformed payload (empty question object) falls back to A question", () => {
    // 故意构造非法 payload，验证运行时降级路径
    const payload = { questions: [{}] } as unknown as AskUserPromptEventPayload;

    assert.equal(buildAskUserPromptMessage(payload), "Agent asks: A question");
  });

  it("empty payload falls back to A question", () => {
    assert.equal(buildAskUserPromptMessage({}), "Agent asks: A question");
  });

  it("null payload falls back to A question", () => {
    assert.equal(buildAskUserPromptMessage(null), "Agent asks: A question");
  });

  it("missing question string in first question falls back", () => {
    const payload = {
      questions: [
        {
          question: "",
          header: "H",
          multiSelect: false,
          options: [{ label: "Opt", description: "D", hasPreview: false }],
        },
      ],
    } satisfies AskUserPromptEventPayload;

    assert.equal(buildAskUserPromptMessage(payload), "Agent asks: A question — Opt");
  });

  it("whitespace-only question is treated as missing", () => {
    const payload = {
      questions: [
        {
          question: "   ",
          header: "H",
          multiSelect: false,
          options: [{ label: "Opt", description: "D", hasPreview: false }],
        },
      ],
    } satisfies AskUserPromptEventPayload;

    // nonEmptyString uses trim().length check, so whitespace-only falls back
    assert.equal(buildAskUserPromptMessage(payload), "Agent asks: A question — Opt");
  });

  it("empty option labels do not produce stray commas", () => {
    const payload = {
      questions: [
        {
          question: "Pick one?",
          header: "Pick",
          multiSelect: false,
          options: [
            { label: "React", description: "UI lib", hasPreview: false },
            { label: "", description: "Empty label", hasPreview: false },
            { label: "Vue", description: "Another UI lib", hasPreview: false },
          ],
        },
      ],
    } satisfies AskUserPromptEventPayload;

    assert.equal(buildAskUserPromptMessage(payload), "Agent asks: Pick one? — React, Vue");
  });

  it("no options produces bare question", () => {
    const payload = {
      questions: [
        {
          question: "Just type?",
          header: "Free",
          multiSelect: false,
          options: [],
        },
      ],
    } satisfies AskUserPromptEventPayload;

    assert.equal(buildAskUserPromptMessage(payload), "Agent asks: Just type?");
  });

  it("legacy flat UniPi payload preserves question and context", () => {
    const payload = {
      question: "Proceed with deploy?",
      context: "Production, with smoke tests",
      optionCount: 2,
      allowMultiple: false,
      allowFreeform: true,
    };

    assert.equal(
      buildAskUserPromptMessage(payload),
      "Agent asks: Proceed with deploy? — Production, with smoke tests",
    );
  });

  it("legacy flat UniPi payload works without context", () => {
    assert.equal(
      buildAskUserPromptMessage({ question: "Proceed?", context: "" }),
      "Agent asks: Proceed?",
    );
  });
});
