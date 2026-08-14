import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { boundHelperOutput } from "../core-compat.ts";

const homes: string[] = [];
const originalHome = process.env.HOME;
afterEach(() => {
  process.env.HOME = originalHome;
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "unipi-helper-output-"));
  homes.push(home);
  process.env.HOME = home;
  return home;
}

describe("helper bounded output", () => {
  it("leaves small output inline", () => {
    tempHome();
    assert.deepEqual(boundHelperOutput("done", 1024), {
      text: "done",
      truncated: false,
      originalBytes: 4,
    });
  });

  it("spills exact large output and can reuse the same artifact reference", () => {
    tempHome();
    const source = "result line\n".repeat(1000);
    const first = boundHelperOutput(source, 2048);
    const second = boundHelperOutput(source, 2048, first.artifactPath);

    assert.equal(first.truncated, true);
    assert.equal(second.artifactPath, first.artifactPath);
    assert.equal(readFileSync(first.artifactPath!, "utf8"), source);
    assert.match(first.text, /Full output:/);
    assert.ok(Buffer.byteLength(first.text, "utf8") <= 2048);
  });
});
