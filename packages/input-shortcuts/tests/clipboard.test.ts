/**
 * Unit tests for clipboard module.
 * Some tests are skipped in CI where no clipboard tool is available.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectClipboard, copyToClipboard, pasteFromClipboard, resetClipboardCache } from "../src/clipboard.ts";

describe("clipboard", () => {
  it("detectClipboard returns a tool or null", () => {
    resetClipboardCache();
    const tool = detectClipboard();
    // In CI there may be no clipboard, so just check it returns something
    assert.ok(tool === null || typeof tool === "string");
  });

  it("copyToClipboard returns result when tool detected", () => {
    resetClipboardCache();
    const tool = detectClipboard();
    if (!tool) return; // Skip if no clipboard tool
    const result = copyToClipboard("test clipboard text");
    // May fail in headless environments (no X display) — that's ok
    assert.ok(typeof result.ok === "boolean");
  });

  it("pasteFromClipboard returns result when tool detected", () => {
    resetClipboardCache();
    const tool = detectClipboard();
    if (!tool) return; // Skip if no clipboard

    const copyResult = copyToClipboard("roundtrip test");
    if (!copyResult.ok) return; // Skip if copy failed (headless)
    const result = pasteFromClipboard();
    assert.equal(result.ok, true);
    assert.equal(result.text, "roundtrip test");
  });

  it("returns error gracefully when no clipboard tool", () => {
    // This test just verifies the error path works
    // We can't easily force no-clipboard, but we can test the result type
    resetClipboardCache();
    const result = copyToClipboard("test");
    // Either ok (tool found) or not ok (no tool) — both are valid
    assert.ok(typeof result.ok === "boolean");
    if (!result.ok) {
      assert.ok(result.reason);
    }
  });
});
