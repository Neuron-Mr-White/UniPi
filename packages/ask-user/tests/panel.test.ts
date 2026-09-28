/**
 * The ask panel behaves like Devin's question UI: digits pick, typing on
 * "Other" needs no Enter, ←→ switch questions, Enter advances and submits,
 * skipped questions never block, "?" asks to clarify, Esc cancels.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AskPanel, type PanelResult } from "../ask-ui.ts";
import { answersText, clarifyText, deriveHeader, prepareArgs } from "../questions.ts";
import { renderAskResult } from "../tools.ts";

const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
const tui = { requestRender: () => {}, terminal: { columns: 100, rows: 40 } } as never;
const UP = "\x1b[A", DOWN = "\x1b[B", LEFT = "\x1b[D", RIGHT = "\x1b[C", ENTER = "\r", ESC = "\x1b";

const QS = prepareArgs({
  questions: [
    { question: "Which planet?", header: "Planet", options: [{ label: "Mars", description: "red" }, { label: "Saturn" }] },
    { question: "Which foods?", header: "Foods", multi_select: true, options: [{ label: "Pizza" }, { label: "Sushi" }, { label: "Tacos" }] },
    { question: "Last book?", header: "Last book", options: [{ label: "Can't remember" }, { label: "Don't read" }] },
  ],
}).questions;

function panel(clipboard: () => string | undefined = () => undefined) {
  let result: PanelResult | undefined;
  const p = new AskPanel(tui, theme, QS, (r) => (result = r), clipboard);
  const keys = (...ks: string[]) => ks.forEach((k) => p.handleInput(k));
  const text = () => p.render(100).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  return { p, keys, text, get result() { return result; } };
}

describe("ask panel", () => {
  it("renders Devin's layout: chips, numbered rows, Other, hint and help line", () => {
    const h = panel();
    const t = h.text();
    assert.match(t, /^── Planet · Foods · Last book ─+/);
    assert.match(t, /❭ 1 Mars\n {6}red\n {4}2 Saturn\n {6}Other \(type your own\)/);
    assert.match(t, /↑↓ navigate · ↵ select · ←→ switch question · \? help me out · esc cancel/);
    assert.match(t, /\? Not ready to answer, help me out!/);
  });

  it("digits pick and advance; space/digits toggle in multi; Enter submits on the last", () => {
    const h = panel();
    h.keys("2"); // Saturn → next
    assert.match(h.text(), /Planet ✓ · Foods/);
    h.keys("1", "3"); // Pizza, Tacos
    assert.match(h.text(), /Foods 2/);
    h.keys(ENTER); // → Last book
    h.keys(DOWN, DOWN); // Other
    h.keys(..."Dune".split(""));
    h.keys(ENTER);
    assert.equal(h.result?.type, "answered");
    if (h.result?.type !== "answered") return;
    assert.deepEqual(h.result.answers, [
      { selected: ["Saturn"], skipped: false },
      { selected: ["Pizza", "Tacos"], skipped: false },
      { selected: [], custom_text: "Dune", skipped: false },
    ]);
  });

  it("typing on Other needs no Enter, hides the numbers, and the text stays editable", () => {
    const h = panel();
    h.keys(DOWN, DOWN, ..."Jupiter moon".split(""));
    const t = h.text();
    assert.match(t, /❭ Other \(type your own\)\n {4}└ Jupiter moon/);
    assert.doesNotMatch(t, /1 Mars/, "numbers hidden while typing so digits are text");
    h.keys(LEFT, LEFT, "X"); // ←→ move the text cursor when there is text
    h.keys(UP); // leave Other: the text is kept
    assert.match(h.text(), /3 Other \(type your own\)\n {6}└ Jupiter moXon/);
    h.keys(DOWN, "\x7f"); // back on Other, backspace edits (cursor after the X)
    assert.match(h.text(), /└ Jupiter moon/);
  });

  it("skipping never blocks: →, → then Enter submits with skipped answers", () => {
    const h = panel();
    h.keys(RIGHT, RIGHT, ENTER); // on Last book, Enter picks "Can't remember"
    assert.equal(h.result?.type, "answered");
    if (h.result?.type !== "answered") return;
    assert.equal(h.result.answers[0]!.skipped, true);
    assert.equal(h.result.answers[1]!.skipped, true);
    assert.deepEqual(h.result.answers[2]!.selected, ["Can't remember"]);
    const text = answersText(QS, h.result.answers);
    assert.match(text, /"Which planet\?": \{\s*"selected": \[\],\s*"skipped": true/);
    assert.match(text, /left unanswered on purpose/);
  });

  it("? asks to clarify; Esc cancels", () => {
    const h = panel();
    h.keys("?");
    assert.equal(h.result?.type, "clarify");
    assert.match(clarifyText(QS, (h.result as { answers: never }).answers), /not ready to answer.*\n.*\nQuestions asked:\n- "Which planet\?"\n {2}\(No answer provided\)/);
    const c = panel();
    c.keys(ESC);
    assert.equal(c.result?.type, "cancel");
  });

  it("a pasted or Ctrl+V'd image path becomes [Image #1] in Other", () => {
    const dir = mkdtempSync(join(tmpdir(), "ask-img-"));
    const png = join(dir, "shot.png");
    writeFileSync(png, Buffer.from("89504e47", "hex"));
    const h = panel(() => png);
    h.keys(`\x1b[200~look at ${png}\x1b[201~`); // pasting jumps to Other
    assert.match(h.text(), /└ look at \[Image #1\]/);
    assert.match(h.text(), /\[Image #1\] shot\.png/);
    h.keys("\x16"); // Ctrl+V — same file again reuses the token
    h.keys(ENTER, ENTER, ENTER);
    assert.equal(h.result?.type, "answered");
    if (h.result?.type === "answered") assert.equal(h.result.attachments.length, 1);
  });
});

describe("questions", () => {
  it("converts the legacy single-question call and folds the context in", () => {
    const { questions } = prepareArgs({ question: "Which database?", context: "We need JSON.", options: [{ label: "Postgres" }, "SQLite"], allowMultiple: true, allowFreeform: false, timeout: 5000 });
    assert.equal(questions.length, 1);
    assert.equal(questions[0]!.question, "We need JSON.\n\nWhich database?");
    assert.equal(questions[0]!.multi_select, true);
    assert.equal(questions[0]!.other, false);
    assert.deepEqual(questions[0]!.options.map((o) => o.label), ["Postgres", "SQLite"]);
    assert.equal(questions[0]!.header, "Database");
  });
  it("caps at 4 questions and derives missing headers", () => {
    const { questions } = prepareArgs({ questions: Array.from({ length: 6 }, (_, i) => ({ question: `Question number ${i}?`, options: [] })) });
    assert.equal(questions.length, 4);
    assert.equal(deriveHeader("What is your preferred time of day?", 0), "Preferred Time");
  });
  it("renders the transcript tree", () => {
    const text = renderAskResult({ questions: QS, answers: [{ selected: ["Mars"], skipped: false }, { selected: [], skipped: true }, { selected: [], custom_text: "Dune", skipped: false }], outcome: "answered" }, theme).render(100).join("\n");
    assert.match(text.replace(/ +\n/g, "\n"), /● Asked user 3 questions\n │ Planet: Mars\n │ Foods: \(skipped\)\n └ Last book: Dune/);
  });
});

describe("settings", () => {
  it("Esc = send submits what's answered; digits can pick without moving on; the help line can be hidden", () => {
    let result: PanelResult | undefined;
    const p = new AskPanel(tui, theme, QS, (r) => (result = r), () => undefined, { escape: "send", digitAdvance: false, helpLine: false });
    const text = () => p.render(100).join("\n");
    assert.doesNotMatch(text(), /Not ready to answer/);
    assert.match(text(), /esc send/);
    p.handleInput("2"); // Saturn picked, still on Planet
    assert.match(text(), /Which planet\?/);
    p.handleInput("\x1b");
    assert.equal(result?.type, "answered");
    if (result?.type === "answered") {
      assert.deepEqual(result.answers[0], { selected: ["Saturn"], skipped: false });
      assert.equal(result.answers[1]!.skipped, true);
    }
  });

  it("the user's Other and max-questions settings win over the agent", async () => {
    const { applySettings } = await import("../tools.ts");
    const { DEFAULT_SETTINGS } = await import("../config.ts");
    const qs = prepareArgs({ questions: [
      { question: "a?", header: "A", options: [{ label: "x" }], other: false },
      { question: "b?", header: "B", options: [{ label: "y" }] },
      { question: "c?", header: "C", options: [] },
    ] }).questions;
    assert.equal(applySettings(qs, { ...DEFAULT_SETTINGS, other: "always" })[0]!.other, undefined);
    assert.equal(applySettings(qs, { ...DEFAULT_SETTINGS, other: "never" })[1]!.other, false);
    assert.equal(applySettings(qs, { ...DEFAULT_SETTINGS, other: "never" })[2]!.other, undefined, "a question with no options keeps Other");
    assert.equal(applySettings(qs, { ...DEFAULT_SETTINGS, maxQuestions: 2 }).length, 2);
  });
});
