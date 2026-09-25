import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSearchLines, renderStoreLine, MEMORY_TOOLS } from "../tools.js";

test("renderStoreLine shows outcome states", () => {
  const rec = { id: "m", title: "t", content: "c", tags: [], project: "conc", type: "decision" as const, created: "", updated: "" };
  const filed = renderStoreLine({ outcome: "filed", record: rec });
  assert.match(filed, /remembered t/);
  assert.match(filed, /conc › decision · filed ✓/);
  const queued = renderStoreLine({ outcome: "queued", record: rec });
  assert.match(queued, /queued ⧗/);
  const md = renderStoreLine({ outcome: "markdown-only", record: rec });
  assert.match(md, /markdown only ⚠/);
  const withSimilar = renderStoreLine({ outcome: "filed", record: rec }, ['"other" (80%)']);
  assert.match(withSimilar, /~ similar: "other" \(80%\)/);
});

test("renderSearchLines groups + bars", () => {
  const lines = renderSearchLines("vim", [
    { title: "a", wing: "w1", room: "preference", score: 0.75, snippet: "x", sourceLabel: "pi", isPiMemory: true },
    { title: "b", wing: "w2", room: "general", score: 0.4, snippet: "y", sourceLabel: "devin-cli", isPiMemory: false },
  ]);
  assert.match(lines[0], /recalled "vim" · 2 memories · 2 projects/);
  assert.match(lines[1], /▰▰▰▰▱ a  w1 › preference · pi/);
  assert.match(lines[2], /▰▰▱▱▱ b  w2 › general · devin/);
});

test("tool names", () => {
  assert.equal(MEMORY_TOOLS.STORE, "memory_store");
  assert.equal(MEMORY_TOOLS.SEARCH, "memory_search");
  assert.equal(MEMORY_TOOLS.DELETE, "memory_delete");
  assert.equal(MEMORY_TOOLS.LIST, "memory_list");
});
