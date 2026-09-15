import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';

export function testUsage(): AssistantMessage['usage'] {
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
