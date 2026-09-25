import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { groupSearchHits } from "../session.js";
import { memoryRoot } from "../paths.js";

test("groupSearchHits dedupes chunks by source_file and keeps best score", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mem-group-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const piFile = path.join(home, ".unipi", "memory", "conc", "preference", "m1.md");
    fs.mkdirSync(path.dirname(piFile), { recursive: true });
    fs.writeFileSync(piFile, "---\nid: m1\ntitle: prefers vim tabs\ntype: preference\nproject: conc\n---\nbody\n");
    const hits = groupSearchHits([
      { drawer_id: "d1", text: "chunk0", score: 0.5, metadata: { source_file: piFile, wing: "conc", room: "preference", added_by: "unipi", chunk_index: 0 } },
      { drawer_id: "d2", text: "chunk1", score: 0.9, metadata: { source_file: piFile, wing: "conc", room: "preference", added_by: "unipi", chunk_index: 1 } },
      { drawer_id: "d3", text: "foreign", score: 0.7, metadata: { source_file: "/somewhere/note.md", wing: "other", room: "general", added_by: "devin-cli" } },
    ], 10);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].score, 0.9); // best chunk wins
    assert.equal(hits[0].title, "prefers vim tabs"); // title from the md file
    assert.equal(hits[0].sourceLabel, "pi");
    assert.equal(hits[1].title, "note"); // basename for foreign drawers
    assert.equal(hits[1].sourceLabel, "devin-cli");
    assert.equal(hits[1].room, "general");
  } finally {
    process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("groupSearchHits falls back to similarity + drawer key", () => {
  const hits = groupSearchHits([
    { drawer_id: "x", text: "a", similarity: 0.4, metadata: {} },
    { drawer_id: "y", text: "b", similarity: 0.8, metadata: {} },
  ], 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].score, 0.8);
});
