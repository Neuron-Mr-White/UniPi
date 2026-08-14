import assert from "node:assert/strict";
import { describe, it } from "node:test";
import cocoindexExtension from "../packages/cocoindex/index.ts";
import ralphExtension from "../packages/ralph/index.ts";

function captureExtension(factory) {
  const tools = [];
  const handlers = new Map();
  const pi = {
    registerTool(tool) {
      tools.push(tool);
    },
    registerCommand() {},
    on(event, handler) {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
    events: {
      emit() {},
      on() {},
    },
  };

  factory(pi);
  return { tools, handlers };
}

function providerDefinition(tool) {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    promptSnippet: tool.promptSnippet,
    promptGuidelines: tool.promptGuidelines,
    parameters: tool.parameters,
  };
}

describe("prefix-cache tool registration", () => {
  it("registers Ralph's static schemas before session_start", () => {
    const first = captureExtension(ralphExtension);
    const second = captureExtension(ralphExtension);

    assert.deepEqual(first.tools.map((tool) => tool.name), ["ralph_start", "ralph_done"]);
    assert.deepEqual(
      first.tools.map(providerDefinition),
      second.tools.map(providerDefinition),
      "equivalent extension loads must produce byte-stable provider definitions",
    );
    assert.equal(
      first.handlers.get("session_start")?.length,
      1,
      "session_start must initialize state, not register another tool set",
    );
  });

  it("registers CocoIndex's static schemas before asynchronous startup work", () => {
    const first = captureExtension(cocoindexExtension);
    const second = captureExtension(cocoindexExtension);

    assert.deepEqual(first.tools.map((tool) => tool.name), ["cocoindex_search", "cocoindex_status"]);
    assert.deepEqual(
      first.tools.map(providerDefinition),
      second.tools.map(providerDefinition),
      "equivalent extension loads must produce byte-stable provider definitions",
    );
    assert.equal(
      first.handlers.get("session_start")?.length,
      1,
      "availability checks must not defer provider-visible tool registration",
    );
  });
});
