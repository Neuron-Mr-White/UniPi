import { describe, it, expect } from "bun:test";
import { compile } from "../src/compaction/summarize.js";
import type { Message } from "@mariozechner/pi-ai";

describe("compile", () => {
  it("compiles a summary from messages", () => {
    const msgs = [
      { role: "user", content: "Implement a login feature" },
      { role: "assistant", content: [{ type: "text", text: "I'll help you implement a login feature." }] },
    ] as unknown as Message[];
    const summary = compile({ messages: msgs });
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).toContain("Session Goal");
  });

  it("merges with previous summary", () => {
    const msgs = [{ role: "user", content: "Add password validation" }] as unknown as Message[];
    const prev = "[Session Goal]\n- Implement a login feature";
    const summary = compile({ messages: msgs, previousSummary: prev });
    expect(summary).toContain("Implement a login feature");
    expect(summary).toContain("Add password validation");
  });

  it("appends recall note", () => {
    const msgs = [{ role: "user", content: "Hello" }] as unknown as Message[];
    const summary = compile({ messages: msgs });
    expect(summary).toContain("vcc_recall");
  });
});
