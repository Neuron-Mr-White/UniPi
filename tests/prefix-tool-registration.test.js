import assert from "node:assert/strict";
import { describe, it } from "node:test";
import longHorizonExtension from "../packages/long-horizon/index.ts";

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
  it("registers long-horizon's static schemas before session_start", () => {
    const first = captureExtension(longHorizonExtension);
    const second = captureExtension(longHorizonExtension);

    assert.ok(
      ["create_goal", "get_goal", "update_goal", "todowrite", "ralph_done", "loop_status"].every(
        (name) => first.tools.some((tool) => tool.name === name),
      ),
    );
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
});
