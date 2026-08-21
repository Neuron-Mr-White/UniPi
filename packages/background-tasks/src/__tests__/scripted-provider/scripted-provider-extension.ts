import { appendFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Api,
  type Message,
  type TextContent,
  type ToolCall,
} from '@earendil-works/pi-ai';

const PROVIDER = 'pi-bg-scripted';
const MODEL_ID = 'scripted-model';
const API = 'pi-bg-scripted-api';
const DEFAULT_USAGE = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type Scenario =
  | 'bg-run-follow-up'
  | 'notify-false'
  | 'wake-false'
  | 'failed-follow-up'
  | 'display-only-bg'
  | 'json-tool-telemetry'
  | 'fusion-reason';
type ScriptedStopReason = 'stop' | 'length' | 'toolUse';

type JsonObject = Record<PropertyKey, unknown>;

interface ScriptedToolCall extends Omit<ToolCall, 'arguments'> {
  arguments: JsonObject;
}

interface ScriptedAssistantMessage extends Omit<AssistantMessage, 'content' | 'stopReason'> {
  content: ScriptedBlock[];
  stopReason: ScriptedStopReason;
}

type ScriptedBlock = TextContent | ScriptedToolCall;

function parseScenario(value: string | undefined): Scenario {
  if (
    value === 'bg-run-follow-up' ||
    value === 'notify-false' ||
    value === 'wake-false' ||
    value === 'failed-follow-up' ||
    value === 'display-only-bg' ||
    value === 'json-tool-telemetry' ||
    value === 'fusion-reason'
  )
    return value;
  return 'bg-run-follow-up';
}

function record(event: JsonObject): void {
  const path = process.env['UNIPI_BG_SCRIPTED_EVENTS'];
  if (!path) return;
  appendFileSync(path, `${JSON.stringify({ ...event, timestamp: Date.now() })}\n`, 'utf8');
}

function text(value: string): TextContent {
  return { type: 'text', text: value };
}

function toolCall(name: string, args: JsonObject, id: string): ScriptedToolCall {
  return { type: 'toolCall', id, name, arguments: args };
}

function assistant(
  content: ScriptedBlock[],
  stopReason: ScriptedStopReason,
): ScriptedAssistantMessage {
  return {
    role: 'assistant',
    content,
    api: API,
    provider: PROVIDER,
    model: MODEL_ID,
    usage: DEFAULT_USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

function shellNode(script: string): string {
  return `node -e ${JSON.stringify(script)}`;
}

function messageText(message: Message): string {
  return typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((part) => ('text' in part ? part.text : part.type)).join(' ')
      : '';
}

function summarizeMessage(message: Message): string {
  const customType =
    'customType' in message && typeof message.customType === 'string'
      ? message.customType
      : undefined;
  const toolName =
    'toolName' in message && typeof message.toolName === 'string' ? message.toolName : undefined;
  return [message.role, customType, toolName, messageText(message)]
    .filter(Boolean)
    .join(':')
    .slice(0, 500);
}

interface EventDrivenContractCheck {
  readonly systemPrompt: boolean;
  readonly toolDescriptions: boolean;
  readonly launchReceipt: boolean;
}

function inspectEventDrivenContract(context: Context): EventDrivenContractCheck {
  const systemPrompt = context.systemPrompt ?? '';
  const toolDescription = (name: string): string =>
    context.tools?.find((tool) => tool.name === name)?.description ?? '';
  const bgRunResult = context.messages
    .filter(
      (message) =>
        message.role === 'toolResult' && 'toolName' in message && message.toolName === 'bg_run',
    )
    .map(messageText)
    .at(-1);
  return {
    systemPrompt:
      systemPrompt.includes('Do not call sleep, bg_status, or bg_logs merely to wait') &&
      systemPrompt.includes('automatically starts a follow-up agent turn') &&
      systemPrompt.includes('A running result is not an instruction to poll again') &&
      !systemPrompt.includes('After bg_run, use bg_status and bg_logs to inspect progress'),
    toolDescriptions:
      toolDescription('bg_run').includes('do not sleep or poll merely to wait') &&
      toolDescription('bg_status').includes('not a waiting primitive') &&
      toolDescription('bg_logs').includes('not a waiting primitive'),
    launchReceipt:
      bgRunResult?.includes('Terminal notification: enabled.') === true &&
      bgRunResult.includes('Automatic follow-up turn: enabled.') &&
      bgRunResult.includes('Next action: do not poll or sleep'),
  };
}

function responseFor(
  scenario: Scenario,
  callCount: number,
  contract: EventDrivenContractCheck,
  context: Context,
): ScriptedAssistantMessage {
  if (scenario === 'fusion-reason') {
    if (callCount === 1) {
      return assistant(
        [toolCall('fusion_reason', { prompt: 'scripted fusion prompt' }, 'call-fusion-reason')],
        'toolUse',
      );
    }
    if (callCount === 2) {
      return assistant(
        [text('Fusion launched; waiting for its terminal notification without polling.')],
        'stop',
      );
    }
    if (callCount === 3) {
      const transcript = context.messages.map(messageText).join('\n');
      const match =
        /<task-id>((?:reason|investigate|research|validate)-[0-9a-f]{32})<\/task-id>/u.exec(
          transcript,
        );
      if (match?.[1] === undefined) {
        return assistant([text('Fusion terminal notification did not contain a task id.')], 'stop');
      }
      return assistant(
        [toolCall('bg_result', { taskId: match[1], delivery: 'inline' }, 'call-fusion-result')],
        'toolUse',
      );
    }
    return assistant([text('Parent observed verified Fusion result from bg_result.')], 'stop');
  }

  if (scenario === 'json-tool-telemetry') {
    if (callCount === 1) {
      return assistant(
        [
          toolCall('scripted_echo', { value: 'ok' }, 'call-scripted-ok'),
          toolCall('scripted_echo', { value: 'fail', fail: true }, 'call-scripted-fail'),
        ],
        'toolUse',
      );
    }
    return assistant([text('JSON tool telemetry complete.')], 'stop');
  }

  if (scenario === 'bg-run-follow-up') {
    if (callCount === 1) {
      return assistant(
        [
          toolCall(
            'bg_run',
            {
              name: 'Scripted Wakeup',
              command: shellNode(
                "setTimeout(() => { console.log('scripted wakeup done'); }, 150);",
              ),
              isAgent: false,
              notifyOnCompletion: true,
            },
            'call-bg-run-wakeup',
          ),
        ],
        'toolUse',
      );
    }
    if (callCount === 2) {
      if (!contract.systemPrompt || !contract.toolDescriptions || !contract.launchReceipt) {
        return assistant([toolCall('bg_status', {}, 'call-bug-181-regressive-poll')], 'toolUse');
      }
      return assistant(
        [text('Initial bg_run tool turn yielded without polling for the terminal event.')],
        'stop',
      );
    }
    return assistant(
      [text('Follow-up turn observed background-task-notification for Scripted Wakeup.')],
      'stop',
    );
  }

  if (scenario === 'notify-false') {
    if (callCount === 1) {
      return assistant(
        [
          toolCall(
            'bg_run',
            {
              name: 'No Notify Scripted',
              command: shellNode("setTimeout(() => { console.log('quiet done'); }, 80);"),
              isAgent: false,
              notifyOnCompletion: false,
              triggerOnCompletion: true,
            },
            'call-bg-run-no-notify',
          ),
        ],
        'toolUse',
      );
    }
    return assistant([text('No-notify initial turn finished.')], 'stop');
  }

  if (scenario === 'wake-false') {
    if (callCount === 1) {
      return assistant(
        [
          toolCall(
            'bg_run',
            {
              name: 'No Wake Scripted',
              command: shellNode("setTimeout(() => { console.log('notify only done'); }, 80);"),
              isAgent: false,
              notifyOnCompletion: true,
              triggerOnCompletion: false,
            },
            'call-bg-run-no-wake',
          ),
        ],
        'toolUse',
      );
    }
    return assistant([text('Notification-only initial turn finished.')], 'stop');
  }

  if (scenario === 'failed-follow-up') {
    if (callCount === 1) {
      return assistant(
        [
          toolCall(
            'bg_run',
            {
              name: 'Failing Scripted',
              command: shellNode(
                "setTimeout(() => { console.error('scripted failure'); process.exit(7); }, 80);",
              ),
              isAgent: false,
              notifyOnCompletion: true,
            },
            'call-bg-run-failed',
          ),
        ],
        'toolUse',
      );
    }
    if (callCount === 2) return assistant([text('Failing task initial turn finished.')], 'stop');
    return assistant(
      [text('Follow-up turn observed failed background task notification.')],
      'stop',
    );
  }

  return assistant([text(`Display-only scenario provider call ${String(callCount)}.`)], 'stop');
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
    const json = JSON.stringify(block.arguments);
    stream.push({ type: 'toolcall_delta', contentIndex, delta: json, partial: { ...partial } });
    partialToolCall.arguments = block.arguments;
    stream.push({ type: 'toolcall_end', contentIndex, toolCall: block, partial: { ...partial } });
  });
  stream.push({ type: 'done', reason: message.stopReason, message });
  stream.end(message);
}

export default function scriptedProviderExtension(pi: ExtensionAPI): void {
  let callCount = 0;
  const scenario = parseScenario(process.env['UNIPI_BG_SCRIPTED_SCENARIO']);

  const ScriptedEchoParams = {
    type: 'object',
    properties: {
      value: { type: 'string' },
      fail: { type: 'boolean' },
    },
    additionalProperties: false,
  } as const;
  pi.registerTool<typeof ScriptedEchoParams, { value: string }>({
    name: 'scripted_echo',
    label: 'Scripted Echo',
    description: 'Test-only deterministic scripted provider tool',
    parameters: ScriptedEchoParams,
    execute(_toolCallId, input) {
      if (input.fail) return Promise.reject(new Error('scripted echo failed intentionally'));
      return Promise.resolve({
        content: [{ type: 'text' as const, text: input.value ?? 'ok' }],
        details: { value: input.value ?? 'ok' },
      });
    },
  });

  pi.registerProvider(PROVIDER, {
    name: 'Pi Background Tasks Scripted Provider',
    baseUrl: 'http://localhost:0',
    apiKey: 'UNIPI_BG_SCRIPTED_API_KEY',
    api: API,
    models: [
      {
        id: MODEL_ID,
        name: 'Scripted Model',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 272_000,
        maxTokens: 4096,
      },
    ],
    streamSimple(_model: Model<Api>, context: Context): AssistantMessageEventStream {
      callCount += 1;
      const eventDrivenContract = inspectEventDrivenContract(context);
      record({
        type: 'provider_call',
        scenario,
        callCount,
        eventDrivenContract,
        roles: context.messages.map((message) => message.role),
        customTypes: context.messages.flatMap((message) =>
          'customType' in message && typeof message.customType === 'string'
            ? [message.customType]
            : [],
        ),
        lastRole: context.messages.at(-1)?.role,
        summaries: context.messages.map(summarizeMessage),
      });
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        pushMessage(stream, responseFor(scenario, callCount, eventDrivenContract, context));
      });
      return stream;
    },
  });
}
