import { marked } from "marked";
import DOMPurify from "dompurify";

/** Markdown → sanitised HTML (the body is user/agent text, never trusted). */
export function renderMarkdown(text: string | undefined): string {
  const source = (text ?? "").trim();
  if (source.length === 0) return "";
  const html = marked.parse(source, { async: false, gfm: true, breaks: true }) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
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
