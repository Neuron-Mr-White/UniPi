import { test } from "node:test";
import assert from "node:assert/strict";
import { progressLines } from "@pi-unipi/core";
import { boardProgressData } from "../src/progress.js";

const plain = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const t = (status: string) => ({ status });

test("board bar: review+done solid, in progress shaded, backlog/cancelled left out", () => {
  const d = boardProgressData([t("done"), t("in_review"), t("in_progress"), t("todo"), t("blocked"), t("backlog"), t("cancelled")], "unipi")!;
  assert.deepEqual([d.done, d.active, d.total], [2, 1, 5]);
  assert.equal(progressLines(plain, d, 100)[0], "▣ Board · unipi  ████████▒▒▒▒░░░░░░░░  2/5 tasks  1 blocked");
  assert.equal(boardProgressData([t("backlog")], "x"), undefined, "nothing schedulable → no bar");
});
