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
  /** Item keys to leave out (jev pruning; see itemKey). */
  drop?: ReadonlySet<string>;
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

const NO_DROP: ReadonlySet<string> = new Set();

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

export function selectRequestLines(requests: string[], maxChars: number, drop: ReadonlySet<string> = NO_DROP): RequestSelection {
  const all = requests
    .map((r, i) => ({ text: oneLine(r), i }))
    .filter((r) => r.text.length > 0 && !TRIVIAL_REQUEST_RE.test(r.text));
  // The opening request and the latest one always stay; the rest can be pruned.
  const meaningful = all.filter((r, k) => k === 0 || k === all.length - 1 || !drop.has(itemKey(r.text)));
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
  drop: ReadonlySet<string> = NO_DROP,
): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const [idx, request] of requests.entries()) {
    if (skip.has(idx) || TRIVIAL_REQUEST_RE.test(oneLine(request))) continue;
    // An answer to an agent question is one explicit decision: keep it whole.
    if (request.includes(" → ")) {
      const key = request.toLowerCase().slice(0, 60);
      if (!seen.has(key) && !drop.has(itemKey(request))) {
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
      if (seen.has(key) || drop.has(itemKey(piece))) continue;
      seen.add(key);
      found.push(clip(oneLine(piece), 220));
      pushedFromThis = found.length - 1;
    }
  }
  // Most recent decisions win when the budget is tight; keep chronological order.
  const kept: string[] = [];
  let used = 0;
  for (let i = found.length - 1; i >= 0 && kept.length < 10; i--) {
    if (used + found[i].length + 3 > maxChars) break;
    kept.unshift(found[i]);
    used += found[i].length + 3;
  }
  return kept;
}

// ── Latest State ─────────────────────────────────────────

/** A progress report to the user is long; step narration ("Next I'll…") is short. */
const REPORT_MIN_CHARS = 400;

export function selectState(reports: string[], maxChars: number, dropReport = false): string[] {
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
  if (reportIdx < 0 || dropReport) return [`Latest step: ${clip(flat[latestIdx], reportIdx < 0 ? Math.floor(maxChars * 0.3) : maxChars - 20)}`];
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

export function selectOpenErrors(blocks: NormalizedBlock[], maxChars: number, drop: ReadonlySet<string> = NO_DROP): string[] {
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
  const lines = [...open.values()]
    .filter((e) => !drop.has(itemKey(e.text)))
    .map((e) => (e.ref != null ? `${e.text} (#${e.ref})` : e.text));
  return fitItems(lines.slice(-5).reverse(), maxChars).reverse();
}

// ── Recent Transcript ────────────────────────────────────

/** The transcript covers recent work; older history lives in the sections above. */
export const TRANSCRIPT_WINDOW_BLOCKS = 160;

export function selectTranscript(blocks: NormalizedBlock[], maxChars: number, fileOps?: FileOps, drop: ReadonlySet<string> = NO_DROP): string {
  if (maxChars < 200 || blocks.length === 0) return "";
  const recent = blocks.slice(-TRANSCRIPT_WINDOW_BLOCKS).filter((b) => b.kind !== "user" || !drop.has(itemKey(b.text)));
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

// ── jev pruning inputs ───────────────────────────────────

export const REPORT_KEY = "__last_full_report__";

export interface SummaryCandidate {
  key: string;
  kind: "request" | "decision" | "error" | "report";
  text: string;
}

/** Items jev may prune: earlier requests, decisions, open errors, an older report. */
export function summaryCandidates(input: LosslessSummaryInput): SummaryCandidate[] {
  const { source } = input;
  const budget = Math.max(2000, Math.round(input.budgetChars));
  const out: SummaryCandidate[] = [];
  const requests = source.requests.map(oneLine).filter((r) => r && !TRIVIAL_REQUEST_RE.test(r));
  // Middle requests (first and latest always stay), newest first, bounded.
  // An answered question is a decision (higher bar to drop), not a one-off request.
  for (const r of requests.slice(1, -1).reverse().slice(0, 12)) out.push({ key: itemKey(r), kind: r.includes(" → ") ? "decision" : "request", text: clip(r, 400) });
  for (const d of selectDecisions(source.requests, budget * 0.35)) out.push({ key: itemKey(d), kind: "decision", text: d });
  for (const e of selectOpenErrors(source.blocks, budget * 0.2)) out.push({ key: itemKey(e.replace(/ \(#\d+\)$/, "")), kind: "error", text: e });
  const state = selectState(source.reports, budget);
  const report = state.find((l) => l.startsWith("Last full report"));
  if (report) out.push({ key: REPORT_KEY, kind: "report", text: clip(report, 700) });
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.key) ? false : (seen.add(c.key), true)));
}

/** What jev judges against: active work, the latest requests and steps, recent commits and transcript. */
export function pruneState(input: LosslessSummaryInput): string {
  const { source } = input;
  const requests = source.requests.map(oneLine).filter((r) => r && !TRIVIAL_REQUEST_RE.test(r));
  const parts = [
    input.activeWork?.length ? `Active work:\n${input.activeWork.map((b) => b.text).join("\n")}` : "",
    requests.length ? `Latest user requests:\n${requests.slice(-2).map((r) => `- ${clip(r, 500)}`).join("\n")}` : "",
    `Latest agent messages:\n${source.reports.slice(-3).map((r) => `- ${clip(oneLine(r), 700)}`).join("\n")}`,
    `Recent commits:\n${selectCommits(source.blocks, 800).join("\n")}`,
    `Recent activity:\n${selectTranscript(source.blocks, 2500)}`,
  ];
  return redactSecrets(parts.filter(Boolean).join("\n\n"));
}

// ── secrets ──────────────────────────────────────────────

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b(password|passwd|passphrase|pwd|token|secret|api[_ -]?key)(\s*(?:is|=|:)\s*)(['"`]?)([^\s'"`]{4,})\3/gi, "$1$2[redacted]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted]"],
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
  requests: 0.16,
  state: 0.14,
  decisions: 0.1,
  files: 0.1,
  commits: 0.05,
  errors: 0.06,
} as const;

export function buildLosslessSummary(input: LosslessSummaryInput): LosslessSummary {
  const { source } = input;
  const on = { ...DEFAULT_SECTIONS, ...input.sections };
  const budget = Math.max(2000, Math.round(input.budgetChars));
  const cap = (share: number) => Math.floor(budget * share);
  const parts: Array<[string, string]> = [];

  if (on.activeWork && input.activeWork?.length) {
    const per = Math.floor(cap(SHARES.activeWork) / input.activeWork.length);
    const lines = input.activeWork.map((b) => clip(b.text.trim(), Math.max(200, per)));
    parts.push(["Active Work", `[Active Work]\n${lines.join("\n\n")}`]);
  }
  const drop = input.drop ?? NO_DROP;
  const requestSel = on.requests ? selectRequestLines(source.requests, cap(SHARES.requests), drop) : { lines: [], shown: new Set<number>() };
  if (on.requests) parts.push(["Your Requests", section("Your Requests", requestSel.lines)]);
  if (on.state) parts.push(["Latest State", section("Latest State", selectState(source.reports, cap(SHARES.state), drop.has(REPORT_KEY)))]);
  if (on.decisions) parts.push(["Decisions & Constraints", section("Decisions & Constraints", selectDecisions(source.requests, cap(SHARES.decisions), requestSel.shown, drop))]);
  if (on.files) parts.push(["Files", section("Files", selectFiles(source.blocks, input.cwd, cap(SHARES.files)))]);
  if (on.commits) parts.push(["Commits", section("Commits", selectCommits(source.blocks, cap(SHARES.commits)))]);
  if (on.errors) parts.push(["Open Errors", section("Open Errors", selectOpenErrors(source.blocks, cap(SHARES.errors), drop))]);

  const head = parts.filter(([, text]) => text);
  const headText = head.map(([, text]) => text).join("\n\n");
  const sections = head.map(([name]) => name);

  let transcript = "";
  if (on.transcript) {
    const remaining = budget - headText.length - RECALL_NOTE.length - 40;
    transcript = selectTranscript(source.blocks, Math.max(Math.floor(budget * 0.18), remaining), input.fileOps, drop);
    if (transcript) sections.push("Recent Transcript");
  }

  const body = [headText, transcript ? `[Recent Transcript]\n${transcript}` : ""].filter(Boolean).join("\n\n");
  if (!body) return { text: "", sections: [] };
  return { text: `${redactSecrets(body)}\n\n---\n\n${RECALL_NOTE}`, sections };
}
