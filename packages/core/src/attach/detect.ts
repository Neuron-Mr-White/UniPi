/**
 * @pi-unipi/core — attachments: path detection and tokens (pure + fs reads)
 *
 * A pasted / dropped / Ctrl+V'd file path in the editor becomes a token:
 *   images    → [Image #N]  (sent as real image content on submit)
 *   documents → [File #N]   (expanded back to "[File #N: <path>]" on submit)
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname } from "node:path";

export const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const DOC_EXT = new Set([
  ".pdf", ".txt", ".md", ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml", ".html", ".log",
  ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".rtf", ".zip", ".svg", ".mp3", ".wav", ".mp4", ".mov",
]);

export type AttachmentKind = "image" | "file";

export interface Attachment {
  id: number;
  kind: AttachmentKind;
  path: string;
  name: string;
  bytes: number;
  mimeType?: string;
}

export function tokenFor(a: Pick<Attachment, "kind" | "id">): string {
  return a.kind === "image" ? `[Image #${a.id}]` : `[File #${a.id}]`;
}

export function kindOf(path: string): AttachmentKind | undefined {
  const ext = extname(path).toLowerCase();
  if (IMAGE_MIME[ext]) return "image";
  if (DOC_EXT.has(ext)) return "file";
  return undefined;
}

/** Candidate path spans: quoted, file:// URIs, and bare absolute or ~ paths (escaped spaces ok). */
const CANDIDATE = /'(\/[^'\n]+|~\/[^'\n]+)'|"(\/[^"\n]+|~\/[^"\n]+)"|(file:\/\/\/[^\s'"]+)|((?:~|\/)(?:[^\s'"\\]|\\ )+)/g;

function normalize(raw: string): string {
  let p = raw;
  if (p.startsWith("file://")) {
    try {
      p = decodeURIComponent(p.slice("file://".length));
    } catch {
      p = p.slice("file://".length);
    }
  }
  p = p.replace(/\\ /g, " ");
  if (p.startsWith("~/")) p = homedir() + p.slice(1);
  return p;
}

export interface Found {
  /** Exact text in the editor to replace. */
  raw: string;
  path: string;
  kind: AttachmentKind;
}

/** Existing, attachable files mentioned in `text` (first occurrence each). */
export function findPaths(text: string, exists: (p: string) => boolean = (p) => existsSync(p) && statSync(p).isFile()): Found[] {
  const out: Found[] = [];
  for (const m of text.matchAll(CANDIDATE)) {
    const raw = m[0];
    const path = normalize(m[1] ?? m[2] ?? m[3] ?? m[4] ?? "");
    const kind = kindOf(path);
    if (!kind || out.some((f) => f.path === path)) continue;
    try {
      if (!exists(path)) continue;
    } catch {
      continue;
    }
    out.push({ raw, path, kind });
  }
  return out;
}

/** Replace found paths with tokens; returns the new text and new attachments. */
export function tokenize(
  text: string,
  existing: readonly Attachment[],
  size: (p: string) => number = (p) => statSync(p).size,
  exists?: (p: string) => boolean,
): { text: string; added: Attachment[] } {
  let next = text;
  let id = existing.reduce((m, a) => Math.max(m, a.id), 0);
  const added: Attachment[] = [];
  for (const f of findPaths(text, exists)) {
    const reuse = [...existing, ...added].find((a) => a.path === f.path);
    const a: Attachment = reuse ?? {
      id: ++id,
      kind: f.kind,
      path: f.path,
      name: basename(f.path),
      bytes: (() => {
        try {
          return size(f.path);
        } catch {
          return 0;
        }
      })(),
      ...(f.kind === "image" ? { mimeType: IMAGE_MIME[extname(f.path).toLowerCase()] } : {}),
    };
    if (!reuse) added.push(a);
    next = next.split(f.raw).join(tokenFor(a));
  }
  return { text: next, added };
}

/** Attachments whose token is still in the text. */
export function stillReferenced(text: string, attachments: readonly Attachment[]): Attachment[] {
  return attachments.filter((a) => text.includes(tokenFor(a)));
}

export interface ImagePart {
  type: "image";
  data: string;
  mimeType: string;
}

/**
 * Submit-time expansion: images become image content (in token order), file
 * tokens become "[File #N: <path>]" so the model can read them.
 */
export function expandForSubmit(
  text: string,
  attachments: readonly Attachment[],
  read: (p: string) => Buffer = (p) => readFileSync(p),
): { text: string; images: ImagePart[] } {
  const used = stillReferenced(text, attachments).sort((a, b) => text.indexOf(tokenFor(a)) - text.indexOf(tokenFor(b)));
  const images: ImagePart[] = [];
  let out = text;
  for (const a of used) {
    if (a.kind === "file") {
      out = out.split(tokenFor(a)).join(`[File #${a.id}: ${a.path}]`);
      continue;
    }
    try {
      images.push({ type: "image", data: read(a.path).toString("base64"), mimeType: a.mimeType ?? "image/png" });
    } catch {
      out = out.split(tokenFor(a)).join(`[Image #${a.id}: ${a.path} (unreadable)]`);
    }
  }
  return { text: out, images };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
