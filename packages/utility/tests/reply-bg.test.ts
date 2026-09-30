import { test } from "node:test";
import assert from "node:assert/strict";
import { bgLuminance, dividerLine, findAssistant, paintLine, patchAssistantRender, replyBg, replyFg, stripBlankRuns, trimEdgeBlankLines } from "../src/render/reply-bg.ts";

test("reply background is true black; light themes lift the text fg", () => {
  assert.equal(replyBg(), "\x1b[48;2;0;0;0m");
  assert.equal(replyFg({ getBgAnsi: () => "\x1b[48;2;232;232;232m" }), "\x1b[97m");
  assert.equal(replyFg({ getBgAnsi: () => "\x1b[48;2;52;53;65m" }), null);
  assert.ok((bgLuminance("\x1b[48;5;236m") ?? 1) < 0.5);
});

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("divider is a centred orange heavy rule; unlabelled it spans the width", () => {
  const t = { bold: (s2: string) => `\x1b[1m${s2}\x1b[22m` };
  const d = dividerLine(t, "summary", 40);
  assert.ok(d.includes(" summary "));
  assert.ok(d.includes("\x1b[38;2;255;135;0m")); // orange
  assert.ok(d.includes("\x1b[1m")); // bold label
  assert.equal(strip(d).length, 40);
  assert.equal(strip(d).indexOf(" summary "), 15);
  assert.equal(strip(d)[0], "━");
  assert.equal(strip(d).at(-1), "━");
  const plain = dividerLine(t, "", 12);
  assert.equal(strip(plain), "━".repeat(12));
  assert.ok(!plain.includes("\x1b[1m"));
  assert.equal(dividerLine({ getColorMode: () => "256color" }, "", 3), "\x1b[38;5;208m━━━\x1b[39m");
});

test("paintLine pads to width and re-opens the background after resets", () => {
  const bg = "\x1b[48;5;236m";
  const out = paintLine("a\x1b[0mb", 5, bg);
  assert.equal(out, `${bg}a\x1b[0m${bg}b   \x1b[49m`);
});

test("only a finished reply without tool calls is painted, and repeat renders are cached", () => {
  let calls = 0;
  class Fake {
    hasToolCalls = false;
    isStreaming = false;
    lastMessage: unknown = { id: 1 };
    contentContainer = {};
    updateContent() {}
    render(_w: number): string[] {
      calls++;
      return ["hello"];
    }
  }
  patchAssistantRender(Fake.prototype as never, () => ({
    bg: "\x1b[48;5;236m",
    fg: null,
    dividerFor: (w: number, label = "summary") =>
      label ? `─ ${label} ${"─".repeat(Math.max(0, w - label.length - 4))}` : "─".repeat(w),
  }));
  const reply = new Fake();
  const first = reply.render(10);
  assert.equal(first.length, 5); // spacer + rule + text + pad + closing rule
  assert.equal(first[0], "");
  assert.equal(first[1], "─ summary ");
  assert.equal(first[4], "─".repeat(10));
  assert.ok(first[2]!.startsWith("\x1b[48;5;236m"));
  assert.ok(!first[4]!.includes("\x1b[48;5;236m")); // the rules sit outside the panel
  assert.strictEqual(reply.render(10), first); // cached array
  const withTools = new Fake();
  withTools.hasToolCalls = true;
  assert.deepEqual(withTools.render(10), ["hello"]);
  const streaming = new Fake();
  streaming.isStreaming = true;
  assert.deepEqual(streaming.render(10), ["hello"]);
  assert.ok(calls >= 3);
});

test("an errored or aborted tail is not framed as the summary", () => {
  class Fake {
    hasToolCalls = false;
    isStreaming = false;
    lastMessage: unknown;
    contentContainer = {};
    updateContent() {}
    render(_w: number): string[] {
      return ["Error: 500"];
    }
  }
  patchAssistantRender(Fake.prototype as never, () => ({
    bg: "\x1b[48;5;236m",
    fg: null,
    dividerFor: (w: number, label = "summary") =>
      label ? `─ ${label} ${"─".repeat(Math.max(0, w - label.length - 4))}` : "─".repeat(w),
  }));
  for (const stopReason of ["error", "aborted", "length", "pending", "deferred"]) {
    const m = new Fake();
    m.lastMessage = { stopReason, content: [{ type: "text", text: "Error: 500" }] };
    assert.deepEqual(m.render(10), ["Error: 500"], stopReason);
  }
  const ok = new Fake();
  ok.lastMessage = { stopReason: "stop", content: [{ type: "text", text: "done" }] };
  assert.equal(ok.render(10).length, 5); // normal reply still framed
});

test("thinking/tool-only steps render no rows; errors still show", () => {
  class Step {
    hasToolCalls = true;
    isStreaming = false;
    lastMessage: unknown;
    contentContainer = {};
    updateContent() {}
    render(_w: number): string[] {
      return ["", ""];
    }
  }
  patchAssistantRender(Step.prototype as never, () => "\x1b[48;5;236m");
  const s = new Step();
  s.lastMessage = { content: [{ type: "thinking", thinking: "hmm" }, { type: "toolCall", id: "1" }], stopReason: "toolUse" };
  assert.deepEqual(s.render(10), []);
  s.lastMessage = { content: [{ type: "thinking", thinking: "hmm" }], stopReason: "error" };
  assert.deepEqual(s.render(10), []); // an all-blank render now paints nothing
  s.lastMessage = { content: [{ type: "text", text: "hi" }, { type: "toolCall", id: "1" }], stopReason: "toolUse" };
  assert.deepEqual(s.render(10), []); // a blank-only step renders nothing — compact
});

test("findAssistant walks the TUI tree", () => {
  const a = { contentContainer: {}, hasToolCalls: false, updateContent() {} };
  const tree = { children: [{ children: [{}, { children: [a] }] }] };
  assert.equal(findAssistant(tree), a);
  assert.equal(findAssistant({ children: [{}] }), undefined);
});

test("stripBlankRuns drops blank thinking regions and their trailing spacer only", () => {
  const spacer = () => ({ lines: 1, render: () => [""] });
  const region = (lines: string[]) => ({ child: {}, render: () => lines });
  const md = (s: string) => ({ render: () => [s] });
  const hidden = region([" \x1b[3m\x1b[38;5;245m\x1b[39m\x1b[23m  "]); // ANSI-only label → blank row
  const visible = region([" Thinking…"]);
  const container = {
    children: [spacer(), hidden, spacer(), md("● text"), visible, spacer(), md("more")],
  };
  stripBlankRuns(container as never, 80);
  assert.equal(container.children.length, 5);
  assert.equal(container.children[0]!.render!(80)[0], "");
  assert.equal((container.children[1] as any).render(80)[0], "● text");
  assert.equal(container.children[2], visible); // real label kept…
  assert.equal(typeof (container.children[3] as any).lines, "number"); // …and so is its spacer
  assert.equal((container.children[4] as any).render(80)[0], "more");
});

test("the patched render strips hidden-thinking rows and edge blanks before painting", () => {
  const spacer = () => ({ lines: 1, render: () => [""] });
  const hiddenRegion = { child: {}, render: () => [" \x1b[3m\x1b[39m "] };
  class Msg {
    hasToolCalls = true;
    isStreaming = true;
    lastMessage: unknown = { content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "hi" }] };
    contentContainer = { children: [spacer(), hiddenRegion, spacer(), { render: () => [" hi"] }] };
    updateContent() {}
    render(_w: number): string[] {
      return this.contentContainer.children.flatMap((c: any) => c.render(80));
    }
  }
  patchAssistantRender(Msg.prototype as never, () => ({
    bg: "\x1b[48;5;236m",
    fg: null,
    dividerFor: (w: number) => "─".repeat(w),
  }));
  // pi's leading Spacer(1) row is trimmed too — no stray blank above the text.
  assert.deepEqual(new Msg().render(80), [" hi"]);
});

test("a leading blank row is not painted inside the summary panel", () => {
  class Reply {
    hasToolCalls = false;
    isStreaming = false;
    lastMessage: unknown = { stopReason: "stop", content: [{ type: "text", text: "hello" }] };
    contentContainer = {};
    updateContent() {}
    render(_w: number): string[] {
      // pi's leading Spacer(1) + the text row.
      return ["", "hello"];
    }
  }
  patchAssistantRender(Reply.prototype as never, () => ({
    bg: "\x1b[48;5;236m",
    fg: null,
    dividerFor: (w: number, label = "summary") =>
      label ? `─ ${label} ${"─".repeat(Math.max(0, w - label.length - 4))}` : "─".repeat(w),
  }));
  const out = new Reply().render(10);
  assert.equal(out.length, 5); // breathing + rule + text + pad + rule — no pad under the rule
  assert.equal(out[1], "─ summary ");
  assert.ok(out[2]!.includes("hello"));
});

test("trimEdgeBlankLines carries dropped OSC-133 zone markers onto surviving lines", () => {
  class Z {
    hasToolCalls = false;
    isStreaming = false;
    lastMessage: unknown = { stopReason: "stop", content: [{ type: "text", text: "hi" }] };
    contentContainer = {};
    updateContent() {}
    render(_w: number): string[] {
      // zone start on the blank spacer row; end+final on the last text row.
      return ["\x1b]133;A\x07", " hi", "\x1b]133;B\x07\x1b]133;C\x07 bye "];
    }
  }
  patchAssistantRender(Z.prototype as never, () => ({
    bg: "\x1b[48;5;236m",
    fg: null,
    dividerFor: (w: number) => "─".repeat(w),
  }));
  const out = new Z().render(10);
  // " hi" keeps its zone start; " bye " keeps end+final; no blank rows painted.
  assert.ok(out[2]!.includes("\x1b]133;A\x07") && out[2]!.includes("hi"));
  assert.ok(out[3]!.includes("\x1b]133;B\x07") && out[3]!.includes("\x1b]133;C\x07"));
  // Direct unit check: dropped edge blanks pass their markers to the nearest
  // surviving line, keeping pi's convention (markers precede the line's text).
  const trimmed = trimEdgeBlankLines(["\x1b]133;A\x07  ", " x ", "  \x1b]133;B\x07"]);
  assert.deepEqual(trimmed, ["\x1b]133;A\x07\x1b]133;B\x07 x "]);
  assert.deepEqual(trimEdgeBlankLines(["", "  \x1b[3m\x1b[39m"]), []);
});

test("an all-blank render paints nothing (no panel, no gap)", () => {
  class Blank {
    hasToolCalls = false;
    isStreaming = false;
    lastMessage: unknown = { stopReason: "stop", content: [{ type: "text", text: "hi" }] };
    contentContainer = {};
    updateContent() {}
    render(_w: number): string[] {
      return ["", "  "];
    }
  }
  patchAssistantRender(Blank.prototype as never, () => ({
    bg: "\x1b[48;5;236m",
    fg: null,
    dividerFor: (w: number) => "─".repeat(w),
  }));
  assert.deepEqual(new Blank().render(10), []);
});
