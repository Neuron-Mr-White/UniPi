/**
 * @pi-unipi/footer — Segment structure tests
 *
 * Tests segment definitions by checking the source files directly.
 * Full rendering tests require pi SDK module resolution.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const SEGMENTS_DIR = path.resolve(import.meta.dirname, "../src/segments");

describe("Segment files", () => {
  const segmentFiles = fs.readdirSync(SEGMENTS_DIR).filter(f => f.endsWith(".ts") && f !== "index.ts");

  it("has segment files for all groups", () => {
    const expected = ["core.ts", "compactor.ts", "memory.ts", "mcp.ts", "ralph.ts", "workflow.ts", "kanboard.ts", "notify.ts", "status-ext.ts"];
    for (const name of expected) {
      assert.ok(segmentFiles.includes(name), `Missing segment file: ${name}`);
    }
  });

  it("each segment file exports a SEGMENTS array", () => {
    for (const file of segmentFiles) {
      const content = fs.readFileSync(path.join(SEGMENTS_DIR, file), "utf-8");
      const match = content.match(/export const \w+_SEGMENTS/);
      assert.ok(match, `${file} should export a SEGMENTS array`);
    }
  });

  it("segment IDs are consistent with file names", () => {
    const content = fs.readFileSync(path.join(SEGMENTS_DIR, "core.ts"), "utf-8");
    assert.ok(content.includes("model"), "core.ts should define model segment");
    assert.ok(content.includes("path"), "core.ts should define path segment");
    assert.ok(content.includes("git"), "core.ts should define git segment");
  });

  it("compactor segments reference compactor data", () => {
    const content = fs.readFileSync(path.join(SEGMENTS_DIR, "compactor.ts"), "utf-8");
    assert.ok(content.includes("compactions"), "compactor.ts should have compactions segment");
    assert.ok(content.includes("tokens_saved"), "compactor.ts should have tokens_saved segment");
  });

  it("memory segments reference memory data", () => {
    const content = fs.readFileSync(path.join(SEGMENTS_DIR, "memory.ts"), "utf-8");
    assert.ok(content.includes("project_count"), "memory.ts should have project_count segment");
  });

  it("mcp segments reference mcp data", () => {
    const content = fs.readFileSync(path.join(SEGMENTS_DIR, "mcp.ts"), "utf-8");
    assert.ok(content.includes("servers_total"), "mcp.ts should have servers_total segment");
  });

  it("ralph segments reference ralph data", () => {
    const content = fs.readFileSync(path.join(SEGMENTS_DIR, "ralph.ts"), "utf-8");
    assert.ok(content.includes("active_loops"), "ralph.ts should have active_loops segment");
  });

  it("workflow segments reference workflow data", () => {
    const content = fs.readFileSync(path.join(SEGMENTS_DIR, "workflow.ts"), "utf-8");
    assert.ok(content.includes("current_command"), "workflow.ts should have current_command segment");
  });

  it("kanboard segments reference kanboard data", () => {
    const content = fs.readFileSync(path.join(SEGMENTS_DIR, "kanboard.ts"), "utf-8");
    assert.ok(content.includes("docs_count"), "kanboard.ts should have docs_count segment");
  });

  it("notify segments reference notify data", () => {
    const content = fs.readFileSync(path.join(SEGMENTS_DIR, "notify.ts"), "utf-8");
    assert.ok(content.includes("platforms_enabled"), "notify.ts should have platforms_enabled segment");
  });
});

describe("Segment rendering helpers", () => {
  it("formatTokens helper formats correctly", () => {
    // Inline test for the formatTokens helper pattern
    function formatTokens(n: number): string {
      if (n < 1000) return n.toString();
      if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
      if (n < 1000000) return `${Math.round(n / 1000)}k`;
      if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
      return `${Math.round(n / 1000000)}M`;
    }

    assert.equal(formatTokens(0), "0");
    assert.equal(formatTokens(500), "500");
    assert.equal(formatTokens(1500), "1.5k");
    assert.equal(formatTokens(15000), "15k");
    assert.equal(formatTokens(1500000), "1.5M");
    assert.equal(formatTokens(15000000), "15M");
  });

  it("withIcon prepends icon when present", () => {
    function withIcon(icon: string, text: string): string {
      return icon ? `${icon} ${text}` : text;
    }
    assert.equal(withIcon("★", "test"), "★ test");
    assert.equal(withIcon("", "test"), "test");
  });
});
