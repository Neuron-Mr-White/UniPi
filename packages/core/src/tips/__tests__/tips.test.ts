/**
 * Info-tip engine tests: selection, maxShows, event matching, one-at-a-time,
 * clearing, and the enabled gate.
 *
 * Run with a scratch HOME:  HOME=$(mktemp -d) npx tsx --test src/tips/__tests__/tips.test.ts
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  installTips,
  listTips,
  pickEventTip,
  pickStartupTip,
  registerTips,
  resetTipRegistry,
  TIP_MAX_EVENT,
  TIP_MAX_STARTUP,
  type Tip,
} from "../index.js";
import { loadTipCounts, recordTipShow, resetTipCounts, resetTipCountsCache } from "../store.js";
import { setSettings } from "../../settings/engine.js";

// lines.ts registers at module scope — import once and snapshot before any
// resetTipRegistry() runs (the ESM cache means a later import won't re-run it).
await import("../lines.js");
const CONTENT_TIPS = [...listTips()];

const startup = (id: string, maxShows?: number): Tip => ({ id, text: `tip ${id}`, when: "startup", maxShows });
const onEvent = (id: string, event: string, match?: (p: unknown) => boolean, maxShows?: number): Tip => ({
  id,
  text: `tip ${id}`,
  when: { event, match },
  maxShows,
});

beforeEach(() => {
  resetTipRegistry();
  resetTipCounts();
  resetTipCountsCache();
  setSettings("tips", { enabled: true }, "global", process.cwd());
});

// ─── selection ──────────────────────────────────────────────────────────────

test("startup pick: least-shown wins, then least-recent", () => {
  const tips = [startup("a"), startup("b"), startup("c")];
  assert.equal(pickStartupTip(tips, {})?.id, "a");
  // b least-shown after a got one show.
  assert.equal(
    pickStartupTip(tips, { a: { count: 1, last: 100 }, b: { count: 0, last: 0 } })?.id,
    "b",
  );
  // Equal counts → least recently shown.
  assert.equal(
    pickStartupTip(tips, {
      a: { count: 1, last: 50 },
      b: { count: 1, last: 10 },
      c: { count: 1, last: 90 },
    })?.id,
    "b",
  );
});

test("startup maxShows defaults to 3; explicit maxShows overrides", () => {
  const tips = [startup("a"), startup("b", 1)];
  const counts = {
    a: { count: TIP_MAX_STARTUP, last: 1 },
    b: { count: 1, last: 2 },
  };
  assert.equal(pickStartupTip(tips, counts), null, "a exhausted, b exhausted at 1");
  assert.equal(pickStartupTip(tips, { a: { count: 2, last: 1 }, b: { count: 1, last: 2 } })?.id, "a");
});

test("event pick: first matching tip under its cap", () => {
  const tips = [
    onEvent("x", "tool_call", (p) => (p as { toolName?: string }).toolName === "bash"),
    onEvent("y", "tool_call"),
  ];
  assert.equal(pickEventTip(tips, "tool_call", { toolName: "read" }, {})?.id, "y");
  assert.equal(pickEventTip(tips, "tool_call", { toolName: "bash" }, {})?.id, "x");
  assert.equal(pickEventTip(tips, "other_event", {}, {}), null);
  // maxShows default 2 for event tips
  assert.equal(
    pickEventTip(tips, "tool_call", { toolName: "read" }, { y: { count: TIP_MAX_EVENT, last: 0 } }),
    null,
  );
});

// ─── engine ─────────────────────────────────────────────────────────────────

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const unipi = new Map<string, ((payload: unknown) => void)[]>();
  const widgets: Record<string, string[] | undefined> = {};
  const widgetCalls: { name: string; content: string[] | undefined }[] = [];
  const commands: string[] = [];
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      setWidget(name: string, content?: string[]) {
        widgetCalls.push({ name, content });
        widgets[name] = content;
      },
      notify() {},
    },
  };
  const pi = {
    on(name: string, h: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), h]);
    },
    events: {
      on(name: string, h: (payload: unknown) => void) {
        unipi.set(name, [...(unipi.get(name) ?? []), h]);
      },
      emit() {},
    },
    registerCommand(name: string) {
      commands.push(name);
    },
  };
  const fire = async (name: string, event: unknown = {}) => {
    for (const h of handlers.get(name) ?? []) await h(event, ctx);
  };
  const emit = (name: string, payload: unknown = {}) => {
    for (const h of unipi.get(name) ?? []) h(payload);
  };
  return { pi, ctx, handlers, unipi, widgets, widgetCalls, commands, fire, emit };
}

test("startup tip shows once per session; event tip replaces it; input clears", async () => {
  const { pi, ctx, fire, emit, widgetCalls, widgets } = fakePi();
  registerTips("test", [startup("a"), onEvent("e", "unipi:test:event")]);
  installTips(pi as never);
  await fire("session_start");
  const shown = widgetCalls.filter((c) => Array.isArray(c.content));
  assert.equal(shown.length, 1, "one startup tip");
  assert.match(shown[0].content![0]!, /💡 tip a/);

  // Event tip replaces the startup tip — still one widget, new content.
  emit("unipi:test:event", {});
  const after = widgetCalls.filter((c) => Array.isArray(c.content));
  assert.equal(after.length, 2);
  assert.match(after[1].content![0]!, /💡 tip e/);
  assert.equal(loadTipCounts()["e"].count, 1);

  // Next turn input clears the widget.
  await fire("input", { text: "hello" });
  assert.equal(widgets["unipi-tips"], undefined);
});

test("pi-event tips fire via pi.on and respect match()", async () => {
  const { pi, fire, widgetCalls } = fakePi();
  registerTips("test", [
    onEvent("bash-tip", "tool_call", (p) => (p as { toolName?: string }).toolName === "bash"),
  ]);
  installTips(pi as never);
  await fire("session_start");
  await fire("tool_call", { toolName: "read" });
  assert.equal(widgetCalls.filter((c) => Array.isArray(c.content)).length, 0, "no match → no tip");
  await fire("tool_call", { toolName: "bash" });
  assert.equal(widgetCalls.filter((c) => Array.isArray(c.content)).length, 1);
});

test("input-triggered tip survives its own turn, clears on the next input", async () => {
  const { pi, fire, widgetCalls, widgets } = fakePi();
  registerTips("test", [
    onEvent("kb", "input", (p) => String((p as { text?: string }).text ?? "").startsWith("/unipi:kanboard-add")),
  ]);
  installTips(pi as never);
  await fire("session_start");
  await fire("input", { text: "/unipi:kanboard-add thing" });
  assert.ok(widgets["unipi-tips"], "tip shown on the matching input");
  // before_agent_start for that same turn must not wipe it.
  await fire("before_agent_start", {});
  assert.ok(widgets["unipi-tips"], "survives the turn it triggered");
  // …but the next user input clears it (then could re-show on a new match).
  await fire("input", { text: "plain text" });
  assert.equal(widgets["unipi-tips"], undefined);
});

test("tips.enabled=false shows nothing", async () => {
  setSettings("tips", { enabled: false }, "global", process.cwd());
  const { pi, fire, widgetCalls } = fakePi();
  registerTips("test", [startup("a")]);
  installTips(pi as never);
  await fire("session_start");
  assert.equal(widgetCalls.filter((c) => Array.isArray(c.content)).length, 0);
});

test("reset clears show counts so tips are eligible again", () => {
  recordTipShow("a");
  recordTipShow("a");
  recordTipShow("a");
  assert.equal(loadTipCounts()["a"].count, 3);
  assert.equal(pickStartupTip([startup("a")], loadTipCounts()), null, "exhausted");
  resetTipCounts();
  resetTipCountsCache();
  assert.equal(pickStartupTip([startup("a")], loadTipCounts())?.id, "a", "eligible again");
});

test("content module registered grouped tips", () => {
  assert.ok(CONTENT_TIPS.length >= 30, `${CONTENT_TIPS.length} tips`);
  const modules = new Set(CONTENT_TIPS.map((t) => t.module));
  assert.ok(modules.size >= 15, `${modules.size} modules`);
  for (const tip of CONTENT_TIPS) {
    assert.ok(tip.text.length <= 110, `${tip.id} over 110 chars`);
  }
});
