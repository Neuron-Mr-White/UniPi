import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { boundModelOutput } from "./bounded-output.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "unipi-bounded-output-"));
  dirs.push(dir);
  return dir;
}

describe("boundModelOutput", () => {
  it("returns small UTF-8 output unchanged without writing an artifact", () => {
    const result = boundModelOutput("small ✓", { maxBytes: 1024, artifactDir: tempDir() });
    assert.deepEqual(result, {
      text: "small ✓",
      truncated: false,
      originalBytes: 9,
      visibleBytes: 9,
    });
  });

  it("bounds large output and writes an exact private artifact", () => {
    const dir = tempDir();
    const source = `${"head α\n".repeat(500)}${"tail Ω\n".repeat(500)}`;
    const result = boundModelOutput(source, {
      maxBytes: 2048,
      artifactDir: dir,
      artifactPrefix: "mcp/server:tool",
    });

    assert.equal(result.truncated, true);
    assert.ok(result.artifactPath?.startsWith(dir));
    assert.equal(readFileSync(result.artifactPath!, "utf8"), source);
    assert.ok(result.visibleBytes <= 2048, "complete model-visible result must honor the ceiling");
    assert.match(result.text, /Full output:/);
    assert.match(result.text, /Use the read tool with offset\/limit/);
    assert.equal(statSync(result.artifactPath!).mode & 0o077, 0);
  });

  it("refuses a symlink artifact directory", () => {
    const root = tempDir();
    const target = join(root, "target");
    const link = join(root, "link");
    // mkdir is performed by boundModelOutput; create a safe target first.
    boundModelOutput("x".repeat(2000), { maxBytes: 1024, artifactDir: target });
    symlinkSync(target, link, "dir");
    const result = boundModelOutput("x".repeat(2000), { maxBytes: 1024, artifactDir: link });
    assert.equal(result.truncated, true);
    assert.equal(result.artifactPath, undefined);
    assert.match(result.text, /artifact unavailable.*unsafe tool-result directory/i);
  });
});
