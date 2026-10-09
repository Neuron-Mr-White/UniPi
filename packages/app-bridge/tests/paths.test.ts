import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS_STAT_MAX, clearTreeIndex, resolveAgainst, statPaths } from "../src/paths.js";
import { parseIn } from "../src/wire.js";

describe("paths_stat (UNI-204)", () => {
  const base = mkdtempSync(join(tmpdir(), "bridge-paths-"));
  const home = join(base, "home");
  const cwd = join(home, "proj");
  const outside = join(base, "elsewhere");
  mkdirSync(join(cwd, "apps/mobile/src/components/chat"), { recursive: true });
  mkdirSync(join(cwd, "packages/a/src"), { recursive: true });
  mkdirSync(join(cwd, "packages/b/src"), { recursive: true });
  mkdirSync(join(cwd, "node_modules/x"), { recursive: true });
  mkdirSync(join(home, "notes"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(cwd, "README.md"), "x");
  writeFileSync(join(cwd, "apps/mobile/src/components/chat/Composer.tsx"), "x");
  writeFileSync(join(cwd, "packages/a/src/index.ts"), "x");
  writeFileSync(join(cwd, "packages/b/src/index.ts"), "x");
  writeFileSync(join(cwd, "node_modules/x/Hidden.ts"), "x");
  writeFileSync(join(home, "notes/todo.md"), "x");
  writeFileSync(join(outside, "secret.txt"), "x");

  beforeEach(() => clearTreeIndex());

  const stat = (...paths: string[]) => statPaths(paths, cwd, home);

  it("resolves relative, ./ and absolute paths against the cwd", async () => {
    assert.deepEqual((await stat("README.md", "./README.md", join(cwd, "README.md"))).map((s) => [s.kind, s.resolved]), [
      ["file", join(cwd, "README.md")],
      ["file", join(cwd, "README.md")],
      ["file", join(cwd, "README.md")],
    ]);
  });

  it("marks directories (with or without a trailing slash)", async () => {
    assert.deepEqual((await stat("packages", "packages/", "apps/mobile/src/")).map((s) => s.kind), ["dir", "dir", "dir"]);
  });

  it("expands ~ against home, and allows home paths outside the cwd", async () => {
    const [s] = await stat("~/notes/todo.md");
    assert.equal(s!.kind, "file");
    assert.equal(s!.resolved, join(home, "notes/todo.md"));
    assert.equal((await stat("~"))[0]!.kind, "dir");
  });

  it("refuses (missing) anything outside cwd and home, even when it exists", async () => {
    const [s] = await stat(join(outside, "secret.txt"));
    assert.equal(s!.kind, "missing");
    assert.equal((await stat("../../elsewhere/secret.txt"))[0]!.kind, "missing");
    assert.equal((await stat("/etc/passwd"))[0]!.kind, "missing");
  });

  it("missing files stay missing", async () => {
    assert.equal((await stat("src/nope.ts"))[0]!.kind, "missing");
    assert.equal((await stat("~/nope.md"))[0]!.kind, "missing");
  });

  it("finds a bare file name or a partial path by unique suffix in the cwd tree", async () => {
    const [bare, partial] = await stat("Composer.tsx", "components/chat/Composer.tsx");
    assert.equal(bare!.kind, "file");
    assert.equal(bare!.resolved, join(cwd, "apps/mobile/src/components/chat/Composer.tsx"));
    assert.equal(partial!.resolved, bare!.resolved);
    assert.equal(bare!.path, "Composer.tsx"); // echoes the request spelling
  });

  it("an ambiguous suffix stays missing; a qualified one resolves", async () => {
    assert.equal((await stat("src/index.ts"))[0]!.kind, "missing");
    assert.equal((await stat("a/src/index.ts"))[0]!.kind, "file");
  });

  it("skips the suffix lookup when the cwd is home", async () => {
    const [s] = await statPaths(["todo.md"], home, home);
    assert.equal(s!.kind, "missing");
    assert.equal((await statPaths(["notes/todo.md"], home, home))[0]!.kind, "file");
  });

  it("does not look inside node_modules for suffix matches", async () => {
    assert.equal((await stat("Hidden.ts"))[0]!.kind, "missing");
  });

  it("keeps the request order and caps the batch", async () => {
    const many = Array.from({ length: PATHS_STAT_MAX + 20 }, (_, i) => `f${i}.ts`);
    assert.equal((await stat(...many)).length, PATHS_STAT_MAX);
    assert.deepEqual((await stat("b.ts", "README.md")).map((s) => s.path), ["b.ts", "README.md"]);
  });

  it("resolveAgainst has no I/O surprises", () => {
    assert.equal(resolveAgainst("~/a", "/c", "/h"), "/h/a");
    assert.equal(resolveAgainst("a/b", "/c", "/h"), "/c/a/b");
    assert.equal(resolveAgainst("/x", "/c", "/h"), "/x");
  });
});

describe("parseIn paths_stat", () => {
  it("accepts a list of strings, drops non-strings/empties, keeps ref", () => {
    assert.deepEqual(parseIn(JSON.stringify({ t: "paths_stat", paths: ["a.ts", 3, "", "b/c.md"], ref: "r" })), { t: "paths_stat", paths: ["a.ts", "b/c.md"], ref: "r" });
  });
  it("rejects a missing paths array", () => {
    assert.ok("bad" in (parseIn('{"t":"paths_stat"}') as object));
    assert.ok("bad" in (parseIn('{"t":"paths_stat","paths":"a"}') as object));
  });
  it("caps count and length", () => {
    const parsed = parseIn(JSON.stringify({ t: "paths_stat", paths: Array.from({ length: 300 }, () => "/a".repeat(3000)) })) as { paths: string[] };
    assert.equal(parsed.paths.length, 200);
    assert.equal(parsed.paths[0]!.length, 4096);
  });
});
