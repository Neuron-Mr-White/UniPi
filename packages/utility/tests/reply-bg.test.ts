import { test } from "node:test";
import assert from "node:assert/strict";
import { bgLuminance, dividerLine, findAssistant, paintLine, patchAssistantRender, replyBg, replyFg } from "../src/render/reply-bg.ts";

test("reply background is true black; light themes lift the text fg", () => {
  assert.equal(replyBg(), "\x1b[48;2;0;0;0m");
  assert.equal(replyFg({ getBgAnsi: () => "\x1b[48;2;232;232;232m" }), "\x1b[97m");
  assert.equal(replyFg({ getBgAnsi: () => "\x1b[48;2;52;53;65m" }), null);
  assert.ok((bgLuminance("\x1b[48;5;236m") ?? 1) < 0.5);
});

test("divider line labels the panel and fills the width", () => {
  const t = { fg: (_k: string, s2: string) => `\x1b[90m${s2}\x1b[39m` };
  const d = dividerLine(t, "summary", 20);
  assert.ok(d.includes(" summary "));
  assert.equal(d.length, 20 + "\x1b[90m".length + "\x1b[39m".length);
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
  patchAssistantRender(Fake.prototype as never, () => ({ bg: "\x1b[48;5;236m", fg: null, dividerFor: (w: number) => `─ summary ${"─".repeat(Math.max(0, w - 10))}` }));
  const reply = new Fake();
  const first = reply.render(10);
  assert.equal(first.length, 3); // divider + text + bottom pad row
  assert.equal(first[0], "─ summary ");
  assert.ok(first[1]!.startsWith("\x1b[48;5;236m"));
  assert.strictEqual(reply.render(10), first); // cached array
  const withTools = new Fake();
  withTools.hasToolCalls = true;
  assert.deepEqual(withTools.render(10), ["hello"]);
  const streaming = new Fake();
  streaming.isStreaming = true;
  assert.deepEqual(streaming.render(10), ["hello"]);
  assert.ok(calls >= 3);
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
  assert.deepEqual(s.render(10), ["", ""]);
  s.lastMessage = { content: [{ type: "text", text: "hi" }, { type: "toolCall", id: "1" }], stopReason: "toolUse" };
  assert.deepEqual(s.render(10), ["", ""]);
});

test("findAssistant walks the TUI tree", () => {
  const a = { contentContainer: {}, hasToolCalls: false, updateContent() {} };
  const tree = { children: [{ children: [{}, { children: [a] }] }] };
  assert.equal(findAssistant(tree), a);
  assert.equal(findAssistant({ children: [{}] }), undefined);
});
