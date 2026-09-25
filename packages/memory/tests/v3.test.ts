import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseMemoryFile, writeMemoryFile, scanProjectMemories } from "../files.js";
import { safeIdPart } from "../paths.js";
import { compareVersions } from "../mempalace.js";
import { MIN_MEMPALACE, lockHolder } from "../daemon.js";
import { groupSearchHits, localSearch } from "../session.js";
import { needsMigration, adoptLooseFiles, acquireConversionLock, releaseConversionLock, readConversionState } from "../convert.js";
import { enqueuePending, readPending, replayPending } from "../pending.js";
import { memoryCompletions } from "../commands.js";

function tmpHome(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mem-v3-"));
  fs.mkdirSync(path.join(d, ".unipi", "memory"), { recursive: true });
  return d;
}
function withHome<T>(home: string, fn: () => T): T {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try { return fn(); } finally { process.env.HOME = prev; }
}
async function withHomeAsync<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try { return await fn(); } finally { process.env.HOME = prev; }
}
const md = (title: string, body = "body"): string =>
  `---\ntitle: ${title}\nproject: p\ntype: summary\ntags: []\n---\n${body}\n`;

// ── version gate ──────────────────────────────────────────────────────────

test("version gate: compareVersions decides palace vs local mode", () => {
  assert.ok(compareVersions("3.10.0", MIN_MEMPALACE) >= 0);
  assert.ok(compareVersions("3.12.1", MIN_MEMPALACE) >= 0);
  assert.ok(compareVersions("3.9.4", MIN_MEMPALACE) < 0);
  assert.ok(compareVersions("2.9.9", MIN_MEMPALACE) < 0);
  assert.ok(compareVersions("3.10", MIN_MEMPALACE) >= 0);
});

// ── v2 id rule ────────────────────────────────────────────────────────────

test("safeIdPart mirrors the v2 bridge rule", () => {
  assert.equal(safeIdPart("Auth-JWT"), "auth_jwt");
  assert.equal(safeIdPart("__leading__"), "leading");
  assert.equal(safeIdPart("--weird--name--"), "weird_name");
  assert.equal(safeIdPart("spaces and.dots"), "spaces_and_dots");
  assert.equal(safeIdPart("..."), "unknown");
  assert.equal(safeIdPart("Étude"), "tude"); // non-ascii chars collapse
});

test("parseMemoryFile derives the normalized id from the filename", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-idrule-"));
  try {
    const p = path.join(dir, "Auth-JWT.md");
    fs.writeFileSync(p, md("Auth JWT", "token guidance"));
    const rec = parseMemoryFile(p);
    assert.equal(rec?.id, "auth_jwt");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── local markdown search ─────────────────────────────────────────────────

test("localSearch scores term overlap and honors scope", () => {
  const home = tmpHome();
  try {
    withHome(home, () => {
      fs.mkdirSync(path.join(home, ".unipi", "memory", "conc", "summary"), { recursive: true });
      fs.writeFileSync(path.join(home, ".unipi", "memory", "conc", "summary", "a.md"), md("auth refresh", "jwt refresh token rotation details"));
      fs.mkdirSync(path.join(home, ".unipi", "memory", "other", "summary"), { recursive: true });
      fs.writeFileSync(path.join(home, ".unipi", "memory", "other", "summary", "b.md"), md("docker images", "dockerfile layers"));
      const all = localSearch("refresh token", 10, "all", "conc");
      assert.equal(all.length, 1);
      assert.equal(all[0].title, "auth refresh");
      assert.equal(all[0].sourceLabel, "local");
      assert.equal(all[0].score, 1);
      const proj = localSearch("docker", 10, "project", "conc");
      assert.equal(proj.length, 0);
      const projAll = localSearch("refresh", 10, "project", "conc");
      assert.equal(projAll.length, 1);
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ── legacy unipi:// hit mapping ───────────────────────────────────────────

test("groupSearchHits maps unipi:// bridge drawers to pi records", () => {
  const hits = groupSearchHits([{
    drawer_id: "d1",
    source_path: "unipi://memory/EnvStripper/some%20record",
    content: "---\ntitle: prefer ripgrep\ntype: preference\n---\nripgrep over grep always",
    wing: "oldwing", room: "unipi_preference", score: 0.9,
    added_by: "unipi-memory-bridge",
  }], 5);
  assert.equal(hits.length, 1);
  const h = hits[0];
  assert.equal(h.title, "prefer ripgrep");           // frontmatter title wins
  assert.equal(h.wing, "EnvStripper");               // decoded from the URI
  assert.equal(h.sourceLabel, "pi");
  assert.equal(h.isPiMemory, true);
  assert.equal(h.room, "unipi_preference");
});

test("groupSearchHits decodes the id when the doc lacks a title", () => {
  const hits = groupSearchHits([{
    drawer_id: "d2",
    source_path: "unipi://memory/conc/some%20record%20id",
    content: "no frontmatter here",
    score: 0.5,
  }], 5);
  assert.equal(hits[0].title, "some record id");
});

// ── case-variant project dirs ─────────────────────────────────────────────

test("scanProjectMemories sees case-variant dirs of the project", () => {
  const home = tmpHome();
  try {
    withHome(home, () => {
      fs.mkdirSync(path.join(home, ".unipi", "memory", "EnvStripper"), { recursive: true });
      fs.writeFileSync(path.join(home, ".unipi", "memory", "EnvStripper", "m1.md"), md("legacy flat"));
      fs.mkdirSync(path.join(home, ".unipi", "memory", "envstripper", "summary"), { recursive: true });
      fs.writeFileSync(path.join(home, ".unipi", "memory", "envstripper", "summary", "m2.md"), md("typed one"));
      const mems = scanProjectMemories("envstripper");
      assert.equal(mems.length, 2);
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ── needsMigration ────────────────────────────────────────────────────────

test("needsMigration detects markers, flat files, and non-sanitized dirs", () => {
  const home = tmpHome();
  try {
    withHome(home, () => {
      const root = path.join(home, ".unipi", "memory");
      assert.equal(needsMigration(), false);
      fs.writeFileSync(path.join(root, ".mempalace-ledger.json"), "{}");
      assert.equal(needsMigration(), true);
      fs.rmSync(path.join(root, ".mempalace-ledger.json"));
      assert.equal(needsMigration(), false);
      fs.mkdirSync(path.join(root, "MyProject"));
      assert.equal(needsMigration(), true);
      fs.rmSync(path.join(root, "MyProject"), { recursive: true });
      fs.mkdirSync(path.join(root, "myproject"));
      fs.writeFileSync(path.join(root, "myproject", "flat.md"), md("flat"));
      assert.equal(needsMigration(), true);
      fs.writeFileSync(path.join(root, ".conversion.json"), JSON.stringify({ phase: "done" }));
      assert.equal(needsMigration(), false); // conversion finished → no hint
      fs.rmSync(path.join(root, ".conversion.json"));
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ── adoption planner ──────────────────────────────────────────────────────

test("adoptLooseFiles moves flat files + case dirs into the typed layout", () => {
  const home = tmpHome();
  try {
    withHome(home, () => {
      const root = path.join(home, ".unipi", "memory");
      fs.mkdirSync(path.join(root, "EnvStripper"));
      fs.writeFileSync(path.join(root, "EnvStripper", "Auth-JWT.md"), md("Auth JWT", "token guidance"));
      fs.mkdirSync(path.join(root, "myproj"));
      fs.writeFileSync(path.join(root, "myproj", "loose.md"), md("Loose note"));
      const adopted = adoptLooseFiles();
      assert.equal(adopted.length, 2);
      assert.ok(fs.existsSync(path.join(root, "envstripper", "summary", "auth_jwt.md")));
      assert.ok(fs.existsSync(path.join(root, "myproj", "summary", "loose.md")));
      assert.ok(!fs.existsSync(path.join(root, "EnvStripper")));
      assert.ok(!fs.existsSync(path.join(root, "myproj", "loose.md")));
      // Typed files at depth 2+ are left alone.
      assert.equal(adopted.find((a) => a.project === "envstripper")?.filePath, path.join(root, "envstripper", "summary", "auth_jwt.md"));
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ── pending replay carries the holder + drops filed ops ───────────────────

test("pending journal keeps heldBy and replay drops filed ops", async () => {
  const home = tmpHome();
  try {
    await withHomeAsync(home, async () => {
      enqueuePending({
        kind: "store", file: "/tmp/x.md", project: "p", id: "x",
        enqueuedAt: "t", heldBy: "PID 1 (/x/mcp)",
      });
      assert.equal(readPending()[0].heldBy, "PID 1 (/x/mcp)");
      const remaining = await replayPending(async (op) => op.id === "x" ? "filed" : "markdown-only");
      assert.equal(remaining, 0);
      assert.equal(readPending().length, 0);
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ── lockHolder extraction ─────────────────────────────────────────────────

test("lockHolder pulls the holder text from a MineAlreadyRunning error", () => {
  const held = lockHolder(
    "MineAlreadyRunning: palace /x is held by PID 317852 (/home/coffee/mp/bridge.py); wait for it",
  );
  assert.equal(held, "PID 317852 (/home/coffee/mp/bridge.py); wait for it");
  assert.equal(lockHolder("no lock info"), undefined);
});

// ── completions ───────────────────────────────────────────────────────────

test("memoryCompletions includes migrate and switch values", () => {
  const items = memoryCompletions("") ?? [];
  assert.ok(items.some((i) => i.value === "migrate"));
  assert.ok(items.some((i) => i.value === "status"));
  const rec = memoryCompletions("recall ") ?? [];
  assert.deepEqual(rec.map((i) => i.value).sort(), ["recall off", "recall on"]);
});

// ── restored commands registered ──────────────────────────────────────────

test("restored v2 commands are all registered", () => {
  const registered: string[] = [];
  const fakePi = {
    registerCommand(name: string) { registered.push(name); },
    getActiveTools: () => [],
    setActiveTools: () => {},
  };
  // registerMemoryCommands registers every command through pi.registerCommand.
  const { registerMemoryCommands } = await_import_commands();
  registerMemoryCommands(fakePi as never, () => null, {});
  for (const name of [
    "unipi:memory", "unipi:memory-process", "unipi:memory-consolidate",
    "unipi:memory-search", "unipi:global-memory-search",
    "unipi:memory-forget", "unipi:global-memory-list",
  ]) {
    assert.ok(registered.includes(name), `missing ${name}`);
  }
});

import { registerMemoryCommands } from "../commands.js";
function await_import_commands() { return { registerMemoryCommands }; }

// ── .gitignore keeps flat files out of `mempalace mine <dir>` ─────────────

test("ensureMempalaceYaml writes a top-level .gitignore for flat files", () => {
  const home = tmpHome();
  try {
    withHome(home, () => {
      const { ensureMempalaceYaml } = await_import_files();
      ensureMempalaceYaml("proj");
      const gi = fs.readFileSync(path.join(home, ".unipi", "memory", "proj", ".gitignore"), "utf-8");
      assert.equal(gi, "/*.md\n");
      // never overwrites an existing .gitignore
      fs.writeFileSync(path.join(home, ".unipi", "memory", "proj", ".gitignore"), "custom\n");
      ensureMempalaceYaml("proj");
      assert.equal(fs.readFileSync(path.join(home, ".unipi", "memory", "proj", ".gitignore"), "utf-8"), "custom\n");
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ── adoption returns the old flat paths for orphan cleanup ────────────────

test("adoptLooseFiles exposes oldPath (+origPath for renamed dirs)", () => {
  const home = tmpHome();
  try {
    withHome(home, () => {
      const root = path.join(home, ".unipi", "memory");
      fs.mkdirSync(path.join(root, "MixedCase"));
      fs.writeFileSync(path.join(root, "MixedCase", "x.md"), md("upper note"));
      const adopted = adoptLooseFiles();
      assert.equal(adopted.length, 1);
      const a = adopted[0];
      assert.equal(a.project, "mixedcase");
      assert.equal(a.oldPath, path.join(root, "mixedcase", "x.md"));
      assert.equal(a.origPath, path.join(root, "MixedCase", "x.md"));
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

import { ensureMempalaceYaml } from "../files.js";
function await_import_files() { return { ensureMempalaceYaml }; }
