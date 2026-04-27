import { describe, it, expect } from "bun:test";
import { buildSections } from "../src/compaction/build-sections.js";
import type { NormalizedBlock } from "../src/types.js";

describe("buildSections", () => {
  it("extracts session goals", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "I need to implement a new feature for the API" },
    ];
    const data = buildSections({ blocks });
    expect(data.sessionGoal.length).toBeGreaterThan(0);
  });

  it("tracks file activity", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "edit", args: { file_path: "src/index.ts" } },
      { kind: "tool_call", name: "write", args: { file_path: "src/new.ts" } },
    ];
    const data = buildSections({ blocks });
    expect(data.filesAndChanges.length).toBeGreaterThan(0);
  });

  it("extracts outstanding context from errors", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_result", name: "bash", text: "Error: command not found", isError: true },
    ];
    const data = buildSections({ blocks });
    expect(data.outstandingContext.length).toBeGreaterThan(0);
  });

  it("builds brief transcript", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Hello" },
      { kind: "assistant", text: "Hi there" },
    ];
    const data = buildSections({ blocks });
    expect(data.briefTranscript.length).toBeGreaterThan(0);
  });
});
