/**
 * @pi-unipi/subagents — transcript items for the dock's view and the live
 * foreground card. Sources: the child's session file (full history, survives
 * restarts, covers resumed runs) and the runtime's live events (current run,
 * including in-flight tools and streaming text).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import type { SidekickEvent } from "@pi-unipi/core/child-agent.js";

export type TranscriptItem =
  | { kind: "task"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; arg: string; output: string; isError: boolean; running: boolean; durationMs?: number };

function firstLine(value: string): string {
  return value.split("\n", 1)[0] ?? "";
}

export function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

/** The argument worth showing next to a tool name. */
export function primaryArg(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const value = name === "bash"
    ? args.command
    : name === "read" || name === "edit" || name === "write"
      ? args.path ?? args.file_path ?? args.filePath
      : args.pattern ?? args.query ?? Object.values(args).find((entry) => typeof entry === "string");
  return typeof value === "string" ? clip(firstLine(value), 100) : "";
}

export function itemsFromEvents(events: readonly SidekickEvent[]): TranscriptItem[] {
  return events.flatMap((event): TranscriptItem[] => {
    if (event.kind === "text") return event.text.trim() ? [{ kind: "text", text: event.text }] : [];
    return [{
      kind: "tool",
      name: event.name,
      arg: primaryArg(event.name, event.args),
      output: event.output,
      isError: event.isError,
      running: !event.done,
      durationMs: event.endedAt !== undefined ? event.endedAt - event.startedAt : undefined,
    }];
  });
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

const fileCache = new Map<string, { mtimeMs: number; size: number; items: TranscriptItem[] }>();

/** Parse a pi session .jsonl into transcript items (user prompts → task).
 *  Cached by mtime+size — the dock re-renders several times a second. */
export function itemsFromSessionFile(path: string): TranscriptItem[] {
  if (!existsSync(path)) return [];
  try {
    const st = statSync(path);
    const hit = fileCache.get(path);
    if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.items;
    const items = parseSession(readFileSync(path, "utf8"));
    if (fileCache.size > 50) fileCache.clear();
    fileCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, items });
    return items;
  } catch {
    return [];
  }
}

function parseSession(raw: string): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const tools = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: { type?: string; message?: { role?: string; content?: unknown; toolCallId?: string; isError?: boolean } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue; // a torn last line while the child is writing
    }
    const msg = entry.message;
    if (entry.type !== "message" || !msg) continue;
    if (msg.role === "user") {
      const text = textOf(msg.content).trim();
      if (text) items.push({ kind: "task", text });
    } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content as Array<Record<string, unknown>>) {
        if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
          items.push({ kind: "text", text: part.text });
        } else if (part.type === "toolCall") {
          const name = String(part.name ?? "tool");
          const item: Extract<TranscriptItem, { kind: "tool" }> = {
            kind: "tool",
            name,
            arg: primaryArg(name, part.arguments as Record<string, unknown> | undefined),
            output: "",
            isError: false,
            running: true,
          };
          tools.set(String(part.id ?? ""), item);
          items.push(item);
        }
      }
    } else if (msg.role === "toolResult") {
      const item = tools.get(String(msg.toolCallId ?? ""));
      if (item) {
        item.output = textOf(msg.content).slice(-4000);
        item.isError = msg.isError === true;
        item.running = false;
      }
    }
  }
  return items;
}

/**
 * The full transcript of one agent. Finished: the session file (fallback:
 * this process's events). Running: the file up to and including the latest
 * task (history + the current prompt), then the live events of this run —
 * the live events already contain what the file has for the current run.
 */
export function buildTranscript(input: {
  sessionFile: string;
  task?: string;
  running: boolean;
  events?: readonly SidekickEvent[];
}): TranscriptItem[] {
  const fromFile = itemsFromSessionFile(input.sessionFile);
  const live = input.events ? itemsFromEvents(input.events) : undefined;
  if (!input.running) {
    if (fromFile.length > 0) return fromFile;
    return [...(input.task ? [{ kind: "task" as const, text: input.task }] : []), ...(live ?? [])];
  }
  let lastTask = -1;
  fromFile.forEach((item, i) => {
    if (item.kind === "task") lastTask = i;
  });
  const last = fromFile[lastTask];
  // The file may not have the current prompt yet: then everything in it is
  // from earlier runs (resume) and the current task comes from the record.
  const current = last?.kind === "task" && (input.task === undefined || last.text === input.task.trim());
  const history = current
    ? fromFile.slice(0, lastTask + 1)
    : [...fromFile, ...(input.task ? [{ kind: "task" as const, text: input.task }] : [])];
  return [...history, ...(live ?? [])];
}
