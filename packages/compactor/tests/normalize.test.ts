import { describe, it, expect } from "bun:test";
import { normalizeMessages } from "../src/compaction/normalize.js";
import type { Message } from "@mariozechner/pi-ai";

describe("normalizeMessages", () => {
  it("normalizes user text messages", () => {
    const msgs = [{ role: "user", content: "Hello world" }] as Message[];
    const blocks = normalizeMessages(msgs);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "user", text: "Hello world" });
  });

  it("normalizes assistant text", () => {
    const msgs = [{ role: "assistant", content: [{ type: "text", text: "Hi there" }] }] as unknown as Message[];
    const blocks = normalizeMessages(msgs);
    expect(blocks[0]).toMatchObject({ kind: "assistant", text: "Hi there" });
  });

  it("normalizes tool results", () => {
    const msgs = [{
      role: "toolResult",
      toolName: "bash",
      content: [{ type: "text", text: "output" }],
      isError: false,
    }] as unknown as Message[];
    const blocks = normalizeMessages(msgs);
    expect(blocks[0]).toMatchObject({ kind: "tool_result", name: "bash", text: "output" });
  });

  it("skips thinking blocks", () => {
    const msgs = [{
      role: "assistant",
      content: [{ type: "thinking", thinking: "secret", redacted: false }],
    }] as unknown as Message[];
    const blocks = normalizeMessages(msgs);
    expect(blocks[0]).toMatchObject({ kind: "thinking", text: "secret" });
  });
});
