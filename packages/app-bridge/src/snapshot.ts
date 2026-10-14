/**
 * Phone-safe copies of session entries: images replaced by a marker (with a
 * thumbnail when small, else a fetchable `ref` — see `media.ts`), long text
 * clipped, the hello snapshot capped so its line fits one relay frame.
 */
import { registerBase64, registerPath } from "./media.js";
import { isSilentEcho } from "@pi-unipi/core";

/** UNI-251: echoes of internal commands the phone never shows, even from
 * sessions recorded before core learned to silence them. */
const HIDDEN_ECHO_COMMANDS = new Set(["unipi-app-session"]);

/** True for a `unipi-command-echo` of an internal (hidden) command. */
export function hiddenEcho(entry: unknown): boolean {
  const e = entry as { type?: string; customType?: string; data?: { text?: unknown } } | null;
  if (!e || e.type !== "custom" || e.customType !== "unipi-command-echo") return false;
  const text = e.data?.text;
  if (typeof text !== "string") return false;
  const name = text.trim().split(/\s/, 1)[0] ?? "";
  if (HIDDEN_ECHO_COMMANDS.has(name.replace(/^\//, ""))) return true;
  try {
    return isSilentEcho(text);
  } catch {
    return false;
  }
}

/** Images this small are sent whole (base64) in the placeholder; bigger
 * ones get a `ref` the phone fetches on demand via `media{mediaRef}`. */
export const INLINE_THUMBNAIL_MAX = 24 * 1024;

/** One relay frame is 1 MiB; keep every line well under it (UTF-8 bytes). */
export const LINE_BUDGET = 900 * 1024;
/** The entries of a hello snapshot get this much; the rest of the hello
 * (commands, models, state) fits in what is left of LINE_BUDGET. */
export const ENTRIES_BUDGET = 600 * 1024;
/** The first screenful(s) on connect; older history pages in on scroll-up. */
export const HELLO_ENTRIES_BUDGET = 256 * 1024;
/** Tool-result / custom-message `details` kept per entry: the phone reads
 * only small scalar fields (status, exit code, durations, usage, report text). */
export const DETAILS_CLIP = 4 * 1024;
/** Fields of `details` the phone never shows, dropped outright (run logs). */
const DETAILS_DROP = new Set(["events", "messages", "transcript", "steps", "history", "output", "fullOutput", "raw", "diff", "patch"]);

/** UTF-8 size of a JSON value as sent. */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

/** A small, phone-useful copy of a `details` object: run logs dropped, strings clipped, total capped. */
export function slimDetails(details: unknown): Json {
  if (!details || typeof details !== "object" || Array.isArray(details)) return phoneSafe(details, 2 * 1024);
  const out: Record<string, Json> = {};
  let used = 0;
  for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
    if (DETAILS_DROP.has(k) || typeof v === "function" || v === undefined) continue;
    // File attachments (kanboard uploads, screenshots, tool-produced files):
    // register each path so the host's blob_get{path} can serve it, and give
    // the phone a mediaRef it can fetch inline bytes through too.
    if (k === "attachments" && Array.isArray(v)) {
      out[k] = v.slice(0, 20).map((a) => attachmentSafe(a));
      continue;
    }
    // Report-like text the phone shows in a card keeps more room.
    const max = k === "report" || k === "text" ? 32 * 1024 : 2 * 1024;
    const safe = phoneSafe(v, max, 1);
    const size = jsonBytes(safe);
    if (k !== "report" && k !== "text" && used + size > DETAILS_CLIP) continue;
    out[k] = safe;
    used += size;
  }
  return out;
}
/** Longest text block kept inside one entry. */
export const TEXT_CLIP = 64 * 1024;
/** Tool-result text kept per entry (the phone shows a tail anyway). */
export const TOOL_TEXT_CLIP = 16 * 1024;

export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.25);
  const tail = max - head;
  return `${text.slice(0, head)}\n…[clipped ${text.length - max} chars]…\n${text.slice(text.length - tail)}`;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** One `details.attachments[]` entry (kanboard uploads, tool-produced files,
 * screenshot paths…): `{path, mime, size, caption?}`. Registers `path` with
 * the media registry (host blob allow-list + phone `media{mediaRef}` fetch)
 * and keeps only the small scalar fields on the wire. */
function attachmentSafe(raw: unknown): Json {
  const a = raw as { path?: unknown; mime?: unknown; size?: unknown; caption?: unknown } | null;
  if (!a || typeof a.path !== "string") return null;
  const mime = typeof a.mime === "string" ? a.mime : "application/octet-stream";
  const mediaRef = registerPath(a.path, mime);
  return {
    path: a.path,
    mime,
    ...(typeof a.size === "number" ? { size: a.size } : {}),
    ...(typeof a.caption === "string" ? { caption: clipText(a.caption, 256) } : {}),
    mediaRef,
  };
}

/** Deep copy of a content part list / message with images and big text made phone-safe. */
export function phoneSafe(value: unknown, textMax = TEXT_CLIP, depth = 0): Json {
  if (depth > 40) return null;
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return clipText(value, textMax);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => phoneSafe(v, textMax, depth + 1));
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (o.type === "image" && typeof o.data === "string") {
      const mime = typeof o.mimeType === "string" ? o.mimeType : "image/*";
      const bytes = Math.round((o.data.length * 3) / 4);
      // Small enough to inline whole (a thumbnail already, or a tiny icon):
      // the phone can show it immediately with no round trip.
      if (o.data.length <= INLINE_THUMBNAIL_MAX) {
        return { type: "image", mime, omitted: false, bytes, data: o.data };
      }
      // Too big to inline: register it and let the phone fetch it with
      // `media{mediaRef}` only if/when it actually renders this message.
      const ref = registerBase64(o.data, mime);
      return { type: "image", mime, omitted: true, bytes, mediaRef: ref };
    }
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "function" || v === undefined) continue;
      // Message / entry `details` (tool results, custom messages): slimmed.
      if (k === "details" && depth <= 2) {
        out[k] = slimDetails(v);
        continue;
      }
      // Tool results: clip their text harder than prose.
      const max = k === "content" && o.role === "toolResult" ? TOOL_TEXT_CLIP : textMax;
      out[k] = phoneSafe(v, max, depth + 1);
    }
    return out;
  }
  return null;
}

/** The entry types worth sending; state-only custom entries are dropped. */
const STATE_ONLY_CUSTOM = new Set([
  "compactor-origin",
  "unipi:auto-name",
  "unipi:skills-revealed",
  "unipi:skills-judged",
  "unipi:plan-mode",
  "pi.virtual-model-state",
]);

/** Entry types the phone never draws (state, tree bookkeeping). */
const SKIP_TYPES = new Set(["label", "session_info", "session", "thinking_level_change", "context_edit", "branch_summary_state"]);

export function wantedEntry(entry: unknown): boolean {
  const e = entry as { type?: string; customType?: string; display?: boolean; message?: { role?: string } } | null;
  if (!e || typeof e.type !== "string") return false;
  if (SKIP_TYPES.has(e.type)) return false;
  // The system prompt is huge and never shown.
  if (e.type === "message" && e.message?.role === "system") return false;
  if (e.type === "custom" && e.customType && STATE_ONLY_CUSTOM.has(e.customType)) return false;
  if (hiddenEcho(e)) return false;
  // Hidden custom messages (display:false, e.g. unipi-continue triggers).
  if (e.type === "custom_message" && e.display === false) return false;
  return true;
}

/** Entries hidden by a later `context_edit` (replacement null) on the branch. */
export function editedAway(branch: readonly unknown[]): Set<string> {
  const hidden = new Set<string>();
  for (const e of branch as Array<{ type?: string; targetId?: string; replacement?: unknown }>) {
    if (e?.type === "context_edit" && typeof e.targetId === "string" && e.replacement === null) hidden.add(e.targetId);
  }
  return hidden;
}

/**
 * The active branch from its latest compaction on (that compaction entry
 * included), phone-safe, trimmed from the oldest end until the serialized
 * size fits `budget`.
 */
export function snapshotEntries(branch: readonly unknown[], budget = ENTRIES_BUDGET): { entries: Json[]; truncated: boolean } {
  let start = 0;
  for (let i = branch.length - 1; i >= 0; i--) {
    if ((branch[i] as { type?: string })?.type === "compaction") {
      start = i;
      break;
    }
  }
  const hidden = editedAway(branch);
  const picked = branch
    .slice(start)
    .filter((e) => wantedEntry(e) && !hidden.has((e as { id?: string }).id ?? ""))
    .map((e) => phoneSafe(e));
  let truncated = start > 0;
  const sizes = picked.map((e) => jsonBytes(e) + 1);
  let total = sizes.reduce((a, b) => a + b, 0);
  let from = 0;
  while (total > budget && from < picked.length - 1) {
    total -= sizes[from]!;
    from++;
    truncated = true;
  }
  let entries = picked.slice(from);
  if (total > budget && entries.length === 1) {
    // One giant entry: clip it harder.
    entries = [phoneSafe(entries[0], 8 * 1024)];
  }
  return { entries, truncated };
}

/** A line that is sure to fit the relay frame (clip harder, then give up on the payload). */
export function fitLine(msg: object): string {
  let line = JSON.stringify(msg);
  if (Buffer.byteLength(line, "utf8") <= LINE_BUDGET) return line;
  line = JSON.stringify(phoneSafe(msg, 8 * 1024));
  if (Buffer.byteLength(line, "utf8") <= LINE_BUDGET) return line;
  const t = (msg as { t?: string }).t ?? "unknown";
  return JSON.stringify({ t: "error", message: `A ${t} message was too large to send to the phone.` });
}

/**
 * A page of history ending right before entry `before` on the active branch
 * (compactions included as markers, nothing skipped): the newest entries
 * that fit `budget`, oldest first. `more` = older entries remain.
 * `before` not on the branch → empty page, more false.
 */
export function historyPage(branch: readonly unknown[], before: string, budget = ENTRIES_BUDGET, until?: string): { entries: Json[]; more: boolean } {
  const end = branch.findIndex((e) => (e as { id?: string })?.id === before);
  if (end <= 0) return { entries: [], more: false };
  const hidden = editedAway(branch);
  // UNI-275 "navigate to": page back at least to `until` (+ a little context
  // above it); entries are clipped harder once the budget is spent so the
  // page still fits one frame.
  const target = until ? branch.findIndex((e) => (e as { id?: string })?.id === until) : -1;
  const stopAt = target >= 0 && target < end ? Math.max(0, target - 6) : -1;
  const out: Json[] = [];
  let used = 0;
  let i = end - 1;
  for (; i >= 0; i--) {
    const e = branch[i];
    if (!wantedEntry(e) || hidden.has((e as { id?: string }).id ?? "")) continue;
    const reaching = stopAt >= 0 && i >= stopAt;
    let safe = phoneSafe(e);
    let size = jsonBytes(safe) + 1;
    if (used + size > budget && out.length > 0) {
      if (!reaching) break;
      // Reaching for the target: keep going with small copies.
      safe = phoneSafe(e, 1024);
      size = jsonBytes(safe) + 1;
      // Never past one relay frame; the app keeps paging toward the target.
      if (used + size > Math.max(budget, LINE_BUDGET - 96 * 1024)) break;
    }
    out.push(size > budget ? phoneSafe(e, 8 * 1024) : safe);
    used += size;
    if (stopAt >= 0 && i <= stopAt && used >= budget / 4) {
      i -= 1;
      break;
    }
  }
  // Any wanted entry left before i?
  let more = false;
  for (let j = i; j >= 0; j--) {
    const e = branch[j];
    if (wantedEntry(e) && !hidden.has((e as { id?: string }).id ?? "")) {
      more = true;
      break;
    }
  }
  return { entries: out.reverse(), more };
}

/** UNI-290: what goes back into the app's composer after `tree_go` to a user
 * message — its text (pi's own `editorText` when the runtime passes it on,
 * else read off the entry, joined the same way pi does) and its images as
 * the usual phone-safe refs (inline thumbnail or a `mediaRef`). */
export type TreeGoRestore = { restore: { text: string; images?: Array<{ mime: string; data?: string; mediaRef?: string; bytes?: number }> } };

/** The ack extras for a `tree_go` that landed: only when `target` is a user
 * message and pi really moved the leaf off it (to its parent) — a no-op
 * navigation (already there) restores nothing. */
export function treeGoRestore(target: unknown, editorText: unknown, leafAfter: string | null): TreeGoRestore | undefined {
  const e = target as { id?: string; type?: string; message?: { role?: string; content?: unknown } } | null | undefined;
  if (!e || e.type !== "message" || e.message?.role !== "user") return undefined;
  if (leafAfter !== null && leafAfter === e.id) return undefined;
  const content = e.message.content;
  const parts = Array.isArray(content) ? (content as Array<{ type?: string; text?: unknown }>) : [];
  const fromEntry = typeof content === "string" ? content : parts.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text as string).join("");
  const text = typeof editorText === "string" ? editorText : fromEntry;
  const images = parts
    .filter((p) => p?.type === "image")
    .map((p) => phoneSafe(p) as { mime?: string; data?: string; mediaRef?: string; bytes?: number } | null)
    .filter((p): p is { mime?: string; data?: string; mediaRef?: string; bytes?: number } => !!p && (typeof p.data === "string" || typeof p.mediaRef === "string"))
    .map((p) => ({ mime: p.mime ?? "image/*", ...(p.data ? { data: p.data } : {}), ...(p.mediaRef ? { mediaRef: p.mediaRef } : {}), ...(typeof p.bytes === "number" ? { bytes: p.bytes } : {}) }));
  if (!text && !images.length) return undefined;
  return { restore: { text: clipText(text, TEXT_CLIP), ...(images.length ? { images } : {}) } };
}
