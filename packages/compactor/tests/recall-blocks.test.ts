import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { recallBlocksFromContext, recallBlocksFromSessionEntries } from "../src/session/recall-blocks.js";
import { MAX_EXPANDED_HIT_BYTES, MAX_RECALL_RESULTS, vccRecall } from "../src/tools/vcc-recall.js";

function entry(id: string, parentId: string | null, message: any): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-05-16T00:00:00.000Z",
    message,
  } as SessionEntry;
}

describe("recall block extraction", () => {
  it("includes raw messages before compaction", () => {
  const entries: SessionEntry[] = [
    entry("u1", null, { role: "user", content: "Remember the secret keyword: nebula" }),
    entry("a1", "u1", { role: "assistant", content: [{ type: "text", text: "Noted." }] }),
    {
      type: "compaction",
      id: "c1",
      parentId: "a1",
      timestamp: "2026-05-16T00:00:01.000Z",
      summary: "Conversation compacted.",
      firstKeptEntryId: "a1",
      tokensBefore: 1000,
    } as SessionEntry,
    entry("u2", "c1", { role: "user", content: "What was the keyword?" }),
  ];

  const blocks = recallBlocksFromSessionEntries(entries);
  const result = vccRecall(blocks, { query: "nebula", limit: 5, expand: true });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].text).toMatch(/secret keyword: nebula/);
  });

  it("reads sessionManager branch instead of compacted context only", () => {
  const branch: SessionEntry[] = [
    entry("u1", null, { role: "user", content: "Pre-compaction detail: zircon" }),
    {
      type: "compaction",
      id: "c1",
      parentId: "u1",
      timestamp: "2026-05-16T00:00:01.000Z",
      summary: "Old detail omitted from summary.",
      firstKeptEntryId: "u1",
      tokensBefore: 1000,
    } as SessionEntry,
  ];
  const ctx = {
    sessionManager: {
      getBranch: () => branch,
      buildSessionContext: () => ({ messages: [{ role: "user", content: "Only compacted context" }] }),
    },
  };

  const blocks = recallBlocksFromContext(ctx);
  const result = vccRecall(blocks, { query: "zircon", limit: 5, expand: true });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].text).toMatch(/zircon/);
  });

  it("hard-caps result count even when validation is bypassed", () => {
    const blocks = Array.from({ length: 100 }, (_, i) => ({
      kind: "user" as const,
      text: `needle ${i}`,
      index: i,
    }));
    const result = vccRecall(blocks as any, { query: "needle", mode: "regex", limit: 10_000 });
    expect(result.hits).toHaveLength(MAX_RECALL_RESULTS);
  });

  it("bounds each expanded hit so one message cannot flood provider history", () => {
    const text = `needle ${"x".repeat(MAX_EXPANDED_HIT_BYTES * 2)}`;
    const result = vccRecall([{ kind: "user", text, index: 0 }] as any, {
      query: "needle",
      mode: "regex",
      expand: true,
    });
    expect(Buffer.byteLength(result.hits[0].text, "utf8")).toBeLessThan(MAX_EXPANDED_HIT_BYTES + 200);
    expect(result.hits[0].text).toMatch(/bytes omitted/);
  });

  it("indexes Pi-specific bashExecution messages", () => {
  const entries: SessionEntry[] = [
    entry("b1", null, {
      role: "bashExecution",
      command: "grep zircon notes.txt",
      output: "zircon found",
      exitCode: 0,
      cancelled: false,
    }),
  ];

  const blocks = recallBlocksFromSessionEntries(entries);
  const result = vccRecall(blocks, { query: "zircon", limit: 5, expand: true });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].kind).toBe("tool_result");
    expect(result.hits[0].text).toMatch(/grep zircon/);
  });
});
