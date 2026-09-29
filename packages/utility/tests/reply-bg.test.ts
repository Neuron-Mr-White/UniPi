import { test } from "node:test";
import assert from "node:assert/strict";
import { bgLuminance, findAssistant, paintLine, patchAssistantRender, replyBg } from "../src/render/reply-bg.ts";

test("light vs dark theme picks the reply background from the user-message bg", () => {
  const dark = { getBgAnsi: () => "\x1b[48;2;52;53;65m", getColorMode: () => "truecolor" };
  const light = { getBgAnsi: () => "\x1b[48;2;232;232;232m", getColorMode: () => "truecolor" };
  assert.equal(replyBg(dark), "\x1b[48;2;46;40;28m");
  assert.equal(replyBg(light), "\x1b[48;2;253;246;214m");
  assert.equal(replyBg({ getBgAnsi: () => "\x1b[48;5;254m", getColorMode: () => "256color" }), "\x1b[48;5;230m");
  assert.ok((bgLuminance("\x1b[48;5;236m") ?? 1) < 0.5);
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
  patchAssistantRender(Fake.prototype as never, () => "\x1b[48;5;236m");
  const reply = new Fake();
  const first = reply.render(10);
  assert.equal(first.length, 2); // text + bottom pad row
  assert.ok(first[0]!.startsWith("\x1b[48;5;236m"));
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
