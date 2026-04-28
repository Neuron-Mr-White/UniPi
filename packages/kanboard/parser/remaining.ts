/**
 * @pi-unipi/kanboard — Remaining Parsers
 *
 * Parsers for quick-work, debug, fix, chore, and review document types.
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

/** Quick-work parser — extracts summary and checklist items */
export class QuickWorkParser implements DocParser {
  canParse(filePath: string): boolean {
    return /\/quick-work\//.test(filePath) && filePath.endsWith(".md");
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

    // Extract checklist items if present
    for (let i = bodyStart; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      const checkboxMatch = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
      if (checkboxMatch) {
        const checked = checkboxMatch[1].toLowerCase() === "x";
        const text = checkboxMatch[2].trim();
        if (text) {
          items.push({
            text,
            status: checked ? "done" : "todo",
            lineNumber: lineNum,
            sourceFile: fileName,
            command: `/unipi:quick-work`,
          });
        }
      }
    }

    return {
      type: "quick-work",
      title: metadata.title ?? fileName.replace(/\.md$/, ""),
      filePath,
      items,
      metadata,
      warnings,
    };
  }

  private emptyDoc(filePath: string, warnings: string[]): ParsedDoc {
    return {
      type: "quick-work",
      title: path.basename(filePath).replace(/\.md$/, ""),
      filePath,
      items: [],
      metadata: {},
      warnings,
    };
  }
}

/** Debug parser — extracts bug description and status */
export class DebugParser implements DocParser {
  canParse(filePath: string): boolean {
    return /\/debug\//.test(filePath) && filePath.endsWith(".md");
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

    // Extract sections as items
    for (let i = bodyStart; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Match ## headers as items
      const headerMatch = line.match(/^##\s+(.+)$/);
      if (headerMatch) {
        const text = headerMatch[1].trim();
        items.push({
          text,
          status: "todo",
          lineNumber: lineNum,
          sourceFile: fileName,
          command: `/unipi:fix debug:${fileName}`,
        });
      }

      // Match checklist items
      const checkboxMatch = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
      if (checkboxMatch) {
        const checked = checkboxMatch[1].toLowerCase() === "x";
        const text = checkboxMatch[2].trim();
        if (text) {
          items.push({
            text,
            status: checked ? "done" : "todo",
            lineNumber: lineNum,
            sourceFile: fileName,
            command: `/unipi:fix debug:${fileName}`,
          });
        }
      }
    }

    return {
      type: "debug",
      title: metadata.title ?? fileName.replace(/\.md$/, ""),
      filePath,
      items,
      metadata,
      warnings,
    };
  }

  private emptyDoc(filePath: string, warnings: string[]): ParsedDoc {
    return {
      type: "debug",
      title: path.basename(filePath).replace(/\.md$/, ""),
      filePath,
      items: [],
      metadata: {},
      warnings,
    };
  }
}

/** Fix parser — extracts what was fixed */
export class FixParser implements DocParser {
  canParse(filePath: string): boolean {
    return /\/fix\//.test(filePath) && filePath.endsWith(".md");
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

    // Extract sections and checklist items
    for (let i = bodyStart; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      const headerMatch = line.match(/^##\s+(.+)$/);
      if (headerMatch) {
        items.push({
          text: headerMatch[1].trim(),
          status: "done",
          lineNumber: lineNum,
          sourceFile: fileName,
          command: `/unipi:fix`,
        });
      }

      const checkboxMatch = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
      if (checkboxMatch) {
        const checked = checkboxMatch[1].toLowerCase() === "x";
        const text = checkboxMatch[2].trim();
        if (text) {
          items.push({
            text,
            status: checked ? "done" : "todo",
            lineNumber: lineNum,
            sourceFile: fileName,
            command: `/unipi:fix`,
          });
        }
      }
    }

    // Extract related debug reference
    const related = metadata.related_debug ?? metadata.debug ?? "";

    return {
      type: "fix",
      title: metadata.title ?? fileName.replace(/\.md$/, ""),
      filePath,
      items,
      metadata: { ...metadata, related_debug: related },
      warnings,
    };
  }

  private emptyDoc(filePath: string, warnings: string[]): ParsedDoc {
    return {
      type: "fix",
      title: path.basename(filePath).replace(/\.md$/, ""),
      filePath,
      items: [],
      metadata: {},
      warnings,
    };
  }
}

/** Chore parser — extracts chore name and steps */
export class ChoreParser implements DocParser {
  canParse(filePath: string): boolean {
    return /\/chore\//.test(filePath) && filePath.endsWith(".md");
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

    // Extract checklist items as steps
    for (let i = bodyStart; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      const checkboxMatch = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
      if (checkboxMatch) {
        const checked = checkboxMatch[1].toLowerCase() === "x";
        const text = checkboxMatch[2].trim();
        if (text) {
          items.push({
            text,
            status: checked ? "done" : "todo",
            lineNumber: lineNum,
            sourceFile: fileName,
            command: `/unipi:chore-execute chore:${fileName}`,
          });
        }
      }
    }

    return {
      type: "chore",
      title: metadata.title ?? metadata.name ?? fileName.replace(/\.md$/, ""),
      filePath,
      items,
      metadata,
      warnings,
    };
  }

  private emptyDoc(filePath: string, warnings: string[]): ParsedDoc {
    return {
      type: "chore",
      title: path.basename(filePath).replace(/\.md$/, ""),
      filePath,
      items: [],
      metadata: {},
      warnings,
    };
  }
}

/** Review parser — extracts review remarks and status */
export class ReviewParser implements DocParser {
  canParse(filePath: string): boolean {
    return /\/reviews\//.test(filePath) && filePath.endsWith(".md");
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

    // Extract checklist items (remarks)
    for (let i = bodyStart; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      const checkboxMatch = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
      if (checkboxMatch) {
        const checked = checkboxMatch[1].toLowerCase() === "x";
        const text = checkboxMatch[2].trim();
        if (text) {
          items.push({
            text,
            status: checked ? "done" : "todo",
            lineNumber: lineNum,
            sourceFile: fileName,
            command: `/unipi:review-work`,
          });
        }
      }
    }

    return {
      type: "review",
      title: metadata.title ?? fileName.replace(/\.md$/, ""),
      filePath,
      items,
      metadata,
      warnings,
    };
  }

  private emptyDoc(filePath: string, warnings: string[]): ParsedDoc {
    return {
      type: "review",
      title: path.basename(filePath).replace(/\.md$/, ""),
      filePath,
      items: [],
      metadata: {},
      warnings,
    };
  }
}
