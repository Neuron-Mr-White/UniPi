import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  WorkTray,
  pickInitialTab,
  renderTabStrip,
  renderTrayStrip,
  registerWorkTrayTab,
  openWorkTray,
  isWorkTrayOpen,
  workTrayItemCount,
  editorIdleFor,
  resetWorkTrayForTests,
  workTrayInputForTests,
  type WorkTrayTab,
  type WorkTrayPane,
} from "../tray.js";
import { resetWorkChangesForTests } from "../index.js";

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as never;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const DOWN = "\x1b[B";

interface FakePane extends WorkTrayPane {
  keys: string[];
  disposed: boolean;
  arrows: boolean;
  initialId?: string;
}

function tab(id: string, order: number, total: number, running = 0, extra: Partial<WorkTrayTab> = {}): WorkTrayTab & { panes: FakePane[] } {
  const panes: FakePane[] = [];
  return {
    id,
    label: id === "bg" ? "Background tasks" : "Subagents",
    shortLabel: id === "bg" ? "Bg tasks" : undefined,
    order,
    counts: () => ({ total, running }),
    createPane: ({ initialId, close }) => {
      const pane: FakePane = {
        keys: [],
        disposed: false,
        arrows: false,
        initialId,
        render: () => [`pane:${id}${initialId ? `:${initialId}` : ""}`],
        invalidate() {},
        handleInput(d: string) {
          pane.keys.push(d);
          if (d === "q") close();
        },
        capturesArrows: () => pane.arrows,
        dispose() {
          pane.disposed = true;
        },
      };
      panes.push(pane);
      return pane;
    },
    panes,
    ...extra,
  };
}

const tui = () => ({ renders: 0, requestRender() { this.renders++; } }) as never;

beforeEach(() => {
  resetWorkTrayForTests();
  resetWorkChangesForTests();
});
afterEach(() => {
  resetWorkTrayForTests();
  resetWorkChangesForTests();
});

describe("pickInitialTab", () => {
  test("Background tasks by default, even when both are empty", () => {
    assert.equal(pickInitialTab([tab("bg", 0, 0), tab("subagents", 1, 0)]), 0);
    assert.equal(pickInitialTab([tab("bg", 0, 2), tab("subagents", 1, 3)]), 0);
  });
  test("skips an empty first tab when a later one has items", () => {
    assert.equal(pickInitialTab([tab("bg", 0, 0), tab("subagents", 1, 3)]), 1);
  });
  test("an explicit tab wins; unknown ids fall back", () => {
    assert.equal(pickInitialTab([tab("bg", 0, 2), tab("subagents", 1, 0)], "subagents"), 1);
    assert.equal(pickInitialTab([tab("bg", 0, 2), tab("subagents", 1, 0)], "nope"), 0);
  });
});

describe("renderTabStrip", () => {
  const list = [tab("bg", 0, 19, 19), tab("subagents", 1, 5, 1)];
  test("counts in headers + key hint on wide terminals", () => {
    const line = strip(renderTabStrip(theme, list, 0, 200));
    assert.match(line, /Background tasks \(19 · 19 running\)/);
    assert.match(line, /Subagents \(5 · 1 running\)/);
    assert.match(line, /←→ tabs · esc close/);
    assert.equal(visibleWidth(line), 200);
  });
  test("active tab is drawn inverse", () => {
    const raw = renderTabStrip(theme, list, 1, 200);
    assert.match(raw, /\x1b\[7m Subagents/);
    assert.doesNotMatch(raw, /\x1b\[7m Background/);
  });
  test("narrow: hint drops, then short labels, then compact counts; never wider than the pane", () => {
    for (const w of [80, 50, 30, 20]) {
      const line = strip(renderTabStrip(theme, list, 0, w));
      assert.ok(visibleWidth(line) <= w, `w=${w}: ${line}`);
    }
    assert.doesNotMatch(strip(renderTabStrip(theme, list, 0, 80)), /tabs · esc/);
    assert.match(strip(renderTabStrip(theme, list, 0, 50)), /Bg tasks/);
    assert.match(strip(renderTabStrip(theme, list, 0, 36)), /Bg tasks 19\/19 │ Subagents 5\/1/);
  });
  test("no running → no running suffix", () => {
    assert.match(strip(renderTabStrip(theme, [tab("bg", 0, 2)], 0, 120)), /Background tasks \(2\)/);
  });
});

describe("renderTrayStrip", () => {
  test("nothing → no line; open tray → no line", () => {
    assert.deepEqual(renderTrayStrip(theme, [tab("bg", 0, 0), tab("subagents", 1, 0)], 120), []);
    assert.deepEqual(renderTrayStrip(theme, [tab("bg", 0, 2)], 120, true), []);
  });
  test("one line naming every non-empty tab + previews; one column short of the width", () => {
    const sub = tab("subagents", 1, 3, 2, { previewLines: () => ["  ⠋ Explore · 3s", "  ⠋ General · 9s"] });
    const lines = renderTrayStrip(theme, [tab("bg", 0, 0), sub], 120).map(strip);
    assert.deepEqual(lines, ["◆ Subagents 3 (2 running) · ↓ open", "  ⠋ Explore · 3s", "  ⠋ General · 9s"]);
    const both = renderTrayStrip(theme, [tab("bg", 0, 2, 1), sub], 120).map(strip);
    assert.equal(both[0], "◆ Background tasks 2 (1 running) · Subagents 3 (2 running) · ↓ open");
    for (const w of [10, 40, 80]) for (const l of renderTrayStrip(theme, [tab("bg", 0, 2, 1), sub], w)) assert.ok(visibleWidth(l) < w);
  });
  test("narrow: short labels before truncation", () => {
    const line = strip(renderTrayStrip(theme, [tab("bg", 0, 19, 19), tab("subagents", 1, 5, 1)], 50)[0]!);
    assert.equal(line, "◆ Bg tasks 19 (19) · Subagents 5 (1) · ↓ open");
  });
  test("a throwing preview never hides the strip", () => {
    const bad = tab("subagents", 1, 1, 1, { previewLines: () => { throw new Error("boom"); } });
    assert.equal(renderTrayStrip(theme, [bad], 80).length, 1);
  });
});

describe("WorkTray", () => {
  test("←/→ switch tabs (wrapping); other keys reach the active pane; panes keep state across switches", () => {
    const bg = tab("bg", 0, 1);
    const sa = tab("subagents", 1, 1);
    let closed = 0;
    const tray = new WorkTray(tui(), theme, [bg, sa], () => closed++);
    assert.match(strip(tray.render(120)[0]!), /\x1b?.*Background tasks/);
    assert.equal(tray.render(120)[1], "pane:bg");
    tray.handleInput("j");
    assert.deepEqual(bg.panes[0]!.keys, ["j"]);
    tray.handleInput(RIGHT);
    assert.equal(tray.activeTabId(), "subagents");
    assert.equal(tray.render(120)[1], "pane:subagents");
    tray.handleInput(RIGHT);
    assert.equal(tray.activeTabId(), "bg", "wraps");
    tray.handleInput(LEFT);
    assert.equal(tray.activeTabId(), "subagents");
    tray.handleInput(LEFT);
    assert.equal(bg.panes.length, 1, "bg pane reused, not recreated");
    assert.equal(closed, 0);
    tray.dispose();
    assert.equal(bg.panes[0]!.disposed, true);
    assert.equal(sa.panes[0]!.disposed, true);
  });

  test("a pane that captures arrows (detail view) gets ←/→ instead of the tray", () => {
    const bg = tab("bg", 0, 1);
    const tray = new WorkTray(tui(), theme, [bg, tab("subagents", 1, 1)], () => {});
    tray.render(100);
    bg.panes[0]!.arrows = true;
    tray.handleInput(LEFT);
    tray.handleInput(RIGHT);
    assert.equal(tray.activeTabId(), "bg");
    assert.deepEqual(bg.panes[0]!.keys, [LEFT, RIGHT]);
    tray.dispose();
  });

  test("pane close closes the tray once; initial item reaches the pane; select() reopens on an item", () => {
    const bg = tab("bg", 0, 1);
    const sa = tab("subagents", 1, 1);
    let closed = 0;
    const tray = new WorkTray(tui(), theme, [bg, sa], () => closed++, { tab: "subagents", initialId: "a1" });
    assert.equal(tray.render(100)[1], "pane:subagents:a1");
    tray.select("bg", "b7");
    assert.equal(tray.render(100)[1], "pane:bg:b7");
    tray.handleInput("q");
    tray.close();
    assert.equal(closed, 1);
    tray.dispose();
  });

  test("lines never exceed the width", () => {
    const tray = new WorkTray(tui(), theme, [tab("bg", 0, 1)], () => {});
    for (const w of [20, 50, 80]) for (const l of tray.render(w)) assert.ok(visibleWidth(l) <= w);
    tray.dispose();
  });
});

describe("↓ handler + registration", () => {
  function fakePi() {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    return { on: (e: string, h: (...a: unknown[]) => unknown) => handlers.set(e, h), handlers };
  }
  const editor = (text: string, auto = false) => ({ getFocusedComponent: () => ({ getText: () => text, isShowingAutocomplete: () => auto }) });

  test("editorIdleFor: only an empty, non-autocompleting editor", () => {
    assert.equal(editorIdleFor(editor("")), true);
    assert.equal(editorIdleFor(editor("abc")), false);
    assert.equal(editorIdleFor(editor("", true)), false);
    assert.equal(editorIdleFor({ getFocusedComponent: () => ({ render() {} }) }), false, "a dialog is focused");
    assert.equal(editorIdleFor(undefined), false);
  });

  test("↓ opens the tray only with items and an idle editor; other keys pass through", async () => {
    const pi = fakePi();
    let total = 0;
    registerWorkTrayTab(pi as never, { ...tab("bg", 0, 0), counts: () => ({ total, running: 0 }) });
    assert.equal(workTrayItemCount(), 0);
    let opened = 0;
    let finish: (() => void) | undefined;
    const ctx = {
      hasUI: true,
      ui: {
        custom: (factory: (t: unknown, th: unknown, kb: unknown, done: () => void) => unknown) =>
          new Promise<void>((resolve) => {
            opened++;
            finish = () => resolve();
            factory(tui(), theme, {}, () => resolve());
          }),
      },
    } as never;
    assert.equal(workTrayInputForTests(DOWN, ctx, editor("")), undefined, "no items → editor keeps ↓");
    total = 2;
    assert.equal(workTrayInputForTests(DOWN, ctx, editor("hi")), undefined, "text in the editor → history/cursor ↓");
    assert.equal(workTrayInputForTests(LEFT, ctx, editor("")), undefined, "← never stolen from the editor");
    assert.equal(workTrayInputForTests(RIGHT, ctx, editor("")), undefined, "→ never stolen from the editor");
    assert.deepEqual(workTrayInputForTests(DOWN, ctx, editor("")), { consume: true });
    await Promise.resolve();
    assert.equal(opened, 1);
    assert.equal(isWorkTrayOpen(), true);
    assert.equal(workTrayInputForTests(DOWN, ctx, editor("")), undefined, "already open → the tray handles ↓ itself");
    finish?.();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(isWorkTrayOpen(), false);
  });

  test("openWorkTray while open switches tab instead of stacking a second pane", async () => {
    const pi = fakePi();
    const bg = tab("bg", 0, 1);
    const sa = tab("subagents", 1, 1);
    registerWorkTrayTab(pi as never, bg);
    registerWorkTrayTab(pi as never, sa);
    let customs = 0;
    let tray: WorkTray | undefined;
    let done: (() => void) | undefined;
    const ctx = {
      hasUI: true,
      ui: {
        custom: (factory: (t: unknown, th: unknown, kb: unknown, d: () => void) => unknown) =>
          new Promise<void>((resolve) => {
            customs++;
            done = () => resolve();
            tray = factory(tui(), theme, {}, () => resolve()) as WorkTray;
          }),
      },
    } as never;
    const first = openWorkTray(ctx);
    await Promise.resolve();
    assert.equal(tray?.activeTabId(), "bg");
    await openWorkTray(ctx, { tab: "subagents", initialId: "x1" });
    assert.equal(customs, 1);
    assert.equal(tray?.activeTabId(), "subagents");
    assert.equal(tray?.render(100)[1], "pane:subagents:x1");
    done?.();
    await first;
  });

  test("session_start installs the strip widget + input hook once per api; no UI → nothing", () => {
    const pi = fakePi();
    registerWorkTrayTab(pi as never, tab("bg", 0, 1));
    registerWorkTrayTab(pi as never, tab("subagents", 1, 1));
    const widgets: string[] = [];
    let inputs = 0;
    const start = pi.handlers.get("session_start")!;
    start({}, { hasUI: true, ui: { setWidget: (k: string) => widgets.push(k), onTerminalInput: () => (inputs++, () => {}) } });
    assert.deepEqual(widgets, ["work-tray-strip"]);
    assert.equal(inputs, 1);
    start({}, { hasUI: false, ui: {} });
    assert.equal(inputs, 1);
  });

  test("unregister removes only its own tab", () => {
    const pi = fakePi();
    const off = registerWorkTrayTab(pi as never, tab("bg", 0, 2));
    registerWorkTrayTab(pi as never, tab("subagents", 1, 3));
    assert.equal(workTrayItemCount(), 5);
    off();
    assert.equal(workTrayItemCount(), 3);
  });
});
