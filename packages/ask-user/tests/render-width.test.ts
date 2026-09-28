/**
 * Width invariant: pi-tui's differential renderer throws when a rendered line
 * is wider than the terminal, taking the whole agent down. For every width,
 * every line of the ask panel and the launcher must fit.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";

import { AskPanel } from "../ask-ui.ts";
import { renderLauncherUI } from "../launcher-ui.ts";
import { prepareArgs } from "../questions.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  colors: {},
} as never;
const tui = { requestRender: () => {}, terminal: { columns: 80, rows: 24 } } as never;
const keybindings = {} as never;

const QUESTIONS = prepareArgs({
  questions: [
    {
      question: "Use the REST daemon and auto-spawn it when it is not running, or keep the old in-process store? 🚀",
      header: "Daemon",
      options: [
        { label: "REST daemon, auto-spawned", description: "A deliberately long description so wrapping and truncation are exercised at every width." },
        { label: "Short" },
        { label: "Emoji label 🚀 and more", description: "Another description with an emoji 🧹 to stress width math." },
      ],
    },
    { question: "Pick some", header: "Several", multi_select: true, options: [{ label: "a" }, { label: "b" }] },
  ],
}).questions;

const WIDTHS = Array.from({ length: 200 }, (_, i) => i + 1);

function assertFits(lines: string[], width: number, label: string): void {
  lines.forEach((line, i) => {
    const w = visibleWidth(line);
    assert.ok(w <= width, `${label}: line ${i} is ${w} columns at terminal width ${width}. Line: ${JSON.stringify(line)}`);
  });
}

describe("ask panel render width invariant", () => {
  it("never renders a line wider than the terminal, in every state", () => {
    for (const width of WIDTHS) {
      const panel = new AskPanel(tui, theme, QUESTIONS, () => {}, () => undefined);
      assertFits(panel.render(width), width, "ask panel");
      for (const key of ["\x1b[B", "\x1b[B", "\x1b[B", "x", "y"]) panel.handleInput(key); // → Other, typing
      assertFits(panel.render(width), width, "ask panel on Other");
      panel.handleInput("\t");
      assertFits(panel.render(width), width, "ask panel multi");
    }
  });

  it("does not throw on zero, negative, fractional or NaN widths", () => {
    const panel = new AskPanel(tui, theme, QUESTIONS, () => {}, () => undefined);
    for (const width of [0, -1, -100, 10.7, Number.NaN]) assert.doesNotThrow(() => panel.render(width));
  });
});

describe("launcher-ui render width invariant", () => {
  const factory = renderLauncherUI({ prefill: "/unipi:workflow run a fairly long command with arguments" });
  it("never renders a line wider than the terminal", () => {
    for (const width of WIDTHS) assertFits(factory(tui, theme, keybindings, () => {}).render(width), width, "launcher-ui");
  });
  it("respects a narrower width after a resize", () => {
    const component = factory(tui, theme, keybindings, () => {});
    component.render(80);
    assertFits(component.render(30), 30, "launcher-ui after shrink");
  });
});
