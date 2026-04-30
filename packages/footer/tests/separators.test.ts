/**
 * @pi-unipi/footer — Separator tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getSeparator, separatorVisibleWidth } from "../src/rendering/separators.ts";

describe("getSeparator", () => {
  it("returns separator for all styles", () => {
    const styles = ["powerline", "powerline-thin", "slash", "pipe", "dot", "ascii"] as const;
    for (const style of styles) {
      const sep = getSeparator(style);
      assert.ok(sep.left, `${style} should have left separator`);
      assert.ok(typeof sep.left === "string", `${style} left should be string`);
      assert.ok(typeof sep.right === "string", `${style} right should be string`);
    }
  });

  it("falls back to powerline-thin for unknown style", () => {
    const sep = getSeparator("unknown" as any);
    const expected = getSeparator("powerline-thin");
    assert.equal(sep.left, expected.left);
  });

  it("slash style includes spaces", () => {
    const sep = getSeparator("slash");
    assert.ok(sep.left.includes("/"));
    assert.ok(sep.left.startsWith(" "));
    assert.ok(sep.left.endsWith(" "));
  });

  it("pipe style includes pipe character", () => {
    const sep = getSeparator("pipe");
    assert.ok(sep.left.includes("|"));
  });

  it("dot style includes dot character", () => {
    const sep = getSeparator("dot");
    assert.ok(sep.left.includes("·") || sep.left.includes("."));
  });

  it("ascii style uses angle brackets or similar", () => {
    const sep = getSeparator("ascii");
    assert.ok(typeof sep.left === "string");
    assert.ok(sep.left.length > 0);
  });
});

describe("separatorVisibleWidth", () => {
  it("returns positive width for all styles", () => {
    const styles = ["powerline", "powerline-thin", "slash", "pipe", "dot", "ascii"] as const;
    for (const style of styles) {
      const width = separatorVisibleWidth(style);
      assert.ok(width > 0, `${style} should have positive width`);
    }
  });
});
