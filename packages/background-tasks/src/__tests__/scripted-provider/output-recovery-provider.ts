import { appendFileSync, writeFileSync } from 'node:fs';
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
} from '@earendil-works/pi-ai';
import { FUSION_CANDIDATE_OUTPUT_COMPRESSION_PROMPT } from '../../fusion/output-contract.js';

export const OUTPUT_RECOVERY_PROVIDER = 'pi-bg-output-recovery';
export const OUTPUT_RECOVERY_MODEL = 'output-recovery-model';
const API = 'pi-bg-output-recovery-api';
export const OUTPUT_RECOVERY_ORIGINAL = 'x'.repeat(49_152);
export const OUTPUT_RECOVERY_REPLACEMENT = 'compressed replacement';

interface OutputRecoveryLogEvent {
  event: 'provider_call' | 'agent_settled';
  pid: number;
  calls?: number;
  call?: number;
  roles?: string[];
  tools?: string[];
  saw_original?: boolean;
  saw_compression_prompt?: boolean;
}

function record(value: OutputRecoveryLogEvent): void {
  const path = process.env['UNIPI_BG_OUTPUT_RECOVERY_LOG'];
  if (path) appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

function messageText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.map((part) => ('text' in part ? part.text : '')).join('');
}

function pushText(stream: AssistantMessageEventStream, text: string): void {
  const usage = {
    input: 10,
    output: text.length,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 10 + text.length,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const message: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: API,
    provider: OUTPUT_RECOVERY_PROVIDER,
    model: OUTPUT_RECOVERY_MODEL,
    usage,
    stopReason: 'stop',
    timestamp: Date.now(),
  };
  const partial: AssistantMessage = { ...message, content: [] };
  const partialText: TextContent = { type: 'text', text: '' };
  stream.push({ type: 'start', partial: { ...partial } });
  partial.content = [partialText];
  stream.push({ type: 'text_start', contentIndex: 0, partial: { ...partial } });
  partialText.text = text;
  stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: { ...partial } });
  stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: { ...partial } });
  stream.push({ type: 'done', reason: 'stop', message });
  stream.end(message);
}

const RecoveryProbeParams = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

export default function outputRecoveryProvider(pi: ExtensionAPI): void {
  let calls = 0;
  let recoveryQueued = false;

  pi.registerTool<typeof RecoveryProbeParams, Record<string, never>>({
    name: 'recovery_probe',
    label: 'Recovery Probe',
    description: 'Test-only tool used to prove that output compression disables tools.',
    parameters: RecoveryProbeParams,
    execute() {
      return Promise.resolve({ content: [{ type: 'text' as const, text: 'unused' }], details: {} });
    },
  });

  pi.on('message_end', (event) => {
    if (event.message.role !== 'assistant' || recoveryQueued) return;
    const text = event.message.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('');
    if (text !== OUTPUT_RECOVERY_ORIGINAL) return;
    const recoveryPath = process.env['UNIPI_BG_OUTPUT_RECOVERY_ARTIFACT'];
    if (!recoveryPath) throw new Error('UNIPI_BG_OUTPUT_RECOVERY_ARTIFACT is required');
    writeFileSync(recoveryPath, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    recoveryQueued = true;
    pi.setActiveTools([]);
    pi.sendUserMessage(FUSION_CANDIDATE_OUTPUT_COMPRESSION_PROMPT, {
      deliverAs: 'followUp',
    });
  });

  // OUR SDK lacks agent_settled; agent_end carries the same end-of-run signal for probes.
  pi.on('agent_end', () => {
    record({ event: 'agent_settled', pid: process.pid, calls });
  });

  pi.registerProvider(OUTPUT_RECOVERY_PROVIDER, {
    name: 'Pi Background Tasks Output Recovery Provider',
    baseUrl: 'http://localhost:0',
    apiKey: 'UNIPI_BG_OUTPUT_RECOVERY_API_KEY',
    api: API,
    models: [
      {
        id: OUTPUT_RECOVERY_MODEL,
        name: 'Output Recovery Model',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 64_000,
      },
    ],
    streamSimple(_model: Model<Api>, context: Context): AssistantMessageEventStream {
      calls += 1;
      const texts = context.messages.map(messageText);
      const tools = Array.isArray(context.tools) ? context.tools.map((tool) => tool.name) : [];
      record({
        event: 'provider_call',
        pid: process.pid,
        call: calls,
        roles: context.messages.map((message) => message.role),
        tools,
        saw_original: texts.includes(OUTPUT_RECOVERY_ORIGINAL),
        saw_compression_prompt: texts.some((text) =>
          text.includes('Compress and restructure only your immediately previous answer'),
        ),
      });
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        pushText(stream, calls === 1 ? OUTPUT_RECOVERY_ORIGINAL : OUTPUT_RECOVERY_REPLACEMENT);
      });
      return stream;
    },
  });
}
