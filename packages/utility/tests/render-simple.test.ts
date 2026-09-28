/**
 * @pi-unipi/utility — "simple" render style (mcode transcript) unit tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { simpleToolLine, simpleWrapTool, targetArg, titleCaseTool, simpleWrapped } from "../src/render/simple.ts";

const theme = {
  fg: (_c: string, t: string) => t,
  bold: (t: string) => t,
} as never as Theme;

const strip = (s: string) => s;

describe("titleCaseTool", () => {
  it("maps snake/kebab names to mcode's Title Case", () => {
    assert.equal(titleCaseTool("get_goal"), "Get Goal");
    assert.equal(titleCaseTool("memory_search"), "Memory Search");
    assert.equal(titleCaseTool("sidekick"), "Sidekick");
  });
});

describe("targetArg", () => {
  const cwd = "/repo";
  it("prefers the command for shell tools", () => {
    assert.equal(targetArg("bash", { command: "git log", other: "x" }, cwd), "git log");
  });
  it("grep shows the pattern and search root", () => {
    assert.equal(targetArg("grep", { pattern: "TODO", path: "/repo/src" }, cwd), "TODO in ./src");
  });
  it("falls back to the first string argument (path-shortened)", () => {
    assert.equal(targetArg("read", { file_path: "/repo/package.json" }, cwd), "./package.json");
    assert.equal(targetArg("read", { file_path: "/other/x.ts" }, cwd), "/other/x.ts");
  });
  it("returns empty when there is nothing to show", () => {
    assert.equal(targetArg("get_goal", {}, cwd), "");
  });
});

describe("simpleToolLine", () => {
  it("renders the mcode collapsed row: gutter, marker, bold verb, muted target", () => {
    const line = simpleToolLine(theme, "read", { file_path: "/repo/pkg.json" }, {
      running: false, cwd: "/repo", width: 200,
    });
    assert.equal(strip(line), "└ • Read (./pkg.json)");
  });
  it("shell rows use the double-space command form", () => {
    const line = simpleToolLine(theme, "bash", { command: "npm test" }, {
      running: false, cwd: "/repo", width: 200,
    });
    assert.equal(strip(line), "└ • Ran  npm test");
  });
  it("appends the output line count with correct pluralization", () => {
    const mk = (text: string) => ({ content: [{ type: "text", text }] }) as never;
    const one = simpleToolLine(theme, "bash", { command: "ls" }, { running: false, result: mk("a"), cwd: "/repo", width: 200 });
    const two = simpleToolLine(theme, "bash", { command: "ls" }, { running: false, result: mk("a\nb"), cwd: "/repo", width: 200 });
    assert.equal(strip(one), "└ • Ran  ls · 1 output line");
    assert.equal(strip(two), "└ • Ran  ls · 2 output lines");
  });
  it("failed results flip the marker and the verb", () => {
    const res = { isError: true, content: [{ type: "text", text: "boom" }] } as never;
    const line = simpleToolLine(theme, "bash", { command: "nope" }, { running: false, failed: true, result: res, cwd: "/repo", width: 200 });
    assert.equal(strip(line), "└ × Command failed  nope · 1 output line");
  });
  it("running rows get the running verb and an ellipsis", () => {
    const line = simpleToolLine(theme, "grep", { pattern: "TODO" }, { running: true, cwd: "/repo", width: 200 });
    assert.equal(strip(line), "└ • Searching (TODO) …");
  });
  it("unknown tools fall back to Title Case of the tool name", () => {
    const line = simpleToolLine(theme, "get_goal", {}, { running: false, cwd: "/repo", width: 200 });
    assert.equal(strip(line), "└ • Get Goal");
  });
  it("truncates to width", () => {
    const line = simpleToolLine(theme, "bash", { command: "x".repeat(300) }, { running: false, cwd: "/repo", width: 40 });
    assert.ok(line.length <= 60);
    assert.ok(line.includes("…"));
  });
});

describe("simpleWrapTool", () => {
  const base = {
    name: "memory_search",
    label: "Memory Search",
    description: "d",
    parameters: {} as never,
    execute: async () => ({ content: [], details: undefined }),
    renderCall: () => ({ render: () => ["ORIGINAL"] }) as never,
    renderResult: () => ({ render: () => ["ORIGINAL_RESULT"] }) as never,
  };
  it("keeps execute/schema and forces renderShell self", () => {
    const wrapped = simpleWrapTool(base as never);
    assert.equal(wrapped.execute, base.execute);
    assert.equal(wrapped.parameters, base.parameters);
    assert.equal(wrapped.renderShell, "self");
    assert.ok(simpleWrapped.has(wrapped));
  });
  it("call row shows the mcode line; once the result lands it swaps in place; result row is empty", () => {
    const wrapped = simpleWrapTool(base as never) as typeof base;
    const themeArg = theme;
    const state: { result?: unknown } = {};
    const ctx = { expanded: false, executionStarted: true, argsComplete: true, cwd: "/repo", args: { query: "x" }, state, isError: false, invalidate: () => {} } as never;
    const call = wrapped.renderCall!({ query: "x" } as never, themeArg, ctx);
    const runningLine = (call as { render: (w: number) => string[] }).render(120)[0];
    assert.match(runningLine, /Memory Search/);
    assert.match(runningLine, /…/);
    const res = { isError: false, content: [{ type: "text", text: "a" }] } as never;
    const resultComp = wrapped.renderResult!(res, { expanded: false, isPartial: false } as never, themeArg, ctx);
    assert.deepEqual((resultComp as { render: (w: number) => string[] }).render(120), []);
    const doneLine = (call as { render: (w: number) => string[] }).render(120)[0];
    assert.match(doneLine, /1 output line/);
    assert.ok(!doneLine.includes("…"));
    const expanded = wrapped.renderCall!({ query: "x" } as never, themeArg, { ...ctx, expanded: true } as never);
    assert.equal((expanded as { render: (w: number) => string[] }).render(120)[0], "ORIGINAL");
  });
});

describe("targetArg multi-line flattening", () => {
  it("keeps the first non-empty line and marks the elision", () => {
    assert.equal(targetArg("memory_store", { content: "---\nid: x\nbody" }, "/tmp"), "--- …");
  });
  it("prefers title over multi-line content", () => {
    assert.equal(targetArg("memory_store", { title: "my_title", content: "a\nb" }, "/tmp"), "my_title");
  });
  it("flattens multi-line shell commands", () => {
    assert.equal(targetArg("bash", { command: "echo a\necho b" }, "/tmp"), "echo a …");
  });
  it("single-line values are untouched", () => {
    assert.equal(targetArg("bash", { command: "ls -la" }, "/tmp"), "ls -la");
    assert.equal(targetArg("read", { file_path: "/repo/pkg.json" }, "/repo"), "./pkg.json");
  });
  it("the assembled row never contains a newline", () => {
    const res = { content: [{ type: "text", text: "out" }] } as never;
    for (const args of [
      { command: "echo a\necho b" },
      { title: "t\nu", content: "c\nd" },
      { query: "x\ny" },
      { path: "/a\nb" },
    ]) {
      const line = simpleToolLine(theme, "memory_store", args, { running: false, result: res, cwd: "/repo", width: 200 });
      assert.ok(!line.includes("\n"), JSON.stringify(line));
    }
  });
});
