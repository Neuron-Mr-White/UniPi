/**
 * @pi-unipi/utility — styled.ts: the render-style formatter for foreign
 * activity (sidekick steps, subagent items). Each style draws with the same
 * verbs/markers the lead's tools get.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatElapsed, renderStyle, styledTextLines, styledToolCallLines } from "../src/render/styled.ts";

const theme = {
  fg: (_c: string, t: string) => t,
  bold: (t: string) => t,
} as never as Theme;

const call = { name: "bash", arg: "npm test", output: "a\nb\nc", isError: false, durationMs: 1230 };

describe("styledToolCallLines", () => {
  it("simple: mcode row with past-tense verb and output-lines meta", () => {
    const lines = styledToolCallLines("simple", call, theme, 80);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^└ • Ran  npm test · 3 output lines · 1\.2s$/);
  });

  it("simple: running shows the verb and no meta", () => {
    const [row] = styledToolCallLines("simple", { ...call, running: true }, theme, 80);
    assert.match(row!, /^└ • Running  npm test/);
    assert.ok(!row!.includes("output lines"));
  });

  it("simple: failed swaps marker and verb, meta in error tone", () => {
    const [row] = styledToolCallLines("simple", { ...call, isError: true }, theme, 80);
    assert.match(row!, /^└ × Command failed/);
  });

  it("advanced: ◆ verb + │ gutter tail + └ status with duration", () => {
    const lines = styledToolCallLines("advanced", { ...call, output: "x\ny\nz\nw\nv\nu", durationMs: 4500 }, theme, 80);
    assert.match(lines[0]!, /^◆ Ran npm test$/);
    assert.ok(lines.some((l) => l.startsWith("│ ")), "guttered output");
    assert.match(lines.at(-1)!, /^└ Done · 4\.5s$/);
    assert.ok(lines.some((l) => l.includes("earlier lines")), "collapsed tail hint");
  });

  it("advanced: failed ends with └ Failed", () => {
    const lines = styledToolCallLines("advanced", { ...call, isError: true }, theme, 80);
    assert.match(lines.at(-1)!, /^└ Failed · 1\.2s$/);
  });

  it("regular: ◆ name arg + dim output tail", () => {
    const lines = styledToolCallLines("regular", call, theme, 80);
    assert.match(lines[0]!, /^◆ bash npm test$/);
    assert.ok(lines.includes("  a") && lines.includes("  c"));
  });

  it("expanded shows the whole output", () => {
    const out = Array.from({ length: 20 }, (_, i) => `l${String(i)}`).join("\n");
    const lines = styledToolCallLines("regular", { ...call, output: out, expanded: true }, theme, 80);
    for (let i = 0; i < 20; i++) assert.ok(lines.some((l) => l.trimEnd().endsWith(`l${String(i)}`)), `l${String(i)}`);
  });
});

describe("styledTextLines", () => {
  it("simple anchors prose with ●", () => {
    const lines = styledTextLines("simple", "the fix is in", {}, theme, 80);
    assert.ok(lines[0]!.includes("● the fix is in"));
  });

  it("regular/advanced render plain markdown", () => {
    const lines = styledTextLines("regular", "the fix is in", {}, theme, 80);
    assert.ok(lines.some((l) => l.includes("the fix is in")));
    assert.ok(!lines.some((l) => l.includes("●")), "no anchor outside simple");
  });

  it("thinking renders dimmed first when provided", () => {
    const lines = styledTextLines("regular", "answer", { thinking: "deep thought" }, theme, 80);
    assert.ok(lines.some((l) => l.includes("thinking")));
    assert.ok(lines.some((l) => l.includes("deep thought")));
  });
});

describe("formatElapsed / renderStyle", () => {
  it("matches pi's bash duration format", () => {
    assert.equal(formatElapsed(500), "500ms");
    assert.equal(formatElapsed(1230), "1.2s");
    assert.equal(formatElapsed(64_000), "1m 4s");
    assert.equal(formatElapsed(3_723_000), "1h 2m 3s");
  });

  it("renderStyle falls back to regular when the namespace is unregistered", () => {
    assert.equal(renderStyle("/nonexistent-cwd-for-style"), "regular");
  });
});
