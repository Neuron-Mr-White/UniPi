/**
 * Turn liveness for the three paths that end the lead's turn while the
 * sidekick is still running (A: a user message interrupts, B: the wait times
 * out, C: block:false). Each must leave the wake line visible — herdr's
 * `working`, pi's loader and pi's elapsed timer all derive from the lead's turn
 * state, so the wake line is what keeps the UI from reading as finished.
 *
 * These drive the real extension and a real SidekickRuntime; the child binary
 * is stubbed (UNIPI_SUBAGENT_PI_BINARY) so the handoff stays genuinely pending
 * without spawning pi or spending tokens.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fusionExtension from "../src/index.js";
import { globalPresetPath } from "../src/preset.js";

const WAKE_KEY = "fusion-sidekick-wake";

/** Swallows stdin and never answers: the handoff stays pending forever. */
function stubPiBinary(): string {
  const dir = mkdtempSync(join("/tmp", "fusion-stub-pi-"));
  const file = join(dir, "stub-pi");
  writeFileSync(file, "#!/bin/sh\nwhile read -r line; do :; done\n");
  chmodSync(file, 0o755);
  return file;
}

function model(provider: string, id: string): Record<string, unknown> {
  return { provider, id, name: id, reasoning: true, cost: { input: 1, cacheRead: 0.1, output: 2 } };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The lead's turn is still running, so pi's own loader is alive and the wake
 * line must stay out of the way. Waits a beat so every publish triggered by
 * the handoff so far has run, and the line still has not appeared.
 */
async function assertTurnStillLive(h: Harness): Promise<void> {
  await wait(300);
  assert.equal(h.wakeWidgets().length, 0, "no wake line while the turn is genuinely live");
}

type Handler = (event: unknown, ctx: unknown) => unknown;
type AnyTool = { execute: (...args: any[]) => Promise<any> };

interface Harness {
  ctx: any;
  tools: Map<string, AnyTool>;
  state: { idle: boolean; pendingUserMessage: boolean };
  wakeWidgets: () => Array<{ widget: unknown; placement?: string }>;
  /** `herdr:working` claim events the extension emitted (for sidebar status). */
  herdrWorking: () => Array<{ active: boolean; label: string }>;
  /** Fires the lead's end-of-turn lifecycle events and flushes the publishes. */
  endTurn: () => Promise<void>;
  shutdown: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const home = mkdtempSync(join("/tmp", "fusion-live-home-"));
  const cwd = mkdtempSync(join("/tmp", "fusion-live-cwd-"));
  mkdirSync(join(home, ".unipi", "config", "fusion"), { recursive: true });
  writeFileSync(globalPresetPath(home), JSON.stringify({
    lead: ["a/lead"],
    sidekick: ["b/side"],
    active: { kind: "fusion", lead: "a/lead", sidekick: "b/side", leadEffort: "high", sidekickEffort: "low" },
  }));

  const handlers = new Map<string, Handler>();
  const tools = new Map<string, AnyTool>();
  const widgets: Array<{ key: string; widget: unknown; placement?: string }> = [];
  const herdrEvents: Array<{ name: string; payload: { active: boolean; label: string } }> = [];
  const state = { idle: false, pendingUserMessage: false };
  const lead = model("a", "lead");
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    events: {
      emit: (name: string, payload: { active: boolean; label: string }) => {
        herdrEvents.push({ name, payload });
      },
    },
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
    registerShortcut: () => undefined,
    registerFlag: () => undefined,
    setModel: async () => true,
    setThinkingLevel: () => undefined,
    getThinkingLevel: () => "medium",
    sendMessage: () => undefined,
  };
  const ctx = {
    cwd,
    hasUI: true,
    model: lead,
    modelRegistry: { getAvailable: () => [lead, model("b", "side")] },
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pendingUserMessage,
    ui: {
      notify: () => undefined,
      addAutocompleteProvider: () => undefined,
      setWidget: (key: string, widget: unknown, options?: { placement?: string }) => {
        widgets.push({ key, widget, placement: options?.placement });
      },
    },
  };

  const previous = {
    home: process.env.HOME,
    child: process.env.UNIPI_FUSION_CHILD,
    binary: process.env.UNIPI_SUBAGENT_PI_BINARY,
  };
  process.env.HOME = home;
  process.env.UNIPI_SUBAGENT_PI_BINARY = stubPiBinary();
  // The extension is a deliberate no-op in a sidekick child; the harness must
  // not inherit that ambient env.
  delete process.env.UNIPI_FUSION_CHILD;
  try {
    fusionExtension(pi as never);
  } finally {
    if (previous.child === undefined) delete process.env.UNIPI_FUSION_CHILD;
    else process.env.UNIPI_FUSION_CHILD = previous.child;
  }
  await handlers.get("session_start")?.({}, ctx);

  let closed = false;
  return {
    ctx,
    tools,
    state,
    wakeWidgets: () => widgets.filter((entry) => entry.key === WAKE_KEY),
    herdrWorking: () => herdrEvents.filter((e) => e.name === "herdr:working").map((e) => e.payload),
    endTurn: async () => {
      handlers.get("turn_end")?.({}, ctx);
      handlers.get("agent_settled")?.({}, ctx);
      await wait(250);
    },    shutdown: async () => {
      if (closed) return;
      closed = true;
      handlers.get("session_shutdown")?.({}, ctx);
      await wait(50);
      if (previous.home === undefined) delete process.env.HOME;
      else process.env.HOME = previous.home;
      if (previous.binary === undefined) delete process.env.UNIPI_SUBAGENT_PI_BINARY;
      else process.env.UNIPI_SUBAGENT_PI_BINARY = previous.binary;
    },
  };
}

test("path A: a user message ends the turn, the wake line covers the still-running sidekick", async () => {
  const h = await harness();
  try {
    h.state.pendingUserMessage = true;
    const result = await h.tools.get("sidekick")!.execute("call", { message: "work" }, undefined, undefined, h.ctx);
    assert.match(result.content[0]!.text, /user message arrived/);
    await assertTurnStillLive(h);

    h.state.idle = true;
    await h.endTurn();
    assert.equal(h.wakeWidgets().length, 1, "wake line shown once the turn has ended");
    assert.equal(typeof h.wakeWidgets()[0]?.widget, "function");
    assert.deepEqual(
      h.herdrWorking(),
      [{ active: true, label: "sidekick working — resumes automatically" }],
      "wake line claims herdr working exactly once",
    );
  } finally {
    await h.shutdown();
  }
});

test("path B: a wait timeout ends the turn, the child keeps running and the wake line covers it", async () => {
  const h = await harness();
  try {
    await h.tools.get("sidekick")!.execute("call", { message: "work", block: false }, undefined, undefined, h.ctx);
    const timedOut = await h.tools.get("read_subagent")!.execute("call", { block: true, timeout: 0.001 }, undefined, undefined, h.ctx);
    assert.match(timedOut.content[0]!.text, /is still running/);
    await assertTurnStillLive(h);

    h.state.idle = true;
    await h.endTurn();
    assert.equal(h.wakeWidgets().length, 1);
    assert.equal(typeof h.wakeWidgets()[0]?.widget, "function");
  } finally {
    await h.shutdown();
  }
});

test("path C: block:false ends the turn and the wake line covers the gap", async () => {
  const h = await harness();
  try {
    const result = await h.tools.get("sidekick")!.execute("call", { message: "work", block: false }, undefined, undefined, h.ctx);
    assert.match(result.content[0]!.text, /started in the background/);
    assert.equal(result.details.background, true);
    await assertTurnStillLive(h);

    h.state.idle = true;
    await h.endTurn();
    assert.equal(h.wakeWidgets().length, 1);
    assert.equal(typeof h.wakeWidgets()[0]?.widget, "function");
  } finally {
    await h.shutdown();
  }
});

test("a live turn keeps pi's own loader: no wake line while the lead is still working", async () => {
  const h = await harness();
  try {
    await h.tools.get("sidekick")!.execute("call", { message: "work", block: false }, undefined, undefined, h.ctx);
    h.state.idle = false;
    await assertTurnStillLive(h);
    await h.endTurn();
    assert.equal(h.wakeWidgets().length, 0);
  } finally {
    await h.shutdown();
  }
});

test("the wake line is cleared when the session shuts down", async () => {
  const h = await harness();
  try {
    await h.tools.get("sidekick")!.execute("call", { message: "work", block: false }, undefined, undefined, h.ctx);
    h.state.idle = true;
    await h.endTurn();
    assert.equal(h.wakeWidgets().length, 1);

    await h.shutdown();
    assert.equal(h.wakeWidgets().at(-1)?.widget, undefined, "session shutdown clears the line");
    assert.deepEqual(
      h.herdrWorking().at(-1),
      { active: false, label: "sidekick working — resumes automatically" },
      "session shutdown releases the herdr working claim",
    );
  } finally {
    await h.shutdown();
  }
});
