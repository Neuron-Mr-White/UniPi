import { test } from "node:test";
import assert from "node:assert/strict";
import { bgLuminance, dividerLine, findAssistant, paintLine, patchAssistantRender, replyBg, replyFg } from "../src/render/reply-bg.ts";

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
