import { test } from "node:test";
import assert from "node:assert/strict";
import { applyGlanceMode, type FooterState } from "../src/index.js";

const EDITOR_SENTINEL = { name: "editor" };
const OVERLAY_SENTINEL = { name: "overlay" };

function state(tui: Record<string, unknown>): FooterState {
  return {
    glanceMode: true,
    glanceInstalled: false,
    piContext: {},
    tuiRef: tui,
  } as unknown as FooterState;
}

function run(isOverlayFocused: boolean) {
  const calls: unknown[] = [];
  const fakeTui = {
    isOverlayFocused: () => isOverlayFocused,
    getFocusedComponent: () => OVERLAY_SENTINEL,
    setFocus: (component: unknown) => calls.push(component),
    requestRender: () => undefined,
  };
  const st = state(fakeTui);
  applyGlanceMode(st, {
    hasUI: true,
    ui: {
      setEditorComponent: () => fakeTui.setFocus(EDITOR_SENTINEL),
    },
  });
  return calls;
}

test("restores overlay focus after installing the Glance editor", () => {
  assert.equal(run(true).at(-1), OVERLAY_SENTINEL);
});

test("does not refocus an overlay when none owns focus", () => {
  assert.equal(run(false).at(-1), EDITOR_SENTINEL);
});
