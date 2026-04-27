import { describe, it, expect } from "bun:test";
import { buildOwnCut } from "../src/compaction/cut.js";

describe("buildOwnCut", () => {
  it("cancels when no live messages", () => {
    const result = buildOwnCut([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_live_messages");
  });

  it("cancels when too few messages", () => {
    const entries = [
      { id: "1", type: "message", message: { role: "user", content: "hi" } },
    ];
    const result = buildOwnCut(entries);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too_few_live_messages");
  });

  it("returns messages and firstKeptEntryId", () => {
    const entries = [
      { id: "1", type: "message", message: { role: "user", content: "hi" } },
      { id: "2", type: "message", message: { role: "assistant", content: "hello" } },
      { id: "3", type: "message", message: { role: "user", content: "bye" } },
    ];
    const result = buildOwnCut(entries);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages.length).toBe(2);
      expect(result.firstKeptEntryId).toBe("3");
    }
  });

  it("handles orphan recovery", () => {
    const entries = [
      { id: "1", type: "compaction", firstKeptEntryId: "gone" },
      { id: "2", type: "message", message: { role: "user", content: "hi" } },
      { id: "3", type: "message", message: { role: "user", content: "bye" } },
    ];
    const result = buildOwnCut(entries);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages.length).toBe(1);
    }
  });
});
