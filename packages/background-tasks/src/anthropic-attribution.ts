import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CLAUDE_CODE_SESSION_HEADER = 'X-Claude-Code-Session-Id';

const CLAUDE_CODE_VERSION = '2.1.173';
const CLAUDE_CODE_ENTRYPOINT = 'sdk-cli';
const CLAUDE_CODE_USER_AGENT = 'claude-cli/2.1.173 (external, sdk-cli)';
export const ANTHROPIC_1M_CONTEXT_BETA = 'context-1m-2025-08-07' as const;
export const CLAUDE_CODE_200K_SUBSCRIPTION_CONTEXT_WINDOW = 200_000 as const;

type ClaudeCode200KSubscriptionBetaValue =
  | 'claude-code-20250219'
  | 'oauth-2025-04-20'
  | 'interleaved-thinking-2025-05-14'
  | 'thinking-token-count-2026-05-13'
  | 'context-management-2025-06-27'
  | 'prompt-caching-scope-2026-01-05'
  | 'advisor-tool-2026-03-01'
  | 'structured-outputs-2025-12-15'
  | 'mid-conversation-system-2026-04-07';

const CLAUDE_CODE_LEGACY_BETA_VALUES = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'advisor-tool-2026-03-01',
  'structured-outputs-2025-12-15',
] as const satisfies readonly ClaudeCode200KSubscriptionBetaValue[];
const CLAUDE_CODE_ADAPTIVE_200K_BETA_VALUES = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'mid-conversation-system-2026-04-07',
] as const satisfies readonly ClaudeCode200KSubscriptionBetaValue[];

function build200KSubscriptionBetaHeader(
  values: readonly ClaudeCode200KSubscriptionBetaValue[],
): string {
  if ((values as readonly string[]).includes(ANTHROPIC_1M_CONTEXT_BETA)) {
    throw new Error(
      `Anthropic attribution 200K subscription policy must not emit ${ANTHROPIC_1M_CONTEXT_BETA}`,
    );
  }
  return values.join(',');
}

export const CLAUDE_CODE_BETA = build200KSubscriptionBetaHeader(CLAUDE_CODE_LEGACY_BETA_VALUES);
const CLAUDE_CODE_ADAPTIVE_200K_BETA = build200KSubscriptionBetaHeader(
  CLAUDE_CODE_ADAPTIVE_200K_BETA_VALUES,
);
const CLAUDE_AGENT_SDK_SYSTEM_TEXT =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const FINGERPRINT_SALT = '59cf53e54c78';
const AUDIT_ENV = 'PIPELINE_ANTHROPIC_ATTRIBUTION_AUDIT_PATH';
const CACHE_RETENTION_ENV = 'PI_CACHE_RETENTION';
export const ANTHROPIC_CACHE_RETENTION_ENTRY = 'pipeline-anthropic-cache-retention';
const ANTHROPIC_CACHE_RETENTION_SCHEMA = 'pipeline.anthropic_cache_retention.v1';
export const ANTHROPIC_ATTRIBUTION_CLAIM_CHANNEL = 'pi-anthropic-attribution:claim:v1';
const ANTHROPIC_ATTRIBUTION_CLAIM_SCHEMA = 'pi-anthropic-attribution.claim.v1';
const NATIVE_ATTESTATION_PLACEHOLDER = '00000';
const ANTHROPIC_CACHE_CONTROL_BREAKPOINT_LIMIT = 4;

// Sanitization behavior derived from the MIT-licensed ravshansbox/pi-anthropic-sps
// extension at commit 17409b5615f0ec0625776bc5434f92f2c55e3fd0. Keep exact-match
// semantics and all known Pi prompt variants; unrelated system text is preserved.
const ANTHROPIC_SYSTEM_PROMPT_BAD_LINES = new Set([
  '- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)',
  '- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)',
  '- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing',
]);

type JsonObject = Record<string, unknown>;
export type CacheRetention = 'none' | 'short' | 'long';
type ProviderEnv = Record<string, string | undefined>;
export interface AnthropicCacheControl {
  type: 'ephemeral';
  ttl?: '1h' | '5m';
  [key: string]: unknown;
}

const parseJsonSource = JSON.parse.bind(JSON) as (source: string) => unknown;

function parseJsonValue(text: string, label: string): unknown {
  try {
    return parseJsonSource(text);
  } catch (error) {
    throw new Error(
      `${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseJsonObject(text: string, label: string): JsonObject {
  const parsed = parseJsonValue(text, label);
  if (!isPlainObject(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

export interface ClaudeAttributionAccount {
  readonly deviceId: string;
  readonly accountUuid: string;
}

interface PiCostRatesLike {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly inputTokensAbove?: number;
}

interface PiModelCostLike extends PiCostRatesLike {
  readonly tiers?: readonly PiCostRatesLike[];
}

export interface PiModelLike {
  readonly provider?: string;
  readonly id?: string;
  readonly api?: string;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  readonly reasoning?: boolean;
  readonly compat?: {
    readonly supportsLongCacheRetention?: boolean;
    readonly supportsCacheControlOnTools?: boolean;
  };
  readonly cost?: PiModelCostLike;
}

type ClaudeCodeThinkingPolicy = 'fixed-budget' | 'adaptive-effort';

export interface ClaudeCodeModelPolicy {
  readonly modelId: string;
  readonly beta: string;
  readonly thinkingPolicy: ClaudeCodeThinkingPolicy;
  readonly contextWindow: typeof CLAUDE_CODE_200K_SUBSCRIPTION_CONTEXT_WINDOW;
}

function claudeCode200KSubscriptionPolicy(
  modelId: string,
  beta: string,
  thinkingPolicy: ClaudeCodeThinkingPolicy,
): ClaudeCodeModelPolicy {
  if (beta.split(',').includes(ANTHROPIC_1M_CONTEXT_BETA)) {
    throw new Error(
      `Anthropic attribution 200K subscription policy for ${modelId} must not emit ${ANTHROPIC_1M_CONTEXT_BETA}`,
    );
  }
  return {
    modelId,
    beta,
    thinkingPolicy,
    contextWindow: CLAUDE_CODE_200K_SUBSCRIPTION_CONTEXT_WINDOW,
  };
}

const CLAUDE_CODE_MODEL_POLICIES: Record<string, ClaudeCodeModelPolicy> = Object.freeze({
  'claude-3-5-haiku-20241022': claudeCode200KSubscriptionPolicy(
    'claude-3-5-haiku-20241022',
    CLAUDE_CODE_BETA,
    'fixed-budget',
  ),
  'claude-3-5-haiku-latest': claudeCode200KSubscriptionPolicy(
    'claude-3-5-haiku-latest',
    CLAUDE_CODE_BETA,
    'fixed-budget',
  ),
  'claude-3-5-sonnet-20240620': claudeCode200KSubscriptionPolicy(
    'claude-3-5-sonnet-20240620',
    CLAUDE_CODE_BETA,
    'fixed-budget',
  ),
  'claude-3-5-sonnet-20241022': claudeCode200KSubscriptionPolicy(
    'claude-3-5-sonnet-20241022',
    CLAUDE_CODE_BETA,
    'fixed-budget',
  ),
  'claude-3-7-sonnet-20250219': claudeCode200KSubscriptionPolicy(
    'claude-3-7-sonnet-20250219',
    CLAUDE_CODE_BETA,
    'fixed-budget',
  ),
  'claude-3-haiku-20240307': claudeCode200KSubscriptionPolicy(
    'claude-3-haiku-20240307',
    CLAUDE_CODE_BETA,
    'fixed-budget',
  ),
  'claude-3-opus-20240229': claudeCode200KSubscriptionPolicy(
    'claude-3-opus-20240229',
    CLAUDE_CODE_BETA,
    'fixed-budget',
  ),
  'claude-3-sonnet-20240229': claudeCode200KSubscriptionPolicy(
    'claude-3-sonnet-20240229',
    CLAUDE_CODE_BETA,
    'fixed-budget',
  ),
  'claude-fable-5': claudeCode200KSubscriptionPolicy(
    'claude-fable-5',
    CLAUDE_CODE_ADAPTIVE_200K_BETA,
    'adaptive-effort',
  ),
  'claude-haiku-4-5': claudeCode200KSubscriptionPolicy(
    'claude-haiku-4-5',
    CLAUDE_CODE_BETA,
    'fixed-budget',
  ),
  'claude-haiku-4-5-20251001': claudeCode200KSubscriptionPolicy(
    'claude-haiku-4-5-20251001',
    CLAUDE_CODE_BETA,
    'fixed-budget',
  ),
  'claude-opus-4-0': claudeCode200KSubscriptionPolicy(
    'claude-opus-4-0',
    CLAUDE_CODE_BETA,
    'fixed-budget',
  ),
  'claude-opus-4-1': claudeCode200KSubscriptionPolicy(
    'claude-opus-4-1',
    CLAUDE_CODE_BETA,
    'fixed-budget',
  ),
  'claude-opus-4-1-20250805': claudeCode200KSubscriptionPolicy(
    'claude-opus-4-1-20250805',
    CLAUDE_CODE_BETA,
    'fixed-budget',
  ),
  'claude-opus-4-20250514': claudeCode200KSubscriptionPolicy(
    'claude-opus-4-20250514',
    CLAUDE_CODE_BETA,
    'fixed-budget',
  ),
  'claude-opus-4-5': claudeCode200KSubscriptionPolicy(
    'claude-opus-4-5',
    CLAUDE_CODE_BETA,
    'fixed-budget',
  ),
  'claude-opus-4-5-20251101': claudeCode200KSubscriptionPolicy(
    'claude-opus-4-5-20251101',
    CLAUDE_CODE_BETA,
    'fixed-budget',
  ),
  'claude-opus-4-6': claudeCode200KSubscriptionPolicy(
    'claude-opus-4-6',
    CLAUDE_CODE_ADAPTIVE_200K_BETA,
    'adaptive-effort',
  ),
  'claude-opus-4-7': claudeCode200KSubscriptionPolicy(
    'claude-opus-4-7',
    CLAUDE_CODE_ADAPTIVE_200K_BETA,
    'adaptive-effort',
  ),
  'claude-opus-4-8': claudeCode200KSubscriptionPolicy(
    'claude-opus-4-8',
    CLAUDE_CODE_ADAPTIVE_200K_BETA,
    'adaptive-effort',
  ),
  'claude-opus-5': claudeCode200KSubscriptionPolicy(
    'claude-opus-5',
    CLAUDE_CODE_ADAPTIVE_200K_BETA,
    'adaptive-effort',
  ),
  'claude-sonnet-4-0': claudeCode200KSubscriptionPolicy(
    'claude-sonnet-4-0',
    CLAUDE_CODE_BETA,
    'fixed-budget',
  ),
  'claude-sonnet-4-20250514': claudeCode200KSubscriptionPolicy(
    'claude-sonnet-4-20250514',
    CLAUDE_CODE_BETA,
    'fixed-budget',
  ),
  'claude-sonnet-4-5': claudeCode200KSubscriptionPolicy(
    'claude-sonnet-4-5',
    CLAUDE_CODE_BETA,
    'fixed-budget',
  ),
  'claude-sonnet-4-5-20250929': claudeCode200KSubscriptionPolicy(
    'claude-sonnet-4-5-20250929',
    CLAUDE_CODE_BETA,
    'fixed-budget',
  ),
  'claude-sonnet-4-6': claudeCode200KSubscriptionPolicy(
    'claude-sonnet-4-6',
    CLAUDE_CODE_ADAPTIVE_200K_BETA,
    'adaptive-effort',
  ),
  'claude-sonnet-5': claudeCode200KSubscriptionPolicy(
    'claude-sonnet-5',
    CLAUDE_CODE_ADAPTIVE_200K_BETA,
    'adaptive-effort',
  ),
});

export interface PiSessionManagerLike {
  getSessionId(): string;
  getBranch(): readonly unknown[];
}

export interface PiContextLike {
  readonly model?: PiModelLike;
  readonly sessionManager: PiSessionManagerLike;
  readonly ui?: {
    notify(message: string, level: 'info' | 'warning' | 'error'): void;
  };
}

export interface PiProviderRegistrationConfig {
  readonly api?: string;
  readonly headers?: Record<string, string>;
  readonly streamSimple?: (
    model: PiModelLike,
    context: PiStreamContext,
    options?: PiSimpleStreamOptions,
  ) => AssistantMessageEventStreamLike;
}

export interface PiProviderRegistrationHost {
  registerProvider(name: string, config: PiProviderRegistrationConfig): void;
}

interface PiCommandConfigLike {
  readonly description: string;
  readonly handler: (args: string, ctx: PiContextLike) => Promise<void> | void;
}

interface PiEventBusLike {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface PiExtensionHost extends PiProviderRegistrationHost {
  readonly events: PiEventBusLike;
  on(
    eventName: 'session_start' | 'session_shutdown' | 'session_tree' | 'before_agent_start',
    handler: (event: unknown, ctx: PiContextLike) => void,
  ): void;
  on(
    eventName: 'before_provider_request',
    handler: (event: { readonly payload: unknown }, ctx: PiContextLike) => unknown,
  ): void;
  registerCommand(name: string, config: PiCommandConfigLike): void;
  appendEntry(customType: string, data?: unknown): void;
}

type PiContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mimeType: string; readonly data: string };

type PiMessage =
  | { readonly role: 'user'; readonly content: string | readonly PiContentBlock[] }
  | { readonly role: 'assistant'; readonly content: readonly JsonObject[] }
  | {
      readonly role: 'toolResult';
      readonly toolCallId: string;
      readonly content: readonly PiContentBlock[];
      readonly isError?: boolean;
    };

export interface PiStreamContext {
  readonly messages: readonly PiMessage[];
  readonly systemPrompt?: string;
  readonly tools?: readonly PiToolLike[];
}

export interface PiToolLike {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
}

export interface PiSimpleStreamOptions {
  readonly apiKey?: string;
  readonly headers?: Record<string, string>;
  readonly maxTokens?: number;
  readonly reasoning?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  readonly thinkingBudgets?: Partial<
    Record<'minimal' | 'low' | 'medium' | 'high' | 'xhigh', number>
  >;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly temperature?: number;
  readonly cacheRetention?: CacheRetention;
  readonly sessionId?: string;
  readonly env?: ProviderEnv;
  readonly metadata?: { readonly user_id?: string };
  readonly toolChoice?: unknown;
  readonly onPayload?: (payload: JsonObject, model: PiModelLike) => Promise<unknown> | unknown;
  readonly onResponse?: (
    response: { readonly status: number; readonly headers: Record<string, string> },
    model: PiModelLike,
  ) => Promise<void> | void;
}

export interface AssistantMessageLike {
  role: 'assistant';
  content: JsonObject[];
  api: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h?: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason: 'stop' | 'length' | 'toolUse' | 'aborted' | 'error';
  timestamp: number;
  responseId?: string;
  errorMessage?: string;
}

type AssistantMessageEvent =
  | { readonly type: 'start'; readonly partial: AssistantMessageLike }
  | {
      readonly type: 'text_start';
      readonly contentIndex: number;
      readonly partial: AssistantMessageLike;
    }
  | {
      readonly type: 'text_delta';
      readonly contentIndex: number;
      readonly delta: string;
      readonly partial: AssistantMessageLike;
    }
  | {
      readonly type: 'text_end';
      readonly contentIndex: number;
      readonly content: string;
      readonly partial: AssistantMessageLike;
    }
  | {
      readonly type: 'thinking_start';
      readonly contentIndex: number;
      readonly partial: AssistantMessageLike;
    }
  | {
      readonly type: 'thinking_delta';
      readonly contentIndex: number;
      readonly delta: string;
      readonly partial: AssistantMessageLike;
    }
  | {
      readonly type: 'thinking_end';
      readonly contentIndex: number;
      readonly content: string;
      readonly partial: AssistantMessageLike;
    }
  | {
      readonly type: 'toolcall_start';
      readonly contentIndex: number;
      readonly partial: AssistantMessageLike;
    }
  | {
      readonly type: 'toolcall_delta';
      readonly contentIndex: number;
      readonly delta: string;
      readonly partial: AssistantMessageLike;
    }
  | {
      readonly type: 'toolcall_end';
      readonly contentIndex: number;
      readonly toolCall: JsonObject;
      readonly partial: AssistantMessageLike;
    }
  | {
      readonly type: 'done';
      readonly reason: AssistantMessageLike['stopReason'];
      readonly message: AssistantMessageLike;
    }
  | {
      readonly type: 'error';
      readonly reason: AssistantMessageLike['stopReason'];
      readonly error: AssistantMessageLike;
    };

export interface AssistantMessageEventStreamLike extends AsyncIterable<AssistantMessageEvent> {
  push(event: AssistantMessageEvent): void;
  end(result?: AssistantMessageLike): void;
  result(): Promise<AssistantMessageLike>;
}

class LocalAssistantMessageEventStream implements AssistantMessageEventStreamLike {
  private queue: AssistantMessageEvent[] = [];
  private waiting: Array<(result: IteratorResult<AssistantMessageEvent>) => void> = [];
  private done = false;
  private readonly finalResultPromise: Promise<AssistantMessageLike>;
  private resolveFinalResult!: (value: AssistantMessageLike) => void;

  constructor() {
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event: AssistantMessageEvent): void {
    if (this.done) return;
    if (event.type === 'done') {
      this.done = true;
      this.resolveFinalResult(event.message);
    } else if (event.type === 'error') {
      this.done = true;
      this.resolveFinalResult(event.error);
    }
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  end(result?: AssistantMessageLike): void {
    this.done = true;
    if (result !== undefined) this.resolveFinalResult(result);
    while (this.waiting.length > 0) {
      this.waiting.shift()?.({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    for (;;) {
      const queued = this.queue.shift();
      if (queued) {
        yield queued;
      } else if (this.done) {
        return;
      } else {
        const next = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve) =>
          this.waiting.push(resolve),
        );
        if (next.done) return;
        yield next.value;
      }
    }
  }

  result(): Promise<AssistantMessageLike> {
    return this.finalResultPromise;
  }
}

function createAssistantMessageEventStream(): AssistantMessageEventStreamLike {
  return new LocalAssistantMessageEventStream();
}

function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function providerEnvValue(name: string, env?: ProviderEnv): string | undefined {
  return env?.[name] ?? process.env[name];
}

function parseCacheRetention(value: string, source: string): CacheRetention {
  if (value === 'none' || value === 'short' || value === 'long') return value;
  throw new Error(
    `Anthropic attribution ${source} must be one of none, short, or long; got ${JSON.stringify(value)}`,
  );
}

/**
 * Resolve retention without allowing the extension default to override an
 * explicit call-level posture (notably Pi's cacheRetention=none compaction calls).
 * Precedence: request option -> persisted session override -> process/provider env
 * -> the repo policy default of one hour.
 */
export function resolveCacheRetentionPreference(
  options?: {
    readonly cacheRetention?: CacheRetention;
    readonly env?: ProviderEnv;
  },
  sessionOverride?: Exclude<CacheRetention, 'none'>,
): CacheRetention {
  if (options?.cacheRetention !== undefined) return options.cacheRetention;
  if (sessionOverride !== undefined) return sessionOverride;
  const configured = providerEnvValue(CACHE_RETENTION_ENV, options?.env);
  if (configured !== undefined) return parseCacheRetention(configured, CACHE_RETENTION_ENV);
  return 'long';
}

/** Restore the latest branch-local command decision; custom entries stay out of LLM context. */
export function restoreAnthropicSessionCacheRetention(
  entries: readonly unknown[],
): Exclude<CacheRetention, 'none'> | undefined {
  let restored: Exclude<CacheRetention, 'none'> | undefined;
  for (const entry of entries) {
    if (!isPlainObject(entry) || entry['type'] !== 'custom') continue;
    if (entry['customType'] !== ANTHROPIC_CACHE_RETENTION_ENTRY) continue;
    const data = entry['data'];
    if (
      !isPlainObject(data) ||
      data['schema_version'] !== ANTHROPIC_CACHE_RETENTION_SCHEMA ||
      (data['retention'] !== 'default' &&
        data['retention'] !== 'short' &&
        data['retention'] !== 'long')
    ) {
      throw new Error('Anthropic attribution found a malformed persisted cache retention entry');
    }
    restored = data['retention'] === 'default' ? undefined : data['retention'];
  }
  return restored;
}

function resolveAnthropicCacheControl(
  model: PiModelLike | undefined,
  options?: { readonly cacheRetention?: CacheRetention; readonly env?: ProviderEnv },
): AnthropicCacheControl | undefined {
  const retention = resolveCacheRetentionPreference(options);
  if (retention === 'none') return undefined;
  const ttl =
    retention === 'long' && (model?.compat?.supportsLongCacheRetention ?? true) ? '1h' : undefined;
  return ttl === undefined ? { type: 'ephemeral' } : { type: 'ephemeral', ttl };
}

function cloneAnthropicCacheControl(value: unknown): AnthropicCacheControl | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error(
      'Anthropic attribution cannot safely process malformed cache_control; expected an object',
    );
  }
  if (value['type'] !== 'ephemeral') {
    throw new Error(
      'Anthropic attribution cannot safely process malformed cache_control.type; expected "ephemeral"',
    );
  }
  const ttl = value['ttl'];
  if (ttl !== undefined && ttl !== '1h' && ttl !== '5m') {
    throw new Error(
      'Anthropic attribution cannot safely process malformed cache_control.ttl; expected "1h" or "5m"',
    );
  }
  return {
    ...value,
    type: 'ephemeral',
    ...(ttl === undefined ? {} : { ttl }),
  } as AnthropicCacheControl;
}

function mergedCacheControl(
  existing: unknown,
  desired: AnthropicCacheControl | undefined,
): AnthropicCacheControl | undefined {
  const existingControl = cloneAnthropicCacheControl(existing);
  if (existingControl === undefined) return desired === undefined ? undefined : { ...desired };
  if (desired?.ttl === '1h' && existingControl.ttl !== '1h')
    return { ...existingControl, ttl: '1h' };
  return existingControl;
}

function cloneBlockWithCacheControl(
  block: JsonObject,
  desired: AnthropicCacheControl | undefined,
): JsonObject {
  const next = { ...block };
  const cacheControl = mergedCacheControl(next['cache_control'], desired);
  if (cacheControl !== undefined) next['cache_control'] = cacheControl;
  return next;
}

function stripAnthropicSystemPromptBadLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !ANTHROPIC_SYSTEM_PROMPT_BAD_LINES.has(line))
    .join('\n');
}

interface CacheControlInspection {
  readonly count: number;
  readonly retention: Exclude<CacheRetention, 'none'> | undefined;
}

function inspectCacheControls(payload: JsonObject): CacheControlInspection {
  let count = 0;
  let hasLong = false;
  const inspectBlock = (block: unknown): void => {
    if (!isPlainObject(block) || block['cache_control'] === undefined) return;
    const cacheControl = cloneAnthropicCacheControl(block['cache_control']);
    count += 1;
    if (cacheControl?.ttl === '1h') hasLong = true;
  };

  const system = payload['system'];
  if (Array.isArray(system)) {
    for (const block of system) inspectBlock(block);
  }

  const tools = payload['tools'];
  if (Array.isArray(tools)) {
    for (const tool of tools) inspectBlock(tool);
  }

  const messages = payload['messages'];
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isPlainObject(message)) continue;
      const content = message['content'];
      if (Array.isArray(content)) {
        for (const block of content) inspectBlock(block);
      }
    }
  }

  return { count, retention: count === 0 ? undefined : hasLong ? 'long' : 'short' };
}

function countCacheControlBreakpoints(payload: JsonObject): number {
  return inspectCacheControls(payload).count;
}

function assertCacheControlBreakpointLimit(payload: JsonObject): void {
  const count = countCacheControlBreakpoints(payload);
  if (count > ANTHROPIC_CACHE_CONTROL_BREAKPOINT_LIMIT) {
    throw new Error(
      `Anthropic attribution produced ${count} cache_control breakpoints; Anthropic supports at most ${ANTHROPIC_CACHE_CONTROL_BREAKPOINT_LIMIT}`,
    );
  }
}

function assertNonEmptyString(value: unknown, fieldName: string, configPath: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `Anthropic attribution config ${configPath} missing/malformed required field ${fieldName}`,
    );
  }
  return value;
}

export function extractClaudeAttributionAccount(
  parsedConfig: unknown,
  configPath: string,
): ClaudeAttributionAccount {
  if (!isPlainObject(parsedConfig)) {
    throw new Error(`Anthropic attribution config ${configPath} is not a JSON object`);
  }
  const oauthAccount = parsedConfig['oauthAccount'];
  if (!isPlainObject(oauthAccount)) {
    throw new Error(
      `Anthropic attribution config ${configPath} missing/malformed required field oauthAccount.accountUuid`,
    );
  }
  return {
    deviceId: assertNonEmptyString(parsedConfig['userID'], 'userID', configPath),
    accountUuid: assertNonEmptyString(
      oauthAccount['accountUuid'],
      'oauthAccount.accountUuid',
      configPath,
    ),
  };
}

export function loadClaudeAttributionAccount(
  configPath = join(homedir(), '.claude.json'),
): ClaudeAttributionAccount {
  let configText: string;
  try {
    configText = readFileSync(configPath, 'utf8');
  } catch (error) {
    throw new Error(
      `Anthropic attribution config ${configPath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return extractClaudeAttributionAccount(
    parseJsonValue(configText, `Anthropic attribution config ${configPath}`),
    configPath,
  );
}

export function isAnthropicContext(ctx: PiContextLike): boolean {
  return ctx.model?.provider === 'anthropic';
}

function getSessionId(ctx: PiContextLike): string {
  const sessionId = ctx.sessionManager.getSessionId();
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new Error('Anthropic attribution requires a non-empty Pi session id');
  }
  return sessionId;
}

function normalizedAnthropicModelId(model: PiModelLike): string {
  if (typeof model.id !== 'string' || model.id.trim().length === 0) {
    throw new Error('Anthropic attribution requires a non-empty model id');
  }
  const providerPrefix = 'anthropic/';
  return model.id.startsWith(providerPrefix) ? model.id.slice(providerPrefix.length) : model.id;
}

export function resolveClaudeCodeModelPolicy(model: PiModelLike): ClaudeCodeModelPolicy {
  const modelId = normalizedAnthropicModelId(model);
  const policy = CLAUDE_CODE_MODEL_POLICIES[modelId];
  if (policy === undefined) {
    throw new Error(`Anthropic attribution has no Claude Code model policy for ${modelId}`);
  }
  return policy;
}

export function resolveAnthropicMaxTokens(model: PiModelLike): number {
  return assertPositiveInteger(
    model.maxTokens,
    `model.maxTokens for ${normalizedAnthropicModelId(model)}`,
  );
}

export function computeClaudeCodeFingerprint(
  messageText: string,
  version = CLAUDE_CODE_VERSION,
): string {
  const chars = [4, 7, 20].map((index) => messageText[index] || '0').join('');
  return createHash('sha256')
    .update(`${FINGERPRINT_SALT}${chars}${version}`)
    .digest('hex')
    .slice(0, 3);
}

function firstUserMessageTextFromPayload(payload: JsonObject): string {
  const messages = payload['messages'];
  if (!Array.isArray(messages)) return '';
  for (const message of messages) {
    if (!isPlainObject(message) || message['role'] !== 'user') continue;
    const content = message['content'];
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const textBlock = content.find(
        (block) =>
          isPlainObject(block) && block['type'] === 'text' && typeof block['text'] === 'string',
      );
      if (isPlainObject(textBlock) && typeof textBlock['text'] === 'string')
        return textBlock['text'];
    }
  }
  return '';
}

export function buildClaudeCodeBillingSystemText(firstUserMessageText: string): string {
  const fingerprint = computeClaudeCodeFingerprint(firstUserMessageText);
  return `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${fingerprint}; cc_entrypoint=${CLAUDE_CODE_ENTRYPOINT}; cch=${NATIVE_ATTESTATION_PLACEHOLDER};`;
}

export function buildAnthropicAttributionHeaders(
  sessionId: string,
  model?: PiModelLike,
): Record<string, string> {
  const beta = model === undefined ? CLAUDE_CODE_BETA : resolveClaudeCodeModelPolicy(model).beta;
  return {
    [CLAUDE_CODE_SESSION_HEADER]: sessionId,
    'anthropic-beta': beta,
    'anthropic-version': '2023-06-01',
    'User-Agent': CLAUDE_CODE_USER_AGENT,
    'x-app': 'cli',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

export function registerAnthropicAttributionProvider(
  pi: PiProviderRegistrationHost,
  ctx: PiContextLike,
  getSessionOverride: () => Exclude<CacheRetention, 'none'> | undefined = () => undefined,
): void {
  if (!isAnthropicContext(ctx)) return;
  pi.registerProvider('anthropic', {
    api: 'anthropic-messages',
    headers: buildAnthropicAttributionHeaders(getSessionId(ctx), ctx.model),
    streamSimple: (model, context, options) =>
      streamAnthropicViaBetaMessages(model, context, {
        ...(options ?? {}),
        cacheRetention: resolveCacheRetentionPreference(options, getSessionOverride()),
      }),
  });
}

function assertPositiveInteger(value: unknown, fieldName: string): number {
  if (!Number.isInteger(value) || typeof value !== 'number' || value <= 0) {
    throw new Error(
      `Anthropic attribution cannot safely process malformed ${fieldName}; expected a positive integer`,
    );
  }
  return value;
}

function rewriteThinking(
  payload: JsonObject,
  maxTokens: number | undefined,
): { readonly thinking: unknown; readonly budgetTokens: number | undefined } {
  if (payload['thinking'] === undefined) return { thinking: undefined, budgetTokens: undefined };
  if (!isPlainObject(payload['thinking'])) {
    throw new Error(
      'Anthropic attribution cannot safely process malformed thinking; expected an object',
    );
  }
  const thinking = { ...payload['thinking'] };
  if (thinking['type'] === 'disabled')
    return { thinking: { type: 'disabled' }, budgetTokens: undefined };
  if (thinking['budget_tokens'] === undefined) return { thinking, budgetTokens: undefined };
  const existingBudget = assertPositiveInteger(thinking['budget_tokens'], 'thinking.budget_tokens');
  if (maxTokens !== undefined && existingBudget >= maxTokens) {
    thinking['budget_tokens'] = maxTokens - 1;
  }
  if (typeof thinking['budget_tokens'] === 'number' && thinking['budget_tokens'] <= 0) {
    throw new Error(
      'Anthropic attribution cannot satisfy thinking.budget_tokens < max_tokens when max_tokens <= 1',
    );
  }
  return { thinking, budgetTokens: thinking['budget_tokens'] as number };
}

function isClaudeCodeIdentityText(text: string): boolean {
  return (
    text.startsWith('x-anthropic-billing-header:') ||
    text === CLAUDE_AGENT_SDK_SYSTEM_TEXT ||
    text === "You are Claude Code, Anthropic's official CLI for Claude." ||
    text ===
      "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
  );
}

function normalizeSystemBlock(block: unknown): unknown {
  if (!isPlainObject(block)) return block;
  const next = { ...block };
  if (typeof next['text'] === 'string')
    next['text'] = stripAnthropicSystemPromptBadLines(next['text']);
  if (next['cache_control'] !== undefined)
    next['cache_control'] = cloneAnthropicCacheControl(next['cache_control']);
  return next;
}

function hasCacheControl(block: unknown): block is JsonObject {
  return isPlainObject(block) && block['cache_control'] !== undefined;
}

function isSystemCacheSurface(block: unknown): block is JsonObject {
  return isPlainObject(block) && typeof block['text'] === 'string';
}

function markSystemCacheSurface(
  blocks: readonly unknown[],
  desired: AnthropicCacheControl | undefined,
): unknown[] {
  const output = blocks.map((block) => (isPlainObject(block) ? { ...block } : block));
  if (desired === undefined) return output;

  let lastTextBlockIndex = -1;
  for (let index = 0; index < output.length; index += 1) {
    if (isSystemCacheSurface(output[index])) lastTextBlockIndex = index;
  }

  if (lastTextBlockIndex === -1) return output;

  const withLongRetentionUpgrades =
    desired.ttl === '1h'
      ? output.map((block) =>
          hasCacheControl(block) ? cloneBlockWithCacheControl(block, desired) : block,
        )
      : output;
  withLongRetentionUpgrades[lastTextBlockIndex] = cloneBlockWithCacheControl(
    withLongRetentionUpgrades[lastTextBlockIndex] as JsonObject,
    desired,
  );
  return withLongRetentionUpgrades;
}

function withClaudeCodeSystemIdentity(
  system: unknown,
  billingSystemText: string,
  cacheControl: AnthropicCacheControl | undefined,
): unknown {
  const identityBlocks: JsonObject[] = [
    { type: 'text', text: billingSystemText },
    { type: 'text', text: CLAUDE_AGENT_SDK_SYSTEM_TEXT },
  ];
  if (system === undefined) return markSystemCacheSurface(identityBlocks, cacheControl);
  if (Array.isArray(system)) {
    const withoutPriorIdentity = system
      .filter((entry) => {
        if (!isPlainObject(entry) || typeof entry['text'] !== 'string') return true;
        return !isClaudeCodeIdentityText(entry['text']);
      })
      .map(normalizeSystemBlock);
    return markSystemCacheSurface([...identityBlocks, ...withoutPriorIdentity], cacheControl);
  }
  if (typeof system === 'string') {
    return markSystemCacheSurface(
      [...identityBlocks, { type: 'text', text: stripAnthropicSystemPromptBadLines(system) }],
      cacheControl,
    );
  }
  throw new Error(
    'Anthropic attribution cannot safely apply Claude Code system identity to malformed system payload',
  );
}

function appendAuditRecord(args: {
  readonly provider: 'anthropic';
  readonly headerRegistered: boolean;
  readonly metadataSessionMatchesHeader: boolean;
  readonly maxTokens: number | undefined;
  readonly thinkingBudgetTokens: number | undefined;
  readonly beta: string;
  readonly betaResourcePath: string;
  readonly nativeAttestation: 'placeholder-pending-live';
}): void {
  const auditPath = process.env[AUDIT_ENV];
  if (auditPath === undefined || auditPath.length === 0) return;
  const record = {
    schema_version: 'pipeline.anthropic_attribution_audit.v1',
    provider: args.provider,
    header_name: CLAUDE_CODE_SESSION_HEADER,
    header_registered: args.headerRegistered,
    anthropic_beta: args.beta,
    anthropic_version: '2023-06-01',
    beta_resource_path: args.betaResourcePath,
    native_attestation: args.nativeAttestation,
    metadata_user_id_keys: ['account_uuid', 'device_id', 'session_id'],
    metadata_session_id_matches_header: args.metadataSessionMatchesHeader,
    account_uuid_present: true,
    device_id_present: true,
    max_tokens: args.maxTokens,
    thinking_budget_tokens: args.thinkingBudgetTokens,
  };
  appendFileSync(auditPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function rewriteAnthropicRequestPayload(args: {
  readonly payload: unknown;
  readonly ctx: PiContextLike;
  readonly account: ClaudeAttributionAccount;
  readonly headerRegistered?: boolean;
  readonly cacheRetention?: CacheRetention;
  readonly env?: ProviderEnv;
}): unknown {
  if (!isAnthropicContext(args.ctx)) return undefined;
  if (!isPlainObject(args.payload)) {
    throw new Error('Anthropic attribution expected provider payload to be a JSON object');
  }

  const sessionId = getSessionId(args.ctx);
  const metadata = args.payload['metadata'] === undefined ? {} : args.payload['metadata'];
  if (!isPlainObject(metadata)) {
    throw new Error('Anthropic attribution expected payload.metadata to be an object when present');
  }

  const policy = resolveClaudeCodeModelPolicy(args.ctx.model ?? {});
  const maxTokens =
    args.payload['max_tokens'] === undefined
      ? undefined
      : assertPositiveInteger(args.payload['max_tokens'], 'max_tokens');
  const { thinking, budgetTokens } = rewriteThinking(args.payload, maxTokens);
  const billingSystemText = buildClaudeCodeBillingSystemText(
    firstUserMessageTextFromPayload(args.payload),
  );
  const incomingCache = inspectCacheControls(args.payload);
  // The provider builder has already resolved environment/session defaults and
  // selected the cache surfaces. No incoming marker can therefore be Pi's
  // explicit call-level `cacheRetention: "none"` (used for compaction). Reapplying
  // the process default here would silently defeat that opt-out.
  const configuredCacheRetention = args.cacheRetention ?? incomingCache.retention;
  const cacheControl =
    configuredCacheRetention === undefined
      ? undefined
      : resolveAnthropicCacheControl(args.ctx.model, {
          cacheRetention: configuredCacheRetention,
        });

  const rewritten: JsonObject = {
    ...args.payload,
    metadata: {
      ...metadata,
      user_id: JSON.stringify({
        account_uuid: args.account.accountUuid,
        device_id: args.account.deviceId,
        session_id: sessionId,
      }),
    },
    system: withClaudeCodeSystemIdentity(args.payload['system'], billingSystemText, cacheControl),
  };
  if (thinking !== undefined) rewritten['thinking'] = thinking;
  assertCacheControlBreakpointLimit(rewritten);

  appendAuditRecord({
    provider: 'anthropic',
    headerRegistered: args.headerRegistered ?? true,
    metadataSessionMatchesHeader: true,
    maxTokens,
    thinkingBudgetTokens: budgetTokens,
    beta: policy.beta,
    betaResourcePath: '/v1/messages?beta=true',
    nativeAttestation: 'placeholder-pending-live',
  });

  return rewritten;
}

function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/g, '\uFFFD');
}

function convertContentBlocks(content: readonly PiContentBlock[]): string | JsonObject[] {
  const hasImages = content.some((block) => block.type === 'image');
  if (!hasImages)
    return sanitizeSurrogates(
      content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
    );
  const blocks = content.map((block) => {
    if (block.type === 'text') return { type: 'text', text: sanitizeSurrogates(block.text) };
    return {
      type: 'image',
      source: { type: 'base64', media_type: block.mimeType, data: block.data },
    };
  });
  if (!blocks.some((block) => block.type === 'text'))
    blocks.unshift({ type: 'text', text: '(see attached image)' });
  return blocks;
}

function cloneMessageForCacheControl(message: JsonObject): JsonObject {
  const content = message['content'];
  return {
    ...message,
    ...(Array.isArray(content)
      ? { content: content.map((block) => (isPlainObject(block) ? { ...block } : block)) }
      : {}),
  };
}

function isCacheableConversationBlock(role: unknown, block: JsonObject): boolean {
  if (role === 'assistant') return block['type'] === 'text';
  return block['type'] === 'text' || block['type'] === 'image' || block['type'] === 'tool_result';
}

function markMessageContentCacheSurface(
  message: JsonObject,
  cacheControl: AnthropicCacheControl,
): boolean {
  const role = message['role'];
  if (role !== 'user' && role !== 'assistant') return false;
  const content = message['content'];
  if (typeof content === 'string') {
    if (content.trim().length === 0) return false;
    message['content'] = [{ type: 'text', text: content, cache_control: { ...cacheControl } }];
    return true;
  }
  if (!Array.isArray(content)) return false;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (!isPlainObject(block) || !isCacheableConversationBlock(role, block)) continue;
    content[index] = cloneBlockWithCacheControl(block, cacheControl);
    return true;
  }
  return false;
}

function markLastConversationCacheSurface(
  messages: readonly JsonObject[],
  cacheControl: AnthropicCacheControl | undefined,
): JsonObject[] {
  const output = messages.map(cloneMessageForCacheControl);
  if (cacheControl === undefined) return output;
  for (let index = output.length - 1; index >= 0; index -= 1) {
    const message = output[index];
    if (message !== undefined && markMessageContentCacheSurface(message, cacheControl)) break;
  }
  return output;
}

function convertMessages(
  messages: readonly PiMessage[],
  cacheControl?: AnthropicCacheControl,
): JsonObject[] {
  const params: JsonObject[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === undefined) {
      throw new TypeError(`Anthropic message ${index} is missing`);
    }
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        if (message.content.trim().length > 0)
          params.push({ role: 'user', content: sanitizeSurrogates(message.content) });
      } else {
        const content = message.content
          .map((block) =>
            block.type === 'text'
              ? { type: 'text', text: sanitizeSurrogates(block.text) }
              : {
                  type: 'image',
                  source: { type: 'base64', media_type: block.mimeType, data: block.data },
                },
          )
          .filter((block) => block.type !== 'text' || String(block.text).trim().length > 0);
        if (content.length > 0) params.push({ role: 'user', content });
      }
    } else if (message.role === 'assistant') {
      const content: JsonObject[] = [];
      for (const block of message.content) {
        if (
          block['type'] === 'text' &&
          typeof block['text'] === 'string' &&
          block['text'].trim().length > 0
        ) {
          content.push({ type: 'text', text: sanitizeSurrogates(block['text']) });
        } else if (
          block['type'] === 'thinking' &&
          typeof block['thinking'] === 'string' &&
          block['thinking'].trim().length > 0
        ) {
          const signature =
            typeof block['thinkingSignature'] === 'string' ? block['thinkingSignature'] : '';
          content.push(
            signature.length > 0
              ? { type: 'thinking', thinking: sanitizeSurrogates(block['thinking']), signature }
              : { type: 'text', text: sanitizeSurrogates(block['thinking']) },
          );
        } else if (
          block['type'] === 'toolCall' &&
          typeof block['id'] === 'string' &&
          typeof block['name'] === 'string'
        ) {
          content.push({
            type: 'tool_use',
            id: block['id'],
            name: block['name'],
            input: block['arguments'] ?? {},
          });
        }
      }
      if (content.length > 0) params.push({ role: 'assistant', content });
    } else if (message.role === 'toolResult') {
      const toolResults: JsonObject[] = [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: convertContentBlocks(message.content),
          is_error: message.isError === true,
        },
      ];
      let lookahead = index + 1;
      while (lookahead < messages.length && messages[lookahead]?.role === 'toolResult') {
        const next = messages[lookahead] as Extract<PiMessage, { role: 'toolResult' }>;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: next.toolCallId,
          content: convertContentBlocks(next.content),
          is_error: next.isError === true,
        });
        lookahead += 1;
      }
      index = lookahead - 1;
      params.push({ role: 'user', content: toolResults });
    }
  }
  return markLastConversationCacheSurface(params, cacheControl);
}

function convertTools(
  tools: readonly PiToolLike[] | undefined,
  cacheControl?: AnthropicCacheControl,
): JsonObject[] {
  if (!tools || tools.length === 0) return [];
  return tools.map((tool, index) => {
    const parameters = isPlainObject(tool.parameters) ? tool.parameters : {};
    const converted: JsonObject = {
      name: tool.name,
      description: tool.description ?? '',
      input_schema: {
        type: 'object',
        properties: isPlainObject(parameters['properties']) ? parameters['properties'] : {},
        required: Array.isArray(parameters['required']) ? parameters['required'] : [],
      },
    };
    return cacheControl !== undefined && index === tools.length - 1
      ? cloneBlockWithCacheControl(converted, cacheControl)
      : converted;
  });
}

function thinkingBudgetFor(
  level: NonNullable<PiSimpleStreamOptions['reasoning']>,
  maxTokens: number,
  custom?: PiSimpleStreamOptions['thinkingBudgets'],
): number {
  const defaults = {
    minimal: 1024,
    low: 4096,
    medium: 10240,
    high: 20480,
    xhigh: 32768,
    off: 0,
  } as const;
  const requested = level === 'off' ? 0 : (custom?.[level] ?? defaults[level]);
  return Math.min(maxTokens - 1, requested);
}

function adaptiveEffortFor(
  level: Exclude<NonNullable<PiSimpleStreamOptions['reasoning']>, 'off'>,
): 'low' | 'medium' | 'high' | 'xhigh' {
  switch (level) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return level;
    case 'minimal':
      throw new Error(
        'Anthropic attribution cannot map Pi reasoning=minimal to Claude adaptive effort; use low, medium, high, or xhigh',
      );
  }
}

export function buildAnthropicRequestParams(
  model: PiModelLike,
  context: PiStreamContext,
  options?: PiSimpleStreamOptions,
): JsonObject {
  const policy = resolveClaudeCodeModelPolicy(model);
  const maxTokens = resolveAnthropicMaxTokens(model);
  const cacheControl = resolveAnthropicCacheControl(model, options);
  const params: JsonObject = {
    model: policy.modelId,
    messages: convertMessages(context.messages, cacheControl),
    max_tokens: maxTokens,
    stream: true,
  };
  if (context.systemPrompt && context.systemPrompt.trim().length > 0) {
    params['system'] = markSystemCacheSurface(
      [
        {
          type: 'text',
          text: sanitizeSurrogates(stripAnthropicSystemPromptBadLines(context.systemPrompt)),
        },
      ],
      cacheControl,
    );
  }
  const tools = convertTools(
    context.tools,
    model.compat?.supportsCacheControlOnTools === false ? undefined : cacheControl,
  );
  if (tools.length > 0) params['tools'] = tools;
  else params['tools'] = [];
  if (options?.toolChoice !== undefined) params['tool_choice'] = options.toolChoice;
  const reasoning = options?.reasoning;
  if (model.reasoning && reasoning !== undefined) {
    if (reasoning === 'off') {
      params['thinking'] = { type: 'disabled' };
      params['temperature'] = options?.temperature ?? 1;
    } else if (policy.thinkingPolicy === 'adaptive-effort') {
      params['thinking'] = { type: 'adaptive' };
      params['output_config'] = { effort: adaptiveEffortFor(reasoning) };
    } else {
      params['thinking'] = {
        type: 'enabled',
        budget_tokens: thinkingBudgetFor(reasoning, maxTokens, options?.thinkingBudgets),
      };
    }
  } else {
    params['thinking'] = { type: 'disabled' };
    params['temperature'] = options?.temperature ?? 1;
  }
  assertCacheControlBreakpointLimit(params);
  return params;
}

function headersToRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries([...headers.entries()]);
}

function lowerHeaderMap(headers: Record<string, string> | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) output[key.toLowerCase()] = value;
  return output;
}

function buildFetchHeaders(
  options: PiSimpleStreamOptions | undefined,
  apiKey: string,
  sessionHeader: string | undefined,
  beta: string,
): Record<string, string> {
  const optionHeaders = lowerHeaderMap(options?.headers);
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'User-Agent': optionHeaders['user-agent'] ?? CLAUDE_CODE_USER_AGENT,
    [CLAUDE_CODE_SESSION_HEADER]: sessionHeader ?? optionHeaders['x-claude-code-session-id'] ?? '',
    'anthropic-beta': beta,
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-version': '2023-06-01',
    'x-app': 'cli',
  };
}

function mapStopReason(reason: unknown): AssistantMessageLike['stopReason'] {
  switch (reason) {
    case 'end_turn':
    case 'pause_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'toolUse';
    default:
      return 'error';
  }
}

function parseStreamingJsonFragment(text: string): unknown {
  try {
    return parseJsonSource(text);
  } catch {
    return {};
  }
}

function validCostRate(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `Anthropic attribution model cost.${field} must be a finite non-negative number`,
    );
  }
  return value;
}

function resolveModelCostRates(
  model: PiModelLike,
  totalInputTokens: number,
): Required<Pick<PiCostRatesLike, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>> {
  let selected = model.cost;
  let matchedThreshold = -1;
  for (const tier of model.cost?.tiers ?? []) {
    const threshold = tier.inputTokensAbove;
    if (
      typeof threshold === 'number' &&
      Number.isFinite(threshold) &&
      threshold >= 0 &&
      totalInputTokens > threshold &&
      threshold > matchedThreshold
    ) {
      selected = tier;
      matchedThreshold = threshold;
    }
  }
  return {
    input: validCostRate(selected?.input, 3, 'input'),
    output: validCostRate(selected?.output, 15, 'output'),
    cacheRead: validCostRate(selected?.cacheRead, 0.3, 'cacheRead'),
    cacheWrite: validCostRate(selected?.cacheWrite, 3.75, 'cacheWrite'),
  };
}

export function updateAnthropicUsage(
  output: AssistantMessageLike,
  usage: JsonObject | undefined,
  model: PiModelLike,
): void {
  if (!usage) return;
  if (typeof usage['input_tokens'] === 'number') output.usage.input = usage['input_tokens'];
  if (typeof usage['output_tokens'] === 'number') output.usage.output = usage['output_tokens'];
  if (typeof usage['cache_read_input_tokens'] === 'number')
    output.usage.cacheRead = usage['cache_read_input_tokens'];
  const cacheCreation = usage['cache_creation'];
  const reportedLongCacheWrite =
    isPlainObject(cacheCreation) && typeof cacheCreation['ephemeral_1h_input_tokens'] === 'number'
      ? cacheCreation['ephemeral_1h_input_tokens']
      : undefined;
  if (typeof usage['cache_creation_input_tokens'] === 'number') {
    output.usage.cacheWrite = usage['cache_creation_input_tokens'];
    output.usage.cacheWrite1h = reportedLongCacheWrite ?? 0;
  } else if (reportedLongCacheWrite !== undefined) {
    output.usage.cacheWrite1h = reportedLongCacheWrite;
  }
  const longCacheWrite = output.usage.cacheWrite1h ?? 0;
  if (
    !Number.isFinite(longCacheWrite) ||
    !Number.isInteger(longCacheWrite) ||
    longCacheWrite < 0 ||
    longCacheWrite > output.usage.cacheWrite
  ) {
    throw new Error(
      'Anthropic attribution received malformed 1h cache usage exceeding total cache writes',
    );
  }
  output.usage.totalTokens =
    output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
  const rates = resolveModelCostRates(
    model,
    output.usage.input + output.usage.cacheRead + output.usage.cacheWrite,
  );
  const shortCacheWrite = output.usage.cacheWrite - longCacheWrite;
  output.usage.cost.input = (output.usage.input * rates.input) / 1_000_000;
  output.usage.cost.output = (output.usage.output * rates.output) / 1_000_000;
  output.usage.cost.cacheRead = (output.usage.cacheRead * rates.cacheRead) / 1_000_000;
  output.usage.cost.cacheWrite =
    (shortCacheWrite * rates.cacheWrite + longCacheWrite * rates.input * 2) / 1_000_000;
  output.usage.cost.total =
    output.usage.cost.input +
    output.usage.cost.output +
    output.usage.cost.cacheRead +
    output.usage.cost.cacheWrite;
}

async function* iterateSseEvents(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<JsonObject> {
  if (!response.body) throw new Error('Anthropic beta messages response had no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let dataLines: string[] = [];
  function flush(): JsonObject | undefined {
    if (dataLines.length === 0) return undefined;
    const data = dataLines.join('\n');
    eventName = '';
    dataLines = [];
    if (data === '[DONE]') return undefined;
    return parseJsonObject(data, 'Anthropic beta messages SSE event');
  }
  function consumeLine(line: string): JsonObject | undefined {
    if (line.length === 0) return flush();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    if (field === 'data') dataLines.push(value);
    void eventName;
    return undefined;
  }
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('Request was aborted');
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const match = /\r\n|\n|\r/.exec(buffer);
        if (match?.index === undefined) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const event = consumeLine(line);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const event = consumeLine(buffer);
      if (event) yield event;
    }
    const trailing = flush();
    if (trailing) yield trailing;
  } finally {
    reader.releaseLock();
  }
}

function createOutput(model: PiModelLike): AssistantMessageLike {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

async function forwardToBuiltInAnthropic(
  model: PiModelLike,
  context: PiStreamContext,
  options: PiSimpleStreamOptions | undefined,
  stream: AssistantMessageEventStreamLike,
  output: AssistantMessageLike,
): Promise<void> {
  try {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string,
    ) => Promise<{
      streamSimpleAnthropic: (
        model: PiModelLike,
        context: PiStreamContext,
        options?: PiSimpleStreamOptions,
      ) => AssistantMessageEventStreamLike;
    }>;
    const mod = await dynamicImport('@earendil-works/pi-ai/anthropic');
    const delegated = mod.streamSimpleAnthropic(model, context, options);
    for await (const event of delegated) stream.push(event);
    stream.end(await delegated.result());
  } catch (error) {
    output.stopReason = 'error';
    output.errorMessage = `Anthropic attribution could not delegate non-target provider ${JSON.stringify(model.provider)}: ${error instanceof Error ? error.message : String(error)}`;
    stream.push({ type: 'error', reason: 'error', error: output });
    stream.end();
  }
}

export function streamAnthropicViaBetaMessages(
  model: PiModelLike,
  context: PiStreamContext,
  options?: PiSimpleStreamOptions,
): AssistantMessageEventStreamLike {
  const stream = createAssistantMessageEventStream();
  const output = createOutput(model);

  if (model.provider !== 'anthropic') {
    void forwardToBuiltInAnthropic(model, context, options, stream, output);
    return stream;
  }

  void (async () => {
    try {
      const apiKey = options?.apiKey;
      if (typeof apiKey !== 'string' || apiKey.length === 0) {
        throw new Error(
          'Anthropic attribution requires Pi OAuth apiKey/token; no credential was supplied',
        );
      }
      if (!apiKey.includes('sk-ant-oat')) {
        throw new Error(
          'Anthropic attribution refuses non-OAuth Anthropic credential; subscription OAuth token is required',
        );
      }

      const policy = resolveClaudeCodeModelPolicy(model);
      let params = buildAnthropicRequestParams(model, context, options);
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== undefined) {
        if (!isPlainObject(nextParams))
          throw new Error('Anthropic attribution onPayload returned a non-object payload');
        params = nextParams;
      }
      const metadataUserId = isPlainObject(params['metadata'])
        ? params['metadata']['user_id']
        : undefined;
      let sessionId: string | undefined;
      if (typeof metadataUserId === 'string') {
        const parsed = parseJsonObject(metadataUserId, 'Anthropic attribution metadata.user_id');
        if (typeof parsed['session_id'] === 'string') sessionId = parsed['session_id'];
      }
      if (!sessionId)
        throw new Error(
          'Anthropic attribution could not derive session_id from rewritten metadata.user_id',
        );

      const baseUrl =
        model.baseUrl && model.baseUrl.length > 0
          ? model.baseUrl.replace(/\/$/, '')
          : 'https://api.anthropic.com';
      const url = `${baseUrl}/v1/messages?beta=true`;
      const headers = buildFetchHeaders(options, apiKey, sessionId, policy.beta);
      const requestInit: RequestInit = {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
      };
      if (options?.signal) requestInit.signal = options.signal;
      const response = await fetch(url, requestInit);
      await options?.onResponse?.(
        { status: response.status, headers: headersToRecord(response.headers) },
        model,
      );
      if (!response.ok) {
        throw new Error(
          `Anthropic beta messages request failed: HTTP ${response.status} ${response.statusText}: ${await response.text()}`,
        );
      }

      stream.push({ type: 'start', partial: output });
      const blocks = output.content as Array<JsonObject & { index?: number; partialJson?: string }>;
      for await (const event of iterateSseEvents(response, options?.signal)) {
        if (event['type'] === 'message_start' && isPlainObject(event['message'])) {
          if (typeof event['message']['id'] === 'string')
            output.responseId = event['message']['id'];
          updateAnthropicUsage(
            output,
            isPlainObject(event['message']['usage']) ? event['message']['usage'] : undefined,
            model,
          );
        } else if (
          event['type'] === 'content_block_start' &&
          typeof event['index'] === 'number' &&
          isPlainObject(event['content_block'])
        ) {
          const contentBlock = event['content_block'];
          if (contentBlock['type'] === 'text') {
            output.content.push({ type: 'text', text: '', index: event['index'] });
            stream.push({
              type: 'text_start',
              contentIndex: output.content.length - 1,
              partial: output,
            });
          } else if (contentBlock['type'] === 'thinking') {
            output.content.push({
              type: 'thinking',
              thinking: '',
              thinkingSignature: '',
              index: event['index'],
            });
            stream.push({
              type: 'thinking_start',
              contentIndex: output.content.length - 1,
              partial: output,
            });
          } else if (contentBlock['type'] === 'redacted_thinking') {
            output.content.push({
              type: 'thinking',
              thinking: '[Reasoning redacted]',
              thinkingSignature: contentBlock['data'],
              redacted: true,
              index: event['index'],
            });
            stream.push({
              type: 'thinking_start',
              contentIndex: output.content.length - 1,
              partial: output,
            });
          } else if (contentBlock['type'] === 'tool_use') {
            output.content.push({
              type: 'toolCall',
              id: contentBlock['id'],
              name: contentBlock['name'],
              arguments: contentBlock['input'] ?? {},
              partialJson: '',
              index: event['index'],
            });
            stream.push({
              type: 'toolcall_start',
              contentIndex: output.content.length - 1,
              partial: output,
            });
          }
        } else if (
          event['type'] === 'content_block_delta' &&
          typeof event['index'] === 'number' &&
          isPlainObject(event['delta'])
        ) {
          const blockIndex = blocks.findIndex((block) => block.index === event['index']);
          const block = blocks[blockIndex];
          if (!block) continue;
          const delta = event['delta'];
          if (
            delta['type'] === 'text_delta' &&
            block['type'] === 'text' &&
            typeof delta['text'] === 'string'
          ) {
            block['text'] = `${String(block['text'] ?? '')}${delta['text']}`;
            stream.push({
              type: 'text_delta',
              contentIndex: blockIndex,
              delta: delta['text'],
              partial: output,
            });
          } else if (
            delta['type'] === 'thinking_delta' &&
            block['type'] === 'thinking' &&
            typeof delta['thinking'] === 'string'
          ) {
            block['thinking'] = `${String(block['thinking'] ?? '')}${delta['thinking']}`;
            stream.push({
              type: 'thinking_delta',
              contentIndex: blockIndex,
              delta: delta['thinking'],
              partial: output,
            });
          } else if (
            delta['type'] === 'input_json_delta' &&
            block['type'] === 'toolCall' &&
            typeof delta['partial_json'] === 'string'
          ) {
            block.partialJson = `${block.partialJson ?? ''}${delta['partial_json']}`;
            block['arguments'] = parseStreamingJsonFragment(block.partialJson);
            stream.push({
              type: 'toolcall_delta',
              contentIndex: blockIndex,
              delta: delta['partial_json'],
              partial: output,
            });
          } else if (
            delta['type'] === 'signature_delta' &&
            block['type'] === 'thinking' &&
            typeof delta['signature'] === 'string'
          ) {
            block['thinkingSignature'] =
              `${String(block['thinkingSignature'] ?? '')}${delta['signature']}`;
          }
        } else if (event['type'] === 'content_block_stop' && typeof event['index'] === 'number') {
          const blockIndex = blocks.findIndex((block) => block.index === event['index']);
          const block = blocks[blockIndex];
          if (!block) continue;
          delete block.index;
          if (block['type'] === 'text') {
            stream.push({
              type: 'text_end',
              contentIndex: blockIndex,
              content: String(block['text'] ?? ''),
              partial: output,
            });
          } else if (block['type'] === 'thinking') {
            stream.push({
              type: 'thinking_end',
              contentIndex: blockIndex,
              content: String(block['thinking'] ?? ''),
              partial: output,
            });
          } else if (block['type'] === 'toolCall') {
            block['arguments'] = parseStreamingJsonFragment(block.partialJson ?? '{}');
            delete block.partialJson;
            stream.push({
              type: 'toolcall_end',
              contentIndex: blockIndex,
              toolCall: block,
              partial: output,
            });
          }
        } else if (event['type'] === 'message_delta') {
          if (isPlainObject(event['delta']) && event['delta']['stop_reason'])
            output.stopReason = mapStopReason(event['delta']['stop_reason']);
          updateAnthropicUsage(
            output,
            isPlainObject(event['usage']) ? event['usage'] : undefined,
            model,
          );
        }
      }
      if (options?.signal?.aborted) throw new Error('Request was aborted');
      if (output.stopReason === 'error')
        throw new Error(output.errorMessage || 'Anthropic stream ended with error stop reason');
      stream.push({ type: 'done', reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content) {
        delete block['index'];
        delete block['partialJson'];
      }
      output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: 'error', reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

function cacheRetentionLabel(retention: CacheRetention): string {
  switch (retention) {
    case 'long':
      return '1-hour';
    case 'short':
      return '5-minute';
    case 'none':
      return 'disabled';
  }
}

interface AnthropicAttributionClaimProbe {
  readonly schema_version: typeof ANTHROPIC_ATTRIBUTION_CLAIM_SCHEMA;
  readonly acknowledge: () => void;
}

function isAnthropicAttributionClaimProbe(value: unknown): value is AnthropicAttributionClaimProbe {
  return (
    isPlainObject(value) &&
    value['schema_version'] === ANTHROPIC_ATTRIBUTION_CLAIM_SCHEMA &&
    typeof value['acknowledge'] === 'function'
  );
}

/**
 * Prevent two independently installed copies from registering duplicate provider
 * hooks and `/unipi:claude-cache` commands in one Pi runtime. Pi loads extension factories
 * sequentially and its EventBus dispatches listeners synchronously, so an existing
 * owner acknowledges this probe before emit() returns. The winning extension only
 * publishes ownership after every registration below succeeds; a factory that throws
 * cannot strand a false claim that suppresses a healthy later copy.
 */
export default function spawnAnthropicAttribution(pi: PiExtensionHost): void {
  const acknowledgements: true[] = [];
  const probe: AnthropicAttributionClaimProbe = {
    schema_version: ANTHROPIC_ATTRIBUTION_CLAIM_SCHEMA,
    acknowledge: () => {
      acknowledgements.push(true);
    },
  };
  pi.events.emit(ANTHROPIC_ATTRIBUTION_CLAIM_CHANNEL, probe);
  if (acknowledgements.length > 0) return;

  let sessionCacheRetention: Exclude<CacheRetention, 'none'> | undefined;
  const getSessionOverride = (): Exclude<CacheRetention, 'none'> | undefined =>
    sessionCacheRetention;

  // Registration is global but route-scoped by provider name. Keeping it at
  // factory scope avoids lifecycle-dependent provider availability; the custom
  // transport derives session/model headers from the attributed payload.
  pi.registerProvider('anthropic', {
    api: 'anthropic-messages',
    streamSimple: (model, context, options) =>
      streamAnthropicViaBetaMessages(model, context, {
        ...(options ?? {}),
        cacheRetention: resolveCacheRetentionPreference(options, getSessionOverride()),
      }),
  });

  pi.registerCommand('unipi:claude-cache', {
    description: 'Show or set Claude cache retention for this session (short, long, default)',
    handler: (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action.length === 0 || action === 'status') {
        const effective = resolveCacheRetentionPreference(undefined, sessionCacheRetention);
        ctx.ui?.notify(
          `Claude cache retention: ${cacheRetentionLabel(effective)}${sessionCacheRetention === undefined ? ' (default)' : ' (session override)'}`,
          'info',
        );
        return;
      }
      if (action !== 'short' && action !== 'long' && action !== 'default') {
        throw new Error('Usage: /unipi:claude-cache [status|short|long|default]');
      }
      sessionCacheRetention = action === 'default' ? undefined : action;
      pi.appendEntry(ANTHROPIC_CACHE_RETENTION_ENTRY, {
        schema_version: ANTHROPIC_CACHE_RETENTION_SCHEMA,
        retention: action,
      });
      const effective = resolveCacheRetentionPreference(undefined, sessionCacheRetention);
      ctx.ui?.notify(
        `Claude cache retention set to ${cacheRetentionLabel(effective)} for this session${action === 'default' ? ' (default policy)' : ''}.`,
        'info',
      );
    },
  });

  pi.on('session_start', (_event, ctx) => {
    sessionCacheRetention = restoreAnthropicSessionCacheRetention(ctx.sessionManager.getBranch());
  });

  pi.on('session_shutdown', () => {
    sessionCacheRetention = undefined;
  });

  pi.on('session_tree', (_event, ctx) => {
    sessionCacheRetention = restoreAnthropicSessionCacheRetention(ctx.sessionManager.getBranch());
  });

  pi.on('before_provider_request', (event, ctx) => {
    if (!isAnthropicContext(ctx)) return undefined;
    return rewriteAnthropicRequestPayload({
      payload: event.payload,
      ctx,
      account: loadClaudeAttributionAccount(),
      headerRegistered: true,
    });
  });

  // Publish ownership last. Extension loading is sequential, so later independent
  // copies probe this responder and become inert instead of registering duplicates.
  pi.events.on(ANTHROPIC_ATTRIBUTION_CLAIM_CHANNEL, (value) => {
    if (isAnthropicAttributionClaimProbe(value)) value.acknowledge();
  });
}
