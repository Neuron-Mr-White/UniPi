/**
 * @pi-unipi/subagents — Native supervisor channel
 *
 * Ported from pi-subagents src/intercom/native-supervisor-channel.ts (core).
 * File-based channel: children write request JSON into a per-run channel dir;
 * the parent polls, surfaces decisions via followUp messages, and writes
 * reply JSON back. Children discover the channel through env vars set at
 * launch (UNIPI_SUBAGENT_SUPERVISOR_CHANNEL_DIR etc.) — NO external
 * pi-intercom dependency.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export const SUPERVISOR_TOOL_NAME = "contact_supervisor";
export const PARENT_SUPERVISOR_TOOL_NAME = "subagent_supervisor";

const MAX_MESSAGE_BYTES = 64 * 1024;
const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;
const CHANNEL_POLL_MS = 500;

export type SupervisorReason = "need_decision" | "interview_request" | "progress_update";

export interface SupervisorRequest {
  type: "subagent.supervisor.request";
  id: string;
  createdAt: number;
  expiresAt?: number;
  reason: SupervisorReason;
  message: string;
  expectsReply: boolean;
  runId: string;
  agent: string;
}

export interface SupervisorReply {
  type: "subagent.supervisor.reply";
  requestId: string;
  createdAt: number;
  message: string;
}

// ============================================================================
// Env contract (child side)
// ============================================================================

export const SUPERVISOR_CHANNEL_DIR_ENV = "UNIPI_SUBAGENT_SUPERVISOR_CHANNEL_DIR";
export const SUPERVISOR_RUN_ID_ENV = "UNIPI_SUBAGENT_RUN_ID";
export const SUPERVISOR_AGENT_ENV = "UNIPI_SUBAGENT_CHILD_AGENT";
export const SUPERVISOR_PARENT_SESSION_ENV = "UNIPI_SUBAGENT_PARENT_SESSION";

/** Child-side metadata read from env. All fields required to activate. */
export function readChildSupervisorMetadata(env: NodeJS.ProcessEnv = process.env): {
  channelDir: string;
  runId: string;
  agent: string;
  parentSessionId: string;
} | undefined {
  const channelDir = env[SUPERVISOR_CHANNEL_DIR_ENV]?.trim();
  const runId = env[SUPERVISOR_RUN_ID_ENV]?.trim();
  const agent = env[SUPERVISOR_AGENT_ENV]?.trim();
  const parentSessionId = env[SUPERVISOR_PARENT_SESSION_ENV]?.trim();
  if (!channelDir || !runId || !agent || !parentSessionId) return undefined;
  return { channelDir, runId, agent, parentSessionId };
}

function safeSegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

/** Channel dir under our temp root: supervisor-channels/<runId>-<agent>/. */
export function resolveSupervisorChannelDir(root: string, runId: string, agent: string): string {
  return path.join(root, `${safeSegment(runId)}-${safeSegment(agent)}`);
}

export function ensureSupervisorChannelDir(channelDir: string): void {
  fs.mkdirSync(path.join(channelDir, "requests"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(channelDir, "replies"), { recursive: true, mode: 0o700 });
}

function requestsDir(channelDir: string): string {
  return path.join(channelDir, "requests");
}
function repliesDir(channelDir: string): string {
  return path.join(channelDir, "replies");
}

function validateMessage(message: string | undefined): string {
  if (!message || !message.trim()) throw new Error("supervisor message must be a non-empty string.");
  if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error(`supervisor message exceeds ${MAX_MESSAGE_BYTES} bytes.`);
  }
  return message;
}

// ============================================================================
// Child side: contact_supervisor
// ============================================================================

/**
 * Write a supervisor request and (optionally) block until a reply lands.
 * Returns the reply text for asks; undefined for progress updates.
 */
export function childContactSupervisor(
  params: { reason: SupervisorReason; message?: string; timeoutMs?: number },
  metadata = readChildSupervisorMetadata(),
  now = Date.now(),
): { replied: boolean; reply?: string } {
  if (!metadata) {
    throw new Error("contact_supervisor is unavailable: no supervisor channel in this environment.");
  }
  const message = validateMessage(params.message);
  ensureSupervisorChannelDir(metadata.channelDir);

  const request: SupervisorRequest = {
    type: "subagent.supervisor.request",
    id: randomUUID(),
    createdAt: now,
    reason: params.reason,
    message,
    expectsReply: params.reason !== "progress_update",
    runId: metadata.runId,
    agent: metadata.agent,
    ...(params.reason !== "progress_update"
      ? { expiresAt: now + (params.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS) }
      : {}),
  };
  fs.writeFileSync(
    path.join(requestsDir(metadata.channelDir), `${request.id}.json`),
    JSON.stringify(request),
    { mode: 0o600 },
  );

  if (!request.expectsReply) return { replied: false };

  // Block on the reply file. In production children run as separate processes
  // (Atomics.wait parks without burning CPU); when Atomics is unavailable
  // (e.g. same-process tests), fall back to a busy poll.
  const replyFile = path.join(repliesDir(metadata.channelDir), `${request.id}.json`);
  const deadline = request.expiresAt ?? now + DEFAULT_ASK_TIMEOUT_MS;
  const waitBuffer = typeof SharedArrayBuffer !== "undefined" ? new Int32Array(new SharedArrayBuffer(4)) : undefined;
  for (;;) {
    try {
      const reply = JSON.parse(fs.readFileSync(replyFile, "utf8")) as SupervisorReply;
      if (reply.requestId === request.id) return { replied: true, reply: reply.message };
    } catch {
      // Not there yet.
    }
    if (Date.now() > deadline) {
      return { replied: false, reply: undefined };
    }
    if (waitBuffer) {
      try {
        Atomics.wait(waitBuffer, 0, 0, CHANNEL_POLL_MS);
      } catch {
        // Busy fallback below.
      }
    }
  }
}

// ============================================================================
// Parent side: poll pending requests, deliver, reply
// ============================================================================

export interface PendingSupervisorRequest extends SupervisorRequest {
  channelDir: string;
}

/** List open requests across all channel dirs under the root. */
export function listPendingSupervisorRequests(root: string): PendingSupervisorRequest[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const pending: PendingSupervisorRequest[] = [];
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const channelDir = path.join(root, entry.name);
    let files: string[];
    try {
      files = fs.readdirSync(requestsDir(channelDir));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const request = JSON.parse(fs.readFileSync(path.join(requestsDir(channelDir), file), "utf8")) as SupervisorRequest;
        if (request.type !== "subagent.supervisor.request") continue;
        if (request.expiresAt !== undefined && request.expiresAt < now) {
          // Expired: clean up so it never re-surfaces.
          fs.rmSync(path.join(requestsDir(channelDir), file), { force: true });
          continue;
        }
        pending.push({ ...request, channelDir });
      } catch {
        // corrupt → skip
      }
    }
  }
  return pending.sort((left, right) => left.createdAt - right.createdAt);
}

/** Reply to a request (removes it from pending). */
export function replyToSupervisorRequest(root: string, requestId: string, message: string): boolean {
  const validMessage = validateMessage(message);
  for (const pending of listPendingSupervisorRequests(root)) {
    if (pending.id !== requestId) continue;
    const reply: SupervisorReply = {
      type: "subagent.supervisor.reply",
      requestId,
      createdAt: Date.now(),
      message: validMessage,
    };
    fs.writeFileSync(path.join(repliesDir(pending.channelDir), `${requestId}.json`), JSON.stringify(reply), { mode: 0o600 });
    try {
      fs.rmSync(path.join(requestsDir(pending.channelDir), `${requestId}.json`), { force: true });
    } catch { /* best effort */ }
    return true;
  }
  return false;
}

/** Create the parent-side poller that delivers requests as notifications. */
export function createSupervisorPoller(
  root: string,
  opts: {
    pollMs?: number;
    notify: (request: PendingSupervisorRequest) => void;
  },
): { stop(): void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  timer = setInterval(() => {
    for (const request of listPendingSupervisorRequests(root)) {
      opts.notify(request);
    }
  }, opts.pollMs ?? CHANNEL_POLL_MS);
  timer.unref?.();
  return {
    stop(): void {
      if (timer) clearInterval(timer);
    },
  };
}
