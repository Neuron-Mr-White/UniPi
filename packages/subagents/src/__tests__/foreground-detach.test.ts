/**
 * Foreground detach shortcut tests — parse/format/match semantics ported
 * from pi-subagents foregroundSingleHintText + config validation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseDetachShortcut,
  formatDetachHint,
  matchesDetachInput,
} from "../foreground-detach.js";

describe("parseDetachShortcut", () => {
  it("requires at least one modifier", () => {
    assert.equal(parseDetachShortcut(undefined), undefined);
    assert.equal(parseDetachShortcut(""), undefined);
    assert.equal(parseDetachShortcut("b"), undefined); // plain key — would steal input
    assert.deepEqual(parseDetachShortcut("ctrl+b"), ["ctrl", "b"]);
    assert.deepEqual(parseDetachShortcut(" Ctrl + B "), ["ctrl", "b"]);
    assert.deepEqual(parseDetachShortcut("alt+left"), ["alt", "left"]);
  });
});

describe("formatDetachHint", () => {
  it("renders a human label", () => {
    assert.equal(formatDetachHint(["ctrl", "b"]), "Ctrl+B detaches (run continues in background)");
    assert.equal(formatDetachHint(["alt", "left"]), "Alt+Left detaches (run continues in background)");
    assert.equal(formatDetachHint(undefined), undefined);
  });
});

describe("matchesDetachInput", () => {
  it("matches ctrl+<letter> control sequences", () => {
    assert.equal(matchesDetachInput("\x02", ["ctrl", "b"]), true); // 0x02 = ctrl+b
    assert.equal(matchesDetachInput("\x01", ["ctrl", "b"]), false);
    assert.equal(matchesDetachInput("b", ["ctrl", "b"]), false);
  });

  it("no match when unconfigured", () => {
    assert.equal(matchesDetachInput("\x02", undefined), false);
  });
});
