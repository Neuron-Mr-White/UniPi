/**
 * Bridge wire messages (unipi-app docs/m5/PROTOCOL.md §3). One JSON object
 * per line on the bridge socket; the host relays them to the phone verbatim.
 */

export const BRIDGE_PROTOCOL = 1;

export type DialogKind = "select" | "confirm" | "input" | "editor" | "ask_user" | "custom";

export interface Dialog {
  id: number;
  kind: DialogKind;
  title?: string;
  options?: string[];
  message?: string;
  placeholder?: string;
  prefill?: string;
  /** ask_user questions (unipi AskQuestion[]). */
  questions?: unknown[];
  /** When the dialog closes by itself (ms since epoch). */
  deadline?: number;
}

export interface SessionInfo {
  file?: string;
  id: string;
  name?: string;
  cwd: string;
}

/** One row of a `sessions` reply: a session the phone can resume. */
export interface SessionsItem {
  path: string;
  id: string;
  name?: string;
  cwd: string;
  /** First user message, clipped. */
  firstMessage: string;
  /** `modified`, ms since epoch. */
  modified: number;
  messageCount: number;
  /** This is the session we're in right now. */
  current: boolean;
}

/** One row of a `tree` reply: a session entry, preview only. */
export interface TreeNode {
  id: string;
  parentId: string | null;
  /** Message role for `type:"message"` entries, else the entry type (compaction, model_change, …). */
  kind: string;
  /** Short preview, \u2264120 chars. */
  preview: string;
  timestamp?: string;
  label?: string;
  /** On the branch from root to the current leaf. */
  onPath: boolean;
  /** This is where the session is right now. */
  current: boolean;
}

export interface ModelInfo {
  provider: string;
  id: string;
  name?: string;
  reasoning: boolean;
}

export interface RunState {
  running: boolean;
  model?: ModelInfo;
  thinking?: string;
  thinkingLevels?: string[];
  context?: { tokens: number | null; window: number; percent: number | null };
  cost?: number;
}

export interface CommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill" | "builtin";
}

/** One queue row shown in the phone's queue strip. `source:"tui"` items (from
 *  pi's own input events, typed or steered elsewhere) are never editable —
 *  the extension API can't touch pi's own queue. `source:"phone"` + `mode:
 *  "after"` items live in the BRIDGE's own queue (not pi's): editable,
 *  removable, reorderable, promotable. */
export interface Queued {
  id: string;
  text: string;
  mode: "steer" | "followUp" | "after";
  source: "phone" | "tui";
  editable: boolean;
}

export type InputMode = "prompt" | "steer" | "followUp";

/** pi → phone. */
export type OutMsg =
  | {
      t: "hello";
      v: number;
      pid: number;
      piVersion?: string;
      session: SessionInfo;
      state: RunState;
      entries: unknown[];
      truncated: boolean;
      streaming?: { id: string; role: "assistant"; content: unknown[] };
      tools: Array<{ callId: string; name: string; args: unknown; text?: string }>;
      commands: CommandInfo[];
      models: ModelInfo[];
      dialogs: Dialog[];
      queue: Queued[];
    }
  | ({ t: "state" } & Partial<RunState>)
  | ({ t: "session"; reason: string } & SessionInfo)
  | { t: "entry"; entry: unknown }
  | { t: "msg_start"; id: string; role: string }
  | { t: "delta"; id: string; kind: "text" | "thinking" | "toolcall"; index: number; text: string }
  | { t: "msg_end"; id: string }
  | { t: "tool_start"; callId: string; name: string; args: unknown }
  | { t: "tool_update"; callId: string; text: string }
  | { t: "tool_end"; callId: string; isError: boolean }
  /** `ref`: the phone request that caused it (its optimistic bubble is now with pi). */
  | { t: "input"; text: string; source: string; mode: InputMode; ref?: string }
  | { t: "queue"; items: Queued[] }
  | ({ t: "dialog" } & Dialog)
  | { t: "dialog_end"; id: number; by: "tui" | "phone" | "cancel" }
  | { t: "notify"; text: string; level: string }
  /** A /unipi:btw aside streaming to the requesting phone only. */
  | { t: "btw_delta"; id: string; kind: "text" | "thinking" | "tool"; text: string; ref?: string }
  | { t: "btw_end"; id: string; answer: string; error?: string; usage?: { input: number; output: number; totalTokens: number }; ref?: string }
  /** Reply to `btw_list{}`: recent pages (question, answer) for this pi session. */
  | { t: "btw_list"; pages: Array<{ question: string; answer: string; error?: string }>; ref?: string }
  /** `code: "busy"`: new/resume/fork/tree_go while pi is running — the phone may retry with `force:true`. */
  | { t: "error"; message: string; ref?: string; code?: "busy" }
  /** `as: "command"`: the prompt ran an extension command (no chat message follows). */
  | { t: "ack"; ref?: string; as?: "command" }
  /** A page of older entries (oldest first) ending right before `before`. */
  | { t: "history"; before: string; entries: unknown[]; more: boolean; ref?: string }
  /** `@` file suggestions for `query` (pi's own finder: fd, .gitignore aware). */
  | { t: "files"; query: string; items: FileItem[]; ref?: string }
  /** Sessions matching `sessions{scope, query?}`, newest first, capped. */
  | { t: "sessions"; items: SessionsItem[]; more: boolean; ref?: string }
  /** Every branch of the session tree, previews only. */
  | { t: "tree"; nodes: TreeNode[]; ref?: string }
  /** A chunk of a `media{mediaRef}` fetch: base64 `data`, more chunks follow until `done`. */
  | { t: "media_chunk"; mediaRef: string; mime: string; data: string; done: boolean }
  /** `media{mediaRef}` failed (unknown/expired ref, read error…). */
  | { t: "media_error"; mediaRef: string; message: string };

/** One `@` suggestion: `value` replaces the typed `@query` (pi's completion text, e.g. `@src/a.ts` or `@"my dir/"`). */
export type FileItem = { value: string; label: string; path: string; dir: boolean };

/** phone → pi. */
export type InMsg =
  /** `mode`: `auto` (prompt when idle, steer when busy; default) \| `steer` (next tool
   *  boundary) \| `followUp` (pi's own queued follow-up — kept for older apps) \|
   *  `now` (abort the run, wait for idle, then send as a prompt) \| `after` (wait in
   *  the bridge's own queue, delivered one at a time on `agent_end`). */
  | { t: "prompt"; text: string; images?: Array<{ mime: string; data: string }>; mode?: "auto" | "steer" | "followUp" | "now" | "after"; ref?: string }
  | { t: "abort"; ref?: string }
  | { t: "answer"; id: number; value: unknown; ref?: string }
  | { t: "set_model"; provider: string; model: string; ref?: string }
  | { t: "set_thinking"; level: string; ref?: string }
  | { t: "compact"; instructions?: string; ref?: string }
  | { t: "resync"; ref?: string }
  /** Older history: entries before the entry `before` on the active branch. */
  | { t: "history"; before: string; ref?: string }
  /** `@` file suggestions; `query` is the text after `@` (may start with `"`). */
  | { t: "files"; query: string; ref?: string }
  /** List sessions to resume: this project's or every project's, optionally filtered. */
  | { t: "sessions"; scope: "cwd" | "all"; query?: string; ref?: string }
  /** Start a brand-new session. `force`: abort the current run first. */
  | { t: "session_new"; force?: boolean; ref?: string }
  /** Resume a session file. `force`: abort the current run first. */
  | { t: "session_resume"; path: string; force?: boolean; ref?: string }
  /** Fork from a session entry into a new session file. `force`: abort the current run first. */
  | { t: "session_fork"; entryId: string; force?: boolean; ref?: string }
  /** The whole session tree, every branch, previews only. */
  | { t: "tree"; ref?: string }
  /** Navigate to a different point in the tree. `force`: abort the current run first. */
  | { t: "tree_go"; id: string; summarize?: boolean; force?: boolean; ref?: string }
  /** Fetches the full bytes behind an image `mediaRef` the bridge sent in a
   *  `media`-omitted placeholder (see `phoneSafe`): replies with one or more
   *  `media_chunk` (≤ 700 KB of base64 per chunk) ending in `done:true`, or a
   *  `media_error`. `ref` (optional) matches the request like every other op. */
  | { t: "media"; mediaRef: string; ref?: string }
  /** Set the session's display name. */
  | { t: "session_rename"; name: string; ref?: string }
  /** Ask a side question (btw): streams `btw_delta`/`btw_end` to this phone only. */
  | { t: "btw"; question: string; ref?: string }
  /** Recent btw pages for this pi session. */
  | { t: "btw_list"; ref?: string }
  /** Edit a bridge-queued (`mode:"after"`, `source:"phone"`) message's text. */
  | { t: "queue_edit"; id: string; text: string; ref?: string }
  /** Remove a bridge-queued message. */
  | { t: "queue_remove"; id: string; ref?: string }
  /** Promote a bridge-queued message to run now: `to:"steer"` steers it in at
   *  the next tool boundary, `to:"now"` aborts the run, waits for idle, then
   *  sends it as a fresh prompt. */
  | { t: "queue_promote"; id: string; to: "steer" | "now"; ref?: string }
  /** Reorder a bridge-queued message to `index` (phone items only). */
  | { t: "queue_move"; id: string; index: number; ref?: string };

const IN_TYPES = new Set([
  "prompt",
  "abort",
  "answer",
  "set_model",
  "set_thinking",
  "compact",
  "resync",
  "history",
  "files",
  "sessions",
  "session_new",
  "session_resume",
  "session_fork",
  "tree",
  "tree_go",
  "session_rename",
  "media",
  "btw",
  "btw_list",
  "queue_edit",
  "queue_remove",
  "queue_promote",
  "queue_move",
]);

/** Parses one phone line; `undefined` for garbage (never throws). */
export function parseIn(line: string): InMsg | { bad: string; ref?: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { bad: "not JSON" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { bad: "not an object" };
  const m = value as Record<string, unknown>;
  const ref = typeof m.ref === "string" ? m.ref.slice(0, 64) : undefined;
  if (typeof m.t !== "string" || !IN_TYPES.has(m.t)) return { bad: `unknown type ${String(m.t)}`, ref };
  switch (m.t) {
    case "prompt": {
      if (typeof m.text !== "string") return { bad: "prompt.text must be a string", ref };
      const mode = m.mode === "steer" || m.mode === "followUp" || m.mode === "now" || m.mode === "after" ? m.mode : "auto";
      const images = Array.isArray(m.images)
        ? m.images.filter((i): i is { mime: string; data: string } => !!i && typeof i.mime === "string" && /^image\//.test(i.mime) && typeof i.data === "string")
        : undefined;
      if (!m.text.trim() && !images?.length) return { bad: "prompt is empty", ref };
      return { t: "prompt", text: m.text, images: images?.length ? images : undefined, mode, ref };
    }
    case "answer":
      if (typeof m.id !== "number") return { bad: "answer.id must be a number", ref };
      return { t: "answer", id: m.id, value: m.value ?? null, ref };
    case "set_model":
      if (typeof m.provider !== "string" || typeof m.model !== "string") return { bad: "set_model needs provider and model", ref };
      return { t: "set_model", provider: m.provider, model: m.model, ref };
    case "set_thinking":
      if (typeof m.level !== "string") return { bad: "set_thinking.level must be a string", ref };
      return { t: "set_thinking", level: m.level, ref };
    case "compact":
      return { t: "compact", instructions: typeof m.instructions === "string" ? m.instructions : undefined, ref };
    case "history":
      if (typeof m.before !== "string" || !m.before) return { bad: "history.before must be an entry id", ref };
      return { t: "history", before: m.before.slice(0, 128), ref };
    case "files":
      if (typeof m.query !== "string") return { bad: "files.query must be a string", ref };
      return { t: "files", query: m.query.slice(0, 512).replace(/[\r\n]/g, ""), ref };
    case "sessions": {
      const scope = m.scope === "all" ? "all" : m.scope === "cwd" ? "cwd" : undefined;
      if (!scope) return { bad: "sessions.scope must be 'cwd' or 'all'", ref };
      return { t: "sessions", scope, query: typeof m.query === "string" ? m.query.slice(0, 256) : undefined, ref };
    }
    case "session_new":
      return { t: "session_new", force: m.force === true, ref };
    case "session_resume":
      if (typeof m.path !== "string" || !m.path) return { bad: "session_resume.path must be a string", ref };
      return { t: "session_resume", path: m.path, force: m.force === true, ref };
    case "session_fork":
      if (typeof m.entryId !== "string" || !m.entryId) return { bad: "session_fork.entryId must be a string", ref };
      return { t: "session_fork", entryId: m.entryId, force: m.force === true, ref };
    case "tree":
      return { t: "tree", ref };
    case "tree_go":
      if (typeof m.id !== "string" || !m.id) return { bad: "tree_go.id must be a string", ref };
      return { t: "tree_go", id: m.id, summarize: m.summarize === true, force: m.force === true, ref };
    case "session_rename":
      if (typeof m.name !== "string") return { bad: "session_rename.name must be a string", ref };
      return { t: "session_rename", name: m.name.slice(0, 200), ref };
    case "media":
      if (typeof m.mediaRef !== "string" || !m.mediaRef) return { bad: "media.mediaRef must be a string", ref };
      return { t: "media", mediaRef: m.mediaRef.slice(0, 128), ref };
    case "btw":
      if (typeof m.question !== "string" || !m.question.trim()) return { bad: "btw.question must be a non-empty string", ref };
      return { t: "btw", question: m.question.slice(0, 8000), ref };
    case "btw_list":
      return { t: "btw_list", ref };
    case "queue_edit":
      if (typeof m.id !== "string" || !m.id) return { bad: "queue_edit.id must be a string", ref };
      if (typeof m.text !== "string") return { bad: "queue_edit.text must be a string", ref };
      return { t: "queue_edit", id: m.id, text: m.text, ref };
    case "queue_remove":
      if (typeof m.id !== "string" || !m.id) return { bad: "queue_remove.id must be a string", ref };
      return { t: "queue_remove", id: m.id, ref };
    case "queue_promote":
      if (typeof m.id !== "string" || !m.id) return { bad: "queue_promote.id must be a string", ref };
      if (m.to !== "steer" && m.to !== "now") return { bad: "queue_promote.to must be 'steer' or 'now'", ref };
      return { t: "queue_promote", id: m.id, to: m.to, ref };
    case "queue_move":
      if (typeof m.id !== "string" || !m.id) return { bad: "queue_move.id must be a string", ref };
      if (typeof m.index !== "number") return { bad: "queue_move.index must be a number", ref };
      return { t: "queue_move", id: m.id, index: m.index, ref };
    default:
      return { t: m.t as "abort" | "resync", ref };
  }
}

/** Splits a byte stream into lines (NDJSON). Lines over `max` are dropped. */
export class LineSplitter {
  private buf = "";
  private skipping = false;
  constructor(private readonly max = 4 * 1024 * 1024) {}
  push(chunk: string): string[] {
    const out: string[] = [];
    let start = 0;
    for (let i = chunk.indexOf("\n"); i >= 0; i = chunk.indexOf("\n", start)) {
      const piece = chunk.slice(start, i);
      if (!this.skipping) out.push(this.buf + piece);
      this.buf = "";
      this.skipping = false;
      start = i + 1;
    }
    if (!this.skipping) {
      this.buf += chunk.slice(start);
      if (this.buf.length > this.max) {
        this.buf = "";
        this.skipping = true;
      }
    }
    return out;
  }
}
