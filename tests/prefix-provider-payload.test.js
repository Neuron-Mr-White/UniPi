import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stream as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { buildRalphLoopReminder } from "../packages/ralph/index.ts";
import { buildMemoryRecallReminder } from "../packages/memory/index.ts";
import { formatMilestoneSnapshot } from "../packages/milestone/hooks.ts";
import { formatActiveSandboxSnapshot } from "../packages/workflow/index.ts";
import { buildResumeSnapshot } from "../packages/compactor/src/session/snapshot.ts";

const MODEL = {
  id: "prefix-test",
  name: "Prefix Test",
  api: "openai-completions",
  provider: "prefix-test",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
  compat: {},
};

const TOOL = {
  name: "stable_tool",
  description: "A deterministic test tool.",
  parameters: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
};

function user(text) {
  return { role: "user", content: text, timestamp: 0 };
}

function assistant(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "prefix-test",
    model: "prefix-test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

async function capturePayload(context, options = {}) {
  let payload;
  const marker = new Error("payload captured");
  const events = streamOpenAICompletions(options.model ?? MODEL, context, {
    apiKey: "test-only",
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    reasoningEffort: options.reasoningEffort,
    onPayload(value) {
      payload = structuredClone(value);
      // Stop before any network request. This test exercises the real provider
      // adapter payload conversion without credentials or paid calls.
      throw marker;
    },
  });

  for await (const event of events) {
    if (event.type === "error" && event.error?.errorMessage !== marker.message) {
      throw new Error(event.error?.errorMessage ?? "provider payload capture failed");
    }
  }

  assert.ok(payload, "provider adapter did not expose a payload");
  return payload;
}

function stableEnvelope(payload) {
  const { messages: _messages, ...envelope } = payload;
  return envelope;
}

describe("provider-native prefix structure", () => {
  it("keeps the complete envelope stable and extends the prior message array", async () => {
    const firstContext = {
      systemPrompt: "Stable system prompt",
      tools: [TOOL],
      messages: [user("first turn")],
    };
    const secondContext = {
      ...firstContext,
      messages: [...firstContext.messages, assistant("first answer"), user("second turn")],
    };

    const first = await capturePayload(firstContext, { temperature: 0, maxTokens: 512 });
    const second = await capturePayload(secondContext, { temperature: 0, maxTokens: 512 });

    assert.deepEqual(stableEnvelope(second), stableEnvelope(first));
    assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
    assert.ok(second.messages.length > first.messages.length);
  });

  it("serializes every concrete UniPi injector as an appended provider user message", async () => {
    const event = {
      id: 1,
      session_id: "prefix-session",
      type: "decision",
      category: "decision",
      priority: 1,
      data: "Preserve prior request bytes",
      project_dir: "/workspace",
      attribution_source: "test",
      attribution_confidence: 1,
      source_hook: "test",
      created_at: "2026-08-14T00:00:00.000Z",
      data_hash: "stable-hash",
    };
    const snapshots = [
      ["Ralph", buildRalphLoopReminder({
        name: "cache-rollout",
        iteration: 4,
        maxIterations: 30,
        taskFile: ".unipi/ralph/cache-rollout.md",
        itemsPerIteration: 2,
      })],
      ["memory", buildMemoryRecallReminder({
        projectName: "unipi",
        memories: [{ title: "prefix_cache_invariant" }],
        canSearch: true,
        canStore: true,
      })],
      ["milestone", formatMilestoneSnapshot("/workspace", "Overall progress: 1/2 items (50%)")],
      ["workflow", formatActiveSandboxSnapshot("brainstorm", "brainstorm")],
      ["compactor resume", buildResumeSnapshot([event], { compactCount: 2 })],
    ];

    const base = {
      systemPrompt: "Stable system prompt",
      tools: [TOOL],
      messages: [user("work on the project"), assistant("working")],
    };
    const first = await capturePayload(base);

    for (const [name, snapshot] of snapshots) {
      const next = await capturePayload({ ...base, messages: [...base.messages, user(snapshot)] });
      assert.deepEqual(stableEnvelope(next), stableEnvelope(first), `${name} changed the request envelope`);
      assert.deepEqual(
        next.messages.slice(0, first.messages.length),
        first.messages,
        `${name} rewrote the provider message prefix`,
      );
      assert.equal(next.messages.at(-1).role, "user");
      assert.equal(next.messages.at(-1).content, snapshot);
    }
  });

  it("classifies real envelope/history changes as cache boundaries", async () => {
    const baseContext = {
      systemPrompt: "Stable system prompt",
      tools: [TOOL],
      messages: [user("first turn"), assistant("first answer"), user("second turn")],
    };
    const base = await capturePayload(baseContext, { temperature: 0, maxTokens: 512 });

    const changedSystem = await capturePayload(
      { ...baseContext, systemPrompt: "Changed system prompt" },
      { temperature: 0, maxTokens: 512 },
    );
    assert.notDeepEqual(changedSystem.messages[0], base.messages[0]);

    const changedSettings = await capturePayload(baseContext, { temperature: 0.7, maxTokens: 1024 });
    assert.notDeepEqual(stableEnvelope(changedSettings), stableEnvelope(base));

    const reasoningModel = {
      ...MODEL,
      reasoning: true,
      compat: { supportsReasoningEffort: true },
    };
    const lowReasoning = await capturePayload(baseContext, {
      model: reasoningModel,
      reasoningEffort: "low",
    });
    const highReasoning = await capturePayload(baseContext, {
      model: reasoningModel,
      reasoningEffort: "high",
    });
    assert.notEqual(lowReasoning.reasoning_effort, highReasoning.reasoning_effort);

    const changedTools = await capturePayload({
      ...baseContext,
      tools: [{ ...TOOL, parameters: { ...TOOL.parameters, required: [] } }],
    }, { temperature: 0, maxTokens: 512 });
    assert.notDeepEqual(changedTools.tools, base.tools);

    const changedModel = await capturePayload(baseContext, {
      temperature: 0,
      maxTokens: 512,
      model: { ...MODEL, id: "prefix-test-2", name: "Prefix Test 2" },
    });
    assert.notEqual(changedModel.model, base.model);

    const compacted = await capturePayload({
      ...baseContext,
      messages: [user("Compaction summary replaces earlier history"), user("second turn")],
    }, { temperature: 0, maxTokens: 512 });
    assert.notDeepEqual(
      compacted.messages.slice(0, base.messages.length),
      base.messages,
      "compaction must be observable as a history replacement boundary",
    );
  });
});
