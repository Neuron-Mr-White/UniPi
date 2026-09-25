import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensureMempalaceYaml,
  findByTitle,
  findSimilar,
  parseMemoryContent,
  parseMemoryFile,
  scanProjectMemories,
  titleSimilarity,
  writeMemoryFile,
} from "../files.js";
import { projectDir } from "../paths.js";

function tmpRoot(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mem-files-"));
  fs.mkdirSync(path.join(d, ".unipi", "memory"), { recursive: true });
  return d;
}

test("parse + write round-trip", () => {
  const rec = {
    id: "m1",
    title: "m1 title",
    content: "body text",
    tags: ["a", "b"],
    project: "conc",
    type: "decision" as const,
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-02T00:00:00Z",
  };
  const home = tmpRoot();
  const prev = process.env.HOME;
  // writeMemoryFile uses os.homedir() — stub via HOME on POSIX.
  process.env.HOME = home;
  try {
    const p = writeMemoryFile(rec);
    assert.equal(p, path.join(home, ".unipi", "memory", "conc", "decision", "m1.md"));
    const parsed = parseMemoryContent(fs.readFileSync(p, "utf-8"));
    assert.equal(parsed?.title, "m1 title");
    assert.equal(parsed?.type, "decision");
    assert.deepEqual(parsed?.tags, ["a", "b"]);
  } finally {
    process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("scan + findByTitle + findSimilar + yaml", () => {
  const home = tmpRoot();
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const p = projectDir("conc");
    fs.mkdirSync(p, { recursive: true });
    fs.mkdirSync(path.join(p, "preference"), { recursive: true });
    fs.writeFileSync(
      path.join(p, "preference", "m1.md"),
      `---\nid: m1\ntitle: prefers vim tabs\ntype: preference\nproject: conc\n---\nbody\n`,
    );
    fs.mkdirSync(path.join(p, "decision"), { recursive: true });
    fs.writeFileSync(
      path.join(p, "decision", "m2.md"),
      `---\nid: m2\ntitle: decided tabs over spaces\ntype: decision\nproject: conc\n---\nbody\n`,
    );
    ensureMempalaceYaml("conc");
    const mems = scanProjectMemories("conc");
    assert.equal(mems.length, 2);
    assert.equal(findByTitle("conc", "prefers vim tabs")?.id, "m1");
    assert.equal(findByTitle("conc", "missing"), null);
    const similar = findSimilar("conc", "vim tabs preference", 0.4);
    assert.ok(similar.length >= 1);
    assert.equal(similar[0].record.id, "m1");
    assert.ok(fs.readFileSync(path.join(p, "mempalace.yaml"), "utf-8").includes("wing: conc"));
    // ensureMempalaceYaml never overwrites
    fs.writeFileSync(path.join(p, "mempalace.yaml"), "wing: custom\n");
    ensureMempalaceYaml("conc");
    assert.equal(fs.readFileSync(path.join(p, "mempalace.yaml"), "utf-8"), "wing: custom\n");
  } finally {
    process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("titleSimilarity >2-char word Jaccard", () => {
  assert.ok(titleSimilarity("vim tabs", "vim tabs config") > 0.6);
  assert.equal(titleSimilarity("abc", "xyz"), 0);
});

test("parseMemoryFile derives id from the filename when frontmatter lacks it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-idfile-"));
  try {
    const p = path.join(dir, "my_legacy_record.md");
    fs.writeFileSync(p, "---\ntitle: Legacy Record\ntags: []\nproject: p\ntype: pattern\n---\nbody here\n");
    const rec = parseMemoryFile(p);
    assert.equal(rec?.id, "my_legacy_record");
    assert.equal(rec?.type, "pattern");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
