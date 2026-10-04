/**
 * The plan review overlay shows the plan (rendered markdown, scrollable) and
 * resolves to approve / keep / discard; wide overlays render the two plan
 * sections side by side (Tab switches panes), narrow ones stack them behind one
 * scroll, and plans without both sections fall back to the single pane.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { renderPlanReview, splitPlan } from "../src/plan/review.js";
import { approvePlan } from "../src/plan/index.js";
import { PLAN_STATE_ENTRY, activePlanFile, resetPlanState, restorePlanState } from "../src/plan/state.js";

initTheme("dark");
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const theme = {
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
};

const PLAN = [
  "# PIT-23 — choose the analytics vendor",
  "",
  "## Summary",
  "Pick a privacy-friendly vendor and record the decision.",
  "",
  "## Steps",
  ...Array.from({ length: 40 }, (_, i) => `${i + 1}. step number ${i + 1}`),
  "",
  "## Verification",
  "The decision is noted on PIT-23.",
].join("\n");

const SPLIT_PLAN = [
  "# PIT-23 — choose the analytics vendor",
  "",
  "## Summary",
  "Pick a privacy-friendly vendor and record the decision.",
  "",
  "## Implementation",
  "### Steps",
  ...Array.from({ length: 40 }, (_, i) => `${i + 1}. step number ${i + 1}`),
  "",
  "### Verification",
  "The decision is noted on PIT-23.",
].join("\n");

function mount(rows = 30, plan: string = PLAN) {
  let renders = 0;
  let result: string | null | undefined;
  const tui = { terminal: { rows, columns: 100 }, requestRender: () => void renders++ };
  const component = renderPlanReview({ plan, path: "docs/plans/x.md" })(tui as never, theme as never, {}, (choice) => {
    result = choice;
  });
  return {
    component,
    get result() {
      return result;
    },
    text: (width = 100) => component.render(width).map(strip).join("\n"),
  };
}

describe("splitPlan", () => {
  it("splits at the two top-level headings and strips them", () => {
    const parts = splitPlan(SPLIT_PLAN);
    assert.ok(parts);
    assert.match(parts.summary, /privacy-friendly vendor/);
    assert.doesNotMatch(parts.summary, /## Summary/);
    assert.match(parts.implementation, /### Steps/);
    assert.doesNotMatch(parts.implementation, /## Implementation/);
  });

  it("keeps a document title with the summary", () => {
    assert.match(splitPlan(SPLIT_PLAN)!.summary, /PIT-23 — choose the analytics vendor/);
  });

  it("is null when either section is missing or out of order", () => {
    assert.equal(splitPlan(PLAN), null, "old-format plan without ## Implementation");
    assert.equal(splitPlan("## Implementation\n### Steps\n1. x"), null, "missing Summary");
    assert.equal(splitPlan("## Implementation\nx\n## Summary\ny"), null, "wrong order");
  });
});

describe("plan review overlay", () => {
  it("shows the plan itself, the path and the three choices", () => {
    const view = mount();
    const text = view.text();
    assert.match(text, /Review plan/);
    assert.match(text, /docs\/plans\/x\.md/);
    assert.match(text, /choose the analytics vendor/);
    assert.match(text, /Pick a privacy-friendly vendor/);
    assert.match(text, /1 Approve & implement/);
    assert.match(text, /2 Keep planning…/);
    assert.match(text, /3 Discard plan/);
    assert.match(text, /more lines/, "a long plan says how much is below");
  });

  it("every line is exactly the given width", () => {
    const view = mount();
    for (const line of view.component.render(100)) {
      assert.equal(strip(line).length, 100, JSON.stringify(strip(line)));
    }
  });

  it("scrolls to the end of a long plan", () => {
    const view = mount();
    assert.doesNotMatch(view.text(), /The decision is noted/);
    view.component.handleInput("G");
    assert.match(view.text(), /The decision is noted on PIT-23/);
    assert.match(view.text(), /end of plan/);
    view.component.handleInput("g");
    assert.match(view.text(), /choose the analytics vendor/);
  });

  it("Enter approves by default; arrows move the choice; digits pick directly; Esc keeps planning", () => {
    const enter = mount();
    enter.component.handleInput("\r");
    assert.equal(enter.result, "approve");

    const right = mount();
    right.component.handleInput("\x1b[C"); // →
    right.component.handleInput("\r");
    assert.equal(right.result, "keep");

    const three = mount();
    three.component.handleInput("3");
    assert.equal(three.result, "discard");

    const esc = mount();
    esc.component.handleInput("\x1b");
    assert.equal(esc.result, null);
  });
});

describe("plan review layouts", () => {
  it("wide: the two sections render side by side, every line width-exact", () => {
    const view = mount(30, SPLIT_PLAN);
    const lines = view.component.render(140).map(strip);
    for (const line of lines) assert.equal(line.length, 140, JSON.stringify(line));
    const text = lines.join("\n");
    assert.match(text, /Pick a privacy-friendly vendor/, "summary text is on screen");
    assert.match(text, /step number/, "implementation text is on screen");
    assert.ok(
      lines.some((line) => line.includes("Summary") && line.includes("Implementation")),
      "the pane titles share one row",
    );
  });

  it("wide: Tab switches the focused pane, which the scroll hint names", () => {
    const view = mount(30, SPLIT_PLAN);
    assert.match(view.text(140), /Summary — end of plan/);
    view.component.handleInput("\t");
    const text = view.text(140);
    assert.match(text, /Implementation ↓ \d+ more lines/, "focus moved to the long implementation pane");
    assert.doesNotMatch(text, /Summary — end of plan/);
  });

  it("wide: scrolling keys hit the focused pane", () => {
    const view = mount(30, SPLIT_PLAN);
    assert.doesNotMatch(view.text(140), /The decision is noted on PIT-23/);
    view.component.handleInput("\t"); // focus implementation
    view.component.handleInput("G");
    const text = view.text(140);
    assert.match(text, /The decision is noted on PIT-23/);
    assert.match(text, /Implementation — end of plan/);
    view.component.handleInput("g");
    assert.doesNotMatch(view.text(140), /The decision is noted on PIT-23/);
  });

  it("wide: the choices still work and Tab no longer cycles them", () => {
    const view = mount(30, SPLIT_PLAN);
    view.component.handleInput("\x1b[C"); // →
    view.component.handleInput("\r");
    assert.equal(view.result, "keep");

    const tab = mount(30, SPLIT_PLAN);
    tab.component.handleInput("\t");
    tab.component.handleInput("\r");
    assert.equal(tab.result, "approve", "Tab switched panes, not the choice");
  });

  it("narrow: the sections stack behind one scroll, every line width-exact", () => {
    const view = mount(30, SPLIT_PLAN);
    const lines = view.component.render(80).map(strip);
    for (const line of lines) assert.equal(line.length, 80, JSON.stringify(line));
    const text = lines.join("\n");
    assert.match(text, /Summary/);
    assert.match(text, /Implementation/);
    assert.match(text, /Pick a privacy-friendly vendor/);
    view.component.handleInput("G");
    assert.match(view.text(80), /The decision is noted on PIT-23/, "one scroll reaches the end");
  });

  it("fallback: without both sections the single pane stays, width-exact", () => {
    const view = mount(30, PLAN);
    const lines = view.component.render(140).map(strip);
    for (const line of lines) assert.equal(line.length, 140, JSON.stringify(line));
    const text = lines.join("\n");
    assert.match(text, /Pick a privacy-friendly vendor/);
    assert.match(text, /step number/);
    assert.doesNotMatch(text, /Summary.*Implementation/);
  });
});

describe("approvePlan uses the review overlay", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "plan-review-"));
    const sessionId = `review-${Math.random().toString(36).slice(2)}`;
    const planFile = activePlanFile(dir, sessionId);
    writeFileSync(planFile, PLAN);
    restorePlanState(sessionId, [{ customType: PLAN_STATE_ENTRY, data: { active: true, planFile } }], dir);
    return { dir, sessionId };
  }

  it("the overlay's approve sends the plan to implement", async () => {
    const { dir, sessionId } = setup();
    const sent: string[] = [];
    let rendered = "";
    const ctx = {
      cwd: dir,
      hasUI: true,
      sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
      ui: {
        async custom(factory: (...args: unknown[]) => { render(w: number): string[]; handleInput(d: string): void }) {
          return new Promise((resolve) => {
            const component = factory({ terminal: { rows: 40 }, requestRender() {} }, theme, {}, resolve);
            rendered = component.render(100).map(strip).join("\n");
            component.handleInput("\r");
          });
        },
        async select() {
          throw new Error("select must not be used when custom is available");
        },
        async input() {
          return undefined;
        },
        notify() {},
      },
    };
    const pi = { sendUserMessage: (text: string) => sent.push(text), sendMessage() {}, appendEntry() {}, events: { emit() {} } };
    const result = await approvePlan(pi as never, ctx as never, sessionId);
    assert.equal(result.status, "approved");
    assert.match(rendered, /choose the analytics vendor/, "the user saw the plan before approving");
    assert.match(sent[0] ?? "", /Implement the approved plan/);
    resetPlanState(sessionId);
  });

  it("falls back to select (with the plan path) when custom UI is unavailable", async () => {
    const { dir, sessionId } = setup();
    let title = "";
    const ctx = {
      cwd: dir,
      hasUI: true,
      sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
      ui: {
        async select(t: string) {
          title = t;
          return undefined;
        },
        async input() {
          return undefined;
        },
        notify() {},
      },
    };
    const pi = { sendUserMessage() {}, sendMessage() {}, appendEntry() {}, events: { emit() {} } };
    const result = await approvePlan(pi as never, ctx as never, sessionId);
    assert.equal(result.status, "keep");
    assert.match(title, /Plan ready \(.*docs\/plans\/.*\.md\)/);
    resetPlanState(sessionId);
  });
});
