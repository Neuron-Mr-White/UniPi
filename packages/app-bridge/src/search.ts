/**
 * UNI-275: search the session for text — similarity-ranked, not just an exact
 * substring. Pure: (branch entries, query) → hits.
 *
 * Score per entry = BM25 over word stems (exact words count most), plus
 * fuzzy credit for query words that only match a vocabulary word by a typo
 * (edit distance ≤ 1 for short words, ≤ 2 for long ones, or a shared
 * prefix), plus a bonus when the whole query appears as a phrase. Field
 * weights: what the user said counts most, then the model's words and
 * commands; tool calls and their output much less (long and noisy). One hit
 * per entry.
 */

export interface SearchHit {
  /** Session entry id (the app jumps to it). */
  id: string;
  /** user | assistant | tool (a call) | output (a tool's result) | command | note */
  role: string;
  /** ~160 chars around the best match. */
  snippet: string;
  /** [start, end) of matched words inside `snippet`, for highlighting. */
  marks: Array<[number, number]>;
  score: number;
  timestamp?: string;
}

interface Doc {
  id: string;
  role: string;
  timestamp?: string;
  /** Searchable text with its weight. */
  fields: Array<{ text: string; weight: number }>;
}

const MAX_FIELD = 8 * 1024;
const MAX_TOOL_OUTPUT = 4 * 1024;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      const part = p as { type?: string; text?: unknown };
      return part?.type === "text" && typeof part.text === "string" ? part.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function argsText(args: unknown): string {
  if (!args || typeof args !== "object") return typeof args === "string" ? args : "";
  const a = args as Record<string, unknown>;
  const picks = ["command", "path", "file_path", "pattern", "query", "url", "task", "title"];
  return picks.map((k) => (typeof a[k] === "string" ? (a[k] as string) : "")).filter(Boolean).join(" ");
}

/** The searchable documents of a branch (one per entry that says something). */
export function searchDocs(branch: readonly unknown[]): Doc[] {
  const docs: Doc[] = [];
  for (const raw of branch) {
    const e = raw as {
      id?: string;
      type?: string;
      timestamp?: string;
      customType?: string;
      data?: { text?: unknown; command?: unknown };
      content?: unknown;
      message?: { role?: string; content?: unknown; toolName?: string };
    };
    if (!e?.id) continue;
    const base = { id: e.id, ...(e.timestamp ? { timestamp: e.timestamp } : {}) };
    if (e.type === "message" && e.message) {
      const m = e.message;
      if (m.role === "user") docs.push({ ...base, role: "user", fields: [{ text: textOf(m.content).slice(0, MAX_FIELD), weight: 1 }] });
      else if (m.role === "assistant") {
        const parts = Array.isArray(m.content) ? (m.content as Array<{ type?: string; text?: string; name?: string; arguments?: unknown }>) : [];
        const said = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
        const calls = parts.filter((p) => p.type === "toolCall").map((p) => `${p.name ?? ""} ${argsText(p.arguments)}`).join("\n");
        // What the model said and what it ran are separate hits (same entry):
        // a command line must not surface as "the assistant said …".
        if (said.trim()) docs.push({ ...base, role: "assistant", fields: [{ text: said.slice(0, MAX_FIELD), weight: 1 }] });
        if (calls.trim()) docs.push({ ...base, role: "tool", fields: [{ text: calls.slice(0, MAX_FIELD), weight: 1 }] });
      } else if (m.role === "toolResult") {
        const out = textOf(m.content);
        if (out.trim()) docs.push({ ...base, role: "output", fields: [{ text: out.slice(0, MAX_TOOL_OUTPUT), weight: 1 }] });
      }
    } else if (e.type === "custom" && e.customType === "unipi-command-echo" && typeof e.data?.text === "string") {
      docs.push({ ...base, role: "command", fields: [{ text: e.data.text, weight: 1 }] });
    } else if (e.type === "custom_message") {
      const t = textOf(e.content);
      if (t.trim()) docs.push({ ...base, role: "note", fields: [{ text: t.slice(0, MAX_FIELD), weight: 1 }] });
    }
  }
  return docs;
}

// ── text ───────────────────────────────────────────────────────────────

const WORD = /[\p{L}\p{N}_]+/gu;

/** Light English stemmer: enough that "tests"/"testing"/"tested" meet "test". */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (w.length > suffix.length + 2 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  // "running" → "runn" → "run"
  if (w.length > 3 && w.at(-1) === w.at(-2) && !/[aeiou]/.test(w.at(-1)!)) w = w.slice(0, -1);
  return w;
}

function words(text: string): Array<{ word: string; stem: string; start: number; end: number }> {
  const out: Array<{ word: string; stem: string; start: number; end: number }> = [];
  for (const m of text.matchAll(WORD)) {
    const word = m[0].toLowerCase();
    out.push({ word, stem: stem(word), start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

/** Edit distance with adjacent swaps as one edit ("depoly" → "deploy" = 1); max+1 when farther than `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return Math.min(prev[b.length]!, max + 1);
}

/** How much a vocabulary stem stands in for a query stem (1 = same, 0 = not at all). */
function closeness(q: string, v: string): number {
  if (q === v) return 1;
  if (q.length >= 3 && v.startsWith(q)) return 0.7; // "auth" → "authentication"
  if (v.length >= 4 && q.startsWith(v)) return 0.5; // "authentication" → "auth"
  if (q.length < 4) return 0;
  const max = q.length >= 8 ? 2 : 1;
  const d = editDistance(q, v, max);
  // editDistance returns max+1 for "too far": only real distances count.
  if (d > max || v.length < 3) return 0;
  return d === 1 ? 0.6 : 0.4;
}

// ── search ─────────────────────────────────────────────────────────────

/** What people said counts most; what was run, and its output, less (long and noisy). */
const ROLE_WEIGHT: Record<string, number> = { user: 1.25, assistant: 1, command: 1, note: 0.7, tool: 0.45, output: 0.3 };

const K1 = 1.2;
const B = 0.75;

export function searchSession(branch: readonly unknown[], query: string, limit = 50): SearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const qWords = [...new Set(words(q).map((w) => w.stem))];
  if (!qWords.length) return [];
  const docs = searchDocs(branch);
  if (!docs.length) return [];

  // Per doc: weighted term frequencies by stem, and its length.
  const indexed = docs.map((d) => {
    const tf = new Map<string, number>();
    let len = 0;
    for (const f of d.fields) {
      for (const w of words(f.text)) {
        tf.set(w.stem, (tf.get(w.stem) ?? 0) + f.weight);
        len += f.weight;
      }
    }
    return { d, tf, len: Math.max(1, len) };
  });
  const avgLen = indexed.reduce((n, x) => n + x.len, 0) / indexed.length;
  const df = new Map<string, number>();
  for (const x of indexed) for (const s of x.tf.keys()) df.set(s, (df.get(s) ?? 0) + 1);
  const vocab = [...df.keys()];
  // Each query stem → the vocabulary stems that count for it, with closeness.
  const expansions = new Map<string, Array<{ stem: string; c: number }>>();
  for (const qs of qWords) {
    const list: Array<{ stem: string; c: number }> = [];
    for (const v of vocab) {
      const c = closeness(qs, v);
      if (c > 0) list.push({ stem: v, c });
    }
    list.sort((a, b) => b.c - a.c);
    expansions.set(qs, list.slice(0, 12));
  }
  const n = indexed.length;
  const idf = (s: string) => Math.log(1 + (n - (df.get(s) ?? 0) + 0.5) / ((df.get(s) ?? 0) + 0.5));
  const phrase = q.toLowerCase().replace(/\s+/g, " ");

  const scored: Array<{ x: (typeof indexed)[number]; score: number; matched: Set<string> }> = [];
  for (const x of indexed) {
    let score = 0;
    let covered = 0;
    const matched = new Set<string>();
    for (const qs of qWords) {
      let best = 0;
      for (const { stem: s, c } of expansions.get(qs) ?? []) {
        const f = x.tf.get(s);
        if (!f) continue;
        const part = c * idf(s) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * x.len) / avgLen)));
        if (part > best) best = part;
        matched.add(s);
      }
      if (best > 0) covered += 1;
      score += best;
    }
    if (score <= 0) continue;
    // Every query word present beats a few repeated ones (a hit on one word of three is weak).
    const coverage = covered / qWords.length;
    score *= coverage * coverage;
    if (qWords.length > 1 && x.d.fields.some((f) => f.text.toLowerCase().replace(/\s+/g, " ").includes(phrase))) score *= 1.6;
    score *= ROLE_WEIGHT[x.d.role] ?? 1;
    scored.push({ x, score, matched });
  }
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const unique = scored.filter(({ x }) => (seen.has(x.d.id) ? false : (seen.add(x.d.id), true)));
  return unique.slice(0, limit).map(({ x, score, matched }) => ({
    id: x.d.id,
    role: x.d.role,
    ...snippet(x.d, matched, phrase),
    score: Math.round(score * 1000) / 1000,
    ...(x.d.timestamp ? { timestamp: x.d.timestamp } : {}),
  }));
}

const SNIPPET = 160;

function snippet(d: Doc, matched: Set<string>, phrase: string): { snippet: string; marks: Array<[number, number]> } {
  // The best field: the first one with a match, by weight.
  const fields = [...d.fields].sort((a, b) => b.weight - a.weight);
  for (const f of fields) {
    const flat = f.text.replace(/\s+/g, " ").trim();
    const ws = words(flat).filter((w) => matched.has(w.stem));
    if (!ws.length) continue;
    const at = flat.toLowerCase().indexOf(phrase);
    const anchor = at >= 0 ? at : ws[0]!.start;
    let start = Math.max(0, anchor - 50);
    if (start > 0) {
      const space = flat.indexOf(" ", start);
      if (space >= 0 && space < anchor) start = space + 1;
    }
    const end = Math.min(flat.length, start + SNIPPET);
    const pre = start > 0 ? "…" : "";
    const text = pre + flat.slice(start, end) + (end < flat.length ? "…" : "");
    const marks: Array<[number, number]> = ws
      .filter((w) => w.start >= start && w.end <= end)
      .map((w) => [w.start - start + pre.length, w.end - start + pre.length]);
    return { snippet: text, marks };
  }
  const flat = (fields[0]?.text ?? "").replace(/\s+/g, " ").trim();
  return { snippet: flat.slice(0, SNIPPET) + (flat.length > SNIPPET ? "…" : ""), marks: [] };
}
