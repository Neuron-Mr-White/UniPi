/**
 * Phone-safe copies of session entries: images replaced by a marker, long
 * text clipped, the hello snapshot capped so its line fits one relay frame.
 */

/** One relay frame is 1 MiB; keep every line well under it. */
export const LINE_BUDGET = 900 * 1024;
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
      return { type: "image", mime: typeof o.mimeType === "string" ? o.mimeType : "image/*", omitted: true, bytes: Math.round((o.data.length * 3) / 4) };
    }
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "function" || v === undefined) continue;
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

export function wantedEntry(entry: unknown): boolean {
  const e = entry as { type?: string; customType?: string } | null;
  if (!e || typeof e.type !== "string") return false;
  if (e.type === "label" || e.type === "session_info") return false;
  if (e.type === "custom" && e.customType && STATE_ONLY_CUSTOM.has(e.customType)) return false;
  return true;
}

/**
 * The active branch from its latest compaction on (that compaction entry
 * included), phone-safe, trimmed from the oldest end until the serialized
 * size fits `budget`.
 */
export function snapshotEntries(branch: readonly unknown[], budget = LINE_BUDGET): { entries: Json[]; truncated: boolean } {
  let start = 0;
  for (let i = branch.length - 1; i >= 0; i--) {
    if ((branch[i] as { type?: string })?.type === "compaction") {
      start = i;
      break;
    }
  }
  const picked = branch.slice(start).filter(wantedEntry).map((e) => phoneSafe(e));
  let truncated = start > 0;
  const sizes = picked.map((e) => JSON.stringify(e).length + 1);
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
  if (line.length <= LINE_BUDGET) return line;
  line = JSON.stringify(phoneSafe(msg, 8 * 1024));
  if (line.length <= LINE_BUDGET) return line;
  const t = (msg as { t?: string }).t ?? "unknown";
  return JSON.stringify({ t: "error", message: `A ${t} message was too large to send to the phone.` });
}
