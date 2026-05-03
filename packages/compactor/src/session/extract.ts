/**
 * Event extraction from tool results and messages
 */

import type { SessionEvent } from "../types.js";

const EventPriority = {
  LOW: 1,
  NORMAL: 2,
  HIGH: 3,
  CRITICAL: 4,
} as const;

export interface ToolResult {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResponse?: string;
  isError?: boolean;
}

export function extractEventsFromToolResult(result: ToolResult): SessionEvent[] {
  const events: SessionEvent[] = [];

  if (result.isError) {
    events.push({
      type: "tool_error",
      category: "error",
      data: `[${result.toolName}] ${String(result.toolResponse ?? "").slice(0, 500)}`,
      priority: EventPriority.HIGH,
      data_hash: "",
    });
  }

  // File operations
  if (["read", "Read", "edit", "Edit", "write", "Write"].includes(result.toolName)) {
    const path = String(result.toolInput.file_path ?? result.toolInput.path ?? "");
    if (path) {
      const type = result.toolName.toLowerCase() === "write" ? "file_write"
        : result.toolName.toLowerCase() === "edit" ? "file_edit"
        : "file_read";
      events.push({
        type,
        category: "file",
        data: path,
        priority: EventPriority.NORMAL,
        data_hash: "",
      });
    }
  }

  // Bash commands
  if (["bash", "Bash"].includes(result.toolName)) {
    const cmd = String(result.toolInput.command ?? result.toolInput.description ?? "").slice(0, 200);
    if (cmd) {
      events.push({
        type: "bash_executed",
        category: "env",
        data: cmd,
        priority: EventPriority.LOW,
        data_hash: "",
      });
    }
  }

  // Git operations
  if (result.toolName.toLowerCase().includes("git")) {
    events.push({
      type: "git_operation",
      category: "git",
      data: `${result.toolName}: ${String(result.toolInput.command ?? "").slice(0, 200)}`,
      priority: EventPriority.NORMAL,
      data_hash: "",
    });
  }

  // Sandbox execution
  if (["sandbox", "ctx_execute", "sandbox_file", "ctx_execute_file", "sandbox_batch", "ctx_batch_execute"].includes(result.toolName)) {
    const language = String(result.toolInput.language ?? "unknown");
    const code = String(result.toolInput.code ?? "").slice(0, 200);
    events.push({
      type: "sandbox_execution",
      category: "sandbox",
      data: `[${language}] ${code}`,
      priority: EventPriority.LOW,
      data_hash: "",
    });
  }

  // Content search queries
  if (["content_search", "ctx_search"].includes(result.toolName)) {
    const query = String(result.toolInput.query ?? "").slice(0, 200);
    events.push({
      type: "content_search",
      category: "search",
      data: query,
      priority: EventPriority.LOW,
      data_hash: "",
    });
  }

  // Content indexing
  if (["content_index", "ctx_index", "content_fetch", "ctx_fetch_and_index"].includes(result.toolName)) {
    const label = String(result.toolInput.label ?? result.toolInput.url ?? "").slice(0, 200);
    events.push({
      type: "content_indexed",
      category: "index",
      data: label,
      priority: EventPriority.LOW,
      data_hash: "",
    });
  }

  return events;
}

export function extractEventsFromUserMessage(content: string): SessionEvent[] {
  const events: SessionEvent[] = [];

  // Detect explicit preferences
  const prefRe = /\b(prefer|preference|want|would like|should|must|need to|important|critical|avoid|don't|do not|never|always)\b/i;
  if (prefRe.test(content)) {
    events.push({
      type: "user_preference",
      category: "decision",
      data: content.slice(0, 500),
      priority: EventPriority.NORMAL,
      data_hash: "",
    });
  }

  // Detect task mentions
  const taskRe = /\b(task|todo|fixme|hack|bug|feature|story|epic)\b/i;
  if (taskRe.test(content)) {
    events.push({
      type: "task_mentioned",
      category: "task",
      data: content.slice(0, 500),
      priority: EventPriority.NORMAL,
      data_hash: "",
    });
  }

  return events;
}
