import { appendFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const RUNTIME_GUARD_PROVIDER = 'pi-bg-runtime-guard';
export const RUNTIME_GUARD_MODEL = 'runtime-guard-model';
export const RUNTIME_GUARD_MARKER = 'MUTATOR_RAN_BEFORE_GOVERNOR';

function record(value: Record<string, unknown>): void {
  const path = process.env['UNIPI_BG_RUNTIME_GUARD_LOG'];
  if (path) appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

export default function runtimeGuardProvider(pi: ExtensionAPI): void {
  const baseUrl = process.env['UNIPI_BG_RUNTIME_GUARD_BASE_URL'];
  if (!baseUrl) throw new Error('UNIPI_BG_RUNTIME_GUARD_BASE_URL is required');

  pi.registerProvider(RUNTIME_GUARD_PROVIDER, {
    name: 'Pi Background Tasks Runtime Guard Probe',
    baseUrl,
    apiKey: '$UNIPI_BG_RUNTIME_GUARD_API_KEY',
    // Exercise the same Pi transport adapter used by Fusion's subscription Codex routes.
    api: 'openai-codex-responses',
    models: [
      {
        id: RUNTIME_GUARD_MODEL,
        name: 'Runtime Guard Model',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 4_096,
      },
    ],
  });

  // This extension deliberately loads before the governor probe. The test proves
  // before_provider_request handlers form a payload-transform chain in load order.
  pi.on('before_provider_request', (event) => {
    record({ hook: 'mutator', payload_type: typeof event.payload });
    if (
      typeof event.payload !== 'object' ||
      event.payload === null ||
      Array.isArray(event.payload)
    ) {
      throw new Error('runtime guard provider payload must be an object');
    }
    return { ...event.payload, pi_bg_runtime_guard_marker: RUNTIME_GUARD_MARKER };
  });
}
