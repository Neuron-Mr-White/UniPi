import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  parseMilestones,
  writeMilestones,
  updateItemStatus,
  getProgressSummary,
} from "../milestone.js";

/** Create a temp file path for testing */
function tmpFile(name: string): string {
  return path.join(os.tmpdir(), `milestone-test-${name}-${Date.now()}.md`);
}

/** Sample MILESTONES.md content */
const SAMPLE = `---
title: "Test Milestones"
created: 2026-04-28
updated: 2026-04-28
---

# Test Milestones

## Phase 1: Foundation
> Set up the core infrastructure

- [x] Project scaffold
- [x] Database schema
- [ ] Authentication system
- [ ] API routing

## Phase 2: Features
> Build the primary features

- [ ] User dashboard
- [ ] File upload
`;

describe("parseMilestones", () => {
  it("parses a valid MILESTONES.md file", () => {
    const file = tmpFile("parse");
    fs.writeFileSync(file, SAMPLE, "utf-8");

    const doc = parseMilestones(file);
    expect(doc.title).toBe("Test Milestones");
    expect(doc.created).toBe("2026-04-28");
    expect(doc.updated).toBe("2026-04-28");
    expect(doc.phases).toHaveLength(2);

    const p1 = doc.phases[0];
    expect(p1.name).toBe("Phase 1: Foundation");
    expect(p1.description).toBe("Set up the core infrastructure");
    expect(p1.items).toHaveLength(4);
    expect(p1.items[0]).toEqual({ text: "Project scaffold", checked: true, lineNumber: 12 });
    expect(p1.items[2]).toEqual({ text: "Authentication system", checked: false, lineNumber: 14 });

    const p2 = doc.phases[1];
    expect(p2.name).toBe("Phase 2: Features");
    expect(p2.items).toHaveLength(2);

    fs.unlinkSync(file);
  });

  it("returns empty doc for missing file", () => {
    const doc = parseMilestones("/nonexistent/path/MILESTONES.md");
    expect(doc.title).toBe("Project Milestones");
    expect(doc.phases).toHaveLength(0);
  });

  it("handles malformed input gracefully", () => {
    const file = tmpFile("malformed");
    fs.writeFileSync(file, "random text\n- not a checkbox\n## Phase\n- [ ] item", "utf-8");

    const doc = parseMilestones(file);
    expect(doc.phases).toHaveLength(1);
    expect(doc.phases[0].items).toHaveLength(1);

    fs.unlinkSync(file);
  });

  it("handles multi-line descriptions", () => {
    const content = `---\ntitle: "T"\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# T\n\n## Phase 1\n> Line one\n> Line two\n\n- [ ] item`;
    const file = tmpFile("desc");
    fs.writeFileSync(file, content, "utf-8");

    const doc = parseMilestones(file);
    expect(doc.phases[0].description).toBe("Line one Line two");

    fs.unlinkSync(file);
  });
});

describe("writeMilestones", () => {
  it("writes a valid MILESTONES.md file", () => {
    const file = tmpFile("write");
    const doc = {
      title: "My Goals",
      created: "2026-04-28",
      updated: "2026-04-28",
      filePath: file,
      phases: [
        {
          name: "Phase 1",
          description: "First phase",
          items: [
            { text: "Done item", checked: true, lineNumber: 1 },
            { text: "Todo item", checked: false, lineNumber: 2 },
          ],
        },
      ],
    };

    writeMilestones(file, doc);
    const content = fs.readFileSync(file, "utf-8");

    expect(content).toContain('title: "My Goals"');
    expect(content).toContain("## Phase 1");
    expect(content).toContain("> First phase");
    expect(content).toContain("- [x] Done item");
    expect(content).toContain("- [ ] Todo item");

    // Verify roundtrip
    const parsed = parseMilestones(file);
    expect(parsed.title).toBe("My Goals");
    expect(parsed.phases[0].items).toHaveLength(2);
    expect(parsed.phases[0].items[0].checked).toBe(true);

    fs.unlinkSync(file);
  });

  it("handles empty phases array", () => {
    const file = tmpFile("empty");
    const doc = {
      title: "Empty",
      created: "2026-01-01",
      updated: "2026-01-01",
      filePath: file,
      phases: [],
    };

    writeMilestones(file, doc);
    const content = fs.readFileSync(file, "utf-8");
    expect(content).toContain("# Empty");
    expect(content).not.toContain("## ");

    fs.unlinkSync(file);
  });
});

describe("updateItemStatus", () => {
  it("checks off an item", () => {
    const file = tmpFile("update-check");
    fs.writeFileSync(file, SAMPLE, "utf-8");

    const result = updateItemStatus(file, "Phase 1: Foundation", "Authentication system", true);
    expect(result).toBe(true);

    const doc = parseMilestones(file);
    const item = doc.phases[0].items.find((i) => i.text === "Authentication system");
    expect(item?.checked).toBe(true);

    fs.unlinkSync(file);
  });

  it("unchecks an item", () => {
    const file = tmpFile("update-uncheck");
    fs.writeFileSync(file, SAMPLE, "utf-8");

    const result = updateItemStatus(file, "Phase 1: Foundation", "Project scaffold", false);
    expect(result).toBe(true);

    const doc = parseMilestones(file);
    const item = doc.phases[0].items.find((i) => i.text === "Project scaffold");
    expect(item?.checked).toBe(false);

    fs.unlinkSync(file);
  });

  it("returns false for non-existent item", () => {
    const file = tmpFile("update-miss");
    fs.writeFileSync(file, SAMPLE, "utf-8");

    const result = updateItemStatus(file, "Phase 1: Foundation", "Nonexistent item", true);
    expect(result).toBe(false);

    fs.unlinkSync(file);
  });

  it("returns false for non-existent phase", () => {
    const file = tmpFile("update-bad-phase");
    fs.writeFileSync(file, SAMPLE, "utf-8");

    const result = updateItemStatus(file, "Phase 99", "Project scaffold", true);
    expect(result).toBe(false);

    fs.unlinkSync(file);
  });

  it("matches case-insensitively", () => {
    const file = tmpFile("update-case");
    fs.writeFileSync(file, SAMPLE, "utf-8");

    const result = updateItemStatus(file, "phase 1: foundation", "AUTHENTICATION SYSTEM", true);
    expect(result).toBe(true);

    fs.unlinkSync(file);
  });

  it("updates the 'updated' frontmatter date", () => {
    const file = tmpFile("update-date");
    fs.writeFileSync(file, SAMPLE, "utf-8");

    updateItemStatus(file, "Phase 1: Foundation", "Authentication system", true);

    const content = fs.readFileSync(file, "utf-8");
    const today = new Date().toISOString().split("T")[0];
    expect(content).toContain(`updated: ${today}`);

    fs.unlinkSync(file);
  });
});

describe("getProgressSummary", () => {
  it("returns accurate stats", () => {
    const file = tmpFile("summary");
    fs.writeFileSync(file, SAMPLE, "utf-8");

    const summary = getProgressSummary(file);
    expect(summary.totalItems).toBe(6);
    expect(summary.completedItems).toBe(2);
    expect(summary.percentComplete).toBe(33);
    expect(summary.currentPhase).toBe("Phase 1: Foundation");
    expect(summary.phases).toHaveLength(2);
    expect(summary.phases[0]).toEqual({ name: "Phase 1: Foundation", done: 2, total: 4 });
    expect(summary.phases[1]).toEqual({ name: "Phase 2: Features", done: 0, total: 2 });

    fs.unlinkSync(file);
  });

  it("returns empty summary for missing file", () => {
    const summary = getProgressSummary("/nonexistent/path");
    expect(summary.totalItems).toBe(0);
    expect(summary.completedItems).toBe(0);
    expect(summary.percentComplete).toBe(0);
    expect(summary.phases).toHaveLength(0);
  });

  it("handles 100% completion", () => {
    const content = `---\ntitle: "Done"\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Done\n\n## Phase 1\n- [x] A\n- [x] B\n`;
    const file = tmpFile("complete");
    fs.writeFileSync(file, content, "utf-8");

    const summary = getProgressSummary(file);
    expect(summary.percentComplete).toBe(100);
    expect(summary.currentPhase).toBe("Phase 1"); // Falls back to first phase when all done

    fs.unlinkSync(file);
  });
});
