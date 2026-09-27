/**
 * Summary source — turn the session branch into what the lossless summary is
 * built from, rebuilt from the FULL history on every compaction.
 *
 * Pi's session file is append-only, so every raw message is still on the
 * branch after earlier compactions. Rebuilding from it (instead of merging onto
 * the previous summary text) means a summary can never inherit bloat or drift
 * from an earlier one.
 *
 * The one hard problem is telling the user's own words apart from text that
 * extensions inject with the user role (loop prompts, nudges, notifications):
 *   - custom messages (hidden reminders, notices) are never user text;
 *   - user messages sent by extensions are marked at `input` time with an
 *     origin entry (see ORIGIN_ENTRY_TYPE) and dropped by that mark;
 *   - older sessions without marks fall back to known injected shapes.
 */

import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { NormalizedBlock } from "../types.js";
import { textOf } from "./content.js";
import { filterNoise } from "./filter-noise.js";
import { normalizeAgentMessage } from "../session/recall-blocks.js";

/** Custom entry appended when an extension (not the user) sends a user message. */
export const ORIGIN_ENTRY_TYPE = "compactor-origin";

/** Stable key for a user message text (whitespace-insensitive, prefix-bounded). */
export function originKey(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim().slice(0, 400);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Known shapes of text that extensions send with the user role. Used for
 * sessions recorded before origin marks existed, and as a safety net.
 */
const INJECTED_PATTERNS: readonly RegExp[] = [
  /^[─━=\-]{8,}\s*🔄 RALPH LOOP/u,
  /🔄 RALPH LOOP:/u,
  /^No-progress guard:/,
  /^Continue working toward the active thread goal/,
  /^Goal (?:recovery|status audit)\b/,
  /^The active goal reached a budget limit/,
  /^\[kanboard [\w.-]+\]/,
  // Tagged envelopes: <background-task-notification>, <session_resume>, <system-reminder>, …
  /^<[a-zA-Z][\w-]*(?:\s[^>]*)?>/,
];

export function isInjectedUserText(text: string, origins?: ReadonlySet<string>): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (origins?.has(originKey(trimmed))) return true;
  return INJECTED_PATTERNS.some((re) => re.test(trimmed));
}

/** Tools whose results are progress reports (long-horizon loops). */
const PROGRESS_TOOLS = /^(?:ralph_done|update_goal)$/;
/** Tools that ask the user a question; their results carry the user's answer. */
const ASK_TOOLS = /^(?:ask_user|ask_user_question|askuserquestion|ask)$/i;

/** "Q → A" from an ask tool result ("User wrote: …" / "User selected: …"), or null when unanswered. */
function askAnswer(message: any): string | null {
  const text = textOf(message.content).trim();
  const m = text.match(/^User (?:wrote|selected|answered|chose)[^:]*:\s*([\s\S]+)$/i);
  if (!m) return null;
  const rawQuestion = typeof message.details?.question === "string" ? message.details.question.replace(/\s+/g, " ").trim() : "";
  // The answer is the user's words: keep it whole, shorten the agent's question.
  const question = rawQuestion.length > 140 ? `${rawQuestion.slice(0, 139).trimEnd()}…` : rawQuestion;
  const answer = m[1].trim();
  return question ? `${question} → ${answer}` : answer;
}

export interface SummarySource {
  /** Blocks for sections + transcript: real user text, assistant, tools. sourceIndex = branch entry index. */
  blocks: NormalizedBlock[];
  /** The user's own messages, raw text (newlines kept), oldest first. */
  requests: string[];
  /** Assistant prose per message, raw text, oldest first. */
  reports: string[];
}

/** Origin marks recorded anywhere on the branch. */
export function collectOrigins(branchEntries: readonly any[]): Set<string> {
  const origins = new Set<string>();
  for (const entry of branchEntries) {
    if (entry?.type === "custom" && entry.customType === ORIGIN_ENTRY_TYPE) {
      const key = entry.data?.key;
      if (typeof key === "string") origins.add(key);
    }
  }
  return origins;
}

const assistantProse = (message: any): string => {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .trim();
};

/**
 * Build the summary source from branch entries [0, endIndex). Entries are the
 * full branch (not just the live window), so earlier compactions are rebuilt
 * from their raw messages; compaction entries themselves are skipped.
 */
export function collectSummarySource(
  branchEntries: readonly any[],
  endIndex: number,
  origins: ReadonlySet<string> = collectOrigins(branchEntries),
): SummarySource {
  const blocks: NormalizedBlock[] = [];
  const requests: string[] = [];
  const reports: string[] = [];
  const end = Math.max(0, Math.min(endIndex, branchEntries.length));

  for (let i = 0; i < end; i++) {
    const entry = branchEntries[i];
    if (!entry) continue;
    if (entry.type === "branch_summary" && typeof entry.summary === "string") {
      blocks.push({ kind: "assistant", text: `[branch summary] ${entry.summary.replace(/\s+/g, " ").slice(0, 600)}`, sourceIndex: i });
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message as AgentMessage & { role?: string };
    if (message.role === "user") {
      const raw = textOf((message as any).content).trim();
      if (isInjectedUserText(raw, origins)) continue;
      requests.push(raw);
    } else if (message.role === "assistant") {
      const prose = assistantProse(message);
      if (prose) reports.push(prose);
    } else if (message.role === "toolResult" && ASK_TOOLS.test(String((message as any).toolName ?? ""))) {
      // The user's answer to an agent question is the user's own decision.
      const answer = askAnswer(message);
      if (answer) requests.push(answer);
    } else if (message.role === "toolResult" && PROGRESS_TOOLS.test(String((message as any).toolName ?? ""))) {
      // Loop progress reports (ralph iteration summaries, goal updates).
      const text = textOf((message as any).content).trim();
      if (text) reports.push(text);
    } else if (message.role === "custom") {
      continue;
    }
    blocks.push(...normalizeAgentMessage(message, i));
  }

  return { blocks: filterNoise(blocks), requests, reports };
}
