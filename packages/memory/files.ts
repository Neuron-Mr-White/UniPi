/**
 * @unipi/memory — Markdown files are the durable tier
 *
 * ~/.unipi/memory/<project>/<type>/<id>.md with YAML frontmatter
 * (id, title, tags, project, created, updated, type). Everything else
 * (MemPalace drawers) is derived from these files.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import {
  MEMORY_TYPES,
  memoryFilePath,
  memoryRoot,
  mempalaceYaml,
  projectDir,
  safeIdPart,
  sanitizeProjectName,
  type MemoryType,
} from "./paths.js";

export interface MemoryRecord {
  id: string;
  title: string;
  content: string;
  tags: string[];
  project: string;
  type: MemoryType;
  created: string;
  updated: string;
  /** Absolute md path when the record came off disk. */
  filePath?: string;
}

interface Frontmatter {
  id?: string;
  title: string;
  tags?: string[];
  project?: string;
  created?: string;
  updated?: string;
  type?: string;
}

export function parseMemoryContent(text: string, filePath?: string): MemoryRecord | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const fm = yaml.load(match[1]) as Frontmatter | undefined;
  if (!fm || typeof fm !== "object" || !fm.title) return null;
  // Legacy files stored the id only in the filename — recover it with the
  // v2 bridge's safe_id_part normalization (parse_markdown_memory parity).
  const fileId = filePath ? safeIdPart(path.basename(filePath, ".md")) : "";
  return {
    id: fm.id ?? fileId,
    title: String(fm.title),
    content: match[2].trim(),
    tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
    project: fm.project ?? "",
    type: (MEMORY_TYPES as readonly string[]).includes(fm.type ?? "")
      ? (fm.type as MemoryType)
      : "summary",
    created: fm.created ?? "",
    updated: fm.updated ?? "",
    filePath,
  };
}

export function parseMemoryFile(filePath: string): MemoryRecord | null {
  try {
    return parseMemoryContent(fs.readFileSync(filePath, "utf-8"), filePath);
  } catch {
    return null;
  }
}

export function memoryDocument(record: MemoryRecord): string {
  const fm = {
    id: record.id,
    title: record.title,
    tags: record.tags,
    project: record.project,
    created: record.created,
    updated: record.updated,
    type: record.type,
  };
  return `---\n${yaml.dump(fm, { lineWidth: -1 })}---\n\n${record.content}\n`;
}

/** Write the record's md file; creates the type dir. Returns the abs path. */
export function writeMemoryFile(record: MemoryRecord): string {
  const filePath = memoryFilePath(record.project, record.type, record.id);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, memoryDocument(record), "utf-8");
  return filePath;
}

/** Write <project>/mempalace.yaml if missing (never overwrites). */
export function ensureMempalaceYaml(project: string): void {
  const dir = projectDir(project);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "mempalace.yaml");
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, mempalaceYaml(project), "utf-8");
  }
  // Keep `mempalace mine <dir>` (the no-daemon fallback) from indexing
  // legacy flat files at the project root — top-level md never belongs
  // to the v3 layout.
  const gitignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(gitignore, "/*.md\n", "utf-8");
  }
}

/** All memory records for a project — every dir whose sanitized name
 *  matches (so a pre-migration `EnvStripper/` still counts for `envstripper`),
 *  at any depth (old flat + typed). */
export function scanProjectMemories(project: string): MemoryRecord[] {
  const out: MemoryRecord[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const rec = parseMemoryFile(full);
        if (rec) out.push(rec);
      }
    }
  };
  for (const { name, dir } of listProjectDirs()) {
    if (name !== project && sanitizeProjectName(name) !== project) continue;
    try { walk(dir); } catch { /* unreadable dir */ }
  }
  return out;
}

/** Directories under ~/.unipi/memory that hold project memories. */
export function listProjectDirs(): Array<{ name: string; dir: string }> {
  const root = memoryRoot();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => ({ name: e.name, dir: path.join(root, e.name) }));
}

/**
 * Word-overlap similarity between two titles — the same rule the old
 * findSimilarByTitle used (Jaccard over >2-char words).
 */
export function titleSimilarity(a: string, b: string): number {
  const norm = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((w) => w.length > 2));
  const wa = norm(a);
  const wb = norm(b);
  const union = new Set([...wa, ...wb]);
  if (union.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter += 1;
  return inter / union.size;
}

/**
 * Find a memory by exact title in the local md files of a project
 * (case-insensitive; the old "exact match" check).
 */
export function findByTitle(project: string, title: string): MemoryRecord | null {
  const lowered = title.trim().toLowerCase();
  return (
    scanProjectMemories(project).find(
      (r) => r.title === title || r.title.toLowerCase() === lowered,
    ) ?? null
  );
}

/** Similar-title memories (≥ threshold) from local md files. */
export function findSimilar(
  project: string,
  title: string,
  threshold = 0.6,
): Array<{ record: MemoryRecord; similarity: number }> {
  return scanProjectMemories(project)
    .map((record) => ({ record, similarity: titleSimilarity(title, record.title) }))
    .filter((x) => x.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity);
}
