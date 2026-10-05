import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MoveContext, MoveLogEntry } from "@pi-unipi/core";
import { createMemoryMoveHandler, planFileMoves, listTypedFiles, type MoveDeps } from "../move.js";
import { memoryFilePath, projectDir, projectName } from "../paths.js";
import { writeMemoryFile, parseMemoryFile } from "../files.js";
import type { MempalaceInstall } from "../mempalace.js";

const install: MempalaceInstall = { python: "/stub/python", version: "0.0.0-stub" };

function stubDeps(overrides: Partial<MoveDeps> = {}): MoveDeps {
  return {
    ensureMempalace: () => install,
    fileThroughDaemon: async () => ({ outcome: "filed" }),
    mineDirect: async () => ({ ok: true }),
    deleteThroughDaemon: async () => ({ outcome: "filed" }),
    deleteViaWriteMcp: async () => ({ ok: true }),
    palacePath: "/stub/palace",
    ...overrides,
  };
}

function withHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mem-move-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  return Promise.resolve().then(() => fn(home)).finally(() => {
    process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });
}

function seedMemory(project: string, type: "preference" | "decision" | "pattern" | "summary", id: string, title: string): string {
  return writeMemoryFile({
    id, title, content: `body for ${title}`, tags: ["t"], project, type,
    created: "2024-01-01T00:00:00Z", updated: "2024-01-01T00:00:00Z",
  });
}

function makeCtx(oldRoot: string, newRoot: string, dryRun = false): { ctx: MoveContext; entries: MoveLogEntry[] } {
  const entries: MoveLogEntry[] = [];
  const ctx: MoveContext = { oldRoot, newRoot, dryRun, log: (e) => entries.push(e), backup: () => {} };
  return { ctx, entries };
}

test("rename moves files, rewrites frontmatter, deletes old source after filed reindex, idempotent", async () => {
  await withHome(async () => {
    let deletedFrom: string[] = [];
    const deps = stubDeps({
      deleteThroughDaemon: async (_i, sourceFile) => { deletedFrom.push(sourceFile); return { outcome: "filed" }; },
    });
    const handler = createMemoryMoveHandler(deps);
    const oldRoot = "/tmp/fake/My Old Project";
    const newRoot = "/tmp/fake/renamed-project";
    const oldProject = projectName(oldRoot);
    const newProject = projectName(newRoot);
    const oldPrefPath = seedMemory(oldProject, "preference", "pref_one", "pref one");
    const oldDecPath = seedMemory(oldProject, "decision", "dec_one", "decision one");

    const { ctx, entries } = makeCtx(oldRoot, newRoot);
    const items = await handler.scan(ctx);
    assert.equal(items.length, 1);
    await items[0].apply();

    const movedPref = memoryFilePath(newProject, "preference", "pref_one");
    const movedDec = memoryFilePath(newProject, "decision", "dec_one");
    assert.ok(fs.existsSync(movedPref));
    assert.ok(fs.existsSync(movedDec));
    assert.equal(parseMemoryFile(movedPref)?.project, newProject);
    assert.equal(fs.existsSync(projectDir(oldProject)), false);
    assert.ok(fs.existsSync(path.join(projectDir(newProject), "mempalace.yaml")));

    assert.deepEqual(new Set(deletedFrom), new Set([oldPrefPath, oldDecPath]));
    assert.ok(entries.some((e) => e.action === "reindex" && e.result === "filed"));
    assert.equal(entries.filter((e) => e.action === "delete-old-source" && e.result === "filed").length, 2);

    const items2 = await handler.scan(makeCtx(oldRoot, newRoot).ctx);
    assert.equal(items2.length, 0);
  });
});

test("parent unchanged, same project name: scan returns nothing", async () => {
  await withHome(async () => {
    const handler = createMemoryMoveHandler(stubDeps());
    const oldRoot = "/tmp/fake/same-name";
    const newRoot = "/tmp/other/same-name";
    seedMemory(projectName(oldRoot), "summary", "s1", "a summary");
    const items = await handler.scan(makeCtx(oldRoot, newRoot).ctx);
    assert.equal(items.length, 0);
    assert.ok(fs.existsSync(memoryFilePath(projectName(oldRoot), "summary", "s1")));
  });
});

test("same-id conflict across different types is skipped, not overwritten", async () => {
  await withHome(async () => {
    const handler = createMemoryMoveHandler(stubDeps());
    const oldRoot = "/tmp/fake/conflict-old";
    const newRoot = "/tmp/fake/conflict-new";
    const oldProject = projectName(oldRoot);
    const newProject = projectName(newRoot);
    seedMemory(oldProject, "pattern", "dup_id", "old content");
    // Same id, different type at destination — still a conflict.
    const destExisting = seedMemory(newProject, "decision", "dup_id", "existing content");
    const before = fs.readFileSync(destExisting, "utf-8");

    const { ctx, entries } = makeCtx(oldRoot, newRoot);
    const items = await handler.scan(ctx);
    await items[0].apply();

    assert.equal(fs.readFileSync(destExisting, "utf-8"), before);
    assert.ok(fs.existsSync(memoryFilePath(oldProject, "pattern", "dup_id")));
    assert.ok(entries.some((e) => e.action === "move" && /same-id conflict/.test(e.result)));
  });
});

test("dry-run plans without touching disk or calling deps", async () => {
  await withHome(async () => {
    let touched = false;
    const handler = createMemoryMoveHandler(stubDeps({ ensureMempalace: () => { touched = true; return install; } }));
    const oldRoot = "/tmp/fake/dry-old";
    const newRoot = "/tmp/fake/dry-new";
    const file = seedMemory(projectName(oldRoot), "preference", "p1", "dry preference");
    const before = fs.readFileSync(file, "utf-8");

    const { ctx, entries } = makeCtx(oldRoot, newRoot, true);
    const items = await handler.scan(ctx);
    await items[0].apply();

    assert.equal(fs.readFileSync(file, "utf-8"), before);
    assert.equal(entries.length, 0);
    assert.equal(fs.existsSync(memoryFilePath(projectName(newRoot), "preference", "p1")), false);
    assert.equal(touched, false);
  });
});

test("listTypedFiles / planFileMoves empty when old dir absent", async () => {
  await withHome(() => {
    assert.deepEqual(listTypedFiles("/does/not/exist"), []);
    assert.deepEqual(planFileMoves("nonexistent-old", "nonexistent-new"), []);
  });
});

test("no install: move happens, reindex and delete both skipped, never deleted", async () => {
  await withHome(async () => {
    let deleteCalled = false;
    const handler = createMemoryMoveHandler(stubDeps({
      ensureMempalace: () => null,
      deleteThroughDaemon: async () => { deleteCalled = true; return { outcome: "filed" }; },
    }));
    const oldRoot = "/tmp/fake/noinstall-old";
    const newRoot = "/tmp/fake/noinstall-new";
    const oldProject = projectName(oldRoot);
    const newProject = projectName(newRoot);
    seedMemory(oldProject, "summary", "s1", "no install summary");
    const { ctx, entries } = makeCtx(oldRoot, newRoot);
    const items = await handler.scan(ctx);
    await items[0].apply();
    assert.ok(fs.existsSync(memoryFilePath(newProject, "summary", "s1")));
    assert.match(entries.find((e) => e.action === "reindex")!.result, /not installed/);
    assert.match(entries.find((e) => e.action === "delete-old-source")!.result, /not installed/);
    assert.equal(deleteCalled, false);
  });
});

test("reindex queued: old source is left in place, logged pending, never deleted", async () => {
  await withHome(async () => {
    let deleteCalled = false;
    const handler = createMemoryMoveHandler(stubDeps({
      fileThroughDaemon: async () => ({ outcome: "queued", jobId: "job1" }),
      deleteThroughDaemon: async () => { deleteCalled = true; return { outcome: "filed" }; },
    }));
    const oldRoot = "/tmp/fake/queued-old";
    const newRoot = "/tmp/fake/queued-new";
    seedMemory(projectName(oldRoot), "summary", "s1", "queued summary");
    const { ctx, entries } = makeCtx(oldRoot, newRoot);
    const items = await handler.scan(ctx);
    await items[0].apply();
    assert.equal(entries.find((e) => e.action === "reindex")!.result, "queued");
    assert.match(entries.find((e) => e.action === "delete-old-source")!.result, /skipped: reindex queued/);
    assert.equal(deleteCalled, false);
  });
});

test("reindex failed (markdown-only both paths): old source is left in place, not deleted", async () => {
  await withHome(async () => {
    let deleteCalled = false;
    const handler = createMemoryMoveHandler(stubDeps({
      fileThroughDaemon: async () => ({ outcome: "markdown-only", error: "daemon unreachable" }),
      mineDirect: async () => ({ ok: false, error: "palace locked" }),
      deleteThroughDaemon: async () => { deleteCalled = true; return { outcome: "filed" }; },
    }));
    const oldRoot = "/tmp/fake/failed-old";
    const newRoot = "/tmp/fake/failed-new";
    seedMemory(projectName(oldRoot), "summary", "s1", "failed summary");
    const { ctx, entries } = makeCtx(oldRoot, newRoot);
    const items = await handler.scan(ctx);
    await items[0].apply();
    assert.match(entries.find((e) => e.action === "reindex")!.result, /^failed/);
    assert.match(entries.find((e) => e.action === "delete-old-source")!.result, /skipped: reindex failed/);
    assert.equal(deleteCalled, false);
  });
});

test("reindex filed via direct fallback still triggers deletion of the exact old source path", async () => {
  await withHome(async () => {
    const seenDeletes: string[] = [];
    const handler = createMemoryMoveHandler(stubDeps({
      fileThroughDaemon: async () => ({ outcome: "markdown-only", error: "daemon unreachable" }),
      mineDirect: async () => ({ ok: true }),
      deleteThroughDaemon: async (_i, sourceFile) => { seenDeletes.push(sourceFile); return { outcome: "filed" }; },
    }));
    const oldRoot = "/tmp/fake/direct-old";
    const newRoot = "/tmp/fake/direct-new";
    const oldProject = projectName(oldRoot);
    const oldPath = seedMemory(oldProject, "summary", "s1", "direct summary");
    const { ctx, entries } = makeCtx(oldRoot, newRoot);
    const items = await handler.scan(ctx);
    await items[0].apply();
    assert.equal(entries.find((e) => e.action === "reindex")!.result, "filed");
    assert.deepEqual(seenDeletes, [oldPath]);
  });
});

test("delete falls back to write-MCP when daemon delete is markdown-only, with exact old path", async () => {
  await withHome(async () => {
    let writeMcpPath = "";
    const handler = createMemoryMoveHandler(stubDeps({
      deleteThroughDaemon: async () => ({ outcome: "markdown-only", error: "daemon unreachable" }),
      deleteViaWriteMcp: async (_i, sourceFile) => { writeMcpPath = sourceFile; return { ok: true }; },
    }));
    const oldRoot = "/tmp/fake/writemcp-old";
    const newRoot = "/tmp/fake/writemcp-new";
    const oldProject = projectName(oldRoot);
    const oldPath = seedMemory(oldProject, "summary", "s1", "writemcp summary");
    const { ctx, entries } = makeCtx(oldRoot, newRoot);
    const items = await handler.scan(ctx);
    await items[0].apply();
    assert.equal(writeMcpPath, oldPath);
    assert.equal(entries.find((e) => e.action === "delete-old-source")!.result, "filed (direct)");
  });
});

test("filename/id mismatch: deletion targets the actual old file path, not a recomputed basename", async () => {
  await withHome(async () => {
    const seenDeletes: string[] = [];
    const handler = createMemoryMoveHandler(stubDeps({
      deleteThroughDaemon: async (_i, sourceFile) => { seenDeletes.push(sourceFile); return { outcome: "filed" }; },
    }));
    const oldRoot = "/tmp/fake/mismatch-old";
    const newRoot = "/tmp/fake/mismatch-new";
    const oldProject = projectName(oldRoot);
    const newProject = projectName(newRoot);
    // File on disk named differently than its frontmatter id.
    const dir = path.join(projectDir(oldProject), "summary");
    fs.mkdirSync(dir, { recursive: true });
    const oldPath = path.join(dir, "legacy-filename.md");
    fs.writeFileSync(
      oldPath,
      "---\nid: real_id\ntitle: mismatched\ntags: []\nproject: " + oldProject + "\ntype: summary\ncreated: a\nupdated: b\n---\nbody\n",
    );
    const { ctx } = makeCtx(oldRoot, newRoot);
    const items = await handler.scan(ctx);
    await items[0].apply();
    const expectedNew = memoryFilePath(newProject, "summary", "real_id");
    assert.ok(fs.existsSync(expectedNew));
    assert.deepEqual(seenDeletes, [oldPath]);
  });
});

test("all conflicts: reindex and delete steps are skipped entirely", async () => {
  await withHome(async () => {
    let reindexCalled = false;
    let deleteCalled = false;
    const handler = createMemoryMoveHandler(stubDeps({
      fileThroughDaemon: async () => { reindexCalled = true; return { outcome: "filed" }; },
      deleteThroughDaemon: async () => { deleteCalled = true; return { outcome: "filed" }; },
    }));
    const oldRoot = "/tmp/fake/allconflict-old";
    const newRoot = "/tmp/fake/allconflict-new";
    const oldProject = projectName(oldRoot);
    const newProject = projectName(newRoot);
    seedMemory(oldProject, "summary", "dup", "old");
    seedMemory(newProject, "summary", "dup", "existing");
    const { ctx, entries } = makeCtx(oldRoot, newRoot);
    const items = await handler.scan(ctx);
    await items[0].apply();
    assert.equal(reindexCalled, false);
    assert.equal(deleteCalled, false);
    assert.equal(entries.some((e) => e.action === "reindex"), false);
    assert.equal(entries.some((e) => e.action === "delete-old-source"), false);
  });
});
