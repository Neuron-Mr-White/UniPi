/**
 * @pi-unipi/utility — Shiki Highlighter tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LruCache,
  detectLanguage,
  detectLanguageFromPath,
  normalizeShikiContrast,
  CACHE_LIMIT,
  MAX_HL_CHARS,
} from "../src/diff/highlighter.js";

describe("LruCache", () => {
  it("stores and retrieves values", () => {
    const cache = new LruCache<string>(10);
    cache.set("key1", "value1");
    assert.equal(cache.get("key1"), "value1");
  });

  it("returns undefined for missing keys", () => {
    const cache = new LruCache<string>(10);
    assert.equal(cache.get("missing"), undefined);
  });

  it("evicts oldest entries at capacity", () => {
    const cache = new LruCache<string>(3);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    // Cache is full
    assert.equal(cache.size, 3);
    // Add one more — should evict "a"
    cache.set("d", "4");
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("b"), "2");
    assert.equal(cache.get("d"), "4");
  });

  it("moves accessed items to most-recently-used", () => {
    const cache = new LruCache<string>(3);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    // Access "a" to make it recently used
    cache.get("a");
    // Add "d" — should evict "b" (oldest unused)
    cache.set("d", "4");
    assert.equal(cache.get("a"), "1"); // still here
    assert.equal(cache.get("b"), undefined); // evicted
    assert.equal(cache.get("c"), "3"); // still here
    assert.equal(cache.get("d"), "4"); // still here
  });

  it("updates existing keys without growing", () => {
    const cache = new LruCache<string>(3);
    cache.set("a", "1");
    cache.set("a", "2");
    assert.equal(cache.get("a"), "2");
    assert.equal(cache.size, 1);
  });

  it("has() checks existence", () => {
    const cache = new LruCache<string>(10);
    cache.set("key", "value");
    assert.ok(cache.has("key"));
    assert.ok(!cache.has("other"));
  });

  it("clear() empties the cache", () => {
    const cache = new LruCache<string>(10);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.get("a"), undefined);
  });

  it("respects CACHE_LIMIT constant", () => {
    const cache = new LruCache<number>(CACHE_LIMIT);
    assert.equal(CACHE_LIMIT, 192);
    // Fill to capacity
    for (let i = 0; i < CACHE_LIMIT; i++) {
      cache.set(`key${i}`, i);
    }
    assert.equal(cache.size, CACHE_LIMIT);
    // Add one more
    cache.set("overflow", 999);
    assert.equal(cache.size, CACHE_LIMIT); // still at capacity
    assert.equal(cache.get("key0"), undefined); // first evicted
  });
});

describe("detectLanguage", () => {
  it("detects TypeScript from .ts", () => {
    assert.equal(detectLanguage(".ts"), "typescript");
    assert.equal(detectLanguage("ts"), "typescript");
  });

  it("detects JavaScript from .js", () => {
    assert.equal(detectLanguage(".js"), "javascript");
  });

  it("detects TSX from .tsx", () => {
    assert.equal(detectLanguage(".tsx"), "tsx");
  });

  it("detects Python from .py", () => {
    assert.equal(detectLanguage(".py"), "python");
  });

  it("detects Rust from .rs", () => {
    assert.equal(detectLanguage(".rs"), "rust");
  });

  it("returns 'text' for unknown extensions", () => {
    assert.equal(detectLanguage(".xyz"), "text");
    assert.equal(detectLanguage(".unknown"), "text");
  });

  it("handles case insensitivity", () => {
    assert.equal(detectLanguage(".TS"), "typescript");
    assert.equal(detectLanguage(".JS"), "javascript");
  });
});

describe("detectLanguageFromPath", () => {
  it("detects language from file path", () => {
    assert.equal(detectLanguageFromPath("src/index.ts"), "typescript");
    assert.equal(detectLanguageFromPath("/home/user/app/main.py"), "python");
    assert.equal(detectLanguageFromPath("README.md"), "markdown");
  });

  it("handles paths without extension", () => {
    assert.equal(detectLanguageFromPath("Makefile"), "text");
    assert.equal(detectLanguageFromPath("Dockerfile"), "text"); // no dot
  });
});

describe("normalizeShikiContrast", () => {
  it("passes through high-contrast ANSI unchanged", () => {
    // White foreground (#ffffff) against dark bg has high contrast
    const ansi = "\x1b[38;2;255;255;255mwhite text\x1b[0m";
    const result = normalizeShikiContrast(ansi, "#1a1a2e");
    assert.equal(result, ansi); // unchanged
  });

  it("brightens low-contrast foregrounds", () => {
    // Very dark foreground (#333333) against dark bg — low contrast
    const ansi = "\x1b[38;2;51;51;51mdark text\x1b[0m";
    const result = normalizeShikiContrast(ansi, "#1a1a2e");
    // Should be brighter than original
    assert.notEqual(result, ansi);
    // Extract the new color and verify it's brighter
    const match = result.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
    assert.ok(match);
    const r = parseInt(match[1]);
    assert.ok(r > 51, `Expected r > 51, got ${r}`);
  });

  it("handles ANSI with no color codes", () => {
    const ansi = "plain text without color";
    const result = normalizeShikiContrast(ansi);
    assert.equal(result, ansi);
  });

  it("handles empty string", () => {
    assert.equal(normalizeShikiContrast(""), "");
  });

  it("processes multiple color codes in one string", () => {
    const ansi = "\x1b[38;2;51;51;51mred\x1b[38;2;51;51;51mblue\x1b[0m";
    const result = normalizeShikiContrast(ansi, "#1a1a2e");
    // Both should be brightened
    const matches = result.match(/\x1b\[38;2;\d+;\d+;\d+m/g);
    assert.ok(matches);
    assert.equal(matches.length, 2);
  });

  it("respects custom minRatio", () => {
    // With a very high minRatio, more colors should be bumped
    const ansi = "\x1b[38;2;150;150;150mgray text\x1b[0m";
    const resultLow = normalizeShikiContrast(ansi, "#1a1a2e", 2.0);
    const resultHigh = normalizeShikiContrast(ansi, "#1a1a2e", 10.0);
    // With ratio 10.0, the gray should be brightened
    assert.notEqual(resultHigh, ansi);
  });
});

describe("Constants", () => {
  it("CACHE_LIMIT is 192", () => {
    assert.equal(CACHE_LIMIT, 192);
  });

  it("MAX_HL_CHARS is 80000", () => {
    assert.equal(MAX_HL_CHARS, 80_000);
  });
});
