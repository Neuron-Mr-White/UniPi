import { test } from "node:test";
import assert from "node:assert/strict";
import { getMoveHandlers, registerMoveHandler } from "./move.js";

test("move handlers replace registrations by id and expose discovery", async () => {
  const first = { id: "test-move", label: "first", scan: () => [] };
  const second = { id: "test-move", label: "second", scan: () => [], discoverOrphans: async () => ["/missing"] };
  registerMoveHandler(first);
  registerMoveHandler(second);
  assert.deepEqual(getMoveHandlers().filter((h) => h.id === first.id), [second]);
  assert.deepEqual(await second.discoverOrphans(), ["/missing"]);
});
