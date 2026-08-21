import { appendFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Instrumented probe extension used by the Pi hook-contract characterisation
 * gate. Its behaviour is selected by `UNIPI_BG_HOOK_PROBE_MODE` so one extension
 * body can answer every question the delegate child-side guard depends on.
 */
export type HookProbeMode =
  | 'observe'
  | 'context-replace'
  | 'context-throw'
  | 'context-abort'
  | 'tool-result-replace';

type JsonObject = Record<PropertyKey, unknown>;

export const HOOK_PROBE_INJECTED_TEXT = 'HOOK_PROBE_INJECTED_CONTEXT_MESSAGE';
export const HOOK_PROBE_REPLACED_TOOL_TEXT = 'HOOK_PROBE_REPLACED_TOOL_RESULT';

function record(event: JsonObject): void {
  const path = process.env['UNIPI_BG_HOOK_PROBE_LOG'];
  if (!path) return;
  appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8');
}

function mode(): HookProbeMode {
  const value = process.env['UNIPI_BG_HOOK_PROBE_MODE'];
  if (
    value === 'context-replace' ||
    value === 'context-throw' ||
    value === 'context-abort' ||
    value === 'tool-result-replace'
  )
    return value;
  return 'observe';
}

interface ContentPartLike {
  readonly type: string;
  readonly text?: unknown;
}

function messageText(message: object): string {
  const content: unknown = Reflect.get(message, 'content');
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: readonly ContentPartLike[] = content.filter(
    (part): part is ContentPartLike =>
      typeof part === 'object' && part !== null && typeof Reflect.get(part, 'type') === 'string',
  );
  return parts.map((part) => (typeof part.text === 'string' ? part.text : `<${part.type}>`)).join('');
}

/**
 * Build the probe extension factory for one probe identity. Two distinct probe
 * modules share this body so handler ordering across separate extensions can be
 * observed directly.
 */
export function createHookProbeExtension(probeId: string): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI): void => {
    let contextFires = 0;
    let toolResultFires = 0;

    pi.on('context', (event, ctx) => {
      contextFires += 1;
      record({
        hook: 'context',
        probeId,
        contextFires,
        roles: event.messages.map((message) => message.role),
        texts: event.messages.map(messageText),
      });
      const selected = mode();
      if (selected === 'context-throw' && probeId === 'probe-a') {
        record({ hook: 'context_throwing', probeId });
        throw new Error('HOOK_PROBE_CONTEXT_THROW');
      }
      if (selected === 'context-abort' && probeId === 'probe-a') {
        record({ hook: 'context_aborting', probeId });
        ctx.abort();
        return undefined;
      }
      if (selected === 'context-replace' && probeId === 'probe-a') {
        return {
          messages: [
            ...event.messages,
            { role: 'user', content: HOOK_PROBE_INJECTED_TEXT, timestamp: Date.now() },
          ],
        };
      }
      return undefined;
    });

    pi.on('tool_result', (event) => {
      toolResultFires += 1;
      record({
        hook: 'tool_result',
        probeId,
        toolResultFires,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        isError: event.isError,
        texts: event.content.map((part) => (part.type === 'text' ? part.text : `<${part.type}>`)),
      });
      if (mode() === 'tool-result-replace' && probeId === 'probe-a') {
        return { content: [{ type: 'text' as const, text: HOOK_PROBE_REPLACED_TOOL_TEXT }] };
      }
      return undefined;
    });

    pi.on('tool_execution_end', (event) => {
      record({
        hook: 'tool_execution_end',
        probeId,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        isError: event.isError,
      });
    });

    pi.on('message_end', (event) => {
      record({ hook: 'message_end', probeId, role: event.message.role });
    });
  };
}
