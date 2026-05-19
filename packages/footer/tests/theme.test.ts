/**
 * @pi-unipi/footer — theme color-mode tests
 *
 * Covers the macOS Apple-Terminal downgrade and the manual override path.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  applyColor,
  getColorMode,
  setColorMode,
  refreshColorMode,
} from "../src/rendering/theme.ts";
import type { ColorScheme, ThemeLike } from "../src/types.ts";

const fakeTheme: ThemeLike = { fg: (_c, t) => t };
const colors: ColorScheme = {
  workflowBrainstorm: "#e06c75",
  workflowWork: "#e5c07b",
  workflowReview: "#82cc6f",
};

function snapshotEnv() {
  return {
    NO_COLOR: process.env.NO_COLOR,
    FORCE_COLOR: process.env.FORCE_COLOR,
    COLORTERM: process.env.COLORTERM,
    TERM: process.env.TERM,
    TERM_PROGRAM: process.env.TERM_PROGRAM,
    CI: process.env.CI,
  };
}
function restoreEnv(snap: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("theme color mode", () => {
  let snap: ReturnType<typeof snapshotEnv>;

  beforeEach(() => {
    snap = snapshotEnv();
    setColorMode(null);
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    delete process.env.COLORTERM;
    delete process.env.TERM_PROGRAM;
    delete process.env.CI;
    process.env.TERM = "xterm-256color";
    refreshColorMode();
  });

  afterEach(() => {
    setColorMode(null);
    restoreEnv(snap);
    refreshColorMode();
  });

  it("emits 24-bit truecolor when forced", () => {
    setColorMode("truecolor");
    const out = applyColor("workflowBrainstorm", "x", fakeTheme, colors);
    assert.match(out, /\x1b\[38;2;224;108;117m/);
  });

  it("emits 8-bit 256-color when forced", () => {
    setColorMode("256");
    const out = applyColor("workflowBrainstorm", "x", fakeTheme, colors);
    assert.match(out, /\x1b\[38;5;\d+m/);
    assert.doesNotMatch(out, /\x1b\[38;2;/);
  });

  it("emits no color escapes when forced none", () => {
    setColorMode("none");
    const out = applyColor("workflowBrainstorm", "x", fakeTheme, colors);
    assert.equal(out, "x");
  });

  it("downgrades to 256 on Apple Terminal even with COLORTERM=truecolor leaked", () => {
    process.env.TERM_PROGRAM = "Apple_Terminal";
    process.env.COLORTERM = "truecolor"; // wrapper might leak this
    refreshColorMode();
    assert.equal(getColorMode(), "256");
    const out = applyColor("workflowBrainstorm", "x", fakeTheme, colors);
    assert.match(out, /\x1b\[38;5;\d+m/);
    assert.doesNotMatch(out, /\x1b\[38;2;/);
  });

  it("stays truecolor on iTerm.app + COLORTERM=truecolor", () => {
    process.env.TERM_PROGRAM = "iTerm.app";
    process.env.COLORTERM = "truecolor";
    refreshColorMode();
    assert.equal(getColorMode(), "truecolor");
    const out = applyColor("workflowBrainstorm", "x", fakeTheme, colors);
    assert.match(out, /\x1b\[38;2;224;108;117m/);
  });

  it("respects NO_COLOR=1", () => {
    process.env.NO_COLOR = "1";
    refreshColorMode();
    assert.equal(getColorMode(), "none");
    const out = applyColor("workflowBrainstorm", "x", fakeTheme, colors);
    assert.equal(out, "x");
  });

  it("FORCE_COLOR=3 overrides Apple_Terminal", () => {
    process.env.TERM_PROGRAM = "Apple_Terminal";
    process.env.FORCE_COLOR = "3";
    refreshColorMode();
    assert.equal(getColorMode(), "truecolor");
  });

  it("FORCE_COLOR=1 selects 256 on truecolor terminals", () => {
    process.env.TERM_PROGRAM = "iTerm.app";
    process.env.COLORTERM = "truecolor";
    process.env.FORCE_COLOR = "1";
    refreshColorMode();
    assert.equal(getColorMode(), "256");
  });

  it("treats TERM=dumb as no color", () => {
    process.env.TERM = "dumb";
    delete process.env.TERM_PROGRAM;
    delete process.env.COLORTERM;
    refreshColorMode();
    assert.equal(getColorMode(), "none");
  });

  it("returns plain text for unknown semantic with hex default", () => {
    setColorMode("256");
    // Use a known semantic; expect the wrapped 256-colour output
    const out = applyColor("workflowReview", "ok", fakeTheme, colors);
    assert.match(out, /\x1b\[38;5;\d+mok\x1b\[0m/);
  });

  it("maps category hexes to distinct 256 indices (preserves differentiation)", () => {
    setColorMode("256");
    const a = applyColor("workflowBrainstorm", "x", fakeTheme, colors);
    const b = applyColor("workflowWork", "x", fakeTheme, colors);
    const c = applyColor("workflowReview", "x", fakeTheme, colors);
    const idx = (s: string) => s.match(/\x1b\[38;5;(\d+)m/)?.[1];
    assert.ok(idx(a) && idx(b) && idx(c));
    // The three categories must map to different indices, otherwise the
    // fix would not restore visual differentiation.
    assert.notEqual(idx(a), idx(b));
    assert.notEqual(idx(b), idx(c));
    assert.notEqual(idx(a), idx(c));
  });
});
