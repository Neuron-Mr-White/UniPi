/**
 * Phone-safe copies of session entries: images replaced by a marker, long
 * text clipped, the hello snapshot capped so its line fits one relay frame.
 */

/** One relay frame is 1 MiB; keep every line well under it (UTF-8 bytes). */
export const LINE_BUDGET = 900 * 1024;
/** The entries of a hello snapshot get this much; the rest of the hello
 * (commands, models, state) fits in what is left of LINE_BUDGET. */
export const ENTRIES_BUDGET = 600 * 1024;
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
