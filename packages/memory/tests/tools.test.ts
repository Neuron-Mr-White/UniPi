import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryCard, searchRows, storeRows, MEMORY_TOOLS } from "../tools.js";

const plain = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const render = (rows: Parameters<typeof memoryCard>[1], w = 100) => memoryCard(plain, rows).render(w);

test("store card: rail, title left, outcome + place right", () => {
  const [filed] = render(storeRows(plain, { action: "created", title: "t", project: "conc", type: "decision", outcome: "filed" }));
  assert.match(filed!, /^▌ Memory t\s+✓ filed conc › decision$/);
  assert.match(render(storeRows(plain, { title: "t", outcome: "queued" }))[0]!, /⧗ queued/);
  assert.match(render(storeRows(plain, { title: "t", outcome: "markdown-only" }))[0]!, /⚠ markdown only/);
  assert.match(render(storeRows(plain, { title: "t", outcome: "filed", action: "updated" }))[0]!, /Memory updated t/);
  const similar = render(storeRows(plain, { title: "t", outcome: "filed", similar: ['"other" (80%)'] }));
  assert.equal(similar[1], '▌ ~ similar: "other" (80%)');
});

test("search card: head with counts, one meter row per hit", () => {
  const lines = render(searchRows(plain, "vim", [
    { title: "a", wing: "w1", room: "preference", score: 0.75, snippet: "x", sourceLabel: "pi", isPiMemory: true },
    { title: "b", wing: "w2", room: "general", score: 0.4, snippet: "y", sourceLabel: "devin-cli", isPiMemory: false },
  ]));
  assert.match(lines[0]!, /^▌ Memory "vim"\s+2 hits · 2 projects$/);
  assert.match(lines[1]!, /^▌ ██████░░ a\s+w1 › preference · pi$/);
  assert.match(lines[2]!, /^▌ ███▎░░░░ b\s+w2 › general · devin$/);
  for (const l of lines) assert.equal(l.length, 100, "right side is aligned to the width");
});

test("tool names", () => {
  assert.equal(MEMORY_TOOLS.STORE, "memory_store");
  assert.equal(MEMORY_TOOLS.SEARCH, "memory_search");
  assert.equal(MEMORY_TOOLS.DELETE, "memory_delete");
  assert.equal(MEMORY_TOOLS.LIST, "memory_list");
});
