import type { SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import { buildDelegateSeed, type BuiltDelegateSeed } from '../../delegate/seed.js';
import type { DelegateLimits, DelegatePinnedRoute } from '../../delegate/types.js';

/**
 * Fully deterministic delegate seed fixture.
 *
 * Pi assigns random ids to session entries, so a `SessionManager` cannot be used
 * to prove cross-process byte stability: its leaf id legitimately differs every
 * time. This fixture supplies a hand-built session view with fixed entry ids, so
 * the only thing that can vary between two builds is the projection itself.
 */

const ROUTE: DelegatePinnedRoute = {
  provider: 'anthropic',
  model: 'claude-test',
  qualified_id: 'anthropic/claude-test',
  context_window_tokens: 200_000,
  thinking_level: 'medium',
  origin: 'parent_current',
};

const LIMITS: DelegateLimits = {
  max_turns: 24,
  max_tool_calls: 120,
  timeout_seconds: 900,
  max_tool_result_bytes: 65_536,
  max_total_tool_output_bytes: 67_108_864,
  max_answer_bytes: 4_194_304,
  allowed_input_tokens: 171_712,
};

function messageEntry(
  id: string,
  parentId: string | null,
  message: UserMessage | AssistantMessage | ToolResultMessage,
): SessionMessageEntry {
  return { type: 'message', id, parentId, timestamp: '2024-01-01T00:00:00.000Z', message };
}

const ENTRIES: readonly SessionMessageEntry[] = [
  messageEntry('e0000001', null, {
    role: 'user',
    content: 'VISIBLE_USER_ONE about the failing test',
    timestamp: 1,
  }),
  messageEntry('e0000002', 'e0000001', {
    role: 'assistant',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    model: 'gpt-5.5',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    content: [
      { type: 'text', text: 'VISIBLE_ASSISTANT_ONE here is my reading' },
      { type: 'thinking', thinking: 'SECRET_THINKING_PAYLOAD', thinkingSignature: '' },
      { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: '/SECRET_TOOL_ARGUMENT' } },
    ],
    timestamp: 2,
  }),
  messageEntry('e0000003', 'e0000002', {
    role: 'toolResult',
    toolCallId: 'c1',
    toolName: 'read',
    content: [{ type: 'text', text: 'SECRET_TOOL_RESULT_PAYLOAD' }],
    isError: false,
    timestamp: 3,
  }),
  messageEntry('e0000004', 'e0000003', {
    role: 'user',
    content: 'VISIBLE_USER_TWO follow-up',
    timestamp: 4,
  }),
];

/** Read-only session view with fixed ids and a fixed leaf. */
export const DETERMINISTIC_SESSION = {
  getLeafId: (): string | null => 'e0000004',
  getLeafEntry: (): SessionMessageEntry | undefined => ENTRIES[ENTRIES.length - 1],
  getEntries: (): SessionMessageEntry[] => [...ENTRIES],
};

export function buildDeterministicFixtureSeed(): BuiltDelegateSeed {
  return buildDelegateSeed(
    {
      cwd: '/tmp/project',
      sessionManager: DETERMINISTIC_SESSION,
      getSystemPrompt: () => 'parent system prompt',
    },
    {
      taskId: 'd0123456789abcdef0123456789abcdef',
      launchNonce: 'ffeeddccbbaa99887766554433221100',
      toolCallId: 'delegate-call-1',
      directive: 'investigate the failing gate',
      capability: 'inspect',
      extensionMode: 'isolated',
      route: ROUTE,
      limits: LIMITS,
    },
  );
}
