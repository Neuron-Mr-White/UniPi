import { describe, it, expect } from "bun:test";
import { compile } from "../src/compaction/summarize.js";
import type { Message } from "@mariozechner/pi-ai";

describe("compile", () => {
  it("compiles a summary from messages", () => {
    const msgs: Message[] = [
      { role: "user", content: "Implement a login feature" },
      { role: "assistant", content: "I'll help you implement a login feature." },
    ];
    const summary = compile({ messages: msgs });
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).toContain("Session Goal");
  });

  it("merges with previous summary", () => {
    const msgs: Message[] = [
      { role: "user", content: "Add password validation" },
    ];
    const prev = "[Session Goal]\n- Implement a login feature";
    const summary = compile({ messages: msgs, previousSummary: prev });
    expect(summary).toContain("Implement a login feature");
    expect(summary).toContain("Add password validation");
  });

  it("appends recall note", () => {
    const msgs: Message[] = [{ role: "user", content: "Hello" }];
    const summary = compile({ messages: msgs });
    expect(summary).toContain("vcc_recall");
  });
});
