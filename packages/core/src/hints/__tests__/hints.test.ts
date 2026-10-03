/**
 * Unicrab hints engine tests:
 *   - selection (least-shown, learned exclusion, whatsnew-first, per-session cap, same-turn no-replace)
 *   - derived event detectors (context-high, long-bash, 3 errors resetting on success, long-prompt, remember, image-input)
 *   - cycle next/prev (only when: "startup" hints in cycle pool)
 *   - 7-column block crab and widget line width in blocks mode and image mode
 *   - header layout at widths 100, 60 and 30
 *   - exact token teaches matching
 *   - lines integrity test: commands verified against source, category counts met
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  installHints,
  listHints,
  pickEventHint,
  pickNextCycleHint,
  pickStartupHint,
  pickWhatsNewHint,
  registerHints,
  resetHintRegistry,
  renderBlockCrab,
  renderHintLine,
  renderHeaderLines,
  isImageLine,
  HINT_MAX_EVENT,
  HINT_MAX_STARTUP,
  HINT_MAX_SESSION_EVENTS,
  WIDGET_KEY,
  type Hint,
} from "../index.js";
import {
  clearHintStoreFile,
  loadHintStore,
  recordHintLearned,
  recordHintShow,
  resetHintHistory,
  resetHintStoreCache,
  setLastSeenVersion,
} from "../store.js";
import { setSettings } from "../../settings/engine.js";
import { visibleWidth } from "@earendil-works/pi-tui";

// lines.ts registers at module scope — import once and snapshot
await import("../lines.js");
const CONTENT_HINTS = [...listHints()];

const startupHint = (id: string, maxShows?: number): Hint => ({
  id,
  category: "command",
  text: `hint ${id}`,
  when: "startup",
  maxShows,
});

const eventHint = (
  id: string,
  event: string,
  match?: (p: unknown) => boolean,
  maxShows?: number,
): Hint => ({
  id,
  category: "explain",
  text: `hint ${id}`,
  when: { event, match },
  maxShows,
});

beforeEach(() => {
  resetHintRegistry();
  clearHintStoreFile();
  resetHintStoreCache();
  setSettings("hints", { enabled: true, header: true, crab: "blocks" }, "global", process.cwd());
});

// ─── selection rules ────────────────────────────────────────────────────────

test("startup pick: least-shown wins, then least-recent", () => {
  const hints = [startupHint("a"), startupHint("b"), startupHint("c")];
  assert.equal(pickStartupHint(hints, {}, [])?.id, "a");

  // b is least-shown after a got 1 show
  assert.equal(
    pickStartupHint(hints, { a: { count: 1, last: 100 }, b: { count: 0, last: 0 } }, [])?.id,
    "b",
  );

  // Equal counts → least recently shown wins
  assert.equal(
    pickStartupHint(
      hints,
      {
        a: { count: 1, last: 50 },
        b: { count: 1, last: 10 },
        c: { count: 1, last: 90 },
      },
      [],
    )?.id,
    "b",
  );
});

test("startup pick: learned hints are excluded", () => {
  const hints = [startupHint("a"), startupHint("b")];
  assert.equal(pickStartupHint(hints, {}, ["a"])?.id, "b");
  assert.equal(pickStartupHint(hints, {}, ["a", "b"]), null);
});

test("startup pick: lore and whatsnew are excluded from regular startup", () => {
  const hints: Hint[] = [
    { id: "l1", category: "lore", text: "lore text", when: "startup" },
    { id: "w1", category: "whatsnew", text: "whats new", when: "startup", since: "3.0.0" },
    { id: "c1", category: "command", text: "cmd text", when: "startup" },
  ];
  assert.equal(pickStartupHint(hints, {}, [])?.id, "c1");
});

test("startup maxShows defaults to 3; explicit overrides", () => {
  const hints = [startupHint("a"), startupHint("b", 1)];
  const counts = {
    a: { count: HINT_MAX_STARTUP, last: 1 },
    b: { count: 1, last: 2 },
  };
  assert.equal(pickStartupHint(hints, counts, []), null);
  assert.equal(
    pickStartupHint(hints, { a: { count: 2, last: 1 }, b: { count: 1, last: 2 } }, [])?.id,
    "a",
  );
});

test("whatsnew pick: shows hint with since > lastSeen and <= currentVersion", () => {
  const hints: Hint[] = [
    { id: "w1", category: "whatsnew", text: "new feature", when: "startup", since: "3.0.0-alpha.21" },
    { id: "w2", category: "whatsnew", text: "future feature", when: "startup", since: "3.0.0-alpha.25" },
    { id: "w3", category: "whatsnew", text: "old feature", when: "startup", since: "3.0.0-alpha.18" },
  ];

  // From 3.0.0-alpha.20 to 3.0.0-alpha.21
  const picked = pickWhatsNewHint(hints, "3.0.0-alpha.20", "3.0.0-alpha.21", {}, []);
  assert.equal(picked?.id, "w1");

  // Learned whatsnew is excluded
  assert.equal(pickWhatsNewHint(hints, "3.0.0-alpha.20", "3.0.0-alpha.21", {}, ["w1"]), null);
});

test("event pick: first matching event hint under its cap", () => {
  const hints = [
    eventHint("x", "tool_call", (p) => (p as { toolName?: string }).toolName === "bash"),
    eventHint("y", "tool_call"),
  ];
  assert.equal(pickEventHint(hints, "tool_call", { toolName: "read" }, {}, [])?.id, "y");
  assert.equal(pickEventHint(hints, "tool_call", { toolName: "bash" }, {}, [])?.id, "x");
  assert.equal(pickEventHint(hints, "other_event", {}, {}, []), null);

  // default cap 2 for event hints
  assert.equal(
    pickEventHint(hints, "tool_call", { toolName: "read" }, { y: { count: HINT_MAX_EVENT, last: 0 } }, []),
    null,
  );
});

test("cycle pool: cycles only when: 'startup' hints (including lore/whatsnew), never event hints", () => {
  const hints: Hint[] = [
    { id: "c1", category: "command", text: "cmd 1", when: "startup" },
    { id: "l1", category: "lore", text: "lore 1", when: "startup" },
    { id: "w1", category: "whatsnew", text: "new 1", when: "startup", since: "3.0.0" },
    { id: "e1", category: "explain", text: "Memory stored!", when: { event: "unipi:memory:stored" } },
  ];

  // e1 (event hint) must NEVER be picked by cycle
  const picked1 = pickNextCycleHint(hints, null, {}, []);
  assert.equal(picked1?.id, "c1");

  const picked2 = pickNextCycleHint(hints, "c1", {}, []);
  assert.equal(picked2?.id, "l1");

  const picked3 = pickNextCycleHint(hints, "l1", { c1: { count: 1, last: 1 }, l1: { count: 1, last: 2 } }, []);
  assert.equal(picked3?.id, "w1");

  // Even when all startup hints have shows, e1 is still excluded
  const picked4 = pickNextCycleHint(
    hints,
    "w1",
    { c1: { count: 1, last: 1 }, l1: { count: 1, last: 2 }, w1: { count: 1, last: 3 } },
    [],
  );
  assert.equal(picked4?.id, "c1", "cycles back to startup hints, never event hint e1");
});

// ─── fake extension host for engine tests ───────────────────────────────────

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi(opts: { getContextUsage?: () => { percent?: number } } = {}) {
  const handlers = new Map<string, Handler[]>();
  const unipi = new Map<string, ((payload: unknown) => void)[]>();
  const widgets: Record<string, unknown> = {};
  const widgetCalls: { name: string; content: unknown }[] = [];
  let headerComponent: unknown = undefined;
  const shortcuts = new Map<string, { description: string; handler: (ctx: unknown) => Promise<void> }>();
  const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>();

  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    getContextUsage: opts.getContextUsage,
    ui: {
      setWidget(name: string, content?: unknown) {
        widgetCalls.push({ name, content });
        widgets[name] = content;
      },
      setHeader(factory?: (tui: unknown, theme: unknown) => unknown) {
        headerComponent = factory ? factory({}, {}) : undefined;
      },
      notify() {},
      custom() {},
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
      emit(name: string, payload: unknown) {
        for (const h of unipi.get(name) ?? []) h(payload);
      },
    },
    registerShortcut(key: string, options: { description: string; handler: (ctx: unknown) => Promise<void> }) {
      shortcuts.set(key, options);
    },
    registerCommand(name: string, options: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, options);
    },
  };

  const emitPi = (name: string, event: unknown) => {
    for (const h of handlers.get(name) ?? []) h(event, ctx);
  };

  return { pi, ctx, widgets, widgetCalls, emitPi, shortcuts, commands, getHeader: () => headerComponent };
}

// ─── engine behavior ────────────────────────────────────────────────────────

test("startup hint shows at session_start; clears on next input", async () => {
  const { pi, ctx, widgets, emitPi } = fakePi();
  registerHints([startupHint("a")]);

  installHints(pi as never);
  emitPi("session_start", {});

  assert.ok(widgets[WIDGET_KEY], "widget mounted on startup");

  // Next input clears the hint
  emitPi("input", { text: "hello" });
  assert.equal(widgets[WIDGET_KEY], undefined, "cleared on input");
});

test("per-session event cap: max 4 event hints per session", async () => {
  const { pi, ctx, widgets, emitPi } = fakePi();
  registerHints([
    eventHint("e1", "test:ev1", undefined, 5),
    eventHint("e2", "test:ev2", undefined, 5),
    eventHint("e3", "test:ev3", undefined, 5),
    eventHint("e4", "test:ev4", undefined, 5),
    eventHint("e5", "test:ev5", undefined, 5),
  ]);

  installHints(pi as never);
  emitPi("session_start", {});

  for (let i = 1; i <= 4; i++) {
    emitPi("input", { text: `turn ${i}` }); // fresh turn
    pi.events.emit(`test:ev${i}`, {});
    assert.ok(widgets[WIDGET_KEY], `event ${i} showed`);
  }

  // 5th event in a new turn must not show (session cap of 4 reached)
  emitPi("input", { text: "turn 5" });
  widgets[WIDGET_KEY] = undefined;
  pi.events.emit("test:ev5", {});
  assert.equal(widgets[WIDGET_KEY], undefined, "5th event rejected by session cap");
});

test("same-turn no-replace: event hint does not replace already-shown hint", async () => {
  const { pi, ctx, widgets, emitPi } = fakePi();
  registerHints([
    eventHint("e1", "test:ev1"),
    eventHint("e2", "test:ev2"),
  ]);

  installHints(pi as never);
  emitPi("session_start", {});
  emitPi("input", { text: "new turn" });

  pi.events.emit("test:ev1", {});
  const first = widgets[WIDGET_KEY];
  assert.ok(first, "first event hint shown");

  // Second event in the SAME turn
  pi.events.emit("test:ev2", {});
  assert.equal(widgets[WIDGET_KEY], first, "did not replace in same turn");
});

test("teaches exact token match: /unipi:kanboard-add does not mark /unipi:kanboard learned", async () => {
  const { pi, emitPi } = fakePi();
  registerHints([
    {
      id: "cmd.kanboard",
      category: "command",
      text: "/unipi:kanboard text",
      when: "startup",
      teaches: "/unipi:kanboard",
    },
  ]);

  installHints(pi as never);
  emitPi("session_start", {});

  // Substring / prefix command must NOT match
  emitPi("input", { text: "/unipi:kanboard-add my task" });
  assert.equal(loadHintStore().learned.includes("cmd.kanboard"), false, "not learned on different command");

  // Exact command with args MUST match
  emitPi("input", { text: "/unipi:kanboard open" });
  assert.equal(loadHintStore().learned.includes("cmd.kanboard"), true, "learned on exact token match");
});

// ─── derived event detectors ────────────────────────────────────────────────

test("derived event: hints:context-high fires on turn_end when usage >= 70% (once per session)", async () => {
  let percent = 50;
  const { pi, widgets, emitPi } = fakePi({
    getContextUsage: () => ({ percent }),
  });
  registerHints([
    eventHint("ctx-hint", "hints:context-high"),
  ]);

  installHints(pi as never);
  emitPi("session_start", {});

  // Turn 1: 50% → no hint
  emitPi("input", { text: "t1" });
  emitPi("turn_end", {});
  assert.equal(widgets[WIDGET_KEY], undefined);

  // Turn 2: 75% → fires hints:context-high
  emitPi("input", { text: "t2" });
  percent = 75;
  emitPi("turn_end", {});
  assert.ok(widgets[WIDGET_KEY], "context-high hint shown");

  // Turn 3: 85% → should NOT fire again (once per session)
  emitPi("input", { text: "t3" });
  percent = 85;
  widgets[WIDGET_KEY] = undefined;
  emitPi("turn_end", {});
  assert.equal(widgets[WIDGET_KEY], undefined, "context-high only fires once per session");
});

test("derived event: hints:long-bash fires when bash duration >= 30s", async () => {
  const { pi, widgets, emitPi } = fakePi();
  registerHints([
    eventHint("bash-hint", "hints:long-bash"),
  ]);

  installHints(pi as never);
  emitPi("session_start", {});
  emitPi("input", { text: "run bash" });

  const originalNow = Date.now;
  let fakeTime = 1000000;
  Date.now = () => fakeTime;

  try {
    emitPi("tool_execution_start", { toolCallId: "call_1", toolName: "bash" });
    fakeTime += 31000; // 31 seconds later
    emitPi("tool_execution_end", { toolCallId: "call_1", toolName: "bash" });

    assert.ok(widgets[WIDGET_KEY], "long-bash hint shown after >= 30s");
  } finally {
    Date.now = originalNow;
  }
});

test("derived event: hints:tool-errors fires after 3 consecutive errors and resets on success", async () => {
  const { pi, widgets, emitPi } = fakePi();
  registerHints([
    eventHint("err-hint", "hints:tool-errors"),
  ]);

  installHints(pi as never);
  emitPi("session_start", {});
  emitPi("input", { text: "try tools" });

  // 1st error
  emitPi("tool_result", { isError: true });
  assert.equal(widgets[WIDGET_KEY], undefined);

  // 2nd error
  emitPi("tool_result", { isError: true });
  assert.equal(widgets[WIDGET_KEY], undefined);

  // Success resets counter!
  emitPi("tool_result", { isError: false });
  assert.equal(widgets[WIDGET_KEY], undefined);

  // 1st error again
  emitPi("tool_result", { isError: true });
  assert.equal(widgets[WIDGET_KEY], undefined);

  // 2nd error
  emitPi("tool_result", { isError: true });
  assert.equal(widgets[WIDGET_KEY], undefined);

  // 3rd consecutive error → fires!
  emitPi("tool_result", { isError: true });
  assert.ok(widgets[WIDGET_KEY], "tool-errors hint shown on 3rd error");
});

test("derived event: hints:long-prompt fires on long text or 3+ paragraphs", async () => {
  const { pi, widgets, emitPi } = fakePi();
  registerHints([
    eventHint("prompt-hint", "hints:long-prompt"),
  ]);

  installHints(pi as never);
  emitPi("session_start", {});

  // Normal short prompt
  emitPi("input", { text: "quick question" });
  assert.equal(widgets[WIDGET_KEY], undefined);

  // Long prompt (>= 800 chars)
  emitPi("input", { text: "a".repeat(850) });
  assert.ok(widgets[WIDGET_KEY], "long prompt triggered hint");

  // Command input starting with / should not trigger
  widgets[WIDGET_KEY] = undefined;
  emitPi("input", { text: "/" + "a".repeat(850) });
  assert.equal(widgets[WIDGET_KEY], undefined, "slash command ignored");

  // 3 blank-line separated paragraphs
  widgets[WIDGET_KEY] = undefined;
  emitPi("input", { text: "Paragraph 1\n\nParagraph 2\n\nParagraph 3" });
  assert.ok(widgets[WIDGET_KEY], "3-paragraph prompt triggered hint");
});

test("derived event: hints:remember fires when prompt contains remember keyword", async () => {
  const { pi, widgets, emitPi } = fakePi();
  registerHints([
    eventHint("rem-hint", "hints:remember"),
  ]);

  installHints(pi as never);
  emitPi("session_start", {});

  emitPi("input", { text: "Please remember this fact for future turns" });
  assert.ok(widgets[WIDGET_KEY], "remember hint fired");
});

test("derived event: hints:image-input fires when images are attached", async () => {
  const { pi, widgets, emitPi } = fakePi();
  registerHints([
    eventHint("img-hint", "hints:image-input"),
  ]);

  installHints(pi as never);
  emitPi("session_start", {});

  emitPi("input", { text: "look at this", images: [{ type: "image", data: "b64" }] });
  assert.ok(widgets[WIDGET_KEY], "image input hint fired");
});

// ─── widget line width & rendering ──────────────────────────────────────────

test("renderBlockCrab returns exactly 7 columns in truecolor and 256color", () => {
  const tc = renderBlockCrab(true);
  const c256 = renderBlockCrab(false);
  assert.equal(visibleWidth(tc), 7, "truecolor crab glyph is 7 columns wide");
  assert.equal(visibleWidth(c256), 7, "256color crab glyph is 7 columns wide");
});

test("widget line width in blocks mode: visibleWidth(line) <= width", () => {
  const hint: Hint = {
    id: "test",
    category: "command",
    text: "Scuttle over to /unipi:settings for every module's options in one unified panel.",
    when: "startup",
  };

  for (const w of [100, 80, 60, 45, 30]) {
    const lineTc = renderHintLine(hint, w, "blocks", true);
    const line256 = renderHintLine(hint, w, "blocks", false);
    assert.ok(visibleWidth(lineTc) <= w, `TC width ${visibleWidth(lineTc)} <= ${w}`);
    assert.ok(visibleWidth(line256) <= w, `256 width ${visibleWidth(line256)} <= ${w}`);
  }
});

test("widget line in image mode: contains kitty sequence and is recognized as image line", () => {
  const hint: Hint = {
    id: "test",
    category: "command",
    text: "Short hint text.",
    when: "startup",
  };

  const line = renderHintLine(hint, 80, "image", true);
  assert.ok(isImageLine(line), "line is recognized as image line");
  assert.ok(line.includes("\x1b_G"), "line contains kitty graphics escape");
});

// ─── header layout at widths 100, 60 and 30 ─────────────────────────────────

test("header layout: width 100 renders wide 22-col 10-row crab header", () => {
  const lines = renderHeaderLines(100, "3.0.0-alpha.21", "0.87.1", true);
  assert.equal(lines.length, 10, "10 rows rendered");
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 100, `line width ${visibleWidth(line)} <= 100`);
  }
  assert.ok(lines[0].includes("U"), "wordmark present on line 1");
  assert.ok(lines[2].includes("Unicrab"), "greeting present on line 3");
  assert.ok(lines[4].includes("/unipi:settings"), "settings hint on line 5");
  // Lore line on row 8 (Line 9), without "Unicrab: " prefix
  assert.ok(!lines[8].includes("Unicrab:"), "no Unicrab: prefix doubling on lore line");
});

test("header layout: width 60 renders compact 14-col 6-row crab header", () => {
  const lines = renderHeaderLines(60, "3.0.0-alpha.21", "0.87.1", true);
  assert.equal(lines.length, 6, "6 rows rendered");
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 60, `line width ${visibleWidth(line)} <= 60`);
  }
  assert.ok(lines[1].includes("U"), "wordmark present on row 2");
  assert.ok(lines[3].includes("/unipi:settings"), "settings line present on row 4");
});

test("header layout: width 30 returns empty lines (leaves pi built-in header)", () => {
  const lines = renderHeaderLines(30, "3.0.0-alpha.21", "0.87.1", true);
  assert.deepEqual(lines, [], "empty array for terminal under 40 cols");
});

// ─── lines integrity test ───────────────────────────────────────────────────

test("lines integrity: all commands verified against source and category counts met", async () => {
  // Collect all registered command names from packages + autocomplete registry
  const { COMMAND_REGISTRY } = await import("../../../../autocomplete/src/constants.js");
  const registeredCommands = new Set<string>(Object.keys(COMMAND_REGISTRY));

  const repoRoot = fileURLToPath(new URL("../../../../..", import.meta.url));
  const root = join(repoRoot, "packages");
  function scanDir(dir: string) {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        scanDir(full);
      } else if (entry.endsWith(".ts") || entry.endsWith(".js") || entry.endsWith(".mts")) {
        const content = readFileSync(full, "utf-8");
        const matches = content.matchAll(/registerCommand\(\s*["'`]([^"'`]+)["'`]/g);
        for (const m of matches) {
          registeredCommands.add(m[1]);
        }
      }
    }
  }
  scanDir(root);

  // Check every command named in lines.ts
  const commandRegex = /\/unipi:([a-zA-Z0-9_-]+)/g;
  for (const hint of CONTENT_HINTS) {
    assert.ok(hint.text.length <= 105, `Hint text length <= 105 chars: [${hint.id}] is ${hint.text.length}`);

    const matches = hint.text.matchAll(commandRegex);
    for (const m of matches) {
      const fullCmd = `unipi:${m[1]}`;
      assert.ok(
        registeredCommands.has(fullCmd) || fullCmd === "unipi:hint" || fullCmd === "unipi:hint-reset",
        `Unknown command /${fullCmd} in hint ${hint.id}`,
      );
    }
  }

  // Check category counts
  const counts: Record<string, number> = {};
  for (const h of CONTENT_HINTS) {
    counts[h.category] = (counts[h.category] || 0) + 1;
  }

  assert.ok((counts.command ?? 0) >= 20, `command category: ${counts.command} >= 20`);
  assert.ok((counts.shortcut ?? 0) >= 10, `shortcut category: ${counts.shortcut} >= 10`);
  assert.ok((counts.setting ?? 0) >= 10, `setting category: ${counts.setting} >= 10`);
  assert.ok((counts.capability ?? 0) >= 8, `capability category: ${counts.capability} >= 8`);
  assert.ok((counts.explain ?? 0) >= 6, `explain category: ${counts.explain} >= 6`);
  assert.ok((counts.trouble ?? 0) >= 5, `trouble category: ${counts.trouble} >= 5`);
  assert.ok((counts.whatsnew ?? 0) >= 4, `whatsnew category: ${counts.whatsnew} >= 4`);
  assert.ok((counts.workflow ?? 0) >= 8, `workflow category: ${counts.workflow} >= 8`);
  assert.equal(counts.lore, 12, `lore category: ${counts.lore} == 12`);
  assert.ok(CONTENT_HINTS.length >= 75 && CONTENT_HINTS.length <= 90, `total hints in 75..90: ${CONTENT_HINTS.length}`);
});
