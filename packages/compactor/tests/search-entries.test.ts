import { describe, it, expect } from "bun:test";
import { searchEntries } from "../src/compaction/search-entries.js";
import type { NormalizedBlock } from "../src/types.js";

describe("searchEntries", () => {
  it("finds relevant blocks with BM25", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "How do I implement authentication?" },
      { kind: "assistant", text: "You can use JWT tokens for authentication." },
      { kind: "user", text: "What about authorization?" },
    ];
    const results = searchEntries(blocks, "authentication JWT");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("returns empty for no matches", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Hello world" },
    ];
    const results = searchEntries(blocks, "xyz123nonexistent");
    expect(results.length).toBe(0);
  });

  it("returns all matches ranked by score (caller paginates)", () => {
    const blocks: NormalizedBlock[] = Array.from({ length: 20 }, (_, i) => ({
      kind: "user" as const,
      text: `Message ${i} about testing`,
    }));
    const results = searchEntries(blocks, "testing");
    expect(results.length).toBe(20);
  });

  it("falls back from regex to keyword search when regex finds nothing", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "What about the cache decision?" },
      { kind: "assistant", text: "We use a redis cache with TTL 300." },
    ];
    // trailing "?" trips looksLikeRegex but has no regex matches as a literal
    const results = searchEntries(blocks, "redis cache decision?");
    expect(results.length).toBeGreaterThan(0);
  });

  it("treats regex metacharacter queries as patterns", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "const timeout = 5000;" },
      { kind: "assistant", text: "nothing relevant here" },
    ];
    const results = searchEntries(blocks, "timeout = \\d+");
    expect(results.length).toBe(1);
    expect(results[0].text).toMatch(/timeout/);
  });
});
