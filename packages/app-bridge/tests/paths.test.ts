import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PATHS_STAT_MAX,
  clearSafeRoots,
  clearTreeIndex,
  forbiddenRoot,
  hostSafeRoots,
  resolveAgainst,
  resolveSafeRoots,
  statPaths,
} from "../src/paths.js";
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

  // No extra roots here: the fixture itself lives under /tmp (an extra root by default).
  const NONE = { roots: [], deny: [] };
  const stat = (...paths: string[]) => statPaths(paths, cwd, home, NONE);

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
    const [s] = await statPaths(["todo.md"], home, home, NONE);
    assert.equal(s!.kind, "missing");
    assert.equal((await statPaths(["notes/todo.md"], home, home, NONE))[0]!.kind, "file");
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

describe("paths_stat extra safe roots (UNI-220)", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "bridge-roots-")));
  const home = join(base, "home");
  const cwd = join(home, "proj");
  const scratch = join(base, "scratch");
  const outside = join(base, "elsewhere");
  for (const d of [cwd, join(scratch, "sub"), join(scratch, "carved"), outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(scratch, "sub/shot.png"), "x");
  writeFileSync(join(scratch, "carved/key.txt"), "x");
  writeFileSync(join(outside, "secret.txt"), "x");
  symlinkSync(join(outside, "secret.txt"), join(scratch, "link.txt"));
  symlinkSync("/etc", join(scratch, "etc"));
  const extra = { roots: [scratch], deny: [join(scratch, "carved")] };
  const stat = (...paths: string[]) => statPaths(paths, cwd, home, extra);

  it("a file under an extra root (e.g. /tmp) is found, absolute or via ..", async () => {
    const [abs, rel] = await stat(join(scratch, "sub/shot.png"), "../../scratch/sub/shot.png");
    assert.equal(abs!.kind, "file");
    assert.equal(rel!.kind, "file");
    assert.equal((await stat(join(scratch, "sub")))[0]!.kind, "dir");
  });

  it("symlink escapes, carve-outs and other folders stay missing", async () => {
    assert.deepEqual(
      (await stat(join(scratch, "link.txt"), join(scratch, "etc/hostname"), join(scratch, "carved/key.txt"), join(outside, "secret.txt"), "/etc/passwd")).map((s) => s.kind),
      ["missing", "missing", "missing", "missing", "missing"],
    );
  });

  it("forbiddenRoot matches the host's list", () => {
    for (const bad of ["/", "/etc", "/usr/local", "/proc", "/sys", "/dev", "/boot", "/root", "/var", "/var/lib", "/run", "/run/media/bob", "/home", "/home/bob"])
      assert.equal(forbiddenRoot(bad, "/home/me", "me"), true, bad);
    for (const ok of ["/tmp", "/var/tmp", "/mnt", "/media", "/run/media/me", "/srv", "/opt", "/data", "/home/me/x"])
      assert.equal(forbiddenRoot(ok, "/home/me", "me"), false, ok);
  });

  it("resolveSafeRoots: existing defaults, allow adds, deny removes, forbidden/symlinked-to-system never", () => {
    symlinkSync("/usr", join(base, "usr-link"));
    const tmp = realpathSync("/tmp");
    const d = resolveSafeRoots({}, home, "me");
    assert.ok(d.includes(tmp), String(d));
    assert.ok(d.every((r) => !forbiddenRoot(r, home, "me")));
    assert.ok(!resolveSafeRoots({ deny: ["/tmp"] }, home, "me").includes(tmp));
    const custom = resolveSafeRoots({ allow: [outside, "/etc", "/", join(base, "usr-link"), "relative", 5] }, home, "me");
    assert.ok(custom.includes(outside));
    assert.ok(!custom.some((r) => r === "/etc" || r === "/" || r.startsWith("/usr")));
  });

  it("hostSafeRoots reads the host config.json fs block (UNIPI_HOST_DIR)", () => {
    const hostDir = join(base, "host");
    mkdirSync(hostDir);
    writeFileSync(join(hostDir, "config.json"), JSON.stringify({ forwarding: {}, fs: { allow: [outside], deny: [scratch] } }));
    const prev = process.env.UNIPI_HOST_DIR;
    process.env.UNIPI_HOST_DIR = hostDir;
    try {
      clearSafeRoots();
      const r = hostSafeRoots(1, home);
      assert.ok(r.roots.includes(outside));
      assert.deepEqual(r.deny, [scratch]);
      // A deny on a parent drops every root under it (same as the host).
      writeFileSync(join(hostDir, "config.json"), JSON.stringify({ fs: { allow: [outside], deny: [base] } }));
      clearSafeRoots();
      assert.ok(!hostSafeRoots(2, home).roots.includes(outside));
    } finally {
      if (prev === undefined) delete process.env.UNIPI_HOST_DIR;
      else process.env.UNIPI_HOST_DIR = prev;
      clearSafeRoots();
    }
  });
});
