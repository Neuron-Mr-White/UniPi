/**
 * @pi-unipi/milestone — MILESTONES.md parser, writer, and updater
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, tryRead } from "@pi-unipi/core";
import type { MilestoneDoc, MilestonePhase, MilestoneItem, ProgressSummary } from "./types.js";

/** Default empty milestone doc */
function emptyDoc(filePath: string): MilestoneDoc {
  return {
    title: "Project Milestones",
    created: new Date().toISOString().split("T")[0],
    updated: new Date().toISOString().split("T")[0],
    phases: [],
    filePath,
  };
}

/**
 * Parse a MILESTONES.md file into a MilestoneDoc.
 * Handles missing file (returns empty doc) and malformed input (skips unparseable lines).
 */
export function parseMilestones(filePath: string): MilestoneDoc {
  const content = tryRead(filePath);
  if (!content) return emptyDoc(filePath);

  const lines = content.split("\n");
  const doc = emptyDoc(filePath);
  let currentPhase: MilestonePhase | null = null;
  let inFrontmatter = false;
  let frontmatterDone = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1; // 1-indexed

    // Frontmatter parsing
    if (lineNum === 1 && line.trim() === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line.trim() === "---") {
        inFrontmatter = false;
        frontmatterDone = true;
        continue;
      }
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match) {
        const [, key, value] = match;
        if (key === "title") doc.title = value.replace(/^["']|["']$/g, "");
        if (key === "created") doc.created = value.trim();
        if (key === "updated") doc.updated = value.trim();
      }
      continue;
    }

    // Phase header: ## Phase N: Name or ## Name
    const phaseMatch = line.match(/^##\s+(.+)$/);
    if (phaseMatch) {
      currentPhase = {
        name: phaseMatch[1].trim(),
        items: [],
      };
      doc.phases.push(currentPhase);
      continue;
    }

    // Phase description: > text
    if (currentPhase && line.match(/^>\s*(.*)$/)) {
      const desc = line.replace(/^>\s*/, "").trim();
      if (desc) {
        currentPhase.description = currentPhase.description
          ? `${currentPhase.description} ${desc}`
          : desc;
      }
      continue;
    }

    // Checkbox item: - [ ] text or - [x] text
    const itemMatch = line.match(/^-\s+\[([ xX])\]\s+(.+)$/);
    if (itemMatch && currentPhase) {
      const checked = itemMatch[1].toLowerCase() === "x";
      const text = itemMatch[2].trim();
      currentPhase.items.push({
        text,
        checked,
        lineNumber: lineNum,
      });
      continue;
    }
  }

  return doc;
}

/**
 * Write a MilestoneDoc to a MILESTONES.md file.
 * Generates frontmatter, phase headers, descriptions, and checkbox items.
 */
export function writeMilestones(filePath: string, doc: MilestoneDoc): void {
  const lines: string[] = [];

  // Frontmatter
  lines.push("---");
  lines.push(`title: "${doc.title}"`);
  lines.push(`created: ${doc.created}`);
  lines.push(`updated: ${doc.updated}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${doc.title}`);
  lines.push("");

  // Phases
  for (const phase of doc.phases) {
    lines.push(`## ${phase.name}`);
    if (phase.description) {
      lines.push(`> ${phase.description}`);
    }
    lines.push("");
    for (const item of phase.items) {
      const check = item.checked ? "[x]" : "[ ]";
      lines.push(`- ${check} ${item.text}`);
    }
    lines.push("");
  }

  ensureDir(filePath);
  // Atomic write: write to temp, rename
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, lines.join("\n"), "utf-8");
  fs.renameSync(tmpPath, filePath);
}

/**
 * Toggle a checkbox item's status in a MILESTONES.md file.
 * Matches by normalized (lowercase, trimmed) phase name and item text.
 * Returns true if item was found and updated.
 */
export function updateItemStatus(
  filePath: string,
  phaseName: string,
  itemText: string,
  checked: boolean,
): boolean {
  const content = tryRead(filePath);
  if (!content) return false;

  const lines = content.split("\n");
  const normalizedPhase = phaseName.toLowerCase().trim();
  const normalizedItem = itemText.toLowerCase().trim();
  let currentPhase = "";
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track current phase
    const phaseMatch = line.match(/^##\s+(.+)$/);
    if (phaseMatch) {
      currentPhase = phaseMatch[1].trim().toLowerCase();
      continue;
    }

    // Match checkbox in the target phase
    if (currentPhase === normalizedPhase) {
      const itemMatch = line.match(/^-\s+\[([ xX])\]\s+(.+)$/);
      if (itemMatch) {
        const lineText = itemMatch[2].trim().toLowerCase();
        if (lineText === normalizedItem) {
          const mark = checked ? "x" : " ";
          lines[i] = `- [${mark}] ${itemMatch[2].trim()}`;
          found = true;
          break;
        }
      }
    }
  }

  if (found) {
    // Update the 'updated' frontmatter date
    const today = new Date().toISOString().split("T")[0];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].match(/^updated:\s*/)) {
        lines[i] = `updated: ${today}`;
        break;
      }
    }

    // Atomic write
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, lines.join("\n"), "utf-8");
    fs.renameSync(tmpPath, filePath);
  }

  return found;
}

/**
 * Get a progress summary from a MILESTONES.md file.
 * Returns empty summary if file doesn't exist.
 */
export function getProgressSummary(filePath: string): ProgressSummary {
  const doc = parseMilestones(filePath);

  let totalItems = 0;
  let completedItems = 0;
  let currentPhase = "";
  const phases: ProgressSummary["phases"] = [];

  for (const phase of doc.phases) {
    const done = phase.items.filter((i) => i.checked).length;
    const total = phase.items.length;
    totalItems += total;
    completedItems += done;

    phases.push({
      name: phase.name,
      done,
      total,
    });

    // Current phase: first phase with incomplete items
    if (!currentPhase && done < total) {
      currentPhase = phase.name;
    }
  }

  return {
    totalItems,
    completedItems,
    percentComplete: totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0,
    currentPhase: currentPhase || (doc.phases.length > 0 ? doc.phases[0].name : "None"),
    phases,
  };
}
