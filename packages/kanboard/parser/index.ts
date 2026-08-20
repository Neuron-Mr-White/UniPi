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

/** Create a registry with all default parsers registered */
export async function createDefaultRegistry(): Promise<ParserRegistry> {
  const registry = new ParserRegistry();

  // Import and register all parsers
  const { SpecParser } = await import("./specs.js");
  const { PlanParser } = await import("./plans.js");
  const { MilestoneParser } = await import("./milestones.js");
  const {
    QuickWorkParser,
    DebugParser,
    FixParser,
    ChoreParser,
    ReviewParser,
  } = await import("./remaining.js");

  registry.register(new SpecParser());
  registry.register(new PlanParser());
  registry.register(new MilestoneParser());
  registry.register(new QuickWorkParser());
  registry.register(new DebugParser());
  registry.register(new FixParser());
  registry.register(new ChoreParser());
  registry.register(new ReviewParser());

  return registry;
}
