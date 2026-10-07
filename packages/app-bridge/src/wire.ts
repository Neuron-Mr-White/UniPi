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

export interface Queued {
  text: string;
  mode: "steer" | "followUp";
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
  | { t: "input"; text: string; source: string; mode: InputMode }
  | { t: "queue"; items: Queued[] }
  | ({ t: "dialog" } & Dialog)
  | { t: "dialog_end"; id: number; by: "tui" | "phone" | "cancel" }
  | { t: "notify"; text: string; level: string }
  | { t: "error"; message: string; ref?: string }
  | { t: "ack"; ref?: string }
  /** A page of older entries (oldest first) ending right before `before`. */
  | { t: "history"; before: string; entries: unknown[]; more: boolean; ref?: string }
  /** `@` file suggestions for `query` (pi's own finder: fd, .gitignore aware). */
  | { t: "files"; query: string; items: FileItem[]; ref?: string };

/** One `@` suggestion: `value` replaces the typed `@query` (pi's completion text, e.g. `@src/a.ts` or `@"my dir/"`). */
export type FileItem = { value: string; label: string; path: string; dir: boolean };

/** phone → pi. */
export type InMsg =
  | { t: "prompt"; text: string; images?: Array<{ mime: string; data: string }>; mode?: "auto" | "steer" | "followUp"; ref?: string }
  | { t: "abort"; ref?: string }
  | { t: "answer"; id: number; value: unknown; ref?: string }
  | { t: "set_model"; provider: string; model: string; ref?: string }
  | { t: "set_thinking"; level: string; ref?: string }
  | { t: "compact"; instructions?: string; ref?: string }
  | { t: "resync"; ref?: string }
  /** Older history: entries before the entry `before` on the active branch. */
  | { t: "history"; before: string; ref?: string }
  /** `@` file suggestions; `query` is the text after `@` (may start with `"`). */
  | { t: "files"; query: string; ref?: string };

const IN_TYPES = new Set(["prompt", "abort", "answer", "set_model", "set_thinking", "compact", "resync", "history", "files"]);

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
      const mode = m.mode === "steer" || m.mode === "followUp" ? m.mode : "auto";
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
