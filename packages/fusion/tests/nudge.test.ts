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

test("kanboard calls and assigned command heads are trivial", () => {
  for (const command of [
    "/home/oi/.pi/agent/npm/node_modules/@pi-unipi/kanboard-linux-x64/bin/unipi-kanboard --actor agent --project p list 2>&1 | head -100",
    `K="/x/bin/unipi-kanboard --actor agent --project p"; $K list 2>&1 | grep -c '\\[todo\\]'; $K show UNI-108`,
    'cd /r && /x/bin/unipi-kanboard --actor agent --project p start UNI-108; grep -rn "Non-trivial shell work" --include=*.ts packages | grep -v node_modules | head',
    'K="/x/unipi-kanboard"; ${K} finish UNI-108',
    'K="/x/unipi-kanboard"; "$K" list',
    'K="/x/unipi-kanboard"; "${K}" show UNI-108',
    '"/x/unipi-kanboard" list',
    "'/x/unipi-kanboard' list",
    'A=one K="/x/unipi-kanboard"; $K list',
    'MODE=test grep foo f',
  ]) {
    assert.equal(isTrivialShell(command), true, command);
  }
});

test("quoted shell operators do not split commands or count as redirects", () => {
  for (const command of [
    'grep -rn "in this request\\|bashStreak\\|isTrivial" packages/fusion/src/index.ts | head -50; git status --short | head -30; git log --oneline -3',
    'echo "a > b"',
    "grep 'x|y' f",
    'grep "a;b" f',
    'echo "a << b"',
    'echo "a && b || c"',
    "echo '$(rm -rf x)'",
    "echo '`rm -rf x`'",
    'echo a\\|b',
    'echo "a\\";b"',
    "ls\ngit status",
  ]) {
    assert.equal(isTrivialShell(command), true, command);
  }
});

test("unknown or mutating variable heads and unquoted writes remain non-trivial", () => {
  for (const command of [
    "$UNKNOWN run",
    "K=npm; $K install",
    'echo "$(rm -rf x)"',
    'echo "`rm -rf x`"',
    "echo hi > out",
    "cat <<EOF",
    "ls; npm test",
    'K="/x/unipi-kanboard"; $K list > out',
    'K=npm echo hi; $K install',
  ]) {
    assert.equal(isTrivialShell(command), false, command);
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
