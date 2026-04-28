/**
 * @pi-unipi/kanboard — Shared types
 */

/** Document types that kanboard can parse */
export type DocType =
  | "spec"
  | "plan"
  | "milestone"
  | "quick-work"
  | "debug"
  | "fix"
  | "chore"
  | "review";

/** Status of a parsed item */
export type ItemStatus = "todo" | "in-progress" | "done";

/** A single parsed item from a document */
export interface ParsedItem {
  /** Item text content */
  text: string;
  /** Current status */
  status: ItemStatus;
  /** Line number in source file (1-indexed) */
  lineNumber: number;
  /** Source file path (relative) */
  sourceFile: string;
  /** Copy command for this item */
  command?: string;
}

/** A parsed document */
export interface ParsedDoc {
  /** Document type */
  type: DocType;
  /** Document title (from frontmatter or filename) */
  title: string;
  /** File path (relative) */
  filePath: string;
  /** Parsed items */
  items: ParsedItem[];
  /** Frontmatter metadata */
  metadata: Record<string, string>;
  /** Warnings collected during parsing */
  warnings: string[];
}

/** Parser interface — each doc type implements this */
export interface DocParser {
  /** Check if this parser can handle the given file */
  canParse(filePath: string): boolean;
  /** Parse the file and return a ParsedDoc */
  parse(filePath: string): ParsedDoc;
}

/** Kanboard configuration */
export interface KanboardConfig {
  /** HTTP server port */
  port: number;
  /** Maximum port to try */
  maxPort: number;
  /** Root directory for docs */
  docsRoot: string;
  /** PID file path */
  pidFile: string;
}
