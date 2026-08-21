import { appendFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
  type TextContent,
  type ToolCall,
} from '@earendil-works/pi-ai';

/**
 * Deterministic provider used only by the Pi hook-contract characterisation
 * gate. It records the exact LLM context it was handed for every call so the
 * test can prove whether a `context` handler's returned messages actually reach
 * the provider, and whether a call was dispatched at all.
 */
const PROVIDER = 'pi-bg-hook-contract';
const MODEL_ID = 'hook-contract-model';
const API = 'pi-bg-hook-contract-api';

const USAGE = {
  input: 7,
  output: 3,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 10,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type JsonObject = Record<PropertyKey, unknown>;

interface ScriptedToolCall extends Omit<ToolCall, 'arguments'> {
  arguments: JsonObject;
}

type ScriptedBlock = TextContent | ScriptedToolCall;

interface ScriptedAssistantMessage extends Omit<AssistantMessage, 'content' | 'stopReason'> {
  content: ScriptedBlock[];
  stopReason: 'stop' | 'toolUse';
}

function record(event: JsonObject): void {
  const path = process.env['UNIPI_BG_HOOK_PROBE_LOG'];
  if (!path) return;
  appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8');
}

function messageText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.map((part) => ('text' in part ? part.text : `<${part.type}>`)).join('');
}

function assistant(
  content: ScriptedBlock[],
  stopReason: 'stop' | 'toolUse',
): ScriptedAssistantMessage {
  return {
    role: 'assistant',
    content,
    api: API,
    provider: PROVIDER,
    model: MODEL_ID,
    usage: USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

function pushMessage(stream: AssistantMessageEventStream, message: ScriptedAssistantMessage): void {
  const partial: AssistantMessage = { ...message, content: [] };
  stream.push({ type: 'start', partial: { ...partial } });
  message.content.forEach((block, contentIndex) => {
    if (block.type === 'text') {
      const partialText: TextContent = { type: 'text', text: '' };
      partial.content = [...partial.content, partialText];
      stream.push({ type: 'text_start', contentIndex, partial: { ...partial } });
      partialText.text = block.text;
      stream.push({ type: 'text_delta', contentIndex, delta: block.text, partial: { ...partial } });
      stream.push({ type: 'text_end', contentIndex, content: block.text, partial: { ...partial } });
      return;
    }
    const partialToolCall: ToolCall = {
      type: 'toolCall',
      id: block.id,
      name: block.name,
      arguments: {},
    };
    partial.content = [...partial.content, partialToolCall];
    stream.push({ type: 'toolcall_start', contentIndex, partial: { ...partial } });
    stream.push({
      type: 'toolcall_delta',
      contentIndex,
      delta: JSON.stringify(block.arguments),
      partial: { ...partial },
    });
    partialToolCall.arguments = block.arguments;
    stream.push({ type: 'toolcall_end', contentIndex, toolCall: block, partial: { ...partial } });
  });
  stream.push({ type: 'done', reason: message.stopReason, message });
  stream.end(message);
}

const ProbeEchoParams = {
  type: 'object',
  properties: { value: { type: 'string' } },
  required: ['value'],
  additionalProperties: false,
} as const;

export default function hookContractProviderExtension(pi: ExtensionAPI): void {
  let providerCalls = 0;

  pi.registerTool<typeof ProbeEchoParams, { value: string }>({
    name: 'probe_echo',
    label: 'Probe Echo',
    description: 'Hook-contract characterisation echo tool.',
    parameters: ProbeEchoParams,
    execute(_toolCallId, input) {
      return Promise.resolve({
        content: [{ type: 'text' as const, text: `ORIGINAL_TOOL_PAYLOAD:${input.value}` }],
        details: { value: input.value },
      });
    },
  });

  pi.registerProvider(PROVIDER, {
    name: 'Pi Background Tasks Hook Contract Provider',
    baseUrl: 'http://localhost:0',
    apiKey: 'UNIPI_BG_HOOK_CONTRACT_API_KEY',
    api: API,
    models: [
      {
        id: MODEL_ID,
        name: 'Hook Contract Model',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 4096,
      },
    ],
    streamSimple(
      _model: Model<Api>,
      context: Context,
      options?: { signal?: AbortSignal | undefined },
    ): AssistantMessageEventStream {
      providerCalls += 1;
      record({
        hook: 'provider_call',
        providerCalls,
        // Records whether Pi handed this call an already-aborted signal. A
        // conforming provider must not send the request in that state.
        signalAborted: options?.signal?.aborted === true,
        roles: context.messages.map((message) => message.role),
        texts: context.messages.map(messageText),
      });
      const stream = createAssistantMessageEventStream();
      const wantsTool = providerCalls === 1 && process.env['UNIPI_BG_HOOK_PROBE_TOOL'] === '1';
      queueMicrotask(() => {
        pushMessage(
          stream,
          wantsTool
            ? assistant(
                [{ type: 'toolCall', id: 'probe-call-1', name: 'probe_echo', arguments: { value: 'seed' } }],
                'toolUse',
              )
            : assistant([{ type: 'text', text: `probe answer ${String(providerCalls)}` }], 'stop'),
        );
      });
      return stream;
    },
  });
}
