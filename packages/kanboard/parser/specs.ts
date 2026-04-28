/**
 * @pi-unipi/kanboard — Spec Parser
 *
 * Parses brainstorm specs for `- [ ]` / `- [x]` checklist items.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DocParser, ParsedDoc, ParsedItem } from "../types.js";

/** Parse frontmatter from markdown file */
function parseFrontmatter(content: string): {
  metadata: Record<string, string>;
  bodyStart: number;
} {
  const metadata: Record<string, string> = {};
  const lines = content.split("\n");

  if (lines[0]?.trim() !== "---") return { metadata, bodyStart: 0 };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") {
      return { metadata, bodyStart: i + 1 };
    }
    const match = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (match) {
      metadata[match[1]] = match[2].trim();
    }
  }

  return { metadata, bodyStart: 0 };
}

/** Spec parser — extracts checklist items from brainstorm specs */
export class SpecParser implements DocParser {
  canParse(filePath: string): boolean {
    return /\/specs\//.test(filePath) && filePath.endsWith(".md");
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

    const { metadata, bodyStart } = parseFrontmatter(content);
    const lines = content.split("\n");
    const fileName = path.basename(filePath);

    for (let i = bodyStart; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1; // 1-indexed

      // Match `- [ ]` and `- [x]` patterns
      const checkboxMatch = line.match(/^(\s*)-\s*\[([ xX])\]\s*(.*)$/);
      if (checkboxMatch) {
        const checked = checkboxMatch[2].toLowerCase() === "x";
        const text = checkboxMatch[3].trim();

        if (!text) {
          warnings.push(`Line ${lineNum}: Empty checkbox text`);
          continue;
        }

        items.push({
          text,
          status: checked ? "done" : "todo",
          lineNumber: lineNum,
          sourceFile: fileName,
          command: `/unipi:plan specs:${fileName}`,
        });
      }
    }

    return {
      type: "spec",
      title: metadata.title ?? fileName.replace(/\.md$/, ""),
      filePath,
      items,
      metadata,
      warnings,
    };
  }

  private emptyDoc(
    filePath: string,
    warnings: string[],
  ): ParsedDoc {
    return {
      type: "spec",
      title: path.basename(filePath).replace(/\.md$/, ""),
      filePath,
      items: [],
      metadata: {},
      warnings,
    };
  }
}
