/**
 * @pi-unipi/kanboard — Config-driven checkbox document parser
 *
 * Replaces 7 separate parser classes (Spec, QuickWork, Debug, Fix, Chore, Review,
 * and the checkbox-extraction half of Milestone) with one config-driven class.
 * Each doc type is just: path regex + type label + command string + checkbox pattern.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DocParser, ParsedDoc, ParsedItem, DocType } from "../types.js";
import { parseFrontmatter } from "./frontmatter.js";

/** Config for a checkbox-based document type. */
interface CheckboxDocConfig {
  /** Document type label */
  type: DocType;
  /** Path regex to match (e.g. /\/specs\//) */
  pathRegex: RegExp;
  /** Command string for parsed items */
  command: string | ((fileName: string) => string);
  /** Whether to also extract ## headers as items (default: false) */
  extractHeaders?: boolean;
  /** Status for header items (default: "todo") */
  headerStatus?: "todo" | "done";
  /** Extra metadata fields to include */
  extraMetadata?: (metadata: Record<string, string>) => Record<string, string>;
  /** Custom title extraction (default: metadata.title ?? fileName) */
  titleExtractor?: (metadata: Record<string, string>, fileName: string) => string;
}

const CHECKBOX_PATTERN = /^\s*-\s*\[([ xX])\]\s*(.*)$/;
const HEADER_PATTERN = /^##\s+(.+)$/;

/** Config-driven parser for checkbox-style documents. */
export class CheckboxParser implements DocParser {
  constructor(private config: CheckboxDocConfig) {}

  canParse(filePath: string): boolean {
    return this.config.pathRegex.test(filePath) && filePath.endsWith(".md");
  }

  parse(filePath: string): ParsedDoc {
    const warnings: string[] = [];
    const items: ParsedItem[] = [];
    let content: string;

    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (err: unknown) {
      warnings.push(`Could not read file: ${err instanceof Error ? err.message : String(err)}`);
      return this.emptyDoc(filePath, warnings);
    }

    const { metadata, bodyStart } = parseFrontmatter(content);
    const lines = content.split("\n");
    const fileName = path.basename(filePath);
    const cmd = typeof this.config.command === "function"
      ? this.config.command(fileName)
      : this.config.command;

    for (let i = bodyStart; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Match ## headers if configured
      if (this.config.extractHeaders) {
        const headerMatch = line.match(HEADER_PATTERN);
        if (headerMatch) {
          items.push({
            text: headerMatch[1].trim(),
            status: this.config.headerStatus ?? "todo",
            lineNumber: lineNum,
            sourceFile: fileName,
            command: cmd,
          });
        }
      }

      // Match checklist items
      const checkboxMatch = line.match(CHECKBOX_PATTERN);
      if (checkboxMatch) {
        const checked = checkboxMatch[1].toLowerCase() === "x";
        const text = checkboxMatch[2].trim();
        if (text) {
          items.push({
            text,
            status: checked ? "done" : "todo",
            lineNumber: lineNum,
            sourceFile: fileName,
            command: cmd,
          });
        }
      }
    }

    const title = this.config.titleExtractor
      ? this.config.titleExtractor(metadata, fileName)
      : (metadata.title ?? fileName.replace(/\.md$/, ""));

    const finalMetadata = this.config.extraMetadata
      ? this.config.extraMetadata(metadata)
      : metadata;

    return {
      type: this.config.type,
      title,
      filePath,
      items,
      metadata: finalMetadata,
      warnings,
    };
  }

  private emptyDoc(filePath: string, warnings: string[]): ParsedDoc {
    return {
      type: this.config.type,
      title: path.basename(filePath).replace(/\.md$/, ""),
      filePath,
      items: [],
      metadata: {},
      warnings,
    };
  }
}

/** All checkbox doc configs — drives the 6 simple parsers. */
export const CHECKBOX_DOC_CONFIGS: CheckboxDocConfig[] = [
  {
    type: "spec",
    pathRegex: /\/specs\//,
    command: (f) => `/unipi:plan specs:${f}`,
  },
  {
    type: "quick-work",
    pathRegex: /\/quick-work\//,
    command: "/unipi:quick-work",
  },
  {
    type: "debug",
    pathRegex: /\/debug\//,
    command: (f) => `/unipi:fix debug:${f}`,
    extractHeaders: true,
    headerStatus: "todo",
  },
  {
    type: "fix",
    pathRegex: /\/fix\//,
    command: "/unipi:fix",
    extractHeaders: true,
    headerStatus: "done",
    extraMetadata: (m) => ({ ...m, related_debug: m.related_debug ?? m.debug ?? "" }),
  },
  {
    type: "chore",
    pathRegex: /\/chore\//,
    command: (f) => `/unipi:chore-execute chore:${f}`,
    titleExtractor: (m, f) => m.title ?? m.name ?? f.replace(/\.md$/, ""),
  },
  {
    type: "review",
    pathRegex: /\/reviews\//,
    command: "/unipi:review-work",
  },
];
