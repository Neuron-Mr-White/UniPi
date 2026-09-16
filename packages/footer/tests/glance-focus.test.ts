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

test("retargets stale overlay preFocus to the new editor", () => {
  const OLD_EDITOR = { name: "old-editor" };
  const NEW_EDITOR = { name: "new-editor" };
  const OVERLAY_B = { name: "overlay-b" };
  const MOUNTED = { name: "mounted-component" };
  const mounted = new Set<unknown>([MOUNTED, NEW_EDITOR]);
  const overlayStack = [
    { component: OVERLAY_SENTINEL, preFocus: OLD_EDITOR },
    { component: OVERLAY_B, preFocus: OVERLAY_SENTINEL },
    { component: { name: "overlay-c" }, preFocus: MOUNTED },
  ];
  let focused: unknown = OVERLAY_SENTINEL;
  const fakeTui = {
    isOverlayFocused: () => true,
    getFocusedComponent: () => focused,
    isComponentMounted: (component: unknown) => mounted.has(component),
    overlayStack,
    setFocus: (component: unknown) => {
      focused = component;
    },
    requestRender: () => undefined,
  };
  const st = state(fakeTui);
  applyGlanceMode(st, {
    hasUI: true,
    ui: {
      // pi detaches the old editor and focuses the new one inside setEditorComponent
      setEditorComponent: () => {
        focused = NEW_EDITOR;
      },
    },
  });
  assert.equal(overlayStack[0].preFocus, NEW_EDITOR);
  assert.equal(overlayStack[1].preFocus, OVERLAY_SENTINEL);
  assert.equal(overlayStack[2].preFocus, MOUNTED);
  assert.equal(focused, OVERLAY_SENTINEL);
});
