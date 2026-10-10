/**
 * @pi-unipi/dream — session digests (the gather step).
 *
 * Turns pi session JSONL into compact "struggle digests": one JSON file per
 * session holding the failed tool calls (with the first line(s) of the error
 * AND its tail — the groupable key of a stack trace is the first line, the
 * useful detail of a short error is the tail), the recovery (next successful
 * call of the same tool), and user corrections. Secrets are scrubbed before
 * anything hits disk: digests are read by a detached model run.
 *
 * Validated as harness digest.mjs (run 1 + run 2 on coffee, UNI-118).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

export interface DigestEvent {
  kind: "tool_error" | "user_correction";
  tool?: string;
  call?: string;
  errorHead?: string;
  errorTail?: string;
  error?: string;
  recovery?: string | null;
  text?: string;
}

export interface SessionDigest {
  session: string;
  cwd: string;
  firstRequest: string;
  userTurns: number;
  toolCalls: number;
  errors: number;
  events: DigestEvent[];
}

const SECRET_RE =
  /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[bp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|[A-Za-z0-9]{40,})/g;
const CORRECTION_RE =
  /^(no\b|wrong|that'?s not|not what|stop\b|don'?t\b|why did you|you (should|shouldn'?t)|actually\b)/i;

export function scrub(text: unknown): string {
  return String(text ?? "")
    .replace(SECRET_RE, "<redacted>")
    .replace(/9801\(\*\)!Coffee/g, "<redacted>");
}

function clip(text: unknown, max: number): string {
  const s = scrub(text).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** pi encodes a cwd into the session dir name; verified against real dirs
 *  (/home/oi -> --home-oi--, /home -> --home--). */
export function encodeSessionDirName(cwd: string): string {
  return `--${cwd.split("/").filter(Boolean).join("-")}--`;
}

/** The pi sessions directory holding this cwd's session files. */
export function sessionDirFor(cwd: string, agentDir?: string): string {
  const base = agentDir ?? path.join(homedir(), ".pi", "agent");
  return path.join(base, "sessions", encodeSessionDirName(cwd));
}

/** Digest every session file in a sessions dir. Returns digests with events. */
export function digestSessions(sessionsDir: string, outDir: string): { count: number; events: number } {
  fs.mkdirSync(outDir, { recursive: true });
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
  } catch {
    // no sessions dir yet (fresh project): an empty digest set
  }
  let eventTotal = 0;
  let sessionCount = 0;
  const index: Array<{ session: string; firstRequest: string; toolCalls: number; errors: number; corrections: number }> = [];
  for (const f of files) {
    const digest = digestSessionFile(path.join(sessionsDir, f));
    if (!digest) continue;
    sessionCount++;
    eventTotal += digest.events.length;
    fs.writeFileSync(path.join(outDir, `${digest.session}.json`), JSON.stringify(digest, null, 1));
    index.push({
      session: digest.session,
      firstRequest: digest.firstRequest.slice(0, 120),
      toolCalls: digest.toolCalls,
      errors: digest.errors,
      corrections: digest.events.filter((e) => e.kind === "user_correction").length,
    });
  }
  fs.writeFileSync(path.join(outDir, "INDEX.json"), JSON.stringify(index, null, 1));
  return { count: sessionCount, events: eventTotal };
}

/** Digest one session JSONL file; null when the session had no struggle events. */
export function digestSessionFile(file: string): SessionDigest | null {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const calls = new Map<string, { name: string; args: unknown }>();
  const events: DigestEvent[] = [];
  let cwd = "";
  let firstRequest = "";
  let userTurns = 0;
  let toolCalls = 0;
  let errors = 0;
  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type === "session") cwd = String(entry.cwd ?? "");
    if (entry.type !== "message") continue;
    const m = entry.message as Record<string, unknown> | undefined;
    if (!m) continue;
    const role = m.role;
    if (role === "user") {
      userTurns++;
      const content = m.content;
      const text =
        (Array.isArray(content)
          ? content.filter((c) => (c as Record<string, unknown>).type === "text").map((c) => (c as Record<string, unknown>).text).join(" ")
          : String(content ?? "")) || "";
      if (!firstRequest) firstRequest = clip(text, 300);
      if (CORRECTION_RE.test(text.trim())) events.push({ kind: "user_correction", text: clip(text, 400) });
    } else if (role === "assistant") {
      for (const c of (Array.isArray(m.content) ? m.content : []) as Array<Record<string, unknown>>) {
        if (c.type === "toolCall") {
          toolCalls++;
          calls.set(String(c.id), { name: String(c.name ?? ""), args: c.arguments });
        }
      }
    } else if (role === "toolResult") {
      const call = calls.get(String(m.toolCallId)) ?? { name: String(m.toolName ?? ""), args: {} };
      const content = m.content;
      const text =
        (Array.isArray(content)
          ? content.filter((c) => (c as Record<string, unknown>).type === "text").map((c) => (c as Record<string, unknown>).text).join(" ")
          : String(content ?? "")) || "";
      const exitFail = /Command exited with code [1-9]/.test(text);
      if (m.isError === true || exitFail) {
        errors++;
        events.push({
          kind: "tool_error",
          tool: call.name,
          call: clip(JSON.stringify(call.args), 300),
          errorHead: clip(text.slice(0, 500), 400),
          errorTail: clip(text.slice(-400), 300),
          recovery: null,
        });
      } else {
        for (let i = events.length - 1; i >= 0; i--) {
          const open = events[i];
          if (open.kind === "tool_error" && open.tool === call.name && !open.recovery) {
            open.recovery = clip(JSON.stringify(call.args), 300);
            break;
          }
        }
      }
    }
  }
  if (!events.length) return null;
  return {
    session: path.basename(file, ".jsonl"),
    cwd,
    firstRequest: firstRequest,
    userTurns,
    toolCalls,
    errors,
    events,
  };
}

/** Count sessions in a dir whose newest struggle digest is newer than `since`. */
export function countNewSessions(sessionsDir: string, sinceMs: number): number {
  try {
    return fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .filter((f) => {
        try {
          return fs.statSync(path.join(sessionsDir, f)).mtimeMs > sinceMs;
        } catch {
          return false;
        }
      }).length;
  } catch {
    return 0;
  }
}
