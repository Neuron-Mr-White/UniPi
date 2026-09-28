/**
 * @pi-unipi/utility — response formatting helpers
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { asJson, diffStats, exitCode, langForPrefix, parseDiff, splitCommand, stripStatus, testSummary } from "../src/render/parse.ts";

describe("splitCommand", () => {
  it("highlights a python heredoc as python and keeps the shell around it", () => {
    const cmd = `cd /repo && grep -n x api.py &&\n  python - <<'PYEOF'\ns = open('a').read()\nprint(s)\nPYEOF\npython -c "import api; print('ok')"`;
    const segs = splitCommand(cmd);
    assert.deepEqual(segs.map((s) => [s.kind, s.lang]), [["shell", "bash"], ["code", "python"], ["shell", "bash"], ["code", "python"], ["shell", "bash"]]);
    assert.equal(segs[1]!.text, "s = open('a').read()\nprint(s)\n");
    assert.equal(segs[3]!.text, "import api; print('ok')");
    assert.equal(segs.map((s) => s.text).join(""), cmd);
  });
  it("uses the redirect target's extension for cat > file <<EOF", () => {
    assert.equal(langForPrefix("cat > config.yaml"), "yaml");
    assert.equal(splitCommand("cat > a.ts <<EOF\nconst x = 1;\nEOF")[1]!.lang, "typescript");
  });
  it("leaves plain commands as one shell segment", () => {
    assert.deepEqual(splitCommand("ls -la && git status").map((s) => s.kind), ["shell"]);
  });
});

describe("diff + status", () => {
  it("parses pi's display diff", () => {
    const rows = parseDiff(" 206     # comment\n+208     if x:\n+209         raise\n-210     old\n   ...\n 212 tail");
    assert.deepEqual(rows.map((r) => [r.kind, r.line]), [["ctx", 206], ["add", 208], ["add", 209], ["del", 210], ["gap", undefined], ["ctx", 212]]);
    assert.deepEqual(diffStats(rows), { added: 2, removed: 1 });
  });
  it("reads exit codes and strips the status line", () => {
    assert.equal(exitCode("boom\n\nCommand exited with code 2", true), 2);
    assert.equal(exitCode("ok", false), 0);
    assert.equal(stripStatus("out\n\nCommand exited with code 2"), "out");
  });
});

describe("output extras", () => {
  it("finds test summaries from node:test, vitest and cargo", () => {
    assert.deepEqual(testSummary("ℹ pass 83\nℹ fail 0"), { passed: 83, failed: 0 });
    assert.deepEqual(testSummary("      Tests  1 failed | 37 passed (38)"), { passed: 37, failed: 1 });
    assert.deepEqual(testSummary("test result: ok. 12 passed; 0 failed; 0 ignored"), { passed: 12, failed: 0 });
    assert.equal(testSummary("hello"), undefined);
  });
  it("pretty-prints whole-output JSON only", () => {
    assert.equal(asJson('{"a":1}'), '{\n  "a": 1\n}');
    assert.equal(asJson("not {json}"), undefined);
  });
});

describe("tint", () => {
  it("re-applies the background after resets and pads to width", async () => {
    const { tint } = await import("../src/render/tools.ts");
    const theme = { bg: (_c: string, t: string) => `\x1b[42m${t}\x1b[49m` } as never;
    const out = tint(theme, "toolSuccessBg", "a\x1b[0mb", 5);
    assert.equal(out, "\x1b[42ma\x1b[0m\x1b[42mb   \x1b[49m");
  });
});
