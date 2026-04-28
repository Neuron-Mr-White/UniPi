/**
 * @pi-unipi/kanboard — Plan Parser
 *
 * Parses plans for `unstarted:` / `in-progress:` / `completed:` task statuses.
 * Also handles `failed:`, `awaiting_user:`, `blocked:`, `skipped:`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DocParser, ParsedDoc, ParsedItem, ItemStatus } from "../types.js";

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

/** Status keyword to ItemStatus mapping */
const STATUS_MAP: Record<string, ItemStatus> = {
  unstarted: "todo",
  "in-progress": "in-progress",
  completed: "done",
  failed: "todo",
  awaiting_user: "in-progress",
  blocked: "in-progress",
  skipped: "done",
};

/** Status keywords to match */
const STATUS_PATTERN =
  /^\s*-?\s*\*?\*?(unstarted|in-progress|completed|failed|awaiting_user|blocked|skipped):\s*\*?\*?(.*)$/;

/** Plan parser — extracts task statuses from plans */
export class PlanParser implements DocParser {
  canParse(filePath: string): boolean {
    return /\/plans\//.test(filePath) && filePath.endsWith(".md");
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

      const match = line.match(STATUS_PATTERN);
      if (match) {
        const statusKey = match[1];
        const text = match[2].trim();

        if (!text) {
          warnings.push(`Line ${lineNum}: Empty task name after status`);
          continue;
        }

        const status = STATUS_MAP[statusKey] ?? "todo";

        items.push({
          text,
          status,
          lineNumber: lineNum,
          sourceFile: fileName,
          command: `/unipi:work plan:${fileName}`,
        });
      }
    }

    return {
      type: "plan",
      title: metadata.title ?? fileName.replace(/\.md$/, ""),
      filePath,
      items,
      metadata,
      warnings,
    };
  }

  private emptyDoc(filePath: string, warnings: string[]): ParsedDoc {
    return {
      type: "plan",
      title: path.basename(filePath).replace(/\.md$/, ""),
      filePath,
      items: [],
      metadata: {},
      warnings,
    };
  }
}
