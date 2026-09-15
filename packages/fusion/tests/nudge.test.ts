import { test } from "node:test";
import assert from "node:assert/strict";
import { isTrivialShell } from "../src/nudge.js";

test("recognizes read-only trivial shell commands", () => {
  for (const command of ["git status", "ls -la src", "cd /x && git log --oneline -3", "rg -n foo packages"]) {
    assert.equal(isTrivialShell(command), true, command);
  }
});

test("rejects implementation and chained shell commands", () => {
  for (const command of ["npm test", "git commit -m x", "ls | wc -l", "git status && npm run build", "python3 script.py"]) {
    assert.equal(isTrivialShell(command), false, command);
  }
});
