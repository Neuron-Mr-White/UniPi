/**
 * @pi-unipi/kanboard — Parser Registry
 *
 * Central registry for document parsers. Auto-detects doc type
 * by file path and routes to the appropriate parser.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DocParser, ParsedDoc } from "../types.js";

/** Parser registry — manages all document parsers */
export class ParserRegistry {
  private parsers: DocParser[] = [];

  /** Register a parser */
  register(parser: DocParser): void {
    this.parsers.push(parser);
  }

  /** Parse a single file using the matching parser */
  parse(filePath: string): ParsedDoc | null {
    for (const parser of this.parsers) {
      if (parser.canParse(filePath)) {
        return parser.parse(filePath);
      }
    }
    return null;
  }

  /** Parse all matching files in a directory */
  parseAll(dir: string): ParsedDoc[] {
    const results: ParsedDoc[] = [];
    const files = this.findDocFiles(dir);

    for (const file of files) {
      const doc = this.parse(file);
      if (doc) {
        results.push(doc);
      }
    }

    return results;
  }

  /** Recursively find .md files in docs directory */
  private findDocFiles(dir: string): string[] {
    const files: string[] = [];

    if (!fs.existsSync(dir)) return files;

    const walk = (currentDir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push(fullPath);
        }
      }
    };

    walk(dir);
    return files;
  }
}

/** Create a registry with all default parsers registered. */
export async function createDefaultRegistry(): Promise<ParserRegistry> {
  const registry = new ParserRegistry();

  // Register checkbox-driven parsers (spec, quick-work, debug, fix, chore, review)
  const { CheckboxParser, CHECKBOX_DOC_CONFIGS } = await import("./checkbox-parser.js");
  for (const config of CHECKBOX_DOC_CONFIGS) {
    registry.register(new CheckboxParser(config));
  }

  // Register plan parser (task-header + status-line format, not checkbox)
  const { PlanParser } = await import("./plans.js");
  registry.register(new PlanParser());

  // Register milestone parser (inline frontmatter + phase headers)
  const { MilestoneParser } = await import("./milestones.js");
  registry.register(new MilestoneParser());

  return registry;
}
