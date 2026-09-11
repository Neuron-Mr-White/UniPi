/**
 * Tests for summarize.ts — issue #36 regression coverage.
 *
 * A thinking model served by llama.cpp/vLLM burns the entire 100-token recap
 * budget on reasoning and returns no visible content, so the summarizer falls
 * back to raw truncation. `disableThinking: true` must send
 * `chat_template_kwargs: { enable_thinking: false, preserve_thinking: false }`;
 * the flag must stay absent by default (strict OpenAI-compatible servers
 * reject unknown params).
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { summarizeLastMessage } from "../../summarize.ts";

const REAL_FETCH = globalThis.fetch;
const BASE = "http://localhost:8080/v1";

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

let captured: CapturedRequest[] = [];

function stubFetch(respond: () => unknown): void {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    captured.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return respond();
  }) as typeof fetch;
}

function okCompletion(content: string): unknown {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  captured = [];
});

describe("summarizeLastMessage disableThinking (issue #36)", () => {
  it("sends chat_template_kwargs when disableThinking is true", async () => {
    stubFetch(() => okCompletion("  A tidy summary.  "));

    const result = await summarizeLastMessage(
      "long message",
      "test-key",
      BASE,
      "openai-completions",
      "gemma-4-e4b",
      { disableThinking: true },
    );

    assert.equal(result, "A tidy summary.");
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0].body.chat_template_kwargs, {
      enable_thinking: false,
      preserve_thinking: false,
    });
    assert.equal(captured[0].body.max_tokens, 100);
  });

  it("omits chat_template_kwargs by default", async () => {
    stubFetch(() => okCompletion("summary"));

    await summarizeLastMessage(
      "long message",
      "test-key",
      BASE,
      "openai-completions",
      "gemma-4-e4b",
    );

    assert.equal(captured[0].body.chat_template_kwargs, undefined);
    assert.ok(Array.isArray(captured[0].body.messages));
    assert.equal(captured[0].body.messages?.[1]?.content, "long message");
  });

  it("omits chat_template_kwargs when disableThinking is false", async () => {
    stubFetch(() => okCompletion("summary"));

    await summarizeLastMessage(
      "long message",
      "test-key",
      BASE,
      "openai-completions",
      "gemma-4-e4b",
      { disableThinking: false },
    );

    assert.equal(captured[0].body.chat_template_kwargs, undefined);
  });

  it("falls back to truncation when a thinking model returns empty content", async () => {
    stubFetch(() => okCompletion(""));

    const long = "x".repeat(300);
    const result = await summarizeLastMessage(
      long,
      "test-key",
      BASE,
      "openai-completions",
      "gemma-4-e4b",
      { disableThinking: true },
    );

    assert.equal(result, `${"x".repeat(100)}...`);
  });

  it("does not send chat_template_kwargs to the Anthropic path", async () => {
    stubFetch(() => ({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "anthro summary" }] }),
    }));

    const result = await summarizeLastMessage(
      "long message",
      "test-key",
      "https://api.anthropic.com/v1",
      "anthropic-messages",
      "claude-opus-5",
      { disableThinking: true },
    );

    assert.equal(result, "anthro summary");
    assert.equal(captured[0].body.chat_template_kwargs, undefined);
    assert.equal(captured[0].body.max_tokens, 100);
  });
});
