import { describe, it, expect } from "bun:test";
import { normalizeMessages } from "../src/compaction/normalize.js";
import type { Message } from "@mariozechner/pi-ai";

describe("normalizeMessages", () => {
  it("normalizes user text messages", () => {
    const msgs: Message[] = [{ role: "user", content: "Hello world" }];
    const blocks = normalizeMessages(msgs);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "user", text: "Hello world" });
  });

  it("normalizes assistant text", () => {
    const msgs: Message[] = [{ role: "assistant", content: "Hi there" }];
    const blocks = normalizeMessages(msgs);
    expect(blocks[0]).toMatchObject({ kind: "assistant", text: "Hi there" });
  });

  it("normalizes tool results", () => {
    const msgs: Message[] = [{
      role: "toolResult",
      toolName: "bash",
      content: "output",
      isError: false,
    }];
    const blocks = normalizeMessages(msgs);
    expect(blocks[0]).toMatchObject({ kind: "tool_result", name: "bash", text: "output" });
  });

  it("skips thinking blocks", () => {
    const msgs: Message[] = [{
      role: "assistant",
      content: [{ type: "thinking", thinking: "secret", redacted: false }],
    }];
    const blocks = normalizeMessages(msgs);
    expect(blocks[0]).toMatchObject({ kind: "thinking", text: "secret" });
  });
});
