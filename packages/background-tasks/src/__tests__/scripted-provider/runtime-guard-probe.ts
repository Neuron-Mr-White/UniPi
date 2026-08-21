import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { RUNTIME_GUARD_MARKER } from './runtime-guard-provider.js';

function record(value: Record<string, unknown>): void {
  const path = process.env['UNIPI_BG_RUNTIME_GUARD_LOG'];
  if (path) appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

export default function runtimeGuardProbe(pi: ExtensionAPI): void {
  pi.on('before_provider_request', (event, ctx) => {
    const serialized = JSON.stringify(event.payload);
    if (serialized === undefined)
      throw new Error('runtime guard probe payload serialized to undefined');
    const payload = event.payload as Record<string, unknown>;
    record({
      hook: 'governor',
      marker_seen: payload['pi_bg_runtime_guard_marker'] === RUNTIME_GUARD_MARKER,
      payload_bytes: Buffer.byteLength(serialized, 'utf8'),
      payload_sha256: createHash('sha256').update(serialized, 'utf8').digest('hex'),
      provider: ctx.model?.provider,
      model: ctx.model?.id,
    });
    ctx.abort();
    return event.payload;
  });
}
