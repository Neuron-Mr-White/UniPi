/**
 * Unit tests for ChordOverlay key mapping: s/u/r/a/y/k fire the matching
 * callback after closing; Esc and unknown keys close silently.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChordOverlay, type ChordCallbacks } from "../src/chord-overlay.ts";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

function theme() {
  return { fg: (_color: string, text: string) => text };
}

function tui() {
  return { requestRender: () => undefined };
}

interface Log {
  done: number;
  actions: string[];
}

function overlay(): { chord: ChordOverlay; log: Log } {
  const log: Log = { done: 0, actions: [] };
  const fire = (name: string) => () => {
    log.actions.push(name);
  };
  const callbacks: ChordCallbacks = {
    onStash: fire("stash"),
    onUndo: fire("undo"),
    onRedo: fire("redo"),
    onAppendStash: fire("appendStash"),
    onCopyLastResponse: fire("copyLastResponse"),
    onKanboard: fire("kanboard"),
  };
  const chord = new ChordOverlay(
    tui() as never,
    theme(),
    {} as never,
    () => {
      log.done += 1;
    },
    callbacks,
  );
  return { chord, log };
}

describe("ChordOverlay", () => {
  it("maps s, u, r, a, y, k to their callbacks after closing", async () => {
    const cases: Array<[string, string]> = [
      ["s", "stash"],
      ["u", "undo"],
      ["r", "redo"],
      ["a", "appendStash"],
      ["y", "copyLastResponse"],
      ["k", "kanboard"],
    ];
    for (const [key, action] of cases) {
      const { chord, log } = overlay();
      chord.handleInput(key);
      await tick(); // actions run on the next tick, after done()
      assert.deepEqual(log.actions, [action], `key ${key}`);
      assert.equal(log.done, 1, `key ${key} closes the overlay`);
    }
  });

  it("Esc closes silently (no action)", async () => {
    const { chord, log } = overlay();
    chord.handleInput("\x1b");
    await tick();
    assert.deepEqual(log.actions, []);
    assert.equal(log.done, 1);
  });

  it("removed keys (t, d, digits) close silently", async () => {
    for (const key of ["t", "d", "0", "5", "9", "x"]) {
      const { chord, log } = overlay();
      chord.handleInput(key);
      await tick();
      assert.deepEqual(log.actions, [], `key ${key} fires nothing`);
      assert.equal(log.done, 1, `key ${key} closes silently`);
    }
  });

  it("renders the six root actions", () => {
    const { chord } = overlay();
    const lines = chord.render(40).join("\n");
    for (const label of [
      "Stash / Restore",
      "Undo",
      "Redo",
      "Append stash",
      "Copy last response",
      "Add to kanboard backlog",
    ]) {
      assert.ok(lines.includes(label), `menu lists ${label}`);
    }
    assert.ok(!lines.includes("Register"), "no register sub-menu");
    assert.ok(!lines.toLowerCase().includes("thinking"), "no thinking toggle");
  });
});
