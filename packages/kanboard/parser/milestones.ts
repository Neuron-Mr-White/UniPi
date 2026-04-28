/**
 * @pi-unipi/kanboard — Milestone Parser
 *
 * Parses MILESTONES.md. Imports `parseMilestones` from `@pi-unipi/milestone`
 * and converts MilestoneDoc to ParsedDoc format.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DocParser, ParsedDoc, ParsedItem } from "../types.js";

/** Milestone parser — converts MilestoneDoc to ParsedDoc */
export class MilestoneParser implements DocParser {
  canParse(filePath: string): boolean {
    return /MILESTONES\.md$/i.test(filePath);
  }

  parse(filePath: string): ParsedDoc {
    const warnings: string[] = [];
    const items: ParsedItem[] = [];
    let content: string;

    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (err: any) {
      warnings.push(`Could not read file: ${err.message}`);
      return this.emptyDoc(filePath, warnings);
    }

    const lines = content.split("\n");
    const fileName = path.basename(filePath);

    // Inline parsing — extract phases and items directly
    // This avoids requiring @pi-unipi/milestone as a runtime dependency
    let currentPhase = "";
    let inFrontmatter = false;
    let frontmatterDone = false;
    let title = "Project Milestones";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Frontmatter parsing
      if (lineNum === 1 && line.trim() === "---") {
        inFrontmatter = true;
        continue;
      }
      if (inFrontmatter && line.trim() === "---") {
        inFrontmatter = false;
        frontmatterDone = true;
        continue;
      }
      if (inFrontmatter) {
        const titleMatch = line.match(/^title:\s*(.+)$/);
        if (titleMatch) {
          title = titleMatch[1].trim().replace(/^["']|["']$/g, "");
        }
        continue;
      }

      // Phase headers (## Phase N: Name)
      const phaseMatch = line.match(/^##\s+(.+)$/);
      if (phaseMatch) {
        currentPhase = phaseMatch[1].trim();
        continue;
      }

      // Checklist items (- [ ] or - [x])
      const checkboxMatch = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
      if (checkboxMatch) {
        const checked = checkboxMatch[1].toLowerCase() === "x";
        const text = checkboxMatch[2].trim();

        if (!text) {
          warnings.push(`Line ${lineNum}: Empty checkbox text`);
          continue;
        }

        items.push({
          text: currentPhase ? `[${currentPhase}] ${text}` : text,
          status: checked ? "done" : "todo",
          lineNumber: lineNum,
          sourceFile: fileName,
          command: `/unipi:milestone-update`,
        });
      }
    }

    return {
      type: "milestone",
      title,
      filePath,
      items,
      metadata: {},
      warnings,
    };
  }

  private emptyDoc(filePath: string, warnings: string[]): ParsedDoc {
    return {
      type: "milestone",
      title: "Project Milestones",
      filePath,
      items: [],
      metadata: {},
      warnings,
    };
  }
}
