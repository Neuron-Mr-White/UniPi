import {
  buildSessionContext,
  convertToLlm,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import type { Message } from '@earendil-works/pi-ai';
import { isJsonObject, type JsonObject } from './types.js';

/**
 * Pi session adapter shared by every consumer of the visible-conversation
 * transform.
 *
 * Responsible for exactly one thing: turning the parent's live Pi session into a
 * frozen `Message[]` snapshot, with the in-flight tool call that requested the
 * snapshot (and therefore its sibling calls) excluded from the branch.
 *
 * The transform itself lives in `visible-conversation-v2.ts` and never sees a
 * `SessionManager`.
 */

export interface ReadonlyParentSessionManager {
  getLeafId(): string | null;
  getLeafEntry(): SessionEntry | undefined;
  getEntries(): SessionEntry[];
}

export interface ParentContextSource {
  cwd: string;
  sessionManager: ReadonlyParentSessionManager;
  getSystemPrompt(): string;
}

export interface ParentSnapshotOptions {
  /** Tool call currently executing, when the snapshot is requested from a tool. */
  toolCallId?: string | undefined;
  /** Tool name used for leaf matching when no explicit call id is available. */
  toolName: string;
  /** Commands have no in-flight tool call and therefore never exclude a leaf. */
  excludeActiveToolCallLeaf: boolean;
}

export interface ParentSnapshot {
  messages: readonly Message[];
  leafId: string | null;
  activeToolCallLeafExcluded: boolean;
}

function entriesById(entries: readonly SessionEntry[]): Map<string, SessionEntry> {
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  return byId;
}

function readArray(record: JsonObject, key: string): readonly unknown[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value : undefined;
}

function recordOf(value: unknown): JsonObject | undefined {
  if (!isJsonObject(value) || Array.isArray(value)) return undefined;
  return value;
}

function entryMessage(entry: SessionEntry): JsonObject | undefined {
  if (entry.type !== 'message') return undefined;
  return recordOf(entry.message);
}

function toolCallPartMatches(
  part: unknown,
  toolCallId: string | undefined,
  toolName: string,
): boolean {
  const record = recordOf(part);
  if (record === undefined || record['type'] !== 'toolCall') return false;
  if (toolCallId !== undefined) return record['id'] === toolCallId;
  return record['name'] === toolName;
}

function messageContainsToolCall(
  message: JsonObject,
  toolCallId: string | undefined,
  toolName: string,
): boolean {
  if (message['role'] !== 'assistant') return false;
  const content = readArray(message, 'content');
  if (content === undefined) return false;
  for (const part of content) {
    if (toolCallPartMatches(part, toolCallId, toolName)) return true;
  }
  return false;
}

interface EffectiveLeaf {
  leafId: string | null;
  activeToolCallLeafExcluded: boolean;
}

function effectiveLeafForTool(
  sessionManager: ReadonlyParentSessionManager,
  toolCallId: string | undefined,
  toolName: string,
): EffectiveLeaf {
  const leaf = sessionManager.getLeafEntry();
  if (leaf === undefined)
    return { leafId: sessionManager.getLeafId(), activeToolCallLeafExcluded: false };
  const message = entryMessage(leaf);
  if (message !== undefined && messageContainsToolCall(message, toolCallId, toolName)) {
    return { leafId: leaf.parentId, activeToolCallLeafExcluded: true };
  }
  return { leafId: sessionManager.getLeafId(), activeToolCallLeafExcluded: false };
}

export function resolveEffectiveLeaf(
  sessionManager: ReadonlyParentSessionManager,
  options: ParentSnapshotOptions,
): EffectiveLeaf {
  if (!options.excludeActiveToolCallLeaf)
    return { leafId: sessionManager.getLeafId(), activeToolCallLeafExcluded: false };
  return effectiveLeafForTool(sessionManager, options.toolCallId, options.toolName);
}

/**
 * Freeze the parent conversation into LLM messages.
 *
 * Callers must complete every downstream use of the returned snapshot without
 * re-reading the session, so the seed cannot drift while a child is being
 * launched.
 */
export function snapshotParentConversation(
  ctx: ParentContextSource,
  options: ParentSnapshotOptions,
): ParentSnapshot {
  const entries = ctx.sessionManager.getEntries();
  const leaf = resolveEffectiveLeaf(ctx.sessionManager, options);
  const sessionContext = buildSessionContext(entries, leaf.leafId, entriesById(entries));
  return {
    messages: convertToLlm(sessionContext.messages),
    leafId: leaf.leafId,
    activeToolCallLeafExcluded: leaf.activeToolCallLeafExcluded,
  };
}
