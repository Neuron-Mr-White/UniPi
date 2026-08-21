import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type TextContent,
  type ToolCall,
} from '@earendil-works/pi-ai';

/**
 * Deterministic provider used by the delegate child-guard gate.
 *
 * Scenarios drive the guard through spill, budget refusal, route drift, turn
 * limits, and the clean commit path, all inside a real Pi agent loop.
 */
const PROVIDER = 'pi-bg-delegate';
const MODEL_ID = 'delegate-model';
const API = 'pi-bg-delegate-api';

const USAGE = {
  input: 12,
  output: 6,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 18,
  cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
};

type JsonObject = Record<PropertyKey, unknown>;

interface ScriptedToolCall extends Omit<ToolCall, 'arguments'> {
  arguments: JsonObject;
}

type ScriptedBlock = TextContent | ScriptedToolCall;

interface ScriptedAssistantMessage extends Omit<AssistantMessage, 'content' | 'stopReason'> {
  content: ScriptedBlock[];
  stopReason: 'stop' | 'toolUse' | 'length';
}

function scenario(): string {
  return process.env['UNIPI_BG_DELEGATE_SCENARIO'] ?? 'plain-answer';
}

function assistant(
  content: ScriptedBlock[],
  stopReason: 'stop' | 'toolUse' | 'length',
  overrides: { provider?: string; model?: string } = {},
): ScriptedAssistantMessage {
  return {
    role: 'assistant',
    content,
    api: API,
    provider: overrides.provider ?? PROVIDER,
    model: overrides.model ?? MODEL_ID,
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

const GuardProbeParams = {
  type: 'object',
  properties: {
    size: { type: 'number' },
    marker: { type: 'string' },
  },
  additionalProperties: false,
} as const;

const GuardImageParams = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

function findSpillReceiptPath(context: Context): string | undefined {
  for (const message of context.messages) {
    if (message.role !== 'toolResult') continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type !== 'text') continue;
      const match = /spill\/[A-Za-z0-9._-]+\.bin/.exec(part.text);
      if (match) return match[0];
    }
  }
  return undefined;
}

export default function delegateGuardProviderExtension(pi: ExtensionAPI): void {
  let calls = 0;

  pi.registerTool<typeof GuardProbeParams, { bytes: number }>({
    name: 'guard_probe',
    label: 'Guard Probe',
    description: 'Delegate guard characterisation probe that emits a payload of a requested size.',
    parameters: GuardProbeParams,
    execute(_toolCallId, input) {
      const size = typeof input.size === 'number' ? input.size : 16;
      const marker = typeof input.marker === 'string' ? input.marker : 'HUGEPAYLOAD';
      // A repeated marker makes leakage into the transcript unambiguous.
      const unit = marker.padEnd(16, '.');
      const text = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
      return Promise.resolve({
        content: [{ type: 'text' as const, text }],
        details: { bytes: text.length },
      });
    },
  });

  pi.registerTool<typeof GuardImageParams, { bytes: number }>({
    name: 'guard_image_probe',
    label: 'Guard Image Probe',
    description: 'Delegate guard probe that emits image-bearing tool content.',
    parameters: GuardImageParams,
    execute() {
      const data = Buffer.from('IMAGE_SENTINEL_BYTES'.repeat(256), 'utf8').toString('base64');
      return Promise.resolve({
        content: [
          { type: 'text' as const, text: 'image preface' },
          { type: 'image' as const, data, mimeType: 'image/png' },
        ],
        details: { bytes: Buffer.byteLength(data, 'utf8') },
      });
    },
  });

  pi.registerProvider(PROVIDER, {
    name: 'Pi Background Tasks Delegate Guard Provider',
    baseUrl: 'http://localhost:0',
    apiKey: 'UNIPI_BG_DELEGATE_API_KEY',
    api: API,
    models: [
      {
        id: MODEL_ID,
        name: 'Delegate Guard Model',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 4096,
      },
    ],
    streamSimple(_model: Model<Api>, context: Context): AssistantMessageEventStream {
      calls += 1;
      const current = scenario();
      const stream = createAssistantMessageEventStream();
      const call = calls;
      queueMicrotask(() => {
        pushMessage(stream, responseFor(current, call, context));
      });
      return stream;
    },
  });
}

function responseFor(
  current: string,
  call: number,
  context: Context,
): ScriptedAssistantMessage {
  if (current === 'invalid-unicode-tool-result') {
    if (call === 1) {
      return assistant(
        [
          {
            type: 'toolCall',
            id: 'guard-call-invalid-unicode',
            name: 'guard_probe',
            arguments: { size: 16, marker: '\uD800' },
          },
        ],
        'toolUse',
      );
    }
    return assistant([{ type: 'text', text: 'MUST_NOT_COMMIT' }], 'stop');
  }

  if (current === 'intermediate-narration') {
    if (call === 1) {
      return assistant(
        [
          { type: 'text', text: 'INTERMEDIATE_NARRATION_MUST_NOT_BE_COMMITTED' },
          {
            type: 'toolCall',
            id: 'guard-call-narration',
            name: 'guard_probe',
            arguments: { size: 16, marker: 'evidence' },
          },
        ],
        'toolUse',
      );
    }
    return assistant([{ type: 'text', text: 'DELEGATE_FINAL_ANSWER' }], 'stop');
  }

  if (current === 'image-tool-result') {
    if (call === 1) {
      return assistant(
        [
          {
            type: 'toolCall',
            id: 'guard-call-image',
            name: 'guard_image_probe',
            arguments: {},
          },
        ],
        'toolUse',
      );
    }
    return assistant([{ type: 'text', text: 'DELEGATE_FINAL_ANSWER' }], 'stop');
  }

  if (current === 'huge-tool-result') {
    if (call === 1) {
      return assistant(
        [
          {
            type: 'toolCall',
            id: 'guard-call-huge',
            name: 'guard_probe',
            arguments: { size: 2 * 1024 * 1024, marker: 'HUGEPAYLOAD' },
          },
        ],
        'toolUse',
      );
    }
    return assistant([{ type: 'text', text: 'DELEGATE_FINAL_ANSWER' }], 'stop');
  }

  if (current === 'split-utf8-range') {
    if (call === 1) {
      return assistant(
        [
          {
            type: 'toolCall',
            id: 'guard-call-utf8',
            name: 'guard_probe',
            arguments: { size: 2048, marker: 'é' },
          },
        ],
        'toolUse',
      );
    }
    const artifact = findSpillReceiptPath(context);
    if (call === 2 && artifact !== undefined) {
      return assistant(
        [
          {
            type: 'toolCall',
            id: 'guard-call-split-byte',
            name: 'delegate_read_artifact',
            arguments: { artifact, offset: 1, length: 1 },
          },
        ],
        'toolUse',
      );
    }
    return assistant([{ type: 'text', text: 'DELEGATE_FINAL_ANSWER' }], 'stop');
  }

  if (current === 'spill-then-read') {
    if (call === 1) {
      return assistant(
        [
          {
            type: 'toolCall',
            id: 'guard-call-spill',
            name: 'guard_probe',
            arguments: { size: 8192, marker: 'RANGEMARKER' },
          },
        ],
        'toolUse',
      );
    }
    const artifact = findSpillReceiptPath(context);
    if (call === 2 && artifact !== undefined) {
      return assistant(
        [
          {
            type: 'toolCall',
            id: 'guard-call-range',
            name: 'delegate_read_artifact',
            arguments: { artifact, offset: 0, length: 11 },
          },
        ],
        'toolUse',
      );
    }
    if (call === 3 && artifact !== undefined) {
      // Deliberately over-long: the bounded reader must refuse rather than
      // return a short read.
      return assistant(
        [
          {
            type: 'toolCall',
            id: 'guard-call-overlong',
            name: 'delegate_read_artifact',
            arguments: { artifact, offset: 8000, length: 100_000 },
          },
        ],
        'toolUse',
      );
    }
    return assistant([{ type: 'text', text: 'DELEGATE_FINAL_ANSWER' }], 'stop');
  }

  if (current === 'subthreshold-growth') {
    if (call <= 8) {
      return assistant(
        [
          {
            type: 'toolCall',
            id: `guard-call-growth-${String(call)}`,
            name: 'guard_probe',
            arguments: { size: 32 * 1024, marker: `GROWTH${String(call)}` },
          },
        ],
        'toolUse',
      );
    }
    return assistant([{ type: 'text', text: 'DELEGATE_FINAL_ANSWER' }], 'stop');
  }

  if (current === 'truncated-answer') {
    // A response cut short by the output-token limit. Its bytes are intact but
    // the answer is incomplete, so it must never be committed as a result.
    return assistant([{ type: 'text', text: 'PARTIAL ANSWER CUT OFF' }], 'length');
  }

  if (current === 'whitespace-answer') {
    return assistant([{ type: 'text', text: '   \n  ' }], 'stop');
  }

  if (current === 'guard-throw') {
    return assistant([{ type: 'text', text: 'GUARD_THROW_SENTINEL_ANSWER' }], 'stop');
  }

  if (current === 'route-drift') {
    return assistant([{ type: 'text', text: 'DELEGATE_FINAL_ANSWER' }], 'stop', {
      provider: 'someone-else',
      model: 'other-model',
    });
  }

  if (current === 'many-turns') {
    if (call <= 4) {
      return assistant(
        [
          {
            type: 'toolCall',
            id: `guard-call-loop-${String(call)}`,
            name: 'guard_probe',
            arguments: { size: 16, marker: 'LOOP' },
          },
        ],
        'toolUse',
      );
    }
    return assistant([{ type: 'text', text: 'DELEGATE_FINAL_ANSWER' }], 'stop');
  }

  return assistant([{ type: 'text', text: 'DELEGATE_FINAL_ANSWER' }], 'stop');
}
