/**
 * @pi-unipi/utility — "simple" render style (mcode transcript) unit tests
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  simpleToolLine,
  simpleWrapTool,
  targetArg,
  titleCaseTool,
  simpleWrapped,
  planGroupRows,
  resetSimpleGroups,
  noteGroupBreak,
  installSimpleGroupEvents,
  anchorAssistant,
  type GroupCall,
  type RowFn,
  type SummaryFn,
} from "../src/render/simple.ts";

const theme = {
  fg: (_c: string, t: string) => t,
  bold: (t: string) => t,
} as never as Theme;

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
      const line = simpleToolLine(theme, "memory_store", targetArg("memory_store", args, "/repo"), {
        running: false, failed: false, meta: " · 1 output line", width: 200,
      });
      assert.ok(!line.includes("\n"), JSON.stringify(line));
      assert.ok(!res || true);
    }
  });
});

describe("simpleToolLine", () => {
  it("renders the mcode collapsed row: gutter, marker, bold verb, muted target", () => {
    const line = simpleToolLine(theme, "read", "./pkg.json", { running: false, width: 200 });
    assert.equal(line, "└ • Read (./pkg.json)");
  });
  it("shell rows use the double-space command form", () => {
    const line = simpleToolLine(theme, "bash", "npm test", { running: false, width: 200 });
    assert.equal(line, "└ • Ran  npm test");
  });
  it("meta text is appended verbatim (caller supplies ' · N output lines')", () => {
    const line = simpleToolLine(theme, "bash", "ls", { running: false, meta: " · 1 output line", width: 200 });
    assert.equal(line, "└ • Ran  ls · 1 output line");
    const two = simpleToolLine(theme, "bash", "ls", { running: false, meta: " · 2 output lines", width: 200 });
    assert.equal(two, "└ • Ran  ls · 2 output lines");
  });
  it("failed rows flip the marker and the verb", () => {
    const line = simpleToolLine(theme, "bash", "nope", { running: false, failed: true, meta: " · 1 output line", width: 200 });
    assert.equal(line, "└ × Command failed  nope · 1 output line");
  });
  it("running rows get the running verb and an ellipsis", () => {
    const line = simpleToolLine(theme, "grep", "TODO", { running: true, width: 200 });
    assert.equal(line, "└ • Searching (TODO) …");
  });
  it("unknown tools fall back to Title Case of the tool name", () => {
    const line = simpleToolLine(theme, "get_goal", "", { running: false, width: 200 });
    assert.equal(line, "└ • Get Goal");
  });
  it("truncates to width and takes the connector", () => {
    const line = simpleToolLine(theme, "bash", "x".repeat(300), { running: false, connector: "├", width: 40 });
    assert.ok(line.length <= 60);
    assert.ok(line.includes("…"));
    assert.ok(line.startsWith("├"));
  });
});

// ─── group planner (mcode rules) ──────────────────────────────────────────

const rowFn: RowFn = (c, o) => `${o.connector} ${c.name}:${c.target}${o.running ? " …" : ""}`;
const summaryFn: SummaryFn = (s) =>
  `${s.connector} ${s.running ? s.actionRunning : s.actionDone} ${s.opCount} ${s.noun}` +
  (s.failedCount === s.total ? " · failed" : s.failedCount ? ` · ${s.failedCount} failed` : "") +
  (s.total > s.opCount ? ` · ${s.total} calls` : "");

const call = (id: string, name: string, extra: Partial<GroupCall> = {}): GroupCall => ({
  id, name, target: `${name}-${id}`, meta: "", failed: false, running: false, ...extra,
});

describe("planGroupRows (mcode collapse rules)", () => {
  it("a single read call stays its own └ row", () => {
    const rows = planGroupRows([call("1", "read")], rowFn, summaryFn);
    assert.deepEqual(rows, [{ id: "1", row: "└ read:read-1" }]);
  });

  it("two finished reads collapse to 'Read 2 files' on the first id; the rest render null", () => {
    const rows = planGroupRows([call("1", "read"), call("2", "read")], rowFn, summaryFn);
    assert.deepEqual(rows, [
      { id: "1", row: "└ Read 2 files" },
      { id: "2", row: null },
    ]);
  });

  it("mixed read categories collapse to 'Explored N operations'", () => {
    const rows = planGroupRows([call("1", "read"), call("2", "grep"), call("3", "ls")], rowFn, summaryFn);
    assert.deepEqual(rows, [
      { id: "1", row: "└ Explored 3 operations" },
      { id: "2", row: null },
      { id: "3", row: null },
    ]);
  });

  it("grep-only runs are 'Searched N searches', ls-only runs 'Listed N paths'", () => {
    const g = planGroupRows([call("1", "grep"), call("2", "grep")], rowFn, summaryFn);
    assert.equal(g[0]!.row, "└ Searched 2 searches");
    const l = planGroupRows([call("1", "ls"), call("2", "find")], rowFn, summaryFn);
    assert.equal(l[0]!.row, "└ Listed 2 paths");
  });

  it("while the group runs, summary so far plus the live latest row", () => {
    const rows = planGroupRows([call("1", "read"), call("2", "read", { running: true })], rowFn, summaryFn);
    assert.deepEqual(rows, [
      { id: "1", row: "├ Reading 2 files" },
      { id: "2", row: "└ read:read-2 …" },
    ]);
  });

  it("bash rows never collapse and sit between read runs with ├/└ connectors", () => {
    const rows = planGroupRows(
      [call("1", "read"), call("2", "read"), call("3", "bash"), call("4", "grep"), call("5", "grep")],
      rowFn,
      summaryFn,
    );
    assert.deepEqual(rows, [
      { id: "1", row: "├ Read 2 files" },
      { id: "2", row: null },
      { id: "3", row: "├ bash:bash-3" },
      { id: "4", row: "└ Searched 2 searches" },
      { id: "5", row: null },
    ]);
  });

  it("a lone read between shells keeps its own row", () => {
    const rows = planGroupRows([call("1", "bash"), call("2", "read"), call("3", "bash")], rowFn, summaryFn);
    assert.deepEqual(rows.map((r) => r.row), ["├ bash:bash-1", "├ read:read-2", "└ bash:bash-3"]);
  });

  it("failures surface on the summary (all failed → · failed)", () => {
    const rows = planGroupRows([call("1", "read", { failed: true }), call("2", "read", { failed: true })], rowFn, summaryFn);
    assert.equal(rows[0]!.row, "└ Read 2 files · failed"); // mcode: all failed → " · failed"
  });

  it("repeated identical operations count once but note the attempt count", () => {
    const dup = (id: string): GroupCall => ({ id, name: "read", target: "same", meta: "", failed: false, running: false });
    const rows = planGroupRows([dup("1"), dup("2"), dup("3")], rowFn, summaryFn);
    assert.match(rows[0]!.row!, /Read 1 files · 3 calls/);
  });

  it("connectors: ├ for every row except the last", () => {
    const rows = planGroupRows(
      [call("1", "read"), call("2", "read"), call("3", "bash")],
      (c, o) => `${o.connector}:${c.id}`,
      (s) => `${s.connector}:summary-${s.opCount}`,
    );
    assert.deepEqual(rows, [
      { id: "1", row: "├:summary-2" },
      { id: "2", row: null },
      { id: "3", row: "└:3" },
    ]);
  });
});

// ─── the wrapper ──────────────────────────────────────────────────────────

const base = {
  name: "memory_search",
  label: "Memory Search",
  description: "d",
  parameters: {} as never,
  execute: async () => ({ content: [], details: undefined }),
  renderCall: () => ({ render: () => ["ORIGINAL"] }) as never,
  renderResult: () => ({ render: () => ["ORIGINAL_RESULT"] }) as never,
};

describe("simpleWrapTool", () => {
  beforeEach(() => resetSimpleGroups());

  it("keeps execute/schema and forces renderShell self", () => {
    const wrapped = simpleWrapTool(base as never);
    assert.equal(wrapped.execute, base.execute);
    assert.equal(wrapped.parameters, base.parameters);
    assert.equal(wrapped.renderShell, "self");
    assert.ok(simpleWrapped.has(wrapped));
  });

  it("collapsed render is the mcode row; expanded falls back to the original renderer", () => {
    const wrapped = simpleWrapTool(base as never) as typeof base;
    const ctx = { expanded: false, executionStarted: true, argsComplete: true, cwd: "/repo", args: { query: "x" }, toolCallId: "t1" } as never;
    const call = wrapped.renderCall!({ query: "x" } as never, theme, ctx);
    const runningLine = (call as { render: (w: number) => string[] }).render(120)[0];
    assert.match(runningLine, /Memory Search/);
    assert.match(runningLine, /…/);
    const res = { isError: false, content: [{ type: "text", text: "a" }] } as never;
    const resultComp = wrapped.renderResult!(res, { expanded: false, isPartial: false } as never, theme, ctx);
    assert.deepEqual((resultComp as { render: (w: number) => string[] }).render(120), []);
    const doneLine = (call as { render: (w: number) => string[] }).render(120)[0];
    assert.match(doneLine, /1 output line/);
    assert.ok(!doneLine.includes("…"));
    const expanded = wrapped.renderCall!({ query: "x" } as never, theme, { ...ctx, expanded: true } as never);
    assert.equal((expanded as { render: (w: number) => string[] }).render(120)[0], "ORIGINAL");
  });

  it("two consecutive read-like calls collapse to the summary row once both are done", () => {
    const def = { ...base, name: "read" } as never;
    const wrapped = simpleWrapTool(def) as typeof base;
    const mk = (id: string) => ({ expanded: false, cwd: "/repo", args: { file_path: `/repo/f${id}` }, toolCallId: id }) as never;
    const c1 = wrapped.renderCall!({ file_path: "/repo/f1" } as never, theme, mk("1"));
    const c2 = wrapped.renderCall!({ file_path: "/repo/f2" } as never, theme, mk("2"));
    const res = (n: number) => ({ isError: false, content: [{ type: "text", text: "x\n".repeat(n) }] }) as never;
    // both running: summary so far + live latest row
    const mid = (c2 as { render: (w: number) => string[] }).render(160);
    assert.deepEqual(mid, [" └ • Reading (./f2) …"]);
    wrapped.renderResult!(res(1), { expanded: false, isPartial: true } as never, theme, mk("1"));
    wrapped.renderResult!(res(1), { expanded: false, isPartial: false } as never, theme, mk("1"));
    // one done, one still running: c1 shows the ├ summary, c2 the └ live row
    const during1 = (c1 as { render: (w: number) => string[] }).render(160);
    const during2 = (c2 as { render: (w: number) => string[] }).render(160);
    assert.deepEqual(during1, [" ├ • Reading 2 files"]);
    assert.deepEqual(during2, [" └ • Reading (./f2) …"]);
    wrapped.renderResult!(res(1), { expanded: false, isPartial: false } as never, theme, mk("2"));
    // both done: single packed summary row
    assert.deepEqual((c1 as { render: (w: number) => string[] }).render(160), [" └ • Read 2 files"]);
    assert.deepEqual((c2 as { render: (w: number) => string[] }).render(160), []);
  });

  it("assistant text breaks the group (noteGroupBreak)", () => {
    const def = { ...base, name: "read" } as never;
    const wrapped = simpleWrapTool(def) as typeof base;
    const mk = (id: string) => ({ expanded: false, cwd: "/repo", args: {}, toolCallId: id }) as never;
    const c1 = wrapped.renderCall!({} as never, theme, mk("1"));
    wrapped.renderResult!({ isError: false, content: [{ type: "text", text: "a" }] } as never, { expanded: false, isPartial: false } as never, theme, mk("1"));
    noteGroupBreak();
    const c2 = wrapped.renderCall!({} as never, theme, mk("2"));
    wrapped.renderResult!({ isError: false, content: [{ type: "text", text: "a" }] } as never, { expanded: false, isPartial: false } as never, theme, mk("2"));
    const l1 = (c1 as { render: (w: number) => string[] }).render(160)[0];
    const l2 = (c2 as { render: (w: number) => string[] }).render(160)[0];
    assert.match(l1!, /└ • Read/);
    assert.match(l2!, /└ • Read/);
  });
});

describe("installSimpleGroupEvents (simple mode)", () => {
  beforeEach(() => resetSimpleGroups());

  function fakePi() {
    const handlers = new Map<string, Array<(e: any, ctx?: any) => void>>();
    const transformers: Array<(md: string, c: { messageType: string }) => string> = [];
    return {
      handlers,
      transformers,
      on: (ev: string, h: (e: any, ctx?: any) => void) => handlers.set(ev, [...(handlers.get(ev) ?? []), h]),
      registerMarkdownTransformer: (fn: (md: string, c: { messageType: string }) => string) => transformers.push(fn),
      emit(ev: string, e: any, ctx?: any) {
        for (const h of handlers.get(ev) ?? []) h(e, ctx);
      },
    };
  }

  const readDef = { ...base, name: "read" } as never;
  const mk = (id: string) => ({ expanded: false, cwd: "/repo", args: { file_path: `/repo/f${id}` }, toolCallId: id }) as never;
  const done = (w: any, id: string) =>
    w.renderResult!({ isError: false, content: [{ type: "text", text: "a" }] } as never, { expanded: false, isPartial: false } as never, theme, mk(id));

  it("hides thinking: empty hidden-thinking label + thinking markdown transformed to nothing", () => {
    const pi = fakePi();
    installSimpleGroupEvents(pi);
    let label: string | undefined = "Thinking...";
    pi.emit("session_start", {}, { ui: { setHiddenThinkingLabel: (l?: string) => { label = l; } } });
    assert.equal(label, "");
    assert.equal(pi.transformers.length, 1);
    assert.equal(pi.transformers[0]!("deep thoughts", { messageType: "assistant-thinking" }), "");
    assert.equal(pi.transformers[0]!("hello", { messageType: "assistant" }), "● hello");
    assert.equal(pi.transformers[0]!("hi", { messageType: "user" }), "hi");
  });

  it("thinking-only / tool-only messages do not break the group; streamed text does", () => {
    const pi = fakePi();
    installSimpleGroupEvents(pi);
    const w = simpleWrapTool(readDef) as typeof base;
    const c1 = w.renderCall!({ file_path: "/repo/f1" } as never, theme, mk("1"));
    done(w, "1");
    // a message that only thinks, then calls another tool: same group
    pi.emit("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } });
    pi.emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "  " } });
    pi.emit("message_end", { message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "toolCall" }] } });
    const c2 = w.renderCall!({ file_path: "/repo/f2" } as never, theme, mk("2"));
    done(w, "2");
    assert.deepEqual((c1 as any).render(160), [" └ • Read 2 files"]);
    assert.deepEqual((c2 as any).render(160), []);
    // visible text streams in: next call starts a fresh group
    pi.emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "Reading one more." } });
    const c3 = w.renderCall!({ file_path: "/repo/f3" } as never, theme, mk("3"));
    done(w, "3");
    assert.deepEqual((c1 as any).render(160), [" └ • Read 2 files"]);
    assert.match((c3 as any).render(160)[0], /^ └ • Read \(\.\/f3\)/);
  });

  it("a new user message breaks the group", () => {
    const pi = fakePi();
    installSimpleGroupEvents(pi);
    const w = simpleWrapTool(readDef) as typeof base;
    const c1 = w.renderCall!({ file_path: "/repo/f1" } as never, theme, mk("1"));
    done(w, "1");
    pi.emit("message_start", { message: { role: "user", content: "next" } });
    const c2 = w.renderCall!({ file_path: "/repo/f2" } as never, theme, mk("2"));
    done(w, "2");
    assert.match((c1 as any).render(160)[0], /^ └ • Read \(\.\/f1\)/);
    assert.match((c2 as any).render(160)[0], /^ └ • Read \(\.\/f2\)/);
  });
});

describe("anchorAssistant (mcode ● prefix)", () => {
  it("prefixes a plain first paragraph once", () => {
    assert.equal(anchorAssistant("I'll look.\n\nMore."), "● I'll look.\n\nMore.");
    assert.equal(anchorAssistant("\nHi"), "\n● Hi");
    assert.equal(anchorAssistant("● already"), "● already");
    assert.equal(anchorAssistant(""), "");
  });
  it("leaves block syntax alone", () => {
    for (const md of ["# Title", "- item", "1. one", "> quote", "| a | b |", "```ts\nx\n```", "---"]) {
      assert.equal(anchorAssistant(md), md);
    }
  });
});

describe("row alignment", () => {
  beforeEach(() => resetSimpleGroups());
  it("rows are indented 1 column to align with pi's padded assistant text (mcode rail under ●)", () => {
    const w = simpleWrapTool({ ...base, name: "read" } as never) as typeof base;
    const ctx = { expanded: false, cwd: "/repo", args: { file_path: "/repo/a" }, toolCallId: "z" } as never;
    const c = w.renderCall!({ file_path: "/repo/a" } as never, theme, ctx);
    w.renderResult!({ isError: false, content: [{ type: "text", text: "a" }] } as never, { expanded: false, isPartial: false } as never, theme, ctx);
    const [line] = (c as any).render(40);
    assert.ok(line.startsWith(" └ • Read"));
    assert.ok(line.length <= 40);
  });
});
