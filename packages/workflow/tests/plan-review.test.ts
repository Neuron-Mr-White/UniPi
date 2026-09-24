/**
 * The plan review overlay shows the plan (rendered markdown, scrollable) and
 * resolves to approve / keep / discard; approvePlan uses it when the UI can host
 * custom components and still falls back to select otherwise.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { renderPlanReview } from "../src/plan/review.js";
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

function mount(rows = 30) {
  let renders = 0;
  let result: string | null | undefined;
  const tui = { terminal: { rows, columns: 100 }, requestRender: () => void renders++ };
  const component = renderPlanReview({ plan: PLAN, path: "docs/plans/x.md" })(tui as never, theme as never, {}, (choice) => {
    result = choice;
  });
  return { component, get result() { return result; }, text: () => component.render(100).map(strip).join("\n") };
}

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

  it("every line fits the width", () => {
    const view = mount();
    for (const line of view.component.render(100)) assert.ok(strip(line).length <= 100, strip(line));
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
