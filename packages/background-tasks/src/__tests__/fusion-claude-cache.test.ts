import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { streamSimple as streamSimpleAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages';
import type { Context, Model } from '@earendil-works/pi-ai';
import { isJsonObject, type JsonObject } from '../types.js';
import { rewriteAnthropicRequestPayload } from '../anthropic-attribution.js';
import {
  FUSION_CLAUDE_CACHE_BREAKPOINT_LIMIT,
  FUSION_CLAUDE_CACHE_OBSERVATION_SCHEMA_VERSION,
  FUSION_CLAUDE_CACHE_RETENTION_ENV,
  FUSION_CLAUDE_PROMPT_CACHING_SCOPE_BETA,
  applyFusionClaudePromptCachingScopeHeader,
  nonAnthropicFusionCacheObservation,
  normalizeFusionClaudeCachePayload,
  resolveFusionClaudeCachePolicy,
  type FusionClaudeCacheNormalization,
} from '../fusion/claude-cache.js';

const SHORT = { type: 'ephemeral' } as const;
const LONG = { type: 'ephemeral', ttl: '1h' } as const;

function controls(payload: JsonObject): unknown[] {
  const found: unknown[] = [];
  const inspect = (value: unknown): void => {
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.hasOwn(value, 'cache_control')
    ) {
      found.push(Reflect.get(value, 'cache_control'));
    }
  };
  if (Array.isArray(payload['system'])) payload['system'].forEach(inspect);
  if (Array.isArray(payload['tools'])) payload['tools'].forEach(inspect);
  if (Array.isArray(payload['messages'])) {
    for (const message of payload['messages']) {
      if (!isJsonObject(message)) continue;
      const content = message['content'];
      if (Array.isArray(content)) content.forEach(inspect);
    }
  }
  return found;
}

function nativePayload(): JsonObject {
  return {
    model: 'claude-opus-4-8',
    system: [
      { type: 'text', text: 'Claude Code identity', cache_control: SHORT },
      { type: 'text', text: 'Fusion system', cache_control: SHORT },
    ],
    tools: [{ name: 'read', input_schema: {}, cache_control: SHORT }],
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'request', cache_control: SHORT }],
      },
    ],
  };
}

void describe('Fusion Claude cache policy', () => {
  void it('defaults to one hour and upgrades only Pi-selected native breakpoints', () => {
    const original = nativePayload();
    const normalized = normalizeFusionClaudeCachePayload({
      payload: original,
      requestOrdinal: 3,
      env: {},
    });

    assert.deepEqual(resolveFusionClaudeCachePolicy({}), {
      retention: 'long',
      source: 'default',
    });
    assert.equal(
      normalized.observation.schema_version,
      FUSION_CLAUDE_CACHE_OBSERVATION_SCHEMA_VERSION,
    );
    assert.equal(normalized.observation.requested_retention, 'long');
    assert.equal(normalized.observation.effective_retention, 'long');
    assert.equal(normalized.observation.breakpoint_count, FUSION_CLAUDE_CACHE_BREAKPOINT_LIMIT);
    assert.equal(normalized.observation.request_ordinal, 3);
    assert.deepEqual(controls(normalized.payload), [LONG, LONG, LONG, LONG]);
    assert.deepEqual(controls(original), [SHORT, SHORT, SHORT, SHORT]);
  });

  void it("upgrades the exact four breakpoints emitted by Pi's OAuth Anthropic adapter", async () => {
    const model: Model<'anthropic-messages'> = {
      id: 'claude-opus-4-8',
      name: 'Claude Opus 4.8',
      api: 'anthropic-messages',
      provider: 'anthropic',
      baseUrl: 'http://127.0.0.1:1',
      reasoning: false,
      input: ['text'],
      cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    };
    const context: Context = {
      systemPrompt: 'Fusion system',
      messages: [{ role: 'user', content: 'request', timestamp: 1 }],
      tools: [
        {
          name: 'read',
          description: 'Read a file',
          parameters: Type.Object({ path: Type.String() }),
        },
      ],
    };
    let incoming: unknown;
    let normalized: FusionClaudeCacheNormalization | undefined;
    const stream = streamSimpleAnthropic(model, context, {
      apiKey: 'sk-ant-oat-test-token',
      env: {},
      onPayload(payload) {
        incoming = payload;
        normalized = normalizeFusionClaudeCachePayload({
          payload,
          requestOrdinal: 1,
          env: {},
        });
        throw new Error('cache payload captured before transport');
      },
    });
    const result = await stream.result();

    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage ?? '', /captured before transport/);
    assert.ok(isJsonObject(incoming));
    assert.deepEqual(controls(incoming), [SHORT, SHORT, SHORT, SHORT]);
    assert.ok(normalized);
    assert.deepEqual(controls(normalized.payload), [LONG, LONG, LONG, LONG]);
  });

  void it('has Pi create one-hour breakpoints when Fusion sets the child policy env', async () => {
    const model: Model<'anthropic-messages'> = {
      id: 'claude-opus-4-8',
      name: 'Claude Opus 4.8',
      api: 'anthropic-messages',
      provider: 'anthropic',
      baseUrl: 'http://127.0.0.1:1',
      reasoning: false,
      input: ['text'],
      cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    };
    const context: Context = {
      systemPrompt: 'Fusion system',
      messages: [{ role: 'user', content: 'request', timestamp: 1 }],
      tools: [
        {
          name: 'read',
          description: 'Read a file',
          parameters: Type.Object({ path: Type.String() }),
        },
      ],
    };
    let payload: unknown;
    const stream = streamSimpleAnthropic(model, context, {
      apiKey: 'sk-ant-oat-test-token',
      env: { [FUSION_CLAUDE_CACHE_RETENTION_ENV]: 'long' },
      onPayload(value) {
        payload = value;
        throw new Error('native long cache payload captured before transport');
      },
    });
    const result = await stream.result();

    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage ?? '', /captured before transport/);
    assert.ok(isJsonObject(payload));
    assert.deepEqual(controls(payload), [LONG, LONG, LONG, LONG]);
  });

  void it('preserves the provider call-level none posture through attribution rewrite', () => {
    const payload: JsonObject = {
      model: 'claude-opus-4-8',
      system: [{ type: 'text', text: 'compaction system' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'summarize' }] }],
    };
    const rewritten = rewriteAnthropicRequestPayload({
      payload,
      ctx: {
        model: { provider: 'anthropic', id: 'claude-opus-4-8' },
        sessionManager: {
          getSessionId: () => '11111111-2222-4333-8444-555555555555',
          getBranch: () => [],
        },
      },
      account: {
        deviceId: 'd'.repeat(64),
        accountUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      },
      env: { [FUSION_CLAUDE_CACHE_RETENTION_ENV]: 'long' },
    });

    assert.ok(isJsonObject(rewritten));
    assert.deepEqual(controls(rewritten), []);
  });

  void it('adds the subscription prompt-caching scope beta exactly once', () => {
    const headers: Record<string, string | null> = {
      'Anthropic-Beta': 'claude-code-20250219,oauth-2025-04-20',
    };
    assert.equal(applyFusionClaudePromptCachingScopeHeader(headers), true);
    assert.equal(applyFusionClaudePromptCachingScopeHeader(headers), true);
    assert.equal(
      headers['Anthropic-Beta'],
      `claude-code-20250219,oauth-2025-04-20,${FUSION_CLAUDE_PROMPT_CACHING_SCOPE_BETA}`,
    );

    const empty: Record<string, string | null> = {};
    applyFusionClaudePromptCachingScopeHeader(empty);
    assert.equal(empty['anthropic-beta'], FUSION_CLAUDE_PROMPT_CACHING_SCOPE_BETA);
  });

  void it('supports explicit short and none without adding new breakpoints', () => {
    const short = normalizeFusionClaudeCachePayload({
      payload: {
        ...nativePayload(),
        system: [{ type: 'text', text: 'system', cache_control: LONG }],
      },
      requestOrdinal: 1,
      env: { [FUSION_CLAUDE_CACHE_RETENTION_ENV]: 'short' },
    });
    assert.equal(short.observation.source, FUSION_CLAUDE_CACHE_RETENTION_ENV);
    assert.equal(short.observation.effective_retention, 'short');
    assert.deepEqual(controls(short.payload), [SHORT, SHORT, SHORT]);

    const disabled = normalizeFusionClaudeCachePayload({
      payload: nativePayload(),
      requestOrdinal: 1,
      env: { [FUSION_CLAUDE_CACHE_RETENTION_ENV]: 'none' },
    });
    assert.equal(disabled.observation.requested_retention, 'none');
    assert.equal(disabled.observation.effective_retention, 'none');
    assert.equal(disabled.observation.breakpoint_count, 0);
    assert.deepEqual(controls(disabled.payload), []);

    const compaction = normalizeFusionClaudeCachePayload({
      payload: { model: 'claude-opus-4-8', system: [{ type: 'text', text: 'summary' }] },
      requestOrdinal: 2,
      env: {},
    });
    assert.equal(compaction.observation.requested_retention, 'long');
    assert.equal(compaction.observation.effective_retention, 'none');
    assert.deepEqual(controls(compaction.payload), []);
  });

  void it('falls back to short when the active model rejects long retention', () => {
    const normalized = normalizeFusionClaudeCachePayload({
      payload: nativePayload(),
      requestOrdinal: 1,
      env: {},
      supportsLongCacheRetention: false,
    });
    assert.equal(normalized.observation.requested_retention, 'long');
    assert.equal(normalized.observation.effective_retention, 'short');
    assert.deepEqual(controls(normalized.payload), [SHORT, SHORT, SHORT, SHORT]);
  });

  void it('rejects malformed policy, controls, ordinals, and excess breakpoints', () => {
    assert.throws(
      () =>
        resolveFusionClaudeCachePolicy({
          [FUSION_CLAUDE_CACHE_RETENTION_ENV]: 'forever',
        }),
      /must be one of none, short, or long/,
    );
    assert.throws(
      () =>
        normalizeFusionClaudeCachePayload({
          payload: { system: [{ cache_control: { type: 'forever' } }] },
          requestOrdinal: 1,
          env: {},
        }),
      /cache_control\.type/,
    );
    assert.throws(
      () =>
        normalizeFusionClaudeCachePayload({
          payload: {},
          requestOrdinal: 0,
          env: {},
        }),
      /positive safe integer/,
    );
    assert.throws(
      () =>
        normalizeFusionClaudeCachePayload({
          payload: {
            system: Array.from({ length: 5 }, () => ({
              type: 'text',
              text: 'x',
              cache_control: SHORT,
            })),
          },
          requestOrdinal: 1,
          env: {},
        }),
      /at most 4/,
    );
  });

  void it('emits a closed not-applicable observation for non-Anthropic routes', () => {
    assert.deepEqual(nonAnthropicFusionCacheObservation(7), {
      schema_version: FUSION_CLAUDE_CACHE_OBSERVATION_SCHEMA_VERSION,
      applicability: 'not_applicable',
      source: 'not_applicable',
      requested_retention: null,
      effective_retention: null,
      breakpoint_count: 0,
      request_ordinal: 7,
    });
  });
});
