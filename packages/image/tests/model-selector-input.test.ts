/**
 * Model-selector overlay input handling.
 *
 * Regression cover for the bug where opening the model picker left BOTH the
 * picker and the underlying settings `select` focused: keys moved the list
 * behind the overlay and nothing could be closed or toggled.
 *
 * The cause was `pickModel` calling `ctx.ui.custom(...)` without awaiting the
 * promise it returns, so the settings loop advanced and mounted the next
 * `ctx.ui.select` while the overlay was still on screen. These tests pin the
 * two invariants that matter: the overlay closes exactly once via `done()`,
 * and the caller does not proceed until it has.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ImageModelSelectorOverlay } from "../src/tui/model-selector.js";

const MODELS = [
  { provider: "openrouter", id: "google/gemini-3-pro-image" },
  { provider: "openrouter", id: "black-forest-labs/flux.2-pro" },
  { provider: "omniroute", id: "fal/fal-ai/flux-2-pro" },
];

function makeOverlay(kind: "generate" | "recognize" = "generate") {
  const overlay = new ImageModelSelectorOverlay(kind, MODELS);
  const closes: number[] = [];
  const selected: string[] = [];
  overlay.onClose = () => closes.push(Date.now());
  overlay.onSelect = (ref) => selected.push(ref);
  return { overlay, closes, selected };
}

test("Esc closes the overlay", () => {
  const { overlay, closes } = makeOverlay();
  overlay.handleInput("\x1b");
  assert.equal(closes.length, 1);
});

test("Ctrl+C closes the overlay", () => {
  // Without this the overlay swallows Ctrl+C and traps the user.
  const { overlay, closes } = makeOverlay();
  overlay.handleInput("\x03");
  assert.equal(closes.length, 1);
});

test("Ctrl+C escapes even while filtering", () => {
  const { overlay, closes } = makeOverlay();
  overlay.handleInput("/");
  overlay.handleInput("f");
  overlay.handleInput("\x03");
  assert.equal(closes.length, 1, "Ctrl+C must not be captured by the filter");
});

test("Enter selects and closes synchronously", () => {
  // A deferred close (setTimeout) let the caller resume while the overlay was
  // still mounted — precisely the double-focus bug.
  const { overlay, closes, selected } = makeOverlay();
  overlay.handleInput("\r");
  assert.deepEqual(selected, ["openrouter/google/gemini-3-pro-image"]);
  assert.equal(closes.length, 1, "must close immediately, not on a timer");
});

test("arrow keys and j/k move the selection", () => {
  const { overlay, selected } = makeOverlay();
  overlay.handleInput("\x1b[B"); // down
  overlay.handleInput("j"); // down
  overlay.handleInput("\x1b[A"); // up
  overlay.handleInput("\r");
  assert.deepEqual(selected, ["openrouter/black-forest-labs/flux.2-pro"]);
});

test("navigation cannot run off either end", () => {
  const { overlay, selected } = makeOverlay();
  for (let i = 0; i < 10; i++) overlay.handleInput("\x1b[A");
  overlay.handleInput("\r");
  assert.deepEqual(selected, ["openrouter/google/gemini-3-pro-image"]);

  const second = makeOverlay();
  for (let i = 0; i < 10; i++) second.overlay.handleInput("\x1b[B");
  second.overlay.handleInput("\r");
  assert.deepEqual(second.selected, ["omniroute/fal/fal-ai/flux-2-pro"]);
});

test("filter narrows the list and Enter picks from the filtered set", () => {
  const { overlay, selected } = makeOverlay();
  overlay.handleInput("/");
  for (const ch of "omniroute") overlay.handleInput(ch);
  overlay.handleInput("\r"); // leave filter mode
  overlay.handleInput("\r"); // select
  assert.deepEqual(selected, ["omniroute/fal/fal-ai/flux-2-pro"]);
});

test("Esc in filter mode clears the filter without closing", () => {
  const { overlay, closes } = makeOverlay();
  overlay.handleInput("/");
  overlay.handleInput("z");
  overlay.handleInput("\x1b");
  assert.equal(closes.length, 0, "first Esc only clears the filter");
  overlay.handleInput("\x1b");
  assert.equal(closes.length, 1, "second Esc closes");
});

test("selecting with an empty filtered list reports an error, not a crash", () => {
  const { overlay, closes, selected } = makeOverlay();
  overlay.handleInput("/");
  for (const ch of "zzzznomatch") overlay.handleInput(ch);
  overlay.handleInput("\r"); // leave filter mode
  overlay.handleInput("\r"); // attempt select
  assert.deepEqual(selected, []);
  assert.equal(closes.length, 0);
  const out = overlay.render(80).join("\n");
  assert.match(out, /No model selected/);
});

test("render never exceeds the given width", () => {
  const { overlay } = makeOverlay();
  // eslint-disable-next-line no-control-regex
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  for (let width = 10; width <= 120; width += 7) {
    for (const line of overlay.render(width)) {
      assert.ok(
        strip(line).length <= width,
        `line exceeds width ${width}: ${strip(line).length}`,
      );
    }
  }
});

// ─── Custom model entry ──────────────────────────────────────────────

test("c enters custom mode and Enter saves a typed reference", () => {
  // Generator detection is heuristic, so the user must be able to name a
  // model the catalog never discovered.
  const { overlay, closes, selected } = makeOverlay();
  overlay.handleInput("c");
  for (const ch of "omniroute/fal/fal-ai/some-new-model") overlay.handleInput(ch);
  overlay.handleInput("\r");
  assert.deepEqual(selected, ["omniroute/fal/fal-ai/some-new-model"]);
  assert.equal(closes.length, 1);
});

test("custom mode rejects a reference with no provider segment", () => {
  const { overlay, closes, selected } = makeOverlay();
  overlay.handleInput("c");
  for (const ch of "just-a-model") overlay.handleInput(ch);
  overlay.handleInput("\r");
  assert.deepEqual(selected, []);
  assert.equal(closes.length, 0, "stays open so the user can correct it");
  assert.match(overlay.render(80).join("\n"), /provider\/model-id/);
});

test("custom mode rejects an empty reference", () => {
  const { overlay, selected } = makeOverlay();
  overlay.handleInput("c");
  overlay.handleInput("\r");
  assert.deepEqual(selected, []);
  assert.match(overlay.render(80).join("\n"), /Enter a model as provider\/model-id/);
});

test("backspace edits the custom reference", () => {
  const { overlay, selected } = makeOverlay();
  overlay.handleInput("c");
  for (const ch of "prov/modelX") overlay.handleInput(ch);
  overlay.handleInput("\x7f");
  overlay.handleInput("\r");
  assert.deepEqual(selected, ["prov/model"]);
});

test("Esc leaves custom mode without closing the overlay", () => {
  const { overlay, closes, selected } = makeOverlay();
  overlay.handleInput("c");
  overlay.handleInput("x");
  overlay.handleInput("\x1b");
  assert.equal(closes.length, 0, "first Esc only exits custom mode");
  overlay.handleInput("\r"); // back on the list — selects normally
  assert.deepEqual(selected, ["openrouter/google/gemini-3-pro-image"]);
});

test("Ctrl+C escapes from custom mode", () => {
  const { overlay, closes } = makeOverlay();
  overlay.handleInput("c");
  overlay.handleInput("x");
  overlay.handleInput("\x03");
  assert.equal(closes.length, 1);
});

test("custom mode renders within the given width", () => {
  const { overlay } = makeOverlay();
  overlay.handleInput("c");
  for (const ch of "omniroute/fal/fal-ai/a-very-long-model-identifier-here") {
    overlay.handleInput(ch);
  }
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  for (let width = 10; width <= 120; width += 7) {
    for (const line of overlay.render(width)) {
      assert.ok(strip(line).length <= width, `exceeds width ${width}`);
    }
  }
});

// ─── Kitty keyboard protocol encodings ───────────────────────────────

/**
 * Under the kitty keyboard protocol (and modifyOtherKeys) Escape does NOT
 * arrive as a bare "\x1b" — it comes as "\x1b[27u" / "\x1b[27;1;27~".
 * Comparing `data === "\x1b"` silently fails, so the overlay could not be
 * cancelled and the filter could not be exited. All key handling now goes
 * through pi-tui's matchesKey().
 */
const ESC_ENCODINGS = ["\x1b", "\x1b[27u", "\x1b[27;1u", "\x1b[27;1;27~"];

for (const esc of ESC_ENCODINGS) {
  const label = JSON.stringify(esc);

  test(`Esc ${label} closes the overlay`, () => {
    const { overlay, closes } = makeOverlay();
    overlay.handleInput(esc);
    assert.equal(closes.length, 1, `${label} must close the overlay`);
  });

  test(`Esc ${label} exits filter mode`, () => {
    const { overlay, closes, selected } = makeOverlay();
    overlay.handleInput("/");
    overlay.handleInput("o");
    overlay.handleInput(esc);
    assert.equal(closes.length, 0, "clears the filter rather than closing");
    // Filter cleared ⇒ the full list is back and index reset to the first item.
    overlay.handleInput("\r");
    assert.deepEqual(selected, ["openrouter/google/gemini-3-pro-image"]);
  });

  test(`Esc ${label} exits custom mode`, () => {
    const { overlay, closes } = makeOverlay();
    overlay.handleInput("c");
    overlay.handleInput("x");
    overlay.handleInput(esc);
    assert.equal(closes.length, 0);
    overlay.handleInput(esc); // now on the list — closes
    assert.equal(closes.length, 1);
  });
}

test("kitty-encoded Ctrl+C closes the overlay", () => {
  const { overlay, closes } = makeOverlay();
  overlay.handleInput("\x1b[99;5u");
  assert.equal(closes.length, 1);
});

test("kitty-encoded Enter selects", () => {
  const { overlay, selected } = makeOverlay();
  overlay.handleInput("\x1b[13u");
  assert.deepEqual(selected, ["openrouter/google/gemini-3-pro-image"]);
});

test("arrow keys navigate while filtering", () => {
  const { overlay, selected } = makeOverlay();
  overlay.handleInput("/");
  for (const ch of "flux") overlay.handleInput(ch);
  overlay.handleInput("\x1b[B"); // down, without leaving the filter
  overlay.handleInput("\r"); // leave filter
  overlay.handleInput("\r"); // select
  assert.deepEqual(selected, ["omniroute/fal/fal-ai/flux-2-pro"]);
});

test("escape sequences are never typed into the filter as text", () => {
  const { overlay } = makeOverlay();
  overlay.handleInput("/");
  overlay.handleInput("\x1b[A"); // arrow key
  const out = overlay.render(80).join("\n");
  assert.doesNotMatch(out, /\[A/, "arrow sequence must not land in the filter text");
});
