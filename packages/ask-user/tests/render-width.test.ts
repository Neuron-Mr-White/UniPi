/**
 * Regression tests for the narrow-terminal TUI crash.
 *
 * pi-tui's differential renderer throws when a rendered line is wider than the
 * terminal, taking the whole agent down. The ask-user components used to floor
 * their inner width at 40 columns (`Math.max(40, width - 2)`), so every line
 * was at least 42 columns wide — guaranteeing a crash on any terminal narrower
 * than 42. They also cached rendered lines without keying on width, so
 * shrinking the terminal served stale, over-wide lines.
 *
 * The invariant asserted here: for every width >= 1, every returned line must
 * satisfy visibleWidth(line) <= width.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";

import { renderAskUI } from "../ask-ui.ts";
import { renderLauncherUI } from "../launcher-ui.ts";
import { AskUserSettingsOverlay } from "../settings-tui.ts";
import type { NormalizedOption } from "../types.ts";

/** Minimal Theme stub — components only use fg() and the editor theme fields. */
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  colors: {},
} as never;

/** Minimal TUI stub — components only call requestRender(). */
const tui = {
  requestRender: () => {},
  terminal: { columns: 80, rows: 24 },
} as never;

const keybindings = {} as never;

const OPTIONS: NormalizedOption[] = [
  {
    label: "Use the REST daemon and auto-spawn it when it is not running",
    value: "rest",
    description:
      "A deliberately long description so wrapping and truncation are exercised at every width.",
  },
  { label: "Short", value: "short", description: "" },
  {
    label: "Freeform answer with a moderately long label 🚀 and emoji",
    value: "free",
    description: "Another description with an emoji 🧹 to stress width math.",
  },
] as never;

/** Widths from pathological to comfortable. */
const WIDTHS = Array.from({ length: 200 }, (_, i) => i + 1);

function assertFits(lines: string[], width: number, label: string): void {
  lines.forEach((line, i) => {
    const w = visibleWidth(line);
    assert.ok(
      w <= width,
      `${label}: line ${i} is ${w} columns at terminal width ${width} ` +
        `(pi-tui would throw). Line: ${JSON.stringify(line)}`,
    );
  });
}

describe("ask-ui render width invariant", () => {
  const factory = renderAskUI({
    question: "wigolo integration — which surface should UniPi use?",
    context:
      "wigolo is a local-first web engine that ships as an MCP server, a REST daemon, an SDK and a CLI.",
    options: OPTIONS,
    allowMultiple: false,
    allowFreeform: true,
    timeout: undefined,
  });

  it("never renders a line wider than the terminal", () => {
    for (const width of WIDTHS) {
      // Fresh instance per width so we test the layout, not the cache.
      const component = factory(tui, theme, keybindings, () => {});
      assertFits(component.render(width), width, "ask-ui");
    }
  });

  it("respects a narrower width after a resize (stale cache regression)", () => {
    const component = factory(tui, theme, keybindings, () => {});
    component.render(80);
    // No invalidate() — pi-tui's requestRender() does not call it on resize.
    assertFits(component.render(30), 30, "ask-ui after shrink");
    assertFits(component.render(10), 10, "ask-ui after second shrink");
    assertFits(component.render(1), 1, "ask-ui at width 1");
  });

  it("still renders content after growing back", () => {
    const component = factory(tui, theme, keybindings, () => {});
    component.render(20);
    const wide = component.render(100);
    assertFits(wide, 100, "ask-ui after grow");
    assert.ok(wide.length > 0, "expected lines after growing back");
  });

  it("survives multi-select and timeout variants at narrow widths", () => {
    const multi = renderAskUI({
      question: "Pick features",
      context: "",
      options: OPTIONS,
      allowMultiple: true,
      allowFreeform: false,
      timeout: 30_000,
    })(tui, theme, keybindings, () => {});

    for (const width of [1, 2, 5, 11, 12, 13, 41, 42, 43]) {
      assertFits(multi.render(width), width, `ask-ui multi @${width}`);
      multi.invalidate();
    }
  });

  it("produces non-empty output at every width", () => {
    for (const width of [1, 12, 42, 120]) {
      const component = factory(tui, theme, keybindings, () => {});
      assert.ok(
        component.render(width).length > 0,
        `expected non-empty render at width ${width}`,
      );
    }
  });
});

describe("launcher-ui render width invariant", () => {
  const factory = renderLauncherUI({
    prefill: "/unipi:workflow run a fairly long command with arguments",
  });

  it("never renders a line wider than the terminal", () => {
    for (const width of WIDTHS) {
      const component = factory(tui, theme, keybindings, () => {});
      assertFits(component.render(width), width, "launcher-ui");
    }
  });

  it("respects a narrower width after a resize (stale cache regression)", () => {
    const component = factory(tui, theme, keybindings, () => {});
    component.render(80);
    assertFits(component.render(30), 30, "launcher-ui after shrink");
    assertFits(component.render(1), 1, "launcher-ui at width 1");
  });

  it("handles an empty prefill", () => {
    const empty = renderLauncherUI({ prefill: "" })(tui, theme, keybindings, () => {});
    for (const width of [1, 6, 12, 42, 80]) {
      assertFits(empty.render(width), width, `launcher-ui empty @${width}`);
      empty.invalidate();
    }
  });
});

describe("settings-tui render width invariant", () => {
  it("never renders a line wider than the terminal", () => {
    const overlay = new AskUserSettingsOverlay();
    for (const width of WIDTHS) {
      assertFits(overlay.render(width), width, "settings-tui");
    }
  });

  it("respects a narrower width after a resize", () => {
    const overlay = new AskUserSettingsOverlay();
    overlay.render(80);
    assertFits(overlay.render(30), 30, "settings-tui after shrink");
    assertFits(overlay.render(1), 1, "settings-tui at width 1");
  });
});

describe("degenerate widths", () => {
  it("does not throw on zero, negative, fractional or NaN widths", () => {
    const component = renderAskUI({
      question: "Q",
      context: "",
      options: OPTIONS,
      allowMultiple: false,
      allowFreeform: false,
      timeout: undefined,
    })(tui, theme, keybindings, () => {});

    for (const width of [0, -1, -100, 10.7, Number.NaN]) {
      const lines = component.render(width);
      component.invalidate();
      // Everything collapses to the minimum usable width of 1.
      assertFits(lines, Math.max(1, Number.isFinite(width) ? Math.floor(width) : 1), `degenerate @${width}`);
    }
  });
});
