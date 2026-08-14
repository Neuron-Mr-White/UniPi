import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import workflowExtension, { WORKFLOW_SANDBOX_SNAPSHOT_TYPE } from "../index.js";

type Handler = (...args: any[]) => any;

function customSnapshotEntry(
  id: string,
  parentId: string | null,
  content: string,
  active: boolean,
): SessionEntry {
  return {
    type: "custom_message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    customType: WORKFLOW_SANDBOX_SNAPSHOT_TYPE,
    content,
    display: false,
    details: { active },
  };
}

function harness(options: { throwOnDispatch?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: Handler }>();
  const emitted: Array<{ name: string; data: unknown }> = [];
  let setActiveToolsCalls = 0;
  let dispatchCalls = 0;

  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerCommand(name: string, command: { handler: Handler }) {
      commands.set(name, command);
    },
    sendUserMessage() {
      dispatchCalls++;
      if (options.throwOnDispatch) throw new Error("dispatch failed");
    },
    getActiveTools: () => ["read", "write", "edit", "bash"],
    getAllTools: () => [],
    setActiveTools() {
      setActiveToolsCalls++;
    },
    events: {
      on() {},
      emit(name: string, data: unknown) {
        emitted.push({ name, data });
      },
    },
  };

  workflowExtension(pi as any);

  const context = (branch: SessionEntry[] = []) => ({
    cwd: "/workspace",
    hasUI: false,
    sessionManager: { getBranch: () => branch },
  });

  return {
    handlers,
    commands,
    emitted,
    context,
    get setActiveToolsCalls() { return setActiveToolsCalls; },
    get dispatchCalls() { return dispatchCalls; },
  };
}

function assistant(stopReason = "stop") {
  return { role: "assistant", stopReason };
}

describe("workflow sandbox", () => {
  it("does not call setActiveTools or mutate systemPrompt while activating", async () => {
    const app = harness();
    await app.commands.get("unipi:brainstorm")!.handler("cache stability", app.context());

    const result = await app.handlers.get("before_agent_start")!(
      { systemPrompt: "stable system prompt" },
      app.context(),
    );

    assert.equal(app.setActiveToolsCalls, 0);
    assert.equal(app.dispatchCalls, 1);
    assert.equal(result.systemPrompt, undefined);
    assert.equal(result.message.customType, WORKFLOW_SANDBOX_SNAPSHOT_TYPE);
  });

  it("returns an active hidden snapshot with level, restrictions, and supersession", async () => {
    const app = harness();
    await app.commands.get("unipi:brainstorm")!.handler("topic", app.context());

    const result = await app.handlers.get("before_agent_start")!({}, app.context());

    assert.equal(result.message.display, false);
    assert.deepEqual(result.message.details, {
      active: true,
      command: "brainstorm",
      level: "brainstorm",
    });
    assert.match(result.message.content, /supersedes all prior UniPi workflow sandbox snapshots/);
    assert.match(result.message.content, /Status: active/);
    assert.match(result.message.content, /Blocked tool names: edit/);
    assert.match(result.message.content, /provider tool schemas and tool order remain unchanged/);
    assert.match(result.message.content, /\.unipi\/docs\/specs\/ only/);
  });

  it("deduplicates against the latest effective workflow snapshot", async () => {
    const app = harness();
    await app.commands.get("unipi:brainstorm")!.handler("topic", app.context());
    const first = await app.handlers.get("before_agent_start")!({}, app.context());
    const branch = [
      customSnapshotEntry("stale", null, "stale snapshot", true),
      customSnapshotEntry("latest", "stale", first.message.content, true),
    ];

    const result = await app.handlers.get("before_agent_start")!({}, app.context(branch));

    assert.equal(result, undefined);
  });

  it("deduplicates an inactive snapshot after cleanup", async () => {
    const app = harness();
    const inactiveContent = [
      "# UniPi Workflow Sandbox Snapshot",
      "This snapshot supersedes all prior UniPi workflow sandbox snapshots; use only this snapshot for workflow sandbox status and restrictions.",
      "Status: inactive",
      "No UniPi workflow sandbox is active. Prior workflow sandbox restrictions no longer apply.",
    ].join("\n\n");
    const branch = [customSnapshotEntry("inactive", null, inactiveContent, false)];

    assert.equal(
      await app.handlers.get("before_agent_start")!({}, app.context(branch)),
      undefined,
    );
  });

  it("clears active restrictions that compaction removed as a distinct message", async () => {
    const app = harness();
    const branch: SessionEntry[] = [
      customSnapshotEntry("active", null, "Status: active", true),
      {
        type: "message",
        id: "kept",
        parentId: "active",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "kept", timestamp: Date.now() },
      },
      {
        type: "compaction",
        id: "compaction",
        parentId: "kept",
        timestamp: new Date().toISOString(),
        summary: "An active workflow sandbox previously restricted tool use.",
        firstKeptEntryId: "kept",
        tokensBefore: 10,
      },
    ];

    const result = await app.handlers.get("before_agent_start")!({}, app.context(branch));

    assert.equal(result.message.details.active, false);
    assert.match(result.message.content, /Status: inactive/);
  });

  it("blocks existing denied tool names but preserves allowed and extension tools", async () => {
    const app = harness();
    await app.commands.get("unipi:worktree-list")!.handler("", app.context());
    const toolCall = app.handlers.get("tool_call")!;

    const blocked = await toolCall({ toolName: "bash" }, app.context());
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /not allowed in read_only sandbox/);
    assert.equal(await toolCall({ toolName: "read" }, app.context()), undefined);
    assert.equal(await toolCall({ toolName: "memory_search" }, app.context()), undefined);
  });

  it("completes at agent_end, then appends one inactive snapshot on next start", async () => {
    const app = harness();
    await app.commands.get("unipi:brainstorm")!.handler("topic", app.context());
    const active = await app.handlers.get("before_agent_start")!({}, app.context());
    const activeBranch = [customSnapshotEntry("active", null, active.message.content, true)];

    await app.handlers.get("agent_end")!({ messages: [assistant()] }, app.context(activeBranch));
    const inactive = await app.handlers.get("before_agent_start")!({}, app.context(activeBranch));

    assert.equal(inactive.systemPrompt, undefined);
    assert.equal(inactive.message.display, false);
    assert.deepEqual(inactive.message.details, { active: false });
    assert.match(inactive.message.content, /Status: inactive/);
    assert.match(inactive.message.content, /Prior workflow sandbox restrictions no longer apply/);

    const clearedBranch = [
      ...activeBranch,
      customSnapshotEntry("inactive", "active", inactive.message.content, false),
    ];
    assert.equal(
      await app.handlers.get("before_agent_start")!({}, app.context(clearedBranch)),
      undefined,
    );
    assert.equal(await app.handlers.get("tool_call")!({ toolName: "edit" }, app.context()), undefined);
  });

  it("adds no marker to a clean no-workflow session", async () => {
    const app = harness();
    assert.equal(await app.handlers.get("before_agent_start")!({}, app.context()), undefined);
  });

  it("rolls back lifecycle and sandbox when dispatch throws", async () => {
    const app = harness({ throwOnDispatch: true });

    await assert.rejects(
      app.commands.get("unipi:brainstorm")!.handler("topic", app.context()),
      /dispatch failed/,
    );
    assert.equal(await app.handlers.get("before_agent_start")!({}, app.context()), undefined);
    assert.equal(await app.handlers.get("tool_call")!({ toolName: "edit" }, app.context()), undefined);

    // A second command reaches dispatch too, proving the lifecycle was reset.
    await assert.rejects(
      app.commands.get("unipi:plan")!.handler("specs:test.md", app.context()),
      /dispatch failed/,
    );
    assert.equal(app.dispatchCalls, 2);
    assert.equal(app.setActiveToolsCalls, 0);
  });

  it("cleans up in-memory lifecycle and sandbox state on session shutdown", async () => {
    const app = harness();
    await app.commands.get("unipi:worktree-list")!.handler("", app.context());
    assert.equal(
      (await app.handlers.get("tool_call")!({ toolName: "bash" }, app.context())).block,
      true,
    );

    await app.handlers.get("session_shutdown")!({}, app.context());

    assert.equal(await app.handlers.get("tool_call")!({ toolName: "bash" }, app.context()), undefined);
    assert.equal(await app.handlers.get("before_agent_start")!({}, app.context()), undefined);
  });

  it("keeps state local to each extension factory", async () => {
    const active = harness();
    const clean = harness();
    await active.commands.get("unipi:worktree-list")!.handler("", active.context());

    assert.equal(
      (await active.handlers.get("tool_call")!({ toolName: "bash" }, active.context())).block,
      true,
    );
    assert.equal(await clean.handlers.get("tool_call")!({ toolName: "bash" }, clean.context()), undefined);
    assert.equal(await clean.handlers.get("before_agent_start")!({}, clean.context()), undefined);
  });
});
