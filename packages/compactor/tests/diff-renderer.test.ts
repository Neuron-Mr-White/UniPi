import { describe, it, expect } from "bun:test";
import { renderDiff, renderEditDiffResult, renderWriteDiffResult } from "../src/display/diff-renderer.js";

describe("diff-renderer", () => {
  it("renders unified diff", () => {
    const before = "line1\nline2\nline3";
    const after = "line1\nmodified\nline3";
    const result = renderDiff(before, after, { layout: "unified", indicator: "classic" });
    expect(result).toContain("- line2");
    expect(result).toContain("+ modified");
  });

  it("renders split diff", () => {
    const before = "line1\nline2";
    const after = "line1\nmodified";
    const result = renderDiff(before, after, { layout: "split", indicator: "bars" });
    expect(result).toContain("│");
  });

  it("renders new file diff", () => {
    const result = renderWriteDiffResult(undefined, "new content", { indicator: "classic" });
    expect(result).toContain("[New file created]");
    expect(result).toContain("+ new content");
  });

  it("auto-selects layout based on width", () => {
    const before = "a\nb\nc";
    const after = "a\nB\nc";
    const result = renderDiff(before, after, { layout: "auto", maxWidth: 50 });
    // Should use unified since width < 100
    expect(result).not.toContain("│");
  });
});
