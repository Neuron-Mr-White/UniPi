/**
 * Getting files into a comment or description: paste, drop or pick → upload →
 * insert the returned markdown at the cursor. Pasted screenshots get a readable
 * name (`screenshot-2026-09-24-1402.png`).
 */
import { api, type Attachment } from "./api.js";
import { describe, slug, toast } from "./state.js";

export function namedFile(file: File): File {
  if (file.name && file.name !== "image.png") return file;
  const ext = (file.type.split("/")[1] ?? "bin").replace("jpeg", "jpg").replace(/\+.*/, "");
  const stamp = new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "");
  return new File([file], `${file.type.startsWith("image/") ? "screenshot" : "file"}-${stamp}.${ext}`, { type: file.type });
}

export async function uploadAll(taskId: string, files: File[]): Promise<Attachment[]> {
  const target = slug();
  if (!target || files.length === 0) return [];
  const done: Attachment[] = [];
  for (const raw of files) {
    const file = namedFile(raw);
    try {
      done.push(await api.upload(target, taskId, file));
    } catch (error) {
      toast(describe(error), "error");
    }
  }
  return done;
}

/** Insert text at the textarea's cursor (on its own line) and return the new value. */
export function insertAtCursor(area: HTMLTextAreaElement | undefined, current: string, snippet: string): string {
  if (!area) return current ? `${current}\n${snippet}` : snippet;
  const start = area.selectionStart ?? current.length;
  const end = area.selectionEnd ?? current.length;
  const before = current.slice(0, start);
  const after = current.slice(end);
  const lead = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
  const trail = after.length > 0 && !after.startsWith("\n") ? "\n" : "";
  const next = `${before}${lead}${snippet}${trail}${after}`;
  const caret = (before + lead + snippet).length;
  queueMicrotask(() => {
    area.focus();
    area.setSelectionRange(caret, caret);
  });
  return next;
}

export function filesFrom(event: ClipboardEvent | DragEvent): File[] {
  const list = "clipboardData" in event ? event.clipboardData?.files : (event as DragEvent).dataTransfer?.files;
  return list ? [...list] : [];
}
