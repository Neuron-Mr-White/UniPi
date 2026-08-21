import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { recallBlocksFromContext, recallBlocksFromSessionEntries } from "../src/session/recall-blocks.js";
import { MAX_EXPANDED_HIT_BYTES, vccRecall } from "../src/tools/vcc-recall.js";

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
    const result = vccRecall(blocks, { query: "nebula" });

    expect(result.text).toMatch(/secret keyword: nebula/);
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
    const result = vccRecall(blocks, { query: "zircon" });

    expect(result.text).toMatch(/zircon/);
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
    const result = vccRecall(blocks, { query: "zircon" });

    expect(result.text).toMatch(/grep zircon/);
    expect(result.text).toMatch(/\[tool_result\]/);
  });
});

describe("recall pagination", () => {
  const blocks = Array.from({ length: 12 }, (_, i) => ({
    kind: "user" as const,
    text: `needle ${i}`,
    sourceIndex: i,
  }));

  it("pages results 5 at a time", () => {
    const r1 = vccRecall(blocks as any, { query: "needle" });
    expect(r1.text).toMatch(/Page 1\/3 \(12 total matches\)/);
    expect(r1.text).toMatch(/page:2 for more results/);

    const r2 = vccRecall(blocks as any, { query: "needle", page: 2 });
    expect(r2.text).toMatch(/Page 2\/3/);
  });

  it("reports empty page gracefully", () => {
    const r = vccRecall(blocks as any, { query: "needle", page: 99 });
    expect(r.text).toMatch(/No matches for "needle"/);
  });
});

describe("recall touched mode", () => {
  it("aggregates files with entry indices", () => {
    const blocks = [
      { kind: "tool_call" as const, name: "edit", args: { file_path: "/repo/src/auth.ts" }, sourceIndex: 4 },
      { kind: "tool_call" as const, name: "read", args: { path: "/repo/src/auth.ts" }, sourceIndex: 2 },
      { kind: "tool_call" as const, name: "write", args: { file_path: "/repo/src/new.ts" }, sourceIndex: 7 },
      { kind: "user" as const, text: "fix auth", sourceIndex: 1 },
    ];
    const result = vccRecall(blocks as any, { mode: "touched" });
    expect(result.text).toMatch(/2 files touched/);
    expect(result.text).toMatch(/src\/auth\.ts/);
    expect(result.text).toMatch(/#4 \(edit\)/);
  });
});

describe("recall expand", () => {
  it("returns full untruncated content for indices", () => {
    const long = "needle " + "x".repeat(5000);
    const blocks = [
      { kind: "user" as const, text: long, sourceIndex: 0 },
      { kind: "user" as const, text: "unrelated", sourceIndex: 1 },
    ];
    const result = vccRecall(blocks as any, { expand: [0] });
    expect(result.text).toContain(long);
  });

  it("rejects invalid expand indices", () => {
    const result = vccRecall([{ kind: "user", text: "hi", sourceIndex: 0 }] as any, { expand: [5] });
    expect(result.text).toMatch(/Cannot expand indices outside active lineage: 5/);
  });

  it("bounds each expanded hit so one message cannot flood provider history", () => {
    const text = `needle ${"x".repeat(MAX_EXPANDED_HIT_BYTES * 2)}`;
    const result = vccRecall([{ kind: "user", text, sourceIndex: 0 }] as any, { expand: [0] });
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThan(MAX_EXPANDED_HIT_BYTES + 300);
    expect(result.text).toMatch(/bytes omitted/);
  });
});

describe("recall drill-down", () => {
  it("expands #N:path to file content", () => {
    const blocks = [
      {
        kind: "tool_call" as const,
        name: "edit",
        args: { file_path: "/repo/src/auth.ts", oldText: "old body", newText: "new body" },
        sourceIndex: 42,
      },
    ];
    const result = vccRecall(blocks as any, { query: "#42:auth.ts" });
    expect(result.text).toMatch(/File: \/repo\/src\/auth\.ts/);
    expect(result.text).toMatch(/--- old ---/);
    expect(result.text).toMatch(/new body/);
  });

  it("does not treat inline mentions as drill-down", () => {
    const blocks = [
      { kind: "user" as const, text: "please check #42:auth.ts again", sourceIndex: 0 },
    ];
    // query has surrounding text → ^ anchor fails → falls through to search
    const result = vccRecall(blocks as any, { query: "please check #42:auth.ts" });
    expect(result.text).toMatch(/matches for/);
  });
});
