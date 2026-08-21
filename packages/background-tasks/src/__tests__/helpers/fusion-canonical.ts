import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import {
  buildFusionCanonicalInput,
  expandFusionProjectionEntry,
  type BuildFusionCanonicalInputOptions,
  type BuiltFusionCanonicalInput,
} from '../../fusion/context.js';
import type {
  ProjectionEntry,
  ProjectionOmissionEntry,
  ProjectionTextEntry,
} from '../../context-visible-conversation-v2.js';
import type {
  FusionCanonicalInputV3,
  FusionContextOmissionLedgerV2,
  FusionUsage,
} from '../../fusion/types.js';

export function testUsage(): FusionUsage {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function userMessage(content: UserMessage['content'], timestamp = 1): UserMessage {
  return { role: 'user', content, timestamp };
}

export function assistantMessage(
  content: AssistantMessage['content'],
  timestamp = 2,
): AssistantMessage {
  return {
    role: 'assistant',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    model: 'gpt-5.5',
    usage: testUsage(),
    stopReason: 'toolUse',
    content,
    timestamp,
  };
}

export function toolResultMessage(
  toolCallId: string,
  toolName: string,
  content: ToolResultMessage['content'],
  timestamp = 3,
): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content,
    details: { ok: true },
    isError: false,
    timestamp,
  };
}

export function sessionWith(messages: readonly (UserMessage | AssistantMessage | ToolResultMessage)[]) {
  const session = SessionManager.inMemory('/tmp/project');
  for (const message of messages) session.appendMessage(message);
  return session;
}

export function buildFrom(
  messages: readonly (UserMessage | AssistantMessage | ToolResultMessage)[],
  options: BuildFusionCanonicalInputOptions,
  systemPrompt = 'system',
): BuiltFusionCanonicalInput {
  const session = sessionWith(messages);
  return buildFusionCanonicalInput(
    { cwd: '/tmp/project', sessionManager: session, getSystemPrompt: () => systemPrompt },
    options,
  );
}

export type ExpandedFusionTextEntry = ProjectionTextEntry;
export type ExpandedFusionOmissionEntry = ProjectionOmissionEntry;
export type ExpandedFusionEntry = ProjectionEntry;

function assertProjection<T>(projection: T | undefined): asserts projection is T {
  if (projection === undefined) throw new Error('expected session projection input');
}

export function expandedEntries(input: FusionCanonicalInputV3): readonly ExpandedFusionEntry[] {
  const projection = input.context?.kind === 'session_projection'
    ? input.context.conversation_projection
    : 'conversation_projection' in input
      ? input.conversation_projection
      : undefined;
  assertProjection(projection);
  return projection.entries.map(expandFusionProjectionEntry);
}

export function textEntries(
  input: FusionCanonicalInputV3,
): readonly ExpandedFusionTextEntry[] {
  return expandedEntries(input).filter(
    (entry): entry is ExpandedFusionTextEntry => entry.kind === 'text',
  );
}

export function omissionEntries(
  input: FusionCanonicalInputV3,
): readonly ExpandedFusionOmissionEntry[] {
  return expandedEntries(input).filter(
    (entry): entry is ExpandedFusionOmissionEntry => entry.kind === 'omitted_activity',
  );
}

export function projectedText(input: FusionCanonicalInputV3): string {
  return textEntries(input)
    .map((entry) => entry.text)
    .join('\n');
}

export function entryKinds(input: FusionCanonicalInputV3): readonly ExpandedFusionEntry['kind'][] {
  return expandedEntries(input).map((entry) => entry.kind);
}

/** Minimal ledger for orchestrator tests that supply a hand-built canonical input. */
export function emptyLedger(policyId: string): FusionContextOmissionLedgerV2 {
  return {
    schema_version: 'pi-background-tasks.fusion-context-ledger.v2',
    policy_id: policyId,
    transform: 'visible-conversation-ledger-v2',
    entries: [],
    projection_map: [],
    root_sha256: 'a'.repeat(64),
  };
}
