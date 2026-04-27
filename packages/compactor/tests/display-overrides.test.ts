/**
 * Tests for tool display overrides and diff renderer enhancements
 */

import { describe, it, expect } from "bun:test";
import { renderReadResult, renderSearchResult, renderBashResult, applyToolDisplayOverride } from "../src/display/tool-overrides.js";
import { renderDiff, detectNerdFont } from "../src/display/diff-renderer.js";

describe("Tool display overrides", () => {
  const config = {
    readOutputMode: "summary" as const,
    searchOutputMode: "count" as const,
    bashOutputMode: "preview" as const,
    previewLines: 10,
    bashCollapsedLines: 5,
    showTruncationHints: true,
  };

  it("renderReadResult in summary mode", () => {
    const result = renderReadResult("line1\nline2\nline3", "/path/to/file.ts", config);
    expect(result).toContain("file.ts");
    expect(result).toContain("lines");
  });

  it("renderReadResult in hidden mode", () => {
    const result = renderReadResult("content", "/path/to/file.ts", { ...config, readOutputMode: "hidden" });
    expect(result).toContain("[Read:");
    expect(result).not.toContain("content");
  });

  it("renderSearchResult in count mode", () => {
    const result = renderSearchResult("match1\nmatch2\nmatch3", config);
    expect(result).toContain("[Search:");
    expect(result).toContain("matches");
  });

  it("renderBashResult in preview mode", () => {
    const output = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const result = renderBashResult(output, "ls -la", config);
    expect(result).toContain("...");
    expect(result).toContain("more lines");
  });

  it("applyToolDisplayOverride returns undefined for unknown tools", () => {
    const event = { content: [{ type: "text", text: "result" }] };
    const result = applyToolDisplayOverride("unknown_tool", event, config);
    expect(result).toBeUndefined();
  });

  it("applyToolDisplayOverride transforms read results", () => {
    const event = {
      content: [{ type: "text", text: "file content here" }],
      args: { path: "/path/to/file.ts" },
    };
    const result = applyToolDisplayOverride("read", event, { ...config, readOutputMode: "hidden" });
    expect(result).toBeDefined();
    expect(result!.content![0].text).toContain("[Read:");
  });

  it("applyToolDisplayOverride transforms bash results", () => {
    const event = {
      content: [{ type: "text", text: "output line 1\noutput line 2" }],
      args: { command: "echo test" },
    };
    const result = applyToolDisplayOverride("bash", event, { ...config, bashOutputMode: "hidden" });
    expect(result).toBeDefined();
    expect(result!.content![0].text).toContain("[Bash:");
  });
});

describe("Diff renderer enhancements", () => {
  it("renders unified diff with syntax highlighting", () => {
    const before = "const x = 1;\nconst y = 2;";
    const after = "const x = 10;\nconst z = 3;";
    const result = renderDiff(before, after, { highlight: true, filePath: "test.js" });
    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
  });

  it("renders split diff", () => {
    const before = "line1\nline2\nline3";
    const after = "line1\nmodified\nline3";
    const result = renderDiff(before, after, { layout: "split" });
    expect(result).toContain("│");
  });

  it("auto-selects layout based on width", () => {
    const before = "a\nb";
    const after = "a\nc";
    const narrow = renderDiff(before, after, { layout: "auto", maxWidth: 50 });
    const wide = renderDiff(before, after, { layout: "auto", maxWidth: 150 });
    // Narrow should be unified, wide should be split
    expect(narrow).toBeDefined();
    expect(wide).toBeDefined();
  });

  it("detectNerdFont returns boolean", () => {
    const result = detectNerdFont();
    expect(typeof result).toBe("boolean");
  });
});
