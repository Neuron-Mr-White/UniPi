/**
 * Fusion sidekick-step grouping: adjacent `sidekick-step` entries must render
 * as one joined tree inside the `▏` rail — `├…├…└` in simple mode — instead
 * of isolated rows separated by blank lines.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { setSettings } from "@pi-unipi/core";
// Registers the "utility" settings namespace (module side effect).
import "@pi-unipi/utility/src/settings.js";
import { patchTranscriptSpacing, type TranscriptContainer } from "@pi-unipi/utility/src/render/spacing.js";
import { renderSidekickStep } from "../src/transcript.js";
import type { SidekickStep } from "../src/sidekick-runtime.js";

initTheme("dark");
// a scratch cwd keeps the settings-version marker out of the repo
setSettings("utility", { render: { style: "simple" } }, "global", mkdtempSync(join(tmpdir(), "uni-fusion-")));

const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;]*m/g;
const strip = (s: string) => s.replace(ANSI, "").trimEnd();
const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s, getBgAnsi: () => "" };

const tool = (over: Partial<Extract<SidekickStep, { kind: "tool" }>>): SidekickStep =>
  ({ kind: "tool", name: "read", arg: "src/a.ts", output: "", isError: false, durationMs: 10, ...over });
const text = (body: string): SidekickStep => ({ kind: "text", text: body });

function chatWith(children: Array<{ render(w: number): string[] }>): TranscriptContainer {
  return { children: children as never, render: (w: number) => children.flatMap((c) => c.render(w)) };
}

test("three consecutive tool steps join into one ├…├…└ rail block (simple)", () => {
  const children = [
    renderSidekickStep(tool({ name: "read", arg: "src/a.ts" }), false, theme),
    renderSidekickStep(tool({ name: "bash", arg: "npm test", output: "ok" }), false, theme),
    renderSidekickStep(tool({ name: "edit", arg: "src/a.ts" }), false, theme),
  ];
  const chat = chatWith(children);
  patchTranscriptSpacing(chat);
  const lines = chat.render(80).map(strip);
  assert.equal(lines.length, 3, "no blank rows between rail members");
  assert.match(lines[0]!, /^▏ ├ • Read \(src\/a\.ts\)/);
  assert.match(lines[1]!, /^▏ ├ • Ran {2}npm test/);
  assert.match(lines[2]!, /^▏ └ • Edited \(src\/a\.ts\)/);
});

test("a text step keeps the same group; the tool run after it trees normally", () => {
  const children = [
    renderSidekickStep(text("checking the loader"), false, theme),
    renderSidekickStep(tool({ name: "read", arg: "src/a.ts" }), false, theme),
    renderSidekickStep(tool({ name: "bash", arg: "npm test" }), false, theme),
  ];
  const chat = chatWith(children);
  patchTranscriptSpacing(chat);
  const lines = chat.render(80).map(strip);
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /^▏ ● checking the loader/);
  assert.match(lines[1]!, /^▏ ├ • Read/);
  assert.match(lines[2]!, /^▏ └ • Ran/);
});

test("a tool step followed by prose ends its tree run (└)", () => {
  const children = [
    renderSidekickStep(tool({ name: "read", arg: "src/a.ts" }), false, theme),
    renderSidekickStep(text("done looking"), false, theme),
    renderSidekickStep(tool({ name: "read", arg: "src/b.ts" }), false, theme),
  ];
  const chat = chatWith(children);
  patchTranscriptSpacing(chat);
  const lines = chat.render(80).map(strip);
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /^▏ └ • Read \(src\/a\.ts\)/, "next is prose → └");
  assert.match(lines[1]!, /^▏ ● done looking/);
  assert.match(lines[2]!, /^▏ └ • Read \(src\/b\.ts\)/);
});

test("without a position (patch absent) steps fall back to └", () => {
  const comp = renderSidekickStep(tool({ name: "read", arg: "x.ts" }), false, theme);
  assert.match(strip(comp.render(80)[0]!), /^▏ └ • Read/);
});

test("a non-sidekick block between steps still gets the blank row", () => {
  const plain = { render: () => ["lead text"], invalidate() {} };
  const chat = chatWith([
    renderSidekickStep(tool({ name: "read", arg: "a" }), false, theme),
    plain,
    renderSidekickStep(tool({ name: "read", arg: "b" }), false, theme),
  ] as never);
  patchTranscriptSpacing(chat);
  const lines = chat.render(80).map(strip);
  assert.equal(lines.length, 5);
  assert.equal(lines[1], "");
  assert.equal(lines[3], "");
});

test("identity groups: same handoff joins, different handoffs separate", () => {
  const same = chatWith([
    renderSidekickStep(tool({ name: "read", arg: "a.ts" }), false, theme, { group: "sidekick:h1", label: "Sidekick" }),
    renderSidekickStep(tool({ name: "bash", arg: "npm test", output: "ok" }), false, theme, { group: "sidekick:h1", label: "Sidekick" }),
  ]);
  patchTranscriptSpacing(same);
  const joined = same.render(80).map(strip);
  assert.equal(joined.length, 3, "header + 2 rows, no gap inside a handoff");
  assert.equal(joined[0], "▏ ◆ Sidekick");

  const separate = chatWith([
    renderSidekickStep(tool({ name: "read", arg: "a.ts" }), false, theme, { group: "sidekick:h1", label: "Sidekick" }),
    renderSidekickStep(tool({ name: "bash", arg: "npm test", output: "ok" }), false, theme, { group: "sidekick:h2", label: "Sidekick" }),
  ]);
  patchTranscriptSpacing(separate);
  const lines = separate.render(80).map(strip);
  assert.ok(lines.some((l, i) => i > 0 && l === "" && lines[i - 1]!.startsWith("▏")), "gap between resumed handoffs");
  assert.equal(lines.filter((l) => l === "▏ ◆ Sidekick").length, 2, "each handoff labels its own panel");
});
