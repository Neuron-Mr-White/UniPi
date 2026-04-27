import { describe, it, expect } from "bun:test";
import { filterNoise } from "../src/compaction/filter-noise.js";
import type { NormalizedBlock } from "../src/types.js";

describe("filterNoise", () => {
  it("removes thinking blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "thinking", text: "secret", redacted: false },
      { kind: "user", text: "hello" },
    ];
    const out = filterNoise(blocks);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("user");
  });

  it("removes noise tools", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "TodoWrite", args: {}, sourceIndex: 0 },
      { kind: "user", text: "hello" },
    ];
    const out = filterNoise(blocks);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("user");
  });

  it("removes XML wrappers from user text", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "<system-reminder>foo</system-reminder> actual" },
    ];
    const out = filterNoise(blocks);
    expect((out[0] as any).text).toBe("actual");
  });

  it("removes noise strings", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Continue from where you left off." },
    ];
    const out = filterNoise(blocks);
    expect(out).toHaveLength(0);
  });
});
