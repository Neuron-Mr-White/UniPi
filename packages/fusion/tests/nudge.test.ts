import { test } from "node:test";
import assert from "node:assert/strict";
import { isTrivialShell } from "../src/nudge.js";

test("recognizes read-only trivial shell commands", () => {
  for (const command of ["git status", "ls -la src", "cd /x && git log --oneline -3", "rg -n foo packages"]) {
    assert.equal(isTrivialShell(command), true, command);
  }
});

test("chained and piped read-only commands are trivial", () => {
  for (const command of [
    "ls | wc -l",
    "grep -rn foo src | head -20",
    "cd a; git diff --stat",
    "sed -n 1,40p f.ts",
    "find . -name '*.ts' | head",
    "cat a 2>&1 | head",
    "timeout 5 git log -3",
  ]) {
    assert.equal(isTrivialShell(command), true, command);
  }
});

test("harmless redirects do not make a command non-trivial, writes do", () => {
  assert.equal(isTrivialShell("cat a 2>/dev/null"), true);
  assert.equal(isTrivialShell("ls >x"), false);
  assert.equal(isTrivialShell("echo hi >> log"), false);
});

test("implementation and chained shell commands are non-trivial", () => {
  for (const command of [
    "npm test",
    "git commit -m x",
    "git status && npm run build",
    "python3 script.py",
    "echo x > f",
    "sed -i s/a/b/ f",
    "find . -delete",
    "ls $(pwd)",
    "cat <<EOF",
    "rm -rf x",
  ]) {
    assert.equal(isTrivialShell(command), false, command);
  }
});
