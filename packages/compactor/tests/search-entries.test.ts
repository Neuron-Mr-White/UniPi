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
    const results = searchEntries(blocks, "authentication JWT", { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("returns empty for no matches", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Hello world" },
    ];
    const results = searchEntries(blocks, "xyz123nonexistent", { limit: 5 });
    expect(results.length).toBe(0);
  });

  it("respects limit", () => {
    const blocks: NormalizedBlock[] = Array.from({ length: 20 }, (_, i) => ({
      kind: "user" as const,
      text: `Message ${i} about testing`,
    }));
    const results = searchEntries(blocks, "testing", { limit: 5 });
    expect(results.length).toBeLessThanOrEqual(5);
  });
});
