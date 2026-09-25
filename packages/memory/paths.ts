/**
 * @unipi/memory — Path + naming rules
 *
 * Memory file layout: ~/.unipi/memory/<project>/<type>/<id>.md
 * project = sanitized basename of cwd (same rule as agent_gate.py /
 * room_detector_local.py: every run of non-alphanumerics -> "_", trim "_",
 * lowercase, fallback "unknown"). wing = project everywhere.
 */

import * as path from "node:path";
import * as os from "node:os";

export const MEMORY_TYPES = ["preference", "decision", "pattern", "summary"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export function memoryRoot(): string {
  return path.join(os.homedir(), ".unipi", "memory");
}

export function palacePath(): string {
  return path.join(os.homedir(), ".mempalace", "palace");
}

/**
 * The shared project/wing name. Same rule as
 * `~/.config/mempalace/agent_gate.py::sanitize_project_name`:
 *   re.sub(r"[^A-Za-z0-9]+", "_", basename).strip("_").lower() or "unknown"
 */
export function projectName(cwd: string): string {
  const base = path.basename(cwd.replace(/[/\\]+$/, ""));
  const name = base.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  return name || "unknown";
}

/** The same rule applied to an already-project-ish string (conversion input). */
export function sanitizeProjectName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  return cleaned || "unknown";
}

/** Memory id from its title (unchanged rule from the old storage layer). */
export function idFromTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

/** The v2 bridge's safe_id_part — the filename-stem fallback id rule:
 *  `[^A-Za-z0-9]+ -> "_", trimmed "_", lowercased, "unknown" when empty. */
export function safeIdPart(stem: string): string {
  const cleaned = stem.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  return cleaned || "unknown";
}

export function projectDir(project: string): string {
  return path.join(memoryRoot(), project);
}

export function memoryFilePath(project: string, type: MemoryType, id: string): string {
  return path.join(projectDir(project), type, `${id}.md`);
}

/**
 * Bridge-parity percent encoding for unipi:// URIs, for the conversion
 * cleanup path. Python: re.sub(r"[^A-Za-z0-9_.~-]", ord->%02X — hex of the
 * full code point, uppercase, minimum 2 digits.
 */
export function quoteUriPart(value: string): string {
  let out = "";
  for (const ch of value) {
    out += /^[A-Za-z0-9_.~-]$/.test(ch)
      ? ch
      : `%${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** The bridge's old source_file URI for a record. */
export function legacySourceUri(project: string, id: string): string {
  return `unipi://memory/${quoteUriPart(project)}/${quoteUriPart(id)}`;
}

/** The per-project mempalace.yaml — rooms = the 4 memory types + general. */
export function mempalaceYaml(project: string): string {
  const room = (name: string, description: string, keywords: string[]) =>
    `  - name: ${name}\n    description: ${description}\n    keywords: [${keywords.join(", ")}]`;
  return [
    `wing: ${project}`,
    "rooms:",
    room("preference", "user preferences", ["preference", "prefer"]),
    room("decision", "decisions", ["decision", "decided"]),
    room("pattern", "patterns", ["pattern"]),
    room("summary", "summaries", ["summary", "summarize"]),
    room("general", "catch-all", ["general"]),
    "",
  ].join("\n");
}
