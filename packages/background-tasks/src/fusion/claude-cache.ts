import type { JsonObject } from '../types.js';

export const FUSION_CLAUDE_CACHE_OBSERVATION_SCHEMA_VERSION =
  'pi-background-tasks.fusion-claude-cache-observation.v1' as const;
export const FUSION_CLAUDE_CACHE_RETENTION_ENV = 'PI_CACHE_RETENTION';
export const FUSION_CLAUDE_CACHE_DEFAULT_RETENTION = 'long' as const;
export const FUSION_CLAUDE_CACHE_BREAKPOINT_LIMIT = 4;
export const FUSION_CLAUDE_PROMPT_CACHING_SCOPE_BETA = 'prompt-caching-scope-2026-01-05' as const;

export type FusionClaudeCacheRetention = 'none' | 'short' | 'long';
export type FusionClaudeCachePolicySource =
  | 'default'
  | typeof FUSION_CLAUDE_CACHE_RETENTION_ENV
  | 'not_applicable';

export interface FusionClaudeCacheObservation {
  schema_version: typeof FUSION_CLAUDE_CACHE_OBSERVATION_SCHEMA_VERSION;
  applicability: 'anthropic' | 'not_applicable';
  source: FusionClaudeCachePolicySource;
  requested_retention: FusionClaudeCacheRetention | null;
  effective_retention: FusionClaudeCacheRetention | null;
  breakpoint_count: number;
  request_ordinal: number;
}

export interface FusionClaudeCacheNormalization {
  payload: JsonObject;
  observation: FusionClaudeCacheObservation;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? (value as unknown[]) : undefined;
}

function requireRequestOrdinal(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Fusion Claude cache request ordinal must be a positive safe integer');
  }
  return value;
}

function parseRetention(value: string): FusionClaudeCacheRetention {
  if (value === 'none' || value === 'short' || value === 'long') return value;
  throw new Error(
    `${FUSION_CLAUDE_CACHE_RETENTION_ENV} must be one of none, short, or long; got ${JSON.stringify(value)}`,
  );
}

export function resolveFusionClaudeCachePolicy(env: Readonly<NodeJS.ProcessEnv> = process.env): {
  retention: FusionClaudeCacheRetention;
  source: FusionClaudeCachePolicySource;
} {
  const configured = env[FUSION_CLAUDE_CACHE_RETENTION_ENV];
  if (configured === undefined) {
    return { retention: FUSION_CLAUDE_CACHE_DEFAULT_RETENTION, source: 'default' };
  }
  return {
    retention: parseRetention(configured),
    source: FUSION_CLAUDE_CACHE_RETENTION_ENV,
  };
}

export function applyFusionClaudePromptCachingScopeHeader(
  headers: Record<string, string | null>,
): boolean {
  const matchingKey = Object.keys(headers).find((key) => key.toLowerCase() === 'anthropic-beta');
  const existing = matchingKey === undefined ? undefined : headers[matchingKey];
  const values =
    typeof existing === 'string'
      ? existing
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
      : [];
  if (!values.includes(FUSION_CLAUDE_PROMPT_CACHING_SCOPE_BETA)) {
    values.push(FUSION_CLAUDE_PROMPT_CACHING_SCOPE_BETA);
  }
  const targetKey = matchingKey ?? 'anthropic-beta';
  headers[targetKey] = values.join(',');
  return true;
}

function validateCacheControl(value: unknown): JsonObject {
  if (!isRecord(value)) {
    throw new Error('Fusion Claude cache_control must be an object');
  }
  if (value['type'] !== 'ephemeral') {
    throw new Error('Fusion Claude cache_control.type must be "ephemeral"');
  }
  const ttl = value['ttl'];
  if (ttl !== undefined && ttl !== '1h' && ttl !== '5m') {
    throw new Error('Fusion Claude cache_control.ttl must be "1h" or "5m" when present');
  }
  return value;
}

/**
 * Normalize only cache breakpoints already selected by Pi's Anthropic adapter.
 *
 * Not creating new breakpoints is deliberate: an empty marker set may represent
 * Pi's explicit cacheRetention="none" compaction request or a model compatibility
 * restriction. The package may strengthen or disable native markers, but it must
 * not override an upstream call-level opt-out that is no longer visible in the
 * final provider payload.
 */
export function normalizeFusionClaudeCachePayload(input: {
  payload: unknown;
  requestOrdinal: number;
  env?: Readonly<NodeJS.ProcessEnv>;
  supportsLongCacheRetention?: boolean | undefined;
}): FusionClaudeCacheNormalization {
  if (!isRecord(input.payload)) {
    throw new Error('Fusion Claude provider payload must be an object');
  }
  const requestOrdinal = requireRequestOrdinal(input.requestOrdinal);
  const policy = resolveFusionClaudeCachePolicy(input.env ?? process.env);
  const normalizedRetention: FusionClaudeCacheRetention =
    policy.retention === 'long' && input.supportsLongCacheRetention === false
      ? 'short'
      : policy.retention;
  let incomingBreakpoints = 0;
  let outputBreakpoints = 0;

  const normalizeBlock = (value: unknown): unknown => {
    if (!isRecord(value) || !Object.hasOwn(value, 'cache_control')) return value;
    const existing = value['cache_control'];
    if (existing === undefined) {
      const next = { ...value };
      Reflect.deleteProperty(next, 'cache_control');
      return next;
    }
    incomingBreakpoints += 1;
    if (incomingBreakpoints > FUSION_CLAUDE_CACHE_BREAKPOINT_LIMIT) {
      throw new Error(
        `Fusion Claude payload has ${String(incomingBreakpoints)} cache_control breakpoints; Anthropic supports at most ${String(FUSION_CLAUDE_CACHE_BREAKPOINT_LIMIT)}`,
      );
    }
    const control = validateCacheControl(existing);
    const next = { ...value };
    if (normalizedRetention === 'none') {
      Reflect.deleteProperty(next, 'cache_control');
      return next;
    }
    const normalizedControl = { ...control, type: 'ephemeral' };
    Reflect.deleteProperty(normalizedControl, 'ttl');
    if (normalizedRetention === 'long') Object.assign(normalizedControl, { ttl: '1h' });
    next['cache_control'] = normalizedControl;
    outputBreakpoints += 1;
    return next;
  };

  const system = unknownArray(input.payload['system']);
  const tools = unknownArray(input.payload['tools']);
  const messages = unknownArray(input.payload['messages']);
  const payload = {
    ...input.payload,
    ...(system === undefined ? {} : { system: system.map(normalizeBlock) }),
    ...(tools === undefined ? {} : { tools: tools.map(normalizeBlock) }),
    ...(messages === undefined
      ? {}
      : {
          messages: messages.map((message) => {
            if (!isRecord(message)) return message;
            const content = unknownArray(message['content']);
            return content === undefined
              ? message
              : { ...message, content: content.map(normalizeBlock) };
          }),
        }),
  };
  if (outputBreakpoints > FUSION_CLAUDE_CACHE_BREAKPOINT_LIMIT) {
    throw new Error(
      `Fusion Claude payload produced ${String(outputBreakpoints)} cache_control breakpoints; Anthropic supports at most ${String(FUSION_CLAUDE_CACHE_BREAKPOINT_LIMIT)}`,
    );
  }

  return {
    payload,
    observation: {
      schema_version: FUSION_CLAUDE_CACHE_OBSERVATION_SCHEMA_VERSION,
      applicability: 'anthropic',
      source: policy.source,
      requested_retention: policy.retention,
      effective_retention: outputBreakpoints === 0 ? 'none' : normalizedRetention,
      breakpoint_count: outputBreakpoints,
      request_ordinal: requestOrdinal,
    },
  };
}

export function nonAnthropicFusionCacheObservation(
  requestOrdinal: number,
): FusionClaudeCacheObservation {
  return {
    schema_version: FUSION_CLAUDE_CACHE_OBSERVATION_SCHEMA_VERSION,
    applicability: 'not_applicable',
    source: 'not_applicable',
    requested_retention: null,
    effective_retention: null,
    breakpoint_count: 0,
    request_ordinal: requireRequestOrdinal(requestOrdinal),
  };
}
