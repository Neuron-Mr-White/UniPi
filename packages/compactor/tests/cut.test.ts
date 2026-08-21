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
      { id: "3", type: "message", message: { role: "assistant", content: "hello" } },
      { id: "4", type: "message", message: { role: "user", content: "bye" } },
    ];
    const result = buildOwnCut(entries);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages.length).toBe(2);
      expect(result.firstKeptEntryId).toBe("4");
    }
  });

  it("keep:0 compacts everything with empty sentinel", () => {
    const entries = [
      { id: "1", type: "message", message: { role: "user", content: "hi" } },
      { id: "2", type: "message", message: { role: "assistant", content: "hello" } },
      { id: "3", type: "message", message: { role: "user", content: "bye" } },
    ];
    const result = buildOwnCut(entries, 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.compactAll).toBe(true);
      expect(result.firstKeptEntryId).toBe("");
      expect(result.keepFallbackToCompactAll).toBe(false);
    }
  });

  it("keep larger than available user turns falls back to compact-all", () => {
    const entries = [
      { id: "1", type: "message", message: { role: "user", content: "hi" } },
      { id: "2", type: "message", message: { role: "assistant", content: "hello" } },
      { id: "3", type: "message", message: { role: "user", content: "bye" } },
    ];
    const result = buildOwnCut(entries, 5);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.compactAll).toBe(true);
      expect(result.keepFallbackToCompactAll).toBe(true);
    }
  });

  it("keep:2 keeps the last two user turns", () => {
    const entries = [
      { id: "1", type: "message", message: { role: "user", content: "a" } },
      { id: "2", type: "message", message: { role: "assistant", content: "b" } },
      { id: "3", type: "message", message: { role: "user", content: "c" } },
      { id: "4", type: "message", message: { role: "assistant", content: "d" } },
      { id: "5", type: "message", message: { role: "user", content: "e" } },
    ];
    const result = buildOwnCut(entries, 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages.length).toBe(2);
      expect(result.firstKeptEntryId).toBe("3");
      expect(result.keptUserTurns).toBe(2);
      expect(result.totalUserTurns).toBe(3);
    }
  });
});
