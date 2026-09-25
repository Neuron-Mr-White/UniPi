import { marked } from "marked";
import DOMPurify from "dompurify";

/**
 * Markdown → sanitised HTML (bodies and comments are user/agent text, never trusted).
 *
 * `att:<TASK>/<name>` references (what `unipi-kanboard attach` and the UI upload
 * produce) are rewritten to the daemon's file route and rendered by kind:
 *   image  → inline image (click opens full size)
 *   video  → <video controls>, audio → <audio controls>
 *   pdf / text / other → a file chip (name + kind), opening in a new tab
 * Only `att:` URLs pointing at this project are turned into media; plain links
 * stay links.
 */

const ATT = /^att:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
const VIDEO = /\.(mp4|webm|mov|m4v|ogv)$/i;
const AUDIO = /\.(mp3|wav|ogg|m4a|flac|opus)$/i;
const PDF = /\.pdf$/i;
const TEXT = /\.(txt|log|md|csv|json|ya?ml|toml|diff|patch)$/i;

export type AttKind = "image" | "video" | "audio" | "pdf" | "text" | "file";

export function attKind(name: string): AttKind {
  if (IMAGE.test(name)) return "image";
  if (VIDEO.test(name)) return "video";
  if (AUDIO.test(name)) return "audio";
  if (PDF.test(name)) return "pdf";
  if (TEXT.test(name)) return "text";
  return "file";
}

let fileBase = "";
/** Set once the project is known: `/api/files/<slug>`. */
export function setAttachmentBase(slug: string | null): void {
  fileBase = slug ? `/api/files/${encodeURIComponent(slug)}` : "";
}

export function attUrl(reference: string): string | null {
  const match = ATT.exec(reference.trim());
  if (!match || !fileBase) return null;
  return `${fileBase}/${match[1]}/${match[2]}`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function displayName(name: string): string {
  // stored as <sha8>-<name>
  return name.replace(/^[0-9a-f]{8}-/, "");
}

const FILE_ICON: Record<AttKind, string> = {
  image: "IMG",
  video: "VID",
  audio: "AUD",
  pdf: "PDF",
  text: "TXT",
  file: "FILE",
};

function chip(url: string, name: string, kind: AttKind, label?: string): string {
  const shown = escapeHtml(label && label.trim() ? label : displayName(name));
  const ext = (name.split(".").pop() ?? "").slice(0, 5).toUpperCase();
  return `<a class="att-chip att-${kind}" href="${url}" target="_blank" rel="noopener"><span class="att-badge">${escapeHtml(
    kind === "file" && ext ? ext : FILE_ICON[kind],
  )}</span><span class="att-name">${shown}</span></a>`;
}

function media(reference: string, alt: string): string | null {
  const match = ATT.exec(reference.trim());
  const url = attUrl(reference);
  if (!match || !url) return null;
  const name = match[2]!;
  const kind = attKind(name);
  const label = escapeHtml(alt || displayName(name));
  switch (kind) {
    case "image":
      return `<a class="att-image" href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${label}" loading="lazy"></a>`;
    case "video":
      return `<video class="att-video" src="${url}" controls preload="metadata"></video>`;
    case "audio":
      return `<audio class="att-audio" src="${url}" controls preload="metadata"></audio>`;
    default:
      return chip(url, name, kind, alt);
  }
}

const renderer = new marked.Renderer();
const baseImage = renderer.image.bind(renderer);
const baseLink = renderer.link.bind(renderer);
renderer.image = function (token) {
  return media(token.href, token.text) ?? baseImage(token);
};
renderer.link = function (token) {
  const match = ATT.exec(token.href.trim());
  const url = attUrl(token.href);
  if (match && url) {
    const kind = attKind(match[2]!);
    // A plain link to an image/video still previews it — nobody wants a chip for a screenshot.
    if (kind === "image" || kind === "video" || kind === "audio") return media(token.href, token.text) ?? baseLink(token);
    return chip(url, match[2]!, kind, token.text);
  }
  return baseLink(token);
};

DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
  // keep target=_blank on our chips/images; everything else stays default
  if (data.attrName === "target" && node.nodeName === "A") data.forceKeepAttr = true;
});

export function renderMarkdown(text: string | undefined): string {
  const source = (text ?? "").trim();
  if (source.length === 0) return "";
  const html = marked.parse(source, { async: false, gfm: true, breaks: true, renderer }) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_TAGS: ["video", "audio"],
    ADD_ATTR: ["controls", "preload", "loading", "target"],
    // att: must never reach the DOM raw; relative /api/files URLs only
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|\/api\/files\/|#|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  });
}

/** Does this text contain an attachment reference? (comments render as markdown only then) */
export function hasMarkup(text: string): boolean {
  return /att:|!\[|\]\(|```|^#{1,6} |\*\*|^\s*[-*] |^\s*\d+\. |^\s*\|.*\|\s*$/m.test(text);
}

/** "3m ago", "2h ago", "5d ago" — short, tabular-friendly. */
export function relativeTime(iso: string | undefined): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
