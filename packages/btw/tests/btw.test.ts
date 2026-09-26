import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildSeedEntries, formatToolLine, pageIndexAfter } from "../extensions/btw.js";

function msgEntry(id: string, parentId: string | null, text: string, role = "user") {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role,
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    },
  };
}

function customMessageEntry(id: string, parentId: string | null, customType: string) {
  return {
    type: "custom_message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    customType,
    content: "hidden btw note text",
    display: true,
  };
}

function compactionEntry(id: string, parentId: string | null, firstKeptId: string) {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    summary: "older context summarized",
    firstKeptEntryId: firstKeptId,
    tokensBefore: 5000,
  };
}

function fakeCtx(entries: any[]) {
  const header = entries.find((e) => e.type === "session") ?? null;
  return {
    sessionManager: {
      getHeader: () => header,
      getBranch: () => entries.filter((e) => e !== header),
    },
  };
}

// ── (a) seed builder drops btw-note, keeps everything else ─────────────────

test("buildSeedEntries drops btw-note custom messages, keeps user/tool/compaction", () => {
  const header = { type: "session", version: 3, id: "s1", timestamp: new Date().toISOString(), cwd: "/x" };
  const branch = [
    msgEntry("e1", null, "hello"),
    { ...msgEntry("e2", "e1", "toolout"), message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "file body" }], isError: false, timestamp: Date.now() } },
    compactionEntry("e3", "e2", "e4"),
    msgEntry("e4", "e3", "codename PELICAN"),
    customMessageEntry("e5", "e4", "btw-note"),
    customMessageEntry("e6", "e5", "other-plugin"),
    msgEntry("e7", "e6", "after note"),
  ];
  const seed = buildSeedEntries(fakeCtx([header, ...branch]) as any);
  assert.equal(seed[0], header);
  const ids = seed.slice(1).map((e: any) => e.id);
  assert.deepEqual(ids, ["e1", "e2", "e3", "e4", "e6", "e7"], "btw-note dropped, rest kept in order");
});

// ── (b) regression: seeded entries reach the provider context ───────────────

test("SessionManager.inMemory seeded from the main branch exposes the branch in buildSessionContext", () => {
  const cwd = mkdtempSync(join(tmpdir(), "btw-seed-"));
  try {
    const header = { type: "session", version: 3, id: "s1", timestamp: new Date().toISOString(), cwd };
    const branch = [
      msgEntry("e1", null, "the codename is PELICAN"),
      { ...msgEntry("e2", "e1", "ok"), message: { role: "assistant", content: [{ type: "text", text: "understood" }], timestamp: Date.now() } },
      compactionEntry("e3", "e2", "e4"),
      msgEntry("e4", "e3", "and the word PELICAN stays"),
      customMessageEntry("e5", "e4", "btw-note"),
    ];
    const seed = buildSeedEntries(fakeCtx([header, ...branch]) as any);
    const sm = SessionManager.inMemory(cwd, undefined, seed as any);
    // This is the list AgentSession serializes into the provider request.
    const ctx = sm.buildSessionContext();
    const text = JSON.stringify(ctx.messages);
    assert.ok(text.includes("PELICAN"), "seeded messages must reach provider context");
    assert.ok(!text.includes("hidden btw note text"), "btw-note must not leak");
    // compaction resolves: the compaction entry is honored in the projection
    assert.ok(ctx.messages.length >= 1);
    sm.dispose?.();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── (c) paging reducer ──────────────────────────────────────────────────────

test("pageIndexAfter clamps into history bounds", () => {
  assert.equal(pageIndexAfter(0, -1, 3), 0);
  assert.equal(pageIndexAfter(0, 1, 3), 1);
  assert.equal(pageIndexAfter(2, 1, 3), 2);
  assert.equal(pageIndexAfter(1, -1, 3), 0);
  assert.equal(pageIndexAfter(0, 1, 0), 0, "empty history is a no-op");
});

// ── (d) tool-line formatter ─────────────────────────────────────────────────

test("formatToolLine renders Devin-style verbs, relative paths, error mark", () => {
  const cwd = "/repo";
  assert.equal(formatToolLine("read", { path: "/repo/src/a.ts" }, cwd, "running"), "… Reading src/a.ts");
  assert.equal(formatToolLine("read", { path: "/repo/src/a.ts" }, cwd, "done"), "✓ Read src/a.ts");
  assert.equal(formatToolLine("read", { path: "/abs/outside.ts" }, cwd, "done"), "✓ Read /abs/outside.ts");
  assert.equal(formatToolLine("grep", { pattern: "foo.*" }, cwd, "running"), "… Searching foo.*");
  assert.equal(formatToolLine("find", { pattern: "*.md" }, cwd, "done"), "✓ Found *.md");
  assert.equal(formatToolLine("ls", { path: "/repo" }, cwd, "done"), "✓ Listed .");
  assert.equal(formatToolLine("read", { path: "/repo/x" }, cwd, "error"), "✗ Read x");
  assert.equal(formatToolLine("mystery", { foo: 1 }, cwd, "running"), "… Running mystery");
});
