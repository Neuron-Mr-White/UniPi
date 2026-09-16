/**
 * Subagent guard tests.
 *
 * In Pi's RPC mode (fusion sidekick) `ctx.hasUI` is true while `ctx.ui.custom()`
 * is a stub returning undefined, so ask_user used to fall through to its cancel
 * branch and silently report "User cancelled the selection". ask_user must
 * instead refuse loudly inside a subagent child.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ASK_USER_TOOLS } from "@pi-unipi/core";

import { isSubagentChild, registerAskUserTools } from "../tools.ts";

const ORIGINAL = process.env.UNIPI_SUBAGENT_CHILD;

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.UNIPI_SUBAGENT_CHILD;
  } else {
    process.env.UNIPI_SUBAGENT_CHILD = ORIGINAL;
  }
});

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown; isError?: boolean }>;
}

function getAskTool(): RegisteredTool {
  let registered: RegisteredTool | undefined;
  registerAskUserTools({
    registerTool(tool: RegisteredTool) {
      registered = tool;
    },
  } as never);
  assert.ok(registered, "ask_user tool was not registered");
  return registered;
}

function createCtx(hasUI: boolean) {
  const state = { customCalls: 0 };
  const ctx = {
    hasUI,
    ui: {
      custom() {
        state.customCalls += 1;
        throw new Error("ctx.ui.custom must not be called in a subagent");
      },
    },
    abort() {},
  };
  return { ctx, state };
}

const PARAMS = {
  question: "Which database should we use?",
  options: [{ label: "Postgres" }, { label: "SQLite" }],
};

describe("isSubagentChild", () => {
  it("is true when UNIPI_SUBAGENT_CHILD is 1", () => {
    assert.equal(isSubagentChild({ UNIPI_SUBAGENT_CHILD: "1" }), true);
  });

  it("is false when unset", () => {
    assert.equal(isSubagentChild({}), false);
  });

  it("is false for 0", () => {
    assert.equal(isSubagentChild({ UNIPI_SUBAGENT_CHILD: "0" }), false);
  });
});

describe("ask_user subagent guard", () => {
  it("refuses inside a subagent child without touching ctx.ui.custom", async () => {
    process.env.UNIPI_SUBAGENT_CHILD = "1";
    const tool = getAskTool();
    const { ctx, state } = createCtx(true);

    const result = await tool.execute("call-1", PARAMS, undefined, undefined, ctx);

    assert.equal(result.isError, true);
    assert.equal(result.content.length, 1);
    assert.match(result.content[0]!.text, /ask_user is not available inside a subagent/);
    assert.equal(state.customCalls, 0);
  });

  it("does not fire when the env var is unset", async () => {
    delete process.env.UNIPI_SUBAGENT_CHILD;
    const tool = getAskTool();
    const { ctx, state } = createCtx(false);

    const result = await tool.execute("call-1", PARAMS, undefined, undefined, ctx);

    assert.doesNotMatch(result.content[0]!.text, /not available inside a subagent/);
    assert.match(result.content[0]!.text, /UI not available|disabled in settings/);
    assert.equal(state.customCalls, 0);
  });
});

describe("ask_user tool registration", () => {
  it("registers the ASK tool", () => {
    assert.equal(getAskTool().name, ASK_USER_TOOLS.ASK);
  });
});
