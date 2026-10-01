/**
 * Lossless (zero-LLM) summary — state first, hard-budgeted, rebuilt from the
 * full session history every time.
 *
 * Section order is what a model resuming the work needs first:
 *   Active Work → Your Requests → Latest State → Decisions & Constraints →
 *   Files → Commits → Open Errors → Recent Transcript
 * Every section has its own share of the budget and every item is clipped, so
 * no single message (a pasted log, an injected snapshot) can blow the summary up.
 */

import { relative, isAbsolute } from "node:path";
import type { FileOps, NormalizedBlock, SummarySections } from "../types.js";
import type { SummarySource } from "./source.js";
import { extractPath } from "./extract/files.js";
import { selectRankedBriefBlocks } from "./rank.js";
import { compileBrief } from "./brief.js";

export const RECALL_NOTE =
  "Everything above is condensed from the full session history, which is kept. " +
  "Use `session_recall` to search it (refs like #123 are entry indices; pass them in `expand` for full content). " +
  "Do not redo work that is already done.";

export const DEFAULT_SECTIONS: SummarySections = {
  activeWork: true,
  requests: true,
  state: true,
  decisions: true,
  files: true,
  commits: true,
  errors: true,
  lessons: true,
  transcript: true,
};

export interface LosslessSummaryInput {
  source: SummarySource;
  /** Authoritative active-work blocks from modules (goal, ralph, kanboard…). */
  activeWork?: ReadonlyArray<{ id: string; text: string }>;
  /** Target size in characters (tokens × chars/token). */
  budgetChars: number;
  cwd?: string;
  fileOps?: FileOps;
  sections?: SummarySections;
}

export interface LosslessSummary {
  text: string;
  sections: string[];
}

/** Auto budget in tokens: scales with the amount of history, 1.5k–4k. */
export function autoBudgetTokens(blockCount: number): number {
  return Math.round(Math.min(4000, Math.max(1500, 1500 + blockCount * 8)));
}

// ── text helpers ─────────────────────────────────────────

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Stable identity of a summary item (survives clipping to ≥80 chars). */
export const itemKey = (text: string): string => oneLine(text).slice(0, 80).toLowerCase();


export function clip(text: string, max: number): string {
  if (max <= 1) return "";
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Add items while they fit in maxChars (each counted with its "- " line). */
function fitItems(items: string[], maxChars: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const item of items) {
    const cost = item.length + 3;
    if (used + cost > maxChars) break;
    out.push(item);
    used += cost;
  }
  return out;
}

function section(title: string, lines: string[]): string {
  return lines.length === 0 ? "" : `[${title}]\n${lines.map((l) => `- ${l}`).join("\n")}`;
}

// ── Your Requests ────────────────────────────────────────

const TRIVIAL_REQUEST_RE =
  /^(?:continue|go on|go ahead|carry on|keep going|proceed|next|go|ok(?:ay)?|yes|yep|y|sure|thanks?|thank you|ty|k|done|resume|restarted[^.]*)[\s.!~]*$/i;

export interface RequestSelection {
  lines: string[];
  /** Indices (into the input) of requests shown verbatim. */
  shown: Set<number>;
}

export function selectRequestLines(requests: string[], maxChars: number): RequestSelection {
  const all = requests
    .map((r, i) => ({ text: oneLine(r), i }))
    .filter((r) => r.text.length > 0 && !TRIVIAL_REQUEST_RE.test(r.text));
  // The opening request and the latest one always stay.
  const meaningful = all;
  const shown = new Set<number>();
  if (meaningful.length === 0) return { lines: [], shown };
  const [first, ...rest] = meaningful;
  const perItem = Math.max(160, Math.floor(maxChars / Math.min(6, meaningful.length)) - 4);
  // The session's opening request: the purpose, kept short.
  const lines = [clip(first.text, 240)];
  shown.add(first.i);
  let budget = maxChars - lines[0].length - 3;
  // Newest first until the budget runs out, then restore chronological order.
  const recent: string[] = [];
  for (let k = rest.length - 1; k >= 0 && recent.length < 5; k--) {
    const item = clip(rest[k].text, perItem);
    if (item.length + 3 > budget) break;
    recent.unshift(item);
    shown.add(rest[k].i);
    budget -= item.length + 3;
  }
  const omitted = rest.length - recent.length;
  if (omitted > 0) lines.push(`(${omitted} more request${omitted === 1 ? "" : "s"} in between — session_recall has them)`);
  return { lines: [...lines, ...recent], shown };
}

export const selectRequests = (requests: string[], maxChars: number): string[] => selectRequestLines(requests, maxChars).lines;

// ── Decisions & Constraints ──────────────────────────────

/** An instruction opens with an imperative or carries a modal; "X don't work" is a bug report. */
const IMPERATIVE_START_RE =
  /^(?:(?:please|also|and|then|but|so)[, ]+)?(?:don'?t|do not|never|always|keep|avoid|make sure|ensure|use|prefer|remember|only use|stop|no need|restore|revert|undo|preserve|stick to|stay with|go back to)\b/i;
const MODAL_RE = /\b(?:should(?:n'?t)?|must|prefer|instead of|instead|rather than|required|important|no need)\b/i;
/** The user rejecting something the agent did: a correction that must stick. */
const CORRECTION_RE = /\bI (?:did not|didn't|never) (?:ask|request|want|say)\b|\bnot what I (?:asked|wanted|meant)\b|\bwhy (?:did|do) you (?:change|remove|delete)\b/i;
const DECISION_RE = { test: (piece: string) => IMPERATIVE_START_RE.test(piece) || MODAL_RE.test(piece) || CORRECTION_RE.test(piece) };

const PASTED_AI_RE = /\bI(?:'m| am) an AI\b|\bas an AI\b|\bI can help (?:with|you)\b|\bif you'd like, I\b|\bI can'?t do that\b|\*\*[^*\n]+\*\*/i;

/** Text the user quoted or pasted (code fences, > quotes) is material, not instructions. */
const stripQuoted = (text: string): string =>
  text.replace(/```[\s\S]*?(?:```|$)/g, "\n").replace(/^\s*>.*$/gm, "");

export function selectDecisions(
  requests: string[],
  maxChars: number,
  skip: ReadonlySet<number> = new Set(),
): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const [idx, request] of requests.entries()) {
    if (skip.has(idx) || TRIVIAL_REQUEST_RE.test(oneLine(request))) continue;
    // An answer to an agent question is one explicit decision: keep it whole.
    if (request.includes(" → ")) {
      const key = request.toLowerCase().slice(0, 60);
      if (!seen.has(key)) {
        seen.add(key);
        found.push(clip(oneLine(request), 260));
      }
      continue;
    }
    const pieces = stripQuoted(request)
      .split(/\n+/)
      .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z0-9"'`])/))
      .map((p) => p.replace(/^\s*(?:[-*+>]|\d+[.)])\s+/, "").trim())
      .filter((p) => p.length >= 24 && p.length <= 400);
    let pushedFromThis = -1;
    for (const piece of pieces) {
      if (!DECISION_RE.test(piece)) continue;
      // "I did not request this" belongs to the instruction right before it.
      if (pushedFromThis >= 0 && CORRECTION_RE.test(piece) && !IMPERATIVE_START_RE.test(piece) && !MODAL_RE.test(piece)) {
        found[pushedFromThis] = clip(`${found[pushedFromThis]} ${oneLine(piece)}`, 260);
        continue;
      }
      if (/\?["')\]]*$/.test(piece)) continue; // a question, not a decision
      if (PASTED_AI_RE.test(piece)) continue; // pasted assistant output
      if (/^(?:it|this|that|these|those)\b/i.test(piece) && piece.length < 60) continue; // needs context it lacks
      if (/^[`$]|[{};]\s*$/.test(piece)) continue; // code, not a decision
      const key = piece.toLowerCase().slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(clip(oneLine(piece), 220));
      pushedFromThis = found.length - 1;
    }
  }
  return pickDecisions(found, maxChars);
}

/** A rule for the whole session, not one task: these outlive recency. */
const STANDING_RE =
  /\b(?:always|never|every|all (?:the )?\w+|by default|default|from now on|going forward|in general|globally|whenever|each time|unless|any time)\b/i;

/**
 * Half the budget goes to the most recent decisions (the current work); the
 * rest to standing rules from anywhere in the session, oldest first, so an
 * early "never do X" is not pushed out by a flurry of recent task details.
 * Output stays chronological.
 */
function pickDecisions(found: string[], maxChars: number): string[] {
  const chosen = new Set<number>();
  let used = 0;
  const take = (i: number) => {
    const cost = found[i].length + 3;
    if (chosen.has(i) || used + cost > maxChars) return false;
    chosen.add(i);
    used += cost;
    return true;
  };
  for (let i = found.length - 1; i >= 0 && used < maxChars / 2; i--) take(i);
  for (let i = 0; i < found.length; i++) {
    if (STANDING_RE.test(found[i]) || CORRECTION_RE.test(found[i])) take(i);
  }
  for (let i = found.length - 1; i >= 0; i--) take(i);
  return [...chosen].sort((a, b) => a - b).map((i) => found[i]);
}

// ── Latest State ─────────────────────────────────────────

/** A progress report to the user is long; step narration ("Next I'll…") is short. */
const REPORT_MIN_CHARS = 400;

export function selectState(reports: string[], maxChars: number): string[] {
  const flat = reports.map((r) => oneLine(r.replace(/!\[[^\]]*\]\([^)]*\)/g, ""))).filter(Boolean);
  if (flat.length === 0) return [];
  let reportIdx = -1;
  for (let i = flat.length - 1; i >= 0; i--) {
    if (flat[i].length >= REPORT_MIN_CHARS) {
      reportIdx = i;
      break;
    }
  }
  const latestIdx = flat.length - 1;
  if (reportIdx === latestIdx) return [`Last report: ${clip(flat[reportIdx], maxChars - 20)}`];
  if (reportIdx < 0) return [`Latest step: ${clip(flat[latestIdx], Math.floor(maxChars * 0.3))}`];
  const step = `Latest step: ${clip(flat[latestIdx], Math.floor(maxChars * 0.3))}`;
  const age = latestIdx - reportIdx;
  const label = `Last full report (${age} message${age === 1 ? "" : "s"} earlier — may be outdated)`;
  return [step, `${label}: ${clip(flat[reportIdx], maxChars - step.length - label.length - 10)}`];
}

// ── Files ────────────────────────────────────────────────

const EDIT_TOOLS = /^(?:edit|multiedit|apply_patch|quick_edit|target_edit)$/i;
const WRITE_TOOLS = /^(?:write|create)$/i;
const READ_TOOLS = /^(?:read)$/i;
/** Screenshots and scratch files: looked at, not worked on. */
const NOISE_READ_RE = /(?:^\/tmp\/|\.(?:png|jpe?g|gif|webp|bmp|svg|ico)$)/i;

export function selectFiles(blocks: NormalizedBlock[], cwd: string | undefined, maxChars: number): string[] {
  const modified = new Map<string, number>();
  const created = new Set<string>();
  const read = new Set<string>();
  const rel = (p: string) => {
    if (!cwd || !isAbsolute(p)) return p;
    const r = relative(cwd, p);
    return r && !r.startsWith("..") ? r : p;
  };
  for (const b of blocks) {
    if (b.kind !== "tool_call") continue;
    const raw = extractPath(b.args);
    if (!raw) continue;
    const path = rel(raw);
    if (EDIT_TOOLS.test(b.name)) modified.set(path, (modified.get(path) ?? 0) + 1);
    else if (WRITE_TOOLS.test(b.name)) created.add(path);
    else if (READ_TOOLS.test(b.name) && !NOISE_READ_RE.test(path)) read.add(path);
  }
  for (const p of created) if (modified.has(p)) created.delete(p);
  for (const p of [...read]) if (modified.has(p) || created.has(p)) read.delete(p);

  const list = (label: string, items: string[], share: number) => {
    if (items.length === 0) return "";
    const fitted = fitItems(items, Math.floor(maxChars * share));
    const more = items.length - fitted.length;
    return `${label}: ${fitted.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`;
  };
  const byCount = [...modified.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => (n > 1 ? `${p} ×${n}` : p));
  return [
    list("Modified", byCount, 0.45),
    list("Created", [...created], 0.3),
    list("Read", [...read].reverse(), 0.2),
  ].filter(Boolean);
}

// ── Lessons ─────────────────────────────────────────────
// Failures turn into knowledge only if someone writes the lesson down. The
// agent usually does, in its own words: memory_store notes, "# Confirmed: …"
// comments in the commands it runs, and diagnosis sentences ("root cause…",
// "…silently ignores…"). Keep those verbatim instead of generating anything.

const MEMORY_TOOL_RE = /^(?:memory_store|memory_save|memory_add|save_memory|remember)$/i;
/** Marks a learned fact, not a status update. */
const LESSON_MARK_RE =
  /\b(?:root cause|turns out|found it|confirmed|gotcha|caveat|silently|no-?ops?|doesn'?t (?:support|work|accept)|not supported|only works|rejects?|ignores?|the fix (?:is|was)|workaround|breaks? (?:when|if)|must (?:use|be|run)|requires?|instead of|never|always)\b/i;
/** Diagnosis sentences need a stronger mark than comments (prose is chattier). */
const DIAGNOSIS_RE =
  /\b(?:root cause|turns out|gotcha|caveat|silently|no-?ops?|doesn'?t (?:support|accept)|not supported|only works|rejects?|ignores?|the (?:real )?(?:issue|problem|bug|cause) (?:is|was)|the fix (?:is|was)|workaround)\b/i;

/** Debug narration ("my DBG print never fired") is the hunt, not the finding. */
const DEBUG_RE = /\b(?:DBG|debug(?:ging)? (?:print|log|output)|print(?:ed)? (?:never|didn'?t)|never (?:fired|printed)|let me|I'?ll (?:check|look|try))\b/i;

export interface LessonCandidate {
  text: string;
  source: "memory" | "comment" | "diagnosis";
  /** Block index (session order). */
  at: number;
}

/** Agent-written lessons in session order (later duplicates win). */
export function lessonCandidates(blocks: NormalizedBlock[]): LessonCandidate[] {
  const out = new Map<string, LessonCandidate>();
  let at = 0;
  const add = (text: string, source: LessonCandidate["source"]) => {
    const t = oneLine(text);
    if (t.length < 30) return;
    const key = itemKey(t);
    out.delete(key);
    out.set(key, { text: clip(t, 320), source, at });
  };
  for (const [i, b] of blocks.entries()) {
    at = i;
    if (b.kind === "tool_call" && MEMORY_TOOL_RE.test(b.name)) {
      const raw = [b.args.content, b.args.text, b.args.memory, b.args.note].find((v) => typeof v === "string") as string | undefined;
      // Past a bare header ("ROOT CAUSES CONFIRMED:"): lines until there is substance.
      if (raw) {
        const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
        let text = "";
        for (const l of lines) {
          text = text ? `${text} ${l}` : l;
          if (text.length >= 160) break;
        }
        add(text, "memory");
      }
    } else if (b.kind === "tool_call" && typeof b.args.command === "string") {
      for (const line of b.args.command.split("\n")) {
        const m = line.match(/^\s*#+\s*(.+)$/);
        // A comment ending in ":" introduces the next command; it is not a finding.
        if (m && m[1].length <= 300 && !/:\s*$/.test(m[1]) && !DEBUG_RE.test(m[1]) && (DIAGNOSIS_RE.test(m[1]) || /\b(?:confirmed|found it)\b/i.test(m[1])) && LESSON_MARK_RE.test(m[1])) add(m[1], "comment");
      }
    } else if (b.kind === "assistant") {
      for (const sentence of b.text.replace(/```[\s\S]*?```/g, " ").split(/(?<=[.!?])\s+|\n+/)) {
        const t = sentence.trim();
        if (t.length >= 50 && t.length <= 320 && !t.endsWith("?") && !DEBUG_RE.test(t) && DIAGNOSIS_RE.test(t)) add(t, "diagnosis");
      }
    }
  }
  return [...out.values()];
}

const LESSON_PRIORITY: Record<LessonCandidate["source"], number> = { memory: 0, comment: 1, diagnosis: 2 };

/** Memory notes first, then comments, then diagnoses; newest first within each; chronological output. */
export function selectLessons(blocks: NormalizedBlock[], maxChars: number): string[] {
  const all = lessonCandidates(blocks).map((c, i) => ({ ...c, i }));
  const ranked = [...all].sort((a, b) => LESSON_PRIORITY[a.source] - LESSON_PRIORITY[b.source] || b.i - a.i);
  const chosen: typeof all = [];
  let used = 0;
  for (const c of ranked) {
    if (used + c.text.length + 3 > maxChars) continue;
    chosen.push(c);
    used += c.text.length + 3;
  }
  return chosen.sort((a, b) => a.i - b.i).map((c) => c.text);
}

// ── Project Knowledge ───────────────────────────────────
// What the agent learned about the project that no user message states:
// the notes it wrote (where deploy steps and conventions live), the commands
// it ran repeatedly, and the hosts it worked against.

const NOTE_RE = /(?:^|\/)(?:AGENTS?|CLAUDE|DESIGN|README|SKILL|CONTRIBUTING|RUNBOOK|NOTES)\.md$|(?:^|\/)docs\/.+\.md$|\.agents\/skills\/.+\.md$/i;
const TOOLING_RE = /^(?:npm|npx|pnpm|yarn|bun|bunx|cargo|mise|make|just|go|pytest|uv|python3? -m|docker|docker-compose|kubectl|helm|rsync|scp|ssh|git push|gh|tea|systemctl|terraform|deno|flutter|xcodebuild)\b/;

/** The first meaningful command of a shell line: no `cd x &&`, pipes, redirects or env prefixes. */
function commandCore(command: string): string {
  const first = command.split("\n").find((l) => l.trim() && !l.trim().startsWith("#")) ?? "";
  const segments = first.split(/\s*(?:&&|;)\s*/).map((x) => x.trim()).filter(Boolean);
  const main = segments.find((x) => !/^(?:cd|export|source|set|echo)\b/.test(x)) ?? "";
  return main
    .replace(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/, "")
    .replace(/\s*(?:\||2>&1|>\s*\S+|>>\s*\S+).*$/, "")
    .trim();
}

export function selectKnowledge(blocks: NormalizedBlock[], cwd: string | undefined, maxChars: number): string[] {
  const rel = (p: string) => {
    if (!cwd || !isAbsolute(p)) return p;
    const r = relative(cwd, p);
    return r && !r.startsWith("..") ? r : p;
  };
  const edited = new Set<string>();
  const read = new Set<string>();
  const commands = new Map<string, { text: string; n: number }>();
  const hosts = new Map<string, number>();
  const addHost = (h: string) => hosts.set(h, (hosts.get(h) ?? 0) + 1);
  for (const b of blocks) {
    if (b.kind !== "tool_call") continue;
    const path = extractPath(b.args);
    if (path && NOTE_RE.test(path)) (EDIT_TOOLS.test(b.name) || WRITE_TOOLS.test(b.name) ? edited : read).add(rel(path));
    const command = typeof b.args.command === "string" ? b.args.command : "";
    if (!command) continue;
    let core = commandCore(command);
    // ssh: the connection is the reusable part, not the remote script.
    if (/^ssh\b/.test(core)) core = core.split(/\s['"]/)[0].trim();
    if (TOOLING_RE.test(core) && core.length <= 160 && !/<<|\\$/.test(core) && (core.match(/['"]/g)?.length ?? 0) % 2 === 0) {
      const key = core.split(/\s+/).slice(0, 3).join(" ");
      const prev = commands.get(key);
      commands.set(key, { text: core, n: (prev?.n ?? 0) + 1 });
    }
    for (const m of command.matchAll(/https?:\/\/([\w.-]+(?::\d+)?)/g)) addHost(m[1]);
    for (const m of command.matchAll(/\b(?:ssh|scp|rsync)\b[^\n]*?\b([\w.-]+@[\w.-]+)/g)) addHost(m[1]);
  }
  for (const p of edited) read.delete(p);
  const lines: string[] = [];
  const cap = (label: string, items: string[], share: number) => {
    if (items.length === 0) return;
    const fitted = fitItems(items, Math.floor(maxChars * share));
    const more = items.length - fitted.length;
    if (fitted.length) lines.push(`${label}: ${fitted.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`);
  };
  cap("Notes written", [...edited], 0.2);
  cap("Notes read", [...read].slice(-8), 0.15);
  const repeated = [...commands.values()].filter((c) => c.n >= 2).sort((a, b) => b.n - a.n).map((c) => `\`${c.text}\` ×${c.n}`);
  cap("Repeated commands", repeated.slice(0, 8), 0.45);
  const topHosts = [...hosts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([h]) => h);
  cap("Hosts", topHosts.slice(0, 6), 0.2);
  return lines;
}

// ── Commits ──────────────────────────────────────────────

const COMMIT_LINE_RE = /\[([\w./@-]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+?)(?= \d+ files? changed|$)/g;
/** `git commit -m "msg"` / `-qm 'msg'` — for quiet commits that print no summary line. */
const COMMIT_CMD_RE = /\bgit\s+commit\b[^"'\n]*?\s-[a-zA-Z]*m\s*(["'])((?:(?!\1).){3,}?)\1/;

export function selectCommits(blocks: NormalizedBlock[], maxChars: number): string[] {
  const commits = new Map<string, string>();
  let pendingSubject: string | null = null;
  for (const b of blocks) {
    if (b.kind === "tool_call") {
      const command = typeof b.args.command === "string" ? b.args.command : "";
      pendingSubject = COMMIT_CMD_RE.exec(command)?.[2] ?? null;
      continue;
    }
    if (b.kind !== "tool_result") continue;
    let found = false;
    if (!b.isError) {
      for (const m of b.text.matchAll(COMMIT_LINE_RE)) {
        commits.set(m[2].slice(0, 8), clip(m[3].replace(/\s+(?:Date|Author|Co-authored-by):.*$/i, "").trim(), 110));
        found = true;
      }
    }
    if (!found && pendingSubject && !b.isError) commits.set(`~${commits.size}`, clip(pendingSubject.trim(), 110));
    pendingSubject = null;
  }
  const lines = [...commits.entries()].map(([hash, subject]) => (hash.startsWith("~") ? subject : `${hash} ${subject}`));
  return fitItems(lines.slice(-10).reverse(), maxChars).reverse();
}

// ── Open Errors ──────────────────────────────────────────

const callTarget = (b: Extract<NormalizedBlock, { kind: "tool_call" }>): string => {
  const path = extractPath(b.args);
  if (path) return path;
  const command = typeof b.args.command === "string" ? b.args.command : "";
  return oneLine(command).slice(0, 60);
};

/** Later successes of the same tool after which an error counts as moved past. */
const RESOLVED_AFTER_SUCCESSES = 3;

export function selectOpenErrors(blocks: NormalizedBlock[], maxChars: number): string[] {
  const lastTarget = new Map<string, string>();
  const open = new Map<string, { tool: string; text: string; ref?: number; successesAfter: number }>();
  // Only recent errors can still be open; older ones are history (session_recall).
  for (const b of blocks.slice(-TRANSCRIPT_WINDOW_BLOCKS)) {
    if (b.kind === "tool_call") {
      lastTarget.set(b.name, callTarget(b));
      continue;
    }
    if (b.kind !== "tool_result") continue;
    const key = `${b.name}\u0000${lastTarget.get(b.name) ?? ""}`;
    open.delete(key);
    if (b.isError) {
      open.set(key, { tool: b.name, text: `[${b.name}] ${clip(oneLine(b.text), 200)}`, ref: b.sourceIndex, successesAfter: 0 });
      continue;
    }
    // A retry with the same target clears its error (above); other successes
    // of the same tool mean the work moved on.
    for (const [k, err] of open) {
      if (err.tool === b.name && ++err.successesAfter >= RESOLVED_AFTER_SUCCESSES) open.delete(k);
    }
  }
  const lines = [...open.values()].map((e) => (e.ref != null ? `${e.text} (#${e.ref})` : e.text));
  return fitItems(lines.slice(-5).reverse(), maxChars).reverse();
}

// ── Recent Transcript ────────────────────────────────────

/** The transcript covers recent work; older history lives in the sections above. */
export const TRANSCRIPT_WINDOW_BLOCKS = 160;

export function selectTranscript(blocks: NormalizedBlock[], maxChars: number, fileOps?: FileOps): string {
  if (maxChars < 200 || blocks.length === 0) return "";
  const recent = blocks.slice(-TRANSCRIPT_WINDOW_BLOCKS);
  const selected = selectRankedBriefBlocks(recent, { maxBriefChars: maxChars, fileOps });
  const lines = compileBrief(selected).split("\n").map((l) => clip(l, 300));
  // Hard cap: keep the newest lines that fit.
  const out: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (used + lines[i].length + 1 > maxChars) break;
    out.unshift(lines[i]);
    used += lines[i].length + 1;
  }
  while (out.length > 0 && !out[0].startsWith("[")) out.shift();
  return out.join("\n").trim();
}
// ── secrets ──────────────────────────────────────────────

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b(password|passwd|passphrase|pwd|token|secret|api[_ -]?key)(\s*(?:is|=|:)\s*)(['"`]?)([^\s'"`]{4,})\3/gi, "$1$2[redacted]"],
  // "use password 'x'", "token `x`": a quoted value right after the word.
  [/\b(password|passwd|passphrase|pwd|token|secret|api[_ -]?key)(\s+)(['"`])([^'"`\n]{4,}?)\3/gi, "$1$2[redacted]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted]"],
  [/\b(Bearer|X-API-KEY:?|Authorization:)\s+[A-Za-z0-9._~+\/=-]{12,}/gi, "$1 [redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted private key]"],
];

/** Summaries are re-sent every turn: keep credentials out (session_recall still has them). */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((t, [re, to]) => t.replace(re, to), text);
}

// ── assembly ─────────────────────────────────────────────

const SHARES = {
  activeWork: 0.16,
  requests: 0.14,
  state: 0.12,
  lessons: 0.1,
  decisions: 0.16,
  files: 0.07,
  knowledge: 0.07,
  commits: 0.05,
  errors: 0.06,
} as const;

export function buildLosslessSummary(input: LosslessSummaryInput): LosslessSummary {
  // Redact before any clipping can cut a secret's closing quote.
  const source: SummarySource = {
    ...input.source,
    requests: input.source.requests.map(redactSecrets),
    reports: input.source.reports.map(redactSecrets),
    blocks: input.source.blocks.map((b) => ("text" in b && typeof b.text === "string" ? { ...b, text: redactSecrets(b.text) } : b)),
  };
  const on = { ...DEFAULT_SECTIONS, ...input.sections };
  const budget = Math.max(2000, Math.round(input.budgetChars));
  const cap = (share: number) => Math.floor(budget * share);
  const parts: Array<[string, string]> = [];

  if (on.activeWork && input.activeWork?.length) {
    const per = Math.floor(cap(SHARES.activeWork) / input.activeWork.length);
    const lines = input.activeWork.map((b) => clip(b.text.trim(), Math.max(200, per)));
    parts.push(["Active Work", `[Active Work]\n${lines.join("\n\n")}`]);
  }
  const requestSel = on.requests ? selectRequestLines(source.requests, cap(SHARES.requests)) : { lines: [], shown: new Set<number>() };
  if (on.requests) parts.push(["Your Requests", section("Your Requests", requestSel.lines)]);
  if (on.state) parts.push(["Latest State", section("Latest State", selectState(source.reports, cap(SHARES.state)))]);
  if (on.decisions) parts.push(["Decisions & Constraints", section("Decisions & Constraints", selectDecisions(source.requests, cap(SHARES.decisions), requestSel.shown))]);
  if (on.files) parts.push(["Files", section("Files", selectFiles(source.blocks, input.cwd, cap(SHARES.files)))]);
  if (on.lessons) parts.push(["Lessons", section("Lessons", selectLessons(source.blocks, cap(SHARES.lessons)))]);
  if (on.files) parts.push(["Project Knowledge", section("Project Knowledge", selectKnowledge(source.blocks, input.cwd, cap(SHARES.knowledge)))]);
  if (on.commits) parts.push(["Commits", section("Commits", selectCommits(source.blocks, cap(SHARES.commits)))]);
  if (on.errors) parts.push(["Open Errors", section("Open Errors", selectOpenErrors(source.blocks, cap(SHARES.errors)))]);

  const head = parts.filter(([, text]) => text);
  const headText = head.map(([, text]) => text).join("\n\n");
  const sections = head.map(([name]) => name);

  let transcript = "";
  if (on.transcript) {
    const remaining = budget - headText.length - RECALL_NOTE.length - 40;
    transcript = selectTranscript(source.blocks, Math.max(Math.floor(budget * 0.18), remaining), input.fileOps);
    if (transcript) sections.push("Recent Transcript");
  }

  const body = [headText, transcript ? `[Recent Transcript]\n${transcript}` : ""].filter(Boolean).join("\n\n");
  if (!body) return { text: "", sections: [] };
  return { text: `${redactSecrets(body)}\n\n---\n\n${RECALL_NOTE}`, sections };
}
