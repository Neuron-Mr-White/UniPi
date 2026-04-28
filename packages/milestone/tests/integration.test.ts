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
import type { MilestoneDoc } from "../types.js";

/** Create a temp directory for integration tests */
function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `milestone-integration-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Create a sample MILESTONES.md */
function createSampleMilestones(dir: string): string {
  const filePath = path.join(dir, "MILESTONES.md");
  const doc: MilestoneDoc = {
    title: "Test Project",
    created: "2026-04-28",
    updated: "2026-04-28",
    filePath,
    phases: [
      {
        name: "Phase 1: Foundation",
        description: "Core infrastructure",
        items: [
          { text: "Project scaffold", checked: true, lineNumber: 0 },
          { text: "Database schema", checked: true, lineNumber: 0 },
          { text: "Authentication", checked: false, lineNumber: 0 },
          { text: "API routing", checked: false, lineNumber: 0 },
          { text: "Error handling", checked: false, lineNumber: 0 },
        ],
      },
      {
        name: "Phase 2: Features",
        description: "User-facing features",
        items: [
          { text: "User dashboard", checked: false, lineNumber: 0 },
          { text: "File upload", checked: false, lineNumber: 0 },
          { text: "Notifications", checked: false, lineNumber: 0 },
          { text: "Search", checked: false, lineNumber: 0 },
          { text: "Analytics", checked: false, lineNumber: 0 },
        ],
      },
    ],
  };
  writeMilestones(filePath, doc);
  return filePath;
}

describe("Integration: Full milestone lifecycle", () => {
  let tmpDirPath: string;

  beforeEach(() => {
    tmpDirPath = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDirPath, { recursive: true, force: true });
  });

  it("create → parse → update → summary lifecycle", () => {
    // 1. Create MILESTONES.md
    const milestonesPath = createSampleMilestones(tmpDirPath);
    expect(fs.existsSync(milestonesPath)).toBe(true);

    // 2. Parse and verify
    const doc = parseMilestones(milestonesPath);
    expect(doc.title).toBe("Test Project");
    expect(doc.phases).toHaveLength(2);
    expect(doc.phases[0].items).toHaveLength(5);
    expect(doc.phases[1].items).toHaveLength(5);

    // 3. Check initial progress
    const initial = getProgressSummary(milestonesPath);
    expect(initial.totalItems).toBe(10);
    expect(initial.completedItems).toBe(2);
    expect(initial.percentComplete).toBe(20);
    expect(initial.currentPhase).toBe("Phase 1: Foundation");

    // 4. Complete some items
    expect(updateItemStatus(milestonesPath, "Phase 1: Foundation", "Authentication", true)).toBe(true);
    expect(updateItemStatus(milestonesPath, "Phase 1: Foundation", "API routing", true)).toBe(true);
    expect(updateItemStatus(milestonesPath, "Phase 2: Features", "User dashboard", true)).toBe(true);

    // 5. Verify updated progress
    const updated = getProgressSummary(milestonesPath);
    expect(updated.completedItems).toBe(5);
    expect(updated.percentComplete).toBe(50);
    expect(updated.phases[0].done).toBe(4);
    expect(updated.phases[1].done).toBe(1);

    // 6. Uncheck an item
    expect(updateItemStatus(milestonesPath, "Phase 1: Foundation", "Authentication", false)).toBe(true);
    const afterUncheck = getProgressSummary(milestonesPath);
    expect(afterUncheck.completedItems).toBe(4);
  });

  it("handles malformed MILESTONES.md gracefully", () => {
    const badPath = path.join(tmpDirPath, "MILESTONES.md");
    fs.writeFileSync(badPath, "not a valid milestone file\n- [ ] orphan item\n", "utf-8");

    const doc = parseMilestones(badPath);
    expect(doc.phases).toHaveLength(0); // No phases without ## headers

    const summary = getProgressSummary(badPath);
    expect(summary.totalItems).toBe(0);
  });

  it("handles missing MILESTONES.md gracefully", () => {
    const missingPath = path.join(tmpDirPath, "nonexistent.md");

    const doc = parseMilestones(missingPath);
    expect(doc.phases).toHaveLength(0);
    expect(doc.title).toBe("Project Milestones");

    const summary = getProgressSummary(missingPath);
    expect(summary.totalItems).toBe(0);
    expect(summary.percentComplete).toBe(0);
  });

  it("atomic write prevents corruption", () => {
    const milestonesPath = createSampleMilestones(tmpDirPath);

    // Write multiple times rapidly
    for (let i = 0; i < 10; i++) {
      const doc = parseMilestones(milestonesPath);
      doc.phases[0].items[0].checked = i % 2 === 0;
      writeMilestones(milestonesPath, doc);
    }

    // File should still be valid
    const final = parseMilestones(milestonesPath);
    expect(final.phases).toHaveLength(2);
    expect(final.phases[0].items).toHaveLength(5);
  });

  it("roundtrip preserves all data", () => {
    const milestonesPath = createSampleMilestones(tmpDirPath);

    // Parse
    const doc = parseMilestones(milestonesPath);

    // Write to a new file
    const newPath = path.join(tmpDirPath, "MILESTONES_COPY.md");
    writeMilestones(newPath, doc);

    // Parse the copy
    const copy = parseMilestones(newPath);

    // Should be identical
    expect(copy.title).toBe(doc.title);
    expect(copy.created).toBe(doc.created);
    expect(copy.phases).toHaveLength(doc.phases.length);

    for (let i = 0; i < doc.phases.length; i++) {
      expect(copy.phases[i].name).toBe(doc.phases[i].name);
      expect(copy.phases[i].description).toBe(doc.phases[i].description);
      expect(copy.phases[i].items).toHaveLength(doc.phases[i].items.length);

      for (let j = 0; j < doc.phases[i].items.length; j++) {
        expect(copy.phases[i].items[j].text).toBe(doc.phases[i].items[j].text);
        expect(copy.phases[i].items[j].checked).toBe(doc.phases[i].items[j].checked);
      }
    }
  });

  it("case-insensitive matching works for updates", () => {
    const milestonesPath = createSampleMilestones(tmpDirPath);

    // Try various cases
    expect(updateItemStatus(milestonesPath, "phase 1: foundation", "PROJECT SCAFFOLD", false)).toBe(true);
    expect(updateItemStatus(milestonesPath, "PHASE 1: FOUNDATION", "authentication", true)).toBe(true);
    expect(updateItemStatus(milestonesPath, "Phase 2: Features", "FILE UPLOAD", true)).toBe(true);

    const summary = getProgressSummary(milestonesPath);
    // scaffold unchecked (-1), auth checked (+1), file upload checked (+1) = 2 + 0 + 1 = 3
    expect(summary.completedItems).toBe(3);
  });

  it("handles 100% completion correctly", () => {
    const milestonesPath = createSampleMilestones(tmpDirPath);

    // Check all items
    for (const phase of parseMilestones(milestonesPath).phases) {
      for (const item of phase.items) {
        if (!item.checked) {
          updateItemStatus(milestonesPath, phase.name, item.text, true);
        }
      }
    }

    const summary = getProgressSummary(milestonesPath);
    expect(summary.completedItems).toBe(10);
    expect(summary.totalItems).toBe(10);
    expect(summary.percentComplete).toBe(100);
    expect(summary.currentPhase).toBe("Phase 1: Foundation"); // Falls back to first phase
  });
});

describe("Integration: Doc scanning simulation", () => {
  it("detects checkbox changes between baseline and current", () => {
    const tmpDirPath = tmpDir();

    // Baseline: all unchecked
    const baseline = `---
title: "Spec"
created: 2026-04-28
updated: 2026-04-28
---

# Spec

## Requirements

- [ ] Feature A
- [ ] Feature B
- [ ] Feature C
`;

    // Current: some checked
    const current = `---
title: "Spec"
created: 2026-04-28
updated: 2026-04-28
---

# Spec

## Requirements

- [x] Feature A
- [x] Feature B
- [ ] Feature C
`;

    const baselinePath = path.join(tmpDirPath, "baseline.md");
    const currentPath = path.join(tmpDirPath, "current.md");
    fs.writeFileSync(baselinePath, baseline, "utf-8");
    fs.writeFileSync(currentPath, current, "utf-8");

    // Simulate what the session end hook does
    const baselineLines = baseline.split("\n");
    const currentLines = current.split("\n");
    const completions: string[] = [];

    for (let i = 0; i < currentLines.length; i++) {
      const currentMatch = currentLines[i].match(/^-\s+\[x\]\s+(.+)$/);
      if (currentMatch) {
        const baselineLine = baselineLines[i] ?? "";
        const baselineMatch = baselineLine.match(/^-\s+\[([ xX])\]\s+(.+)$/);
        if (baselineMatch && baselineMatch[1] === " ") {
          completions.push(currentMatch[1].trim());
        }
      }
    }

    expect(completions).toEqual(["Feature A", "Feature B"]);

    fs.rmSync(tmpDirPath, { recursive: true, force: true });
  });
});
