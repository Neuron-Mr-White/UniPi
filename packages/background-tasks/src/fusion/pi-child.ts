import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FUSION_CANDIDATE_OUTPUT_RECOVERY_PATH_ENV,
  FUSION_CHILD_MAX_PROVIDER_REQUESTS,
  FUSION_CHILD_MAX_TOOL_CALLS,
  FUSION_CHILD_RESULT_PREFIX,
  FUSION_CHILD_RESULT_SCHEMA_VERSION,
  FUSION_CHILD_SETTLEMENT_PREFIX,
  FUSION_CHILD_SETTLEMENT_SCHEMA_VERSION,
  FUSION_RESEARCH_ENABLED_ENV,
  FUSION_RUNTIME_GUARD_PREFIX,
  FUSION_RUNTIME_GUARD_SCHEMA_VERSION,
  FUSION_SOURCE_POLICY_PATH_ENV,
  FUSION_SOURCE_POLICY_SHA256_ENV,
  FUSION_TOOL_CALL_LOG_PATH_ENV,
  FUSION_TOOL_CALL_SEAL_SCHEMA_VERSION,
  FUSION_TOOL_CALL_SEAL_SUFFIX,
  FUSION_CHILD_MAX_TOTAL_TOOL_RESULT_BYTES,
  buildFusionChildSettlement,
  isRecoverableFusionChildErrorRecord,
  serializeFusionChildResultRecords,
  type FusionChildOutputContractMetadata,
  type FusionChildOutputRecoveryRole,
  type FusionChildResultMetadata,
  type FusionChildSettlementFailureReason,
  type FusionChildSettlementRecord,
  type FusionRuntimeGuardCode,
  type FusionRuntimeGuardRecord,
} from './child-protocol.js';
import {
  FUSION_CLAUDE_CACHE_BREAKPOINT_LIMIT,
  FUSION_CLAUDE_CACHE_OBSERVATION_SCHEMA_VERSION,
  FUSION_CLAUDE_CACHE_RETENTION_ENV,
  type FusionClaudeCacheObservation,
  type FusionClaudeCacheRetention,
} from './claude-cache.js';
import {
  FUSION_FORBIDDEN_TOOLS,
  FUSION_NO_TOOLS_CAPABILITY,
  FUSION_INSPECT_TOOLS,
  FUSION_RESEARCH_TOOLS,
  FUSION_TOOL_CALL_LOG_SCHEMA_VERSION,
  FUSION_WEB_FETCH_TOOL_NAME,
  FusionError,
  addFusionUsage,
  cloneFusionUsage,
  createEmptyFusionUsage,
  type FusionCapability,
  type FusionCandidateOutputRecovery,
  type FusionChildRunResult,
  type FusionErrorDetails,
  type FusionStage,
  type FusionToolCallLogRecord,
  type FusionToolCallTrace,
  type FusionUsage,
  type ResolvedFusionModel,
} from './types.js';
import { isJsonObject, parseJsonText } from '../types.js';
import {
  FUSION_CANDIDATE_MAX_OUTPUT_BYTES,
  fusionJsonRenderedTextBytes,
} from './output-contract.js';
import { canonicalizeFusionPublicUrl, readFusionSourcePolicyFile } from './source-policy.js';
import {
  assertWindowsCommandLineWithinLimit,
  piLaunchArgv,
  resolvePiLaunch,
  type PiLaunchDependencies,
} from '../pi-launch.js';
import { resolveAnthropicAttributionExtensionPath } from '../anthropic-attribution-path.js';

// The response cap now applies to one final full answer, not cumulative Pi JSON events.
export const FUSION_CHILD_STDOUT_LIMIT_BYTES = 32 * 1024 * 1024;
export const FUSION_CHILD_STDERR_LIMIT_BYTES = 16 * 1024 * 1024;
export const FUSION_CHILD_TIMEOUT_MS = 50 * 60 * 1000;
/**
 * Stale-action watchdog threshold.
 *
 * Activity is one stdout or stderr byte from the child. The child extension emits its
 * compact metadata frame only at `message_end`, and Pi text mode writes stdout only for
 * the final assistant message, so a single slow model turn is genuinely silent on both
 * streams. The threshold must therefore exceed the longest plausible single turn, not the
 * longest plausible tool call: a value tuned to tool latency would kill healthy children
 * mid-reasoning. Thirty-five minutes leaves a wide margin over observed turn latency
 * while remaining materially below the 50-minute absolute cap, so the stale-action
 * watchdog retains an independent purpose instead of becoming an unreachable duplicate
 * timeout.
 */
export const FUSION_CHILD_IDLE_TIMEOUT_MS = 35 * 60 * 1000;
export const FUSION_CHILD_KILL_GRACE_MS = 3000;
export const FUSION_CHILD_SIGKILL_WAIT_MS = 5000;
const FUSION_PI_CHILD_O_NOFOLLOW =
  typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;

export const FUSION_CHILD_REMOVED_ENV_KEYS = [
  'PI_SESSION_ID',
  'PI_SESSION_FILE',
  'PI_PROVIDER',
  'PI_MODEL',
  'PI_REASONING_LEVEL',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_BASE_URL',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_RESOURCE_NAME',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_DEPLOYMENT_NAME_MAP',
  'AZURE_OPENAI_AD_TOKEN',
  'PI_API_KEY',
  'PI_API_BASE_URL',
  'PI_AUTH_FILE',
  FUSION_TOOL_CALL_LOG_PATH_ENV,
  FUSION_CANDIDATE_OUTPUT_RECOVERY_PATH_ENV,
  FUSION_RESEARCH_ENABLED_ENV,
  FUSION_SOURCE_POLICY_PATH_ENV,
  FUSION_SOURCE_POLICY_SHA256_ENV,
] as const;

interface FusionReadableStream {
  on(event: 'data', listener: (data: Buffer | string) => void): unknown;
  off(event: 'data', listener: (data: Buffer | string) => void): unknown;
}

interface FusionWritableStream {
  write(data: Buffer, callback: (error?: Error | null) => void): boolean;
  end(callback?: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
}

export interface FusionChildProcess {
  pid?: number | undefined;
  stdin?: FusionWritableStream | null | undefined;
  stdout?: FusionReadableStream | null | undefined;
  stderr?: FusionReadableStream | null | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
  off(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

export type FusionChildSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => FusionChildProcess;

export type FusionKillProcess = (pid: number, signal?: NodeJS.Signals | number) => boolean;

export interface RunPiChildOptions {
  stage: FusionStage;
  slot?: 1 | 2 | 3;
  attempt: number;
  cwd: string;
  model: ResolvedFusionModel;
  capability?: FusionCapability | undefined;
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal | undefined;
  spawn?: FusionChildSpawn | undefined;
  killProcess?: FusionKillProcess | undefined;
  platform?: NodeJS.Platform | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  stdoutLimitBytes?: number | undefined;
  childExtensionPath?: string | undefined;
  stderrLimitBytes?: number | undefined;
  timeoutMs?: number | undefined;
  idleTimeoutMs?: number | undefined;
  killGraceMs?: number | undefined;
  sigkillWaitMs?: number | undefined;
  piLaunchDependencies?: PiLaunchDependencies | undefined;
  toolCallLogPath?: string | undefined;
  sourcePolicy?: { path: string; sha256: string } | undefined;
  candidateOutputRecoveryPath?: string | undefined;
}

interface CloseRecord {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ProcessState {
  primaryError: FusionError | undefined;
  cleanupErrors: string[];
  terminationStarted: boolean;
  termTimer: NodeJS.Timeout | undefined;
  waitTimer: NodeJS.Timeout | undefined;
  timeoutTimer: NodeJS.Timeout | undefined;
  idleTimer: NodeJS.Timeout | undefined;
  settled: boolean;
}

interface ObservedChildSnapshot {
  usage: FusionUsage;
  provider?: string;
  model?: string;
  qualifiedId?: string;
}

export class FusionChildRunError extends FusionError {
  readonly events: Buffer;
  readonly response: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number | null;
  readonly signalName: NodeJS.Signals | null;
  readonly usage: FusionUsage;
  readonly provider: string | undefined;
  readonly modelName: string | undefined;
  readonly qualifiedId: string | undefined;
  readonly outputRecovery: FusionCandidateOutputRecovery | undefined;

  constructor(
    error: FusionError,
    events: Buffer,
    response: Buffer,
    stderr: Buffer,
    close: CloseRecord,
    observed: ObservedChildSnapshot,
    outputRecovery?: FusionCandidateOutputRecovery,
  ) {
    const details: FusionErrorDetails = {
      code: error.code,
      transient: error.transient,
      childCreated: error.childCreated,
    };
    if (error.stage !== undefined) details.stage = error.stage;
    if (error.slot !== undefined) details.slot = error.slot;
    if (error.attempt !== undefined) details.attempt = error.attempt;
    if (error.artifactDir !== undefined) details.artifactDir = error.artifactDir;
    super(error.message, details);
    this.name = 'FusionChildRunError';
    this.events = events;
    this.response = response;
    this.stderr = stderr;
    this.exitCode = close.code;
    this.signalName = close.signal;
    this.usage = cloneFusionUsage(observed.usage);
    this.provider = observed.provider;
    this.modelName = observed.model;
    this.qualifiedId = observed.qualifiedId;
    this.outputRecovery = outputRecovery;
  }
}

export function fusionPiChildEnv(
  env: NodeJS.ProcessEnv = process.env,
  provider?: string | undefined,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const removed = new Set<string>(FUSION_CHILD_REMOVED_ENV_KEYS);
  for (const inheritedKey of Object.keys(out)) {
    if (removed.has(inheritedKey.toUpperCase())) Reflect.deleteProperty(out, inheritedKey);
  }
  out['PI_SKIP_VERSION_CHECK'] = '1';
  if (provider === 'anthropic' && out[FUSION_CLAUDE_CACHE_RETENTION_ENV] === undefined) {
    out[FUSION_CLAUDE_CACHE_RETENTION_ENV] = 'long';
  }
  return out;
}

export function resolveFusionChildExtensionPath(
  moduleUrl = import.meta.url,
  pathExists: (path: string) => boolean = existsSync,
): string {
  const modulePath = fileURLToPath(moduleUrl);
  const extension = modulePath.endsWith('.ts') ? 'fusion-child.ts' : 'fusion-child.js';
  const candidate = resolve(dirname(modulePath), '../../extensions', extension);
  if (!pathExists(candidate)) {
    throw new Error(`Fusion child metadata extension is missing: ${candidate}`);
  }
  return candidate;
}

/**
 * Provider whose isolated children require the package-owned attribution and
 * exact-match system-prompt sanitization extension.
 */
export const FUSION_SANITIZED_PROVIDER = 'anthropic';

export function assertFusionToolPolicyDisjoint(
  allowlist: readonly string[] = FUSION_INSPECT_TOOLS,
  denylist: readonly string[] = FUSION_FORBIDDEN_TOOLS,
): void {
  for (const forbidden of denylist) {
    if (allowlist.includes(forbidden)) {
      throw new FusionError(
        `fusion inspect capability would enable the forbidden tool ${forbidden}`,
        { code: 'orchestration_failed', childCreated: false },
      );
    }
  }
}

function researchToolAllowlist(): readonly string[] {
  return FUSION_RESEARCH_TOOLS;
}

function fusionToolArgv(capability: FusionCapability): string[] {
  if (capability === 'reason') return ['--no-tools'];
  if (capability === 'inspect') {
    assertFusionToolPolicyDisjoint(FUSION_INSPECT_TOOLS);
    return [
      '--no-builtin-tools',
      '--tools',
      FUSION_INSPECT_TOOLS.join(','),
      '--exclude-tools',
      FUSION_FORBIDDEN_TOOLS.join(','),
    ];
  }
  if (capability === 'research') {
    const allowlist = researchToolAllowlist();
    assertFusionToolPolicyDisjoint(allowlist);
    return [
      '--no-builtin-tools',
      '--tools',
      allowlist.join(','),
      '--exclude-tools',
      FUSION_FORBIDDEN_TOOLS.join(','),
    ];
  }
  throw new FusionError(`fusion capability ${String(capability)} is not supported`, {
    code: 'orchestration_failed',
    childCreated: false,
  });
}

/**
 * Extensions explicitly loaded into a child, in deterministic order.
 *
 * `--no-extensions` disables discovery but still honours explicit `--extension`
 * paths, so this list is the complete set a child receives. The metadata
 * extension is always present. For Claude routes the sanitizer loads first so
 * the package-owned attribution provider establishes the Claude Code OAuth
 * request shape first, the sanitizer preserves that shape while removing only
 * rejected prompt lines, and the private runtime governor observes the final
 * payload. Non-Anthropic child argv remains unchanged.
 */
export function fusionChildExtensionPaths(
  model: ResolvedFusionModel,
  childExtensionPath: string,
  resolveAttribution: () => string = resolveAnthropicAttributionExtensionPath,
): readonly string[] {
  if (model.provider !== FUSION_SANITIZED_PROVIDER) return [childExtensionPath];
  return [resolveAttribution(), childExtensionPath];
}

export function buildFusionPiChildArgv(
  model: ResolvedFusionModel,
  systemPrompt: string,
  childExtensionPath = resolveFusionChildExtensionPath(),
  capability: FusionCapability = FUSION_NO_TOOLS_CAPABILITY,
  resolveAttribution: () => string = resolveAnthropicAttributionExtensionPath,
): string[] {
  const extensionArgs = fusionChildExtensionPaths(
    model,
    childExtensionPath,
    resolveAttribution,
  ).flatMap((path) => ['--extension', path]);
  return [
    '--mode',
    'text',
    '--no-session',
    ...fusionToolArgv(capability),
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    ...extensionArgs,
    '--provider',
    model.provider,
    '--model',
    model.model,
    '--thinking',
    model.thinkingLevel,
    '--system-prompt',
    systemPrompt,
  ];
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const FUSION_CHILD_RESULT_PREFIX_BYTES = Buffer.from(FUSION_CHILD_RESULT_PREFIX, 'utf8');
const FUSION_CHILD_SETTLEMENT_PREFIX_BYTES = Buffer.from(FUSION_CHILD_SETTLEMENT_PREFIX, 'utf8');
const FUSION_RUNTIME_GUARD_PREFIX_BYTES = Buffer.from(FUSION_RUNTIME_GUARD_PREFIX, 'utf8');
const PI_EXTENSION_ERROR_PREFIX_BYTES = Buffer.from('Extension error (', 'utf8');

interface ParsedFusionChildStderr {
  records: FusionChildResultMetadata[];
  events: Buffer;
  diagnostics: Buffer;
}

function assertClosedRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<PropertyKey, unknown> {
  if (!isJsonObject(value) || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} keys mismatch: expected ${expected.join(', ')}`);
  }
  return value;
}

function assertClosedRecordWithOptional(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  label: string,
): Record<PropertyKey, unknown> {
  if (!isJsonObject(value) || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const actual = Object.keys(value).sort();
  const missing = requiredKeys.filter((key) => !Object.hasOwn(value, key));
  const unknownKeys = actual.filter((key) => !allowed.has(key));
  if (missing.length > 0 || unknownKeys.length > 0) {
    throw new Error(
      `${label} keys mismatch: required ${[...requiredKeys].sort().join(', ')}; optional ${[
        ...optionalKeys,
      ]
        .sort()
        .join(', ')}`,
    );
  }
  return value;
}

function requireNonBlankString(
  record: Record<PropertyKey, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`${label}.${key} must be a non-blank string`);
  return value;
}

function requireSha256(record: Record<PropertyKey, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !SHA256_HEX_PATTERN.test(value))
    throw new Error(`${label}.${key} must be a lowercase SHA-256 hex digest`);
  return value;
}

function requireUsageInteger(
  record: Record<PropertyKey, unknown>,
  key: string,
  label: string,
): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label}.${key} must be a non-negative safe integer`);
  return value;
}

function requirePositiveSafeInteger(
  record: Record<PropertyKey, unknown>,
  key: string,
  label: string,
): number {
  const value = requireUsageInteger(record, key, label);
  if (value === 0) throw new Error(`${label}.${key} must be a positive safe integer`);
  return value;
}

function requireCostNumber(
  record: Record<PropertyKey, unknown>,
  key: string,
  label: string,
): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error(`${label}.${key} must be a non-negative finite number`);
  return value;
}

function parseCompactUsage(value: unknown): FusionUsage {
  const record = assertClosedRecordWithOptional(
    value,
    ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'cost'],
    ['cacheWrite1h', 'reasoning'],
    'fusion child usage',
  );
  const cost = assertClosedRecord(
    record['cost'],
    ['input', 'output', 'cacheRead', 'cacheWrite', 'total'],
    'fusion child usage.cost',
  );
  const output = requireUsageInteger(record, 'output', 'fusion child usage');
  const cacheWrite = requireUsageInteger(record, 'cacheWrite', 'fusion child usage');
  const cacheWrite1h =
    record['cacheWrite1h'] === undefined
      ? undefined
      : requireUsageInteger(record, 'cacheWrite1h', 'fusion child usage');
  const reasoning =
    record['reasoning'] === undefined
      ? undefined
      : requireUsageInteger(record, 'reasoning', 'fusion child usage');
  if (cacheWrite1h !== undefined && cacheWrite1h > cacheWrite) {
    throw new Error('fusion child usage.cacheWrite1h must not exceed cacheWrite');
  }
  if (reasoning !== undefined && reasoning > output) {
    throw new Error('fusion child usage.reasoning must not exceed output');
  }
  return {
    input: requireUsageInteger(record, 'input', 'fusion child usage'),
    output,
    cacheRead: requireUsageInteger(record, 'cacheRead', 'fusion child usage'),
    cacheWrite,
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
    ...(reasoning === undefined ? {} : { reasoning }),
    totalTokens: requireUsageInteger(record, 'totalTokens', 'fusion child usage'),
    cost: {
      input: requireCostNumber(cost, 'input', 'fusion child usage.cost'),
      output: requireCostNumber(cost, 'output', 'fusion child usage.cost'),
      cacheRead: requireCostNumber(cost, 'cacheRead', 'fusion child usage.cost'),
      cacheWrite: requireCostNumber(cost, 'cacheWrite', 'fusion child usage.cost'),
      total: requireCostNumber(cost, 'total', 'fusion child usage.cost'),
    },
  };
}

const FUSION_CLAUDE_CACHE_RETENTIONS = new Set<FusionClaudeCacheRetention>([
  'none',
  'short',
  'long',
]);

function parseFusionClaudeCacheObservation(
  value: unknown,
  provider: string,
): FusionClaudeCacheObservation {
  const record = assertClosedRecord(
    value,
    [
      'schema_version',
      'applicability',
      'source',
      'requested_retention',
      'effective_retention',
      'breakpoint_count',
      'request_ordinal',
    ],
    'fusion child cache observation',
  );
  if (record['schema_version'] !== FUSION_CLAUDE_CACHE_OBSERVATION_SCHEMA_VERSION) {
    throw new Error('fusion child cache observation schema_version mismatch');
  }
  const applicability = record['applicability'];
  const source = record['source'];
  const requested = record['requested_retention'];
  const effective = record['effective_retention'];
  const breakpointCount = requireUsageInteger(
    record,
    'breakpoint_count',
    'fusion child cache observation',
  );
  const requestOrdinal = requirePositiveSafeInteger(
    record,
    'request_ordinal',
    'fusion child cache observation',
  );
  if (requestOrdinal > FUSION_CHILD_MAX_PROVIDER_REQUESTS) {
    throw new Error('fusion child cache observation exceeds the provider request limit');
  }
  if (breakpointCount > FUSION_CLAUDE_CACHE_BREAKPOINT_LIMIT) {
    throw new Error('fusion child cache observation exceeds the Anthropic breakpoint limit');
  }
  if (provider !== 'anthropic') {
    if (
      applicability !== 'not_applicable' ||
      source !== 'not_applicable' ||
      requested !== null ||
      effective !== null ||
      breakpointCount !== 0
    ) {
      throw new Error('non-Anthropic fusion child has contradictory cache observation');
    }
    return {
      schema_version: FUSION_CLAUDE_CACHE_OBSERVATION_SCHEMA_VERSION,
      applicability: 'not_applicable',
      source: 'not_applicable',
      requested_retention: null,
      effective_retention: null,
      breakpoint_count: 0,
      request_ordinal: requestOrdinal,
    };
  }
  if (applicability !== 'anthropic') {
    throw new Error('Anthropic fusion child cache observation is not applicable');
  }
  if (source !== 'default' && source !== FUSION_CLAUDE_CACHE_RETENTION_ENV) {
    throw new Error('Anthropic fusion child cache observation source is invalid');
  }
  if (
    typeof requested !== 'string' ||
    !FUSION_CLAUDE_CACHE_RETENTIONS.has(requested as FusionClaudeCacheRetention) ||
    typeof effective !== 'string' ||
    !FUSION_CLAUDE_CACHE_RETENTIONS.has(effective as FusionClaudeCacheRetention)
  ) {
    throw new Error('Anthropic fusion child cache retention is invalid');
  }
  const requestedRetention = requested as FusionClaudeCacheRetention;
  const effectiveRetention = effective as FusionClaudeCacheRetention;
  if (source === 'default' && requestedRetention !== 'long') {
    throw new Error('default Anthropic cache policy did not request long retention');
  }
  if ((effectiveRetention === 'none') !== (breakpointCount === 0)) {
    throw new Error('Anthropic fusion child cache retention/breakpoint evidence mismatch');
  }
  if (requestedRetention === 'none' && effectiveRetention !== 'none') {
    throw new Error('disabled Anthropic cache policy reported active breakpoints');
  }
  if (effectiveRetention === 'long' && requestedRetention !== 'long') {
    throw new Error('Anthropic long cache retention was not requested');
  }
  return {
    schema_version: FUSION_CLAUDE_CACHE_OBSERVATION_SCHEMA_VERSION,
    applicability: 'anthropic',
    source,
    requested_retention: requestedRetention,
    effective_retention: effectiveRetention,
    breakpoint_count: breakpointCount,
    request_ordinal: requestOrdinal,
  };
}

const FUSION_OUTPUT_RECOVERY_ROLES = new Set<FusionChildOutputRecoveryRole>([
  'none',
  'oversized_original',
  'replacement',
]);

function parseChildOutputContract(value: unknown): FusionChildOutputContractMetadata {
  const record = assertClosedRecord(
    value,
    ['json_rendered_bytes', 'candidate_limit_bytes', 'recovery_role'],
    'fusion child result.output_contract',
  );
  const candidateLimitValue = record['candidate_limit_bytes'];
  const candidateLimit =
    candidateLimitValue === null
      ? null
      : requirePositiveSafeInteger(
          record,
          'candidate_limit_bytes',
          'fusion child result.output_contract',
        );
  if (candidateLimit !== null && candidateLimit !== FUSION_CANDIDATE_MAX_OUTPUT_BYTES) {
    throw new Error('fusion child result candidate output limit mismatches the shared contract');
  }
  const recoveryRole = record['recovery_role'];
  if (
    typeof recoveryRole !== 'string' ||
    !FUSION_OUTPUT_RECOVERY_ROLES.has(recoveryRole as FusionChildOutputRecoveryRole)
  ) {
    throw new Error('fusion child result.output_contract.recovery_role is invalid');
  }
  if (recoveryRole !== 'none' && candidateLimit === null) {
    throw new Error('fusion child result output recovery has no candidate contract');
  }
  return {
    json_rendered_bytes: requireUsageInteger(
      record,
      'json_rendered_bytes',
      'fusion child result.output_contract',
    ),
    candidate_limit_bytes: candidateLimit,
    recovery_role: recoveryRole as FusionChildOutputRecoveryRole,
  };
}

function parseChildResultMetadata(value: unknown): FusionChildResultMetadata {
  const record = assertClosedRecord(
    value,
    [
      'schema_version',
      'provider',
      'model',
      'stop_reason',
      'text_blocks',
      'text_sha256',
      'usage',
      'cache_observation',
      'output_contract',
    ],
    'fusion child result',
  );
  if (record['schema_version'] !== FUSION_CHILD_RESULT_SCHEMA_VERSION)
    throw new Error('fusion child result schema_version mismatch');
  const textBlocksValue = record['text_blocks'];
  if (!Array.isArray(textBlocksValue))
    throw new Error('fusion child result.text_blocks must be an array');
  const textBlocks = textBlocksValue.map((value, index) => {
    const label = `fusion child result.text_blocks[${String(index)}]`;
    const block = assertClosedRecord(value, ['utf8_bytes', 'sha256'], label);
    return {
      utf8_bytes: requireUsageInteger(block, 'utf8_bytes', label),
      sha256: requireSha256(block, 'sha256', label),
    };
  });
  const usage = parseCompactUsage(record['usage']);
  const provider = requireNonBlankString(record, 'provider', 'fusion child result');
  return {
    schema_version: FUSION_CHILD_RESULT_SCHEMA_VERSION,
    provider,
    model: requireNonBlankString(record, 'model', 'fusion child result'),
    stop_reason: requireNonBlankString(record, 'stop_reason', 'fusion child result'),
    text_blocks: textBlocks,
    text_sha256: requireSha256(record, 'text_sha256', 'fusion child result'),
    usage,
    cache_observation: parseFusionClaudeCacheObservation(record['cache_observation'], provider),
    output_contract: parseChildOutputContract(record['output_contract']),
  };
}

const FUSION_RUNTIME_GUARD_CODES = new Set<FusionRuntimeGuardCode>([
  'provider_request_limit',
  'provider_payload_invalid',
  'claude_cache_policy',
  'tool_call_limit',
]);

export function parseFusionRuntimeGuard(stderr: Buffer): FusionRuntimeGuardRecord | undefined {
  const frames: FusionRuntimeGuardRecord[] = [];
  let cursor = 0;
  for (;;) {
    const frameStart = stderr.indexOf(FUSION_RUNTIME_GUARD_PREFIX_BYTES, cursor);
    if (frameStart < 0) break;
    const payloadStart = frameStart + FUSION_RUNTIME_GUARD_PREFIX_BYTES.length;
    const newline = stderr.indexOf(10, payloadStart);
    if (newline < 0) throw new Error('fusion runtime guard frame is not newline-terminated');
    const bytes = stderr.subarray(payloadStart, newline);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      throw new Error('fusion runtime guard frame is not valid UTF-8');
    }
    const record = assertClosedRecord(
      parseJsonText(text),
      [
        'schema_version',
        'code',
        'provider',
        'model',
        'request_ordinal',
        'tool_call_count',
        'payload_bytes',
        'payload_sha256',
        'message',
      ],
      'fusion runtime guard',
    );
    if (record['schema_version'] !== FUSION_RUNTIME_GUARD_SCHEMA_VERSION) {
      throw new Error('fusion runtime guard schema_version mismatch');
    }
    const code = requireNonBlankString(record, 'code', 'fusion runtime guard');
    if (!FUSION_RUNTIME_GUARD_CODES.has(code as FusionRuntimeGuardCode)) {
      throw new Error(`fusion runtime guard code is unsupported: ${code}`);
    }
    const frame: FusionRuntimeGuardRecord = {
      schema_version: FUSION_RUNTIME_GUARD_SCHEMA_VERSION,
      code: code as FusionRuntimeGuardCode,
      provider: requireNonBlankString(record, 'provider', 'fusion runtime guard'),
      model: requireNonBlankString(record, 'model', 'fusion runtime guard'),
      request_ordinal: requirePositiveSafeInteger(
        record,
        'request_ordinal',
        'fusion runtime guard',
      ),
      tool_call_count: requireUsageInteger(record, 'tool_call_count', 'fusion runtime guard'),
      payload_bytes: requireUsageInteger(record, 'payload_bytes', 'fusion runtime guard'),
      payload_sha256: requireSha256(record, 'payload_sha256', 'fusion runtime guard'),
      message: requireNonBlankString(record, 'message', 'fusion runtime guard'),
    };
    const emptyPayloadHash = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
    if (frame.code === 'claude_cache_policy' || frame.code === 'provider_payload_invalid') {
      if (frame.payload_bytes !== 0 || frame.payload_sha256 !== emptyPayloadHash) {
        throw new Error('fusion runtime guard invalid-payload evidence mismatch');
      }
    }
    if (
      frame.code === 'provider_request_limit' &&
      frame.request_ordinal <= FUSION_CHILD_MAX_PROVIDER_REQUESTS
    ) {
      throw new Error('fusion runtime guard provider request limit was not exceeded');
    }
    if (frame.code === 'tool_call_limit') {
      if (frame.tool_call_count <= FUSION_CHILD_MAX_TOOL_CALLS) {
        throw new Error('fusion runtime guard tool call limit was not exceeded');
      }
      if (frame.payload_bytes !== 0 || frame.payload_sha256 !== emptyPayloadHash) {
        throw new Error('fusion runtime guard tool call limit payload evidence mismatch');
      }
    }
    frames.push(frame);
    cursor = newline + 1;
  }
  if (frames.length > 1) throw new Error('fusion child emitted multiple runtime guard frames');
  return frames[0];
}

const FUSION_CHILD_SETTLEMENT_FAILURE_REASONS = new Set<FusionChildSettlementFailureReason>([
  'no_records',
  'final_not_stop',
  'invalid_non_final',
  'runtime_guard',
  'cache_observation',
  'output_recovery',
]);

export function parseFusionChildSettlement(
  stderr: Buffer,
): FusionChildSettlementRecord | undefined {
  const frames: FusionChildSettlementRecord[] = [];
  let cursor = 0;
  for (;;) {
    const frameStart = stderr.indexOf(FUSION_CHILD_SETTLEMENT_PREFIX_BYTES, cursor);
    if (frameStart < 0) break;
    const payloadStart = frameStart + FUSION_CHILD_SETTLEMENT_PREFIX_BYTES.length;
    const newline = stderr.indexOf(10, payloadStart);
    if (newline < 0) throw new Error('fusion child settlement frame is not newline-terminated');
    const bytes = stderr.subarray(payloadStart, newline);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      throw new Error('fusion child settlement frame is not valid UTF-8');
    }
    const record = assertClosedRecord(
      parseJsonText(text),
      [
        'schema_version',
        'status',
        'record_count',
        'records_sha256',
        'final_record_index',
        'final_text_sha256',
        'recovered_error_ordinals',
        'recovered_output_cap_ordinals',
        'failure_reason',
      ],
      'fusion child settlement',
    );
    if (record['schema_version'] !== FUSION_CHILD_SETTLEMENT_SCHEMA_VERSION) {
      throw new Error('fusion child settlement schema_version mismatch');
    }
    const status = record['status'];
    if (status !== 'complete' && status !== 'failed') {
      throw new Error('fusion child settlement.status is invalid');
    }
    const recordCount = requireUsageInteger(record, 'record_count', 'fusion child settlement');
    const finalIndexValue = record['final_record_index'];
    const finalRecordIndex =
      finalIndexValue === null
        ? null
        : requireUsageInteger(record, 'final_record_index', 'fusion child settlement');
    const finalHashValue = record['final_text_sha256'];
    const finalTextSha256 =
      finalHashValue === null
        ? null
        : requireSha256(record, 'final_text_sha256', 'fusion child settlement');
    const recoveredValue = record['recovered_error_ordinals'];
    if (!Array.isArray(recoveredValue)) {
      throw new Error('fusion child settlement.recovered_error_ordinals must be an array');
    }
    const recoveredErrorOrdinals = recoveredValue.map((value, index) => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(
          `fusion child settlement.recovered_error_ordinals[${String(index)}] must be a non-negative safe integer`,
        );
      }
      return value;
    });
    for (let index = 0; index < recoveredErrorOrdinals.length; index += 1) {
      const ordinal = recoveredErrorOrdinals[index];
      if (
        ordinal === undefined ||
        ordinal >= recordCount - 1 ||
        (index > 0 && ordinal <= (recoveredErrorOrdinals[index - 1] ?? -1))
      ) {
        throw new Error('fusion child settlement recovered-error ordinals are not canonical');
      }
    }
    const recoveredOutputValue = record['recovered_output_cap_ordinals'];
    if (!Array.isArray(recoveredOutputValue)) {
      throw new Error('fusion child settlement.recovered_output_cap_ordinals must be an array');
    }
    const recoveredOutputCapOrdinals = recoveredOutputValue.map((value, index) => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(
          `fusion child settlement.recovered_output_cap_ordinals[${String(index)}] must be a non-negative safe integer`,
        );
      }
      return value;
    });
    for (let index = 0; index < recoveredOutputCapOrdinals.length; index += 1) {
      const ordinal = recoveredOutputCapOrdinals[index];
      if (
        ordinal === undefined ||
        ordinal >= recordCount - 1 ||
        (index > 0 && ordinal <= (recoveredOutputCapOrdinals[index - 1] ?? -1))
      ) {
        throw new Error('fusion child settlement recovered-output ordinals are not canonical');
      }
    }
    const failureValue = record['failure_reason'];
    let failureReason: FusionChildSettlementFailureReason | null;
    if (failureValue === null) failureReason = null;
    else if (
      typeof failureValue === 'string' &&
      FUSION_CHILD_SETTLEMENT_FAILURE_REASONS.has(
        failureValue as FusionChildSettlementFailureReason,
      )
    ) {
      failureReason = failureValue as FusionChildSettlementFailureReason;
    } else {
      throw new Error('fusion child settlement.failure_reason is invalid');
    }
    if ((status === 'complete') !== (failureReason === null)) {
      throw new Error('fusion child settlement status/failure_reason mismatch');
    }
    if (recordCount === 0) {
      if (finalRecordIndex !== null || finalTextSha256 !== null) {
        throw new Error('fusion child settlement empty stream has final-record evidence');
      }
    } else if (finalRecordIndex !== recordCount - 1 || finalTextSha256 === null) {
      throw new Error('fusion child settlement final-record evidence mismatch');
    }
    frames.push({
      schema_version: FUSION_CHILD_SETTLEMENT_SCHEMA_VERSION,
      status,
      record_count: recordCount,
      records_sha256: requireSha256(record, 'records_sha256', 'fusion child settlement'),
      final_record_index: finalRecordIndex,
      final_text_sha256: finalTextSha256,
      recovered_error_ordinals: recoveredErrorOrdinals,
      recovered_output_cap_ordinals: recoveredOutputCapOrdinals,
      failure_reason: failureReason,
    });
    cursor = newline + 1;
  }
  if (frames.length > 1) throw new Error('fusion child emitted multiple settlement frames');
  return frames[0];
}

function assertFusionChildSettlementOrdering(stderr: Buffer): void {
  const settlementStart = stderr.indexOf(FUSION_CHILD_SETTLEMENT_PREFIX_BYTES);
  if (settlementStart < 0) return;
  if (stderr.indexOf(FUSION_CHILD_RESULT_PREFIX_BYTES, settlementStart) >= 0) {
    throw new Error('fusion child emitted result metadata after terminal settlement');
  }
}

function stripChildControlFrames(stderr: Buffer): Buffer {
  const prefixes = [FUSION_CHILD_SETTLEMENT_PREFIX_BYTES, FUSION_RUNTIME_GUARD_PREFIX_BYTES];
  const diagnostics: Buffer[] = [];
  let cursor = 0;
  for (;;) {
    let next = -1;
    let prefix: Buffer | undefined;
    for (const candidate of prefixes) {
      const found = stderr.indexOf(candidate, cursor);
      if (found >= 0 && (next < 0 || found < next)) {
        next = found;
        prefix = candidate;
      }
    }
    if (next < 0 || prefix === undefined) {
      if (cursor < stderr.length) diagnostics.push(stderr.subarray(cursor));
      break;
    }
    if (next > cursor) diagnostics.push(stderr.subarray(cursor, next));
    const newline = stderr.indexOf(10, next + prefix.length);
    if (newline < 0) throw new Error('fusion child control frame is not newline-terminated');
    cursor = newline + 1;
  }
  return Buffer.concat(diagnostics);
}

export function assertFusionRuntimeGuardMatchesModel(
  guard: FusionRuntimeGuardRecord,
  model: ResolvedFusionModel,
): void {
  const routeUnknown = guard.provider === 'unknown' && guard.model === 'unknown';
  if (!routeUnknown && (guard.provider !== model.provider || guard.model !== model.model)) {
    throw new Error(
      `fusion runtime guard route mismatch: expected ${model.qualifiedId}, observed ${guard.provider}/${guard.model}`,
    );
  }
  if (routeUnknown && guard.code !== 'provider_payload_invalid') {
    throw new Error('fusion runtime guard omitted the route for a route-bound refusal');
  }
}

export function parseFusionChildStderr(stderr: Buffer): ParsedFusionChildStderr {
  // Validate every package-owned side frame even though result metadata is parsed
  // independently below. Malformed refusal/settlement evidence must never degrade
  // into opaque diagnostics.
  parseFusionRuntimeGuard(stderr);
  const settlement = parseFusionChildSettlement(stderr);
  assertFusionChildSettlementOrdering(stderr);
  const records: FusionChildResultMetadata[] = [];
  const diagnostics: Buffer[] = [];
  let cursor = 0;
  for (;;) {
    const frameStart = stderr.indexOf(FUSION_CHILD_RESULT_PREFIX_BYTES, cursor);
    if (frameStart < 0) {
      if (cursor < stderr.length) diagnostics.push(stderr.subarray(cursor));
      break;
    }
    if (frameStart > cursor) diagnostics.push(stderr.subarray(cursor, frameStart));
    const payloadStart = frameStart + FUSION_CHILD_RESULT_PREFIX_BYTES.length;
    const newline = stderr.indexOf(10, payloadStart);
    if (newline < 0) throw new Error('fusion child metadata frame is not newline-terminated');
    const payloadBytes = stderr.subarray(payloadStart, newline);
    const payloadText = payloadBytes.toString('utf8');
    if (!Buffer.from(payloadText, 'utf8').equals(payloadBytes))
      throw new Error('fusion child metadata frame is not valid UTF-8');
    let parsed: unknown;
    try {
      parsed = parseJsonText(payloadText);
    } catch (error) {
      throw new Error(
        `fusion child metadata frame is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    records.push(parseChildResultMetadata(parsed));
    cursor = newline + 1;
  }
  const resultEvents = serializeFusionChildResultRecords(records);
  const events =
    settlement === undefined
      ? resultEvents
      : Buffer.concat([resultEvents, Buffer.from(`${JSON.stringify(settlement)}\n`, 'utf8')]);
  return {
    records,
    events,
    diagnostics: stripChildControlFrames(Buffer.concat(diagnostics)),
  };
}

function parseToolCallLogRecord(value: unknown, label: string): FusionToolCallLogRecord {
  const record = assertClosedRecordWithOptional(
    value,
    [
      'schema_version',
      'ordinal',
      'tool_name',
      'arguments_sha256',
      'arguments_bytes',
      'result_bytes',
      'result_sha256',
      'status',
      'duration_ms',
    ],
    ['url', 'rejected_url_sha256', 'final_url', 'http_status', 'response_bytes', 'content_sha256'],
    label,
  );
  if (record['schema_version'] !== FUSION_TOOL_CALL_LOG_SCHEMA_VERSION) {
    throw new Error(`${label}.schema_version mismatch`);
  }
  const status = record['status'];
  if (status !== 'ok' && status !== 'error') throw new Error(`${label}.status is invalid`);
  const parsedRecord: FusionToolCallLogRecord = {
    schema_version: FUSION_TOOL_CALL_LOG_SCHEMA_VERSION,
    ordinal: requireUsageInteger(record, 'ordinal', label),
    tool_name: requireNonBlankString(record, 'tool_name', label),
    arguments_sha256: requireSha256(record, 'arguments_sha256', label),
    arguments_bytes: requireUsageInteger(record, 'arguments_bytes', label),
    result_bytes: requireUsageInteger(record, 'result_bytes', label),
    result_sha256: requireSha256(record, 'result_sha256', label),
    status,
    duration_ms: requireUsageInteger(record, 'duration_ms', label),
  };
  if (record['url'] !== undefined) parsedRecord.url = requireNonBlankString(record, 'url', label);
  if (record['rejected_url_sha256'] !== undefined)
    parsedRecord.rejected_url_sha256 = requireSha256(record, 'rejected_url_sha256', label);
  if (record['final_url'] !== undefined)
    parsedRecord.final_url = requireNonBlankString(record, 'final_url', label);
  if (record['http_status'] !== undefined)
    parsedRecord.http_status = requireUsageInteger(record, 'http_status', label);
  if (record['response_bytes'] !== undefined)
    parsedRecord.response_bytes = requireUsageInteger(record, 'response_bytes', label);
  if (record['content_sha256'] !== undefined)
    parsedRecord.content_sha256 = requireSha256(record, 'content_sha256', label);
  return parsedRecord;
}

export function parseFusionToolCallLog(bytes: Buffer): FusionToolCallTrace {
  if (bytes.length === 0) {
    return {
      bytes,
      records: [],
      summary: { count: 0, total_result_bytes: 0, trace_complete: true },
    };
  }
  if (bytes.at(-1) !== 10) {
    throw new Error('fusion tool-call log has trailing partial line');
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error('fusion tool-call log is not valid UTF-8');
  }
  const lines = text.split('\n');
  lines.pop();
  const records = lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = parseJsonText(line);
    } catch (error) {
      throw new Error(
        `fusion tool-call log line ${String(index)} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return parseToolCallLogRecord(parsed, `fusion tool-call log line ${String(index)}`);
  });
  const seen = new Set<number>();
  for (const [index, record] of records.entries()) {
    if (seen.has(record.ordinal)) {
      throw new Error(`fusion tool-call log duplicate ordinal ${String(record.ordinal)}`);
    }
    seen.add(record.ordinal);
    if (record.ordinal !== index) {
      throw new Error(
        `fusion tool-call log ordinal gap: expected ${String(index)}, observed ${String(record.ordinal)}`,
      );
    }
  }
  return {
    bytes,
    records,
    summary: {
      count: records.length,
      total_result_bytes: records.reduce((sum, record) => sum + record.result_bytes, 0),
      trace_complete: true,
    },
  };
}

async function assertCompletedToolPolicy(
  trace: FusionToolCallTrace,
  capability: FusionCapability,
  sourcePolicy: { path: string; sha256: string } | undefined,
): Promise<void> {
  const allowed =
    capability === 'inspect'
      ? FUSION_INSPECT_TOOLS
      : capability === 'research'
        ? FUSION_RESEARCH_TOOLS
        : [];
  const allowedSet = new Set<string>(allowed);
  const declared =
    capability === 'research' && sourcePolicy !== undefined
      ? new Set(
          (await readFusionSourcePolicyFile(sourcePolicy.path, sourcePolicy.sha256)).sources.map(
            (source) => source.canonical_url,
          ),
        )
      : undefined;
  for (const record of trace.records) {
    if (!allowedSet.has(record.tool_name)) {
      throw new Error(`fusion child used non-allowlisted tool ${record.tool_name}`);
    }
    if (capability === 'research' && record.tool_name === FUSION_WEB_FETCH_TOOL_NAME) {
      if (sourcePolicy === undefined || declared === undefined)
        throw new Error('fusion research source policy missing during audit');
      if (record.status === 'ok') {
        if (record.url === undefined) throw new Error('fusion research fetch audit is missing url');
        const canonicalUrl = canonicalizeFusionPublicUrl(record.url);
        if (record.url !== canonicalUrl)
          throw new Error('fusion research fetch audit URL was not canonical');
        if (!declared.has(canonicalUrl))
          throw new Error('fusion research fetch audit URL was not declared');
        if (record.rejected_url_sha256 !== undefined) {
          throw new Error(
            'fusion research successful fetch audit must not include rejected_url_sha256',
          );
        }
        if (record.final_url === undefined)
          throw new Error('fusion research fetch audit is missing final_url');
        if (record.http_status === undefined)
          throw new Error('fusion research fetch audit is missing http_status');
        if (record.response_bytes === undefined)
          throw new Error('fusion research fetch audit is missing response_bytes');
        if (record.content_sha256 === undefined)
          throw new Error('fusion research fetch audit is missing content_sha256');
      } else {
        if (record.url !== undefined || record.final_url !== undefined) {
          throw new Error('fusion research rejected fetch audit must not persist raw URL');
        }
        if (record.rejected_url_sha256 === undefined) {
          throw new Error('fusion research rejected fetch audit is missing rejected_url_sha256');
        }
      }
    }
  }
}

function isNotFound(error: unknown): boolean {
  return isJsonObject(error) && error['code'] === 'ENOENT';
}

async function readFusionToolCallLog(path: string): Promise<FusionToolCallTrace> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | FUSION_PI_CHILD_O_NOFOLLOW);
  } catch (error) {
    // The child extension creates this file before tools can run, so a missing file
    // means the audit trail was never established - not that zero tools were used. Those
    // must stay distinguishable: silently accepting absence would let a run whose activity
    // was never recorded report success, defeating the purpose of the log.
    if (isNotFound(error)) {
      throw new Error(
        `fusion tool-call log is missing at ${path}; the inspect child never initialized its audit trail`,
      );
    }
    if (isJsonObject(error) && error['code'] === 'ELOOP') {
      throw new Error(
        `fusion tool-call log at ${path} is a symlink; refusing to trust a redirected audit trail`,
      );
    }
    throw error;
  }
  try {
    // The audit trail must be a real file inside the run directory. A symlink here would let
    // anything able to pre-create the path redirect the parent's read elsewhere, so the file
    // is opened with O_NOFOLLOW and then fstat-checked before its bytes are trusted.
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(
        `fusion tool-call log at ${path} is not a regular file; refusing to trust a redirected audit trail`,
      );
    }
    return parseFusionToolCallLog(await handle.readFile());
  } finally {
    await handle.close();
  }
}

async function assertFusionToolCallLogSeal(
  path: string,
  trace: FusionToolCallTrace,
): Promise<void> {
  const sealPath = `${path}${FUSION_TOOL_CALL_SEAL_SUFFIX}`;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(sealPath, constants.O_RDONLY | FUSION_PI_CHILD_O_NOFOLLOW);
  } catch (error) {
    if (isNotFound(error)) throw new Error('fusion tool-call audit completion seal is missing');
    if (isJsonObject(error) && error['code'] === 'ELOOP') {
      throw new Error('fusion tool-call audit completion seal is a symlink');
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile())
      throw new Error('fusion tool-call audit completion seal is not a regular file');
    if (stats.size > 4096) throw new Error('fusion tool-call audit completion seal is oversized');
    const bytes = await handle.readFile();
    if (bytes.at(-1) !== 10) throw new Error('fusion tool-call audit completion seal is partial');
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      throw new Error('fusion tool-call audit completion seal is not UTF-8');
    }
    const parsed = parseJsonText(text);
    if (!isJsonObject(parsed) || Array.isArray(parsed)) {
      throw new Error('fusion tool-call audit completion seal must be an object');
    }
    const keys = Object.keys(parsed).sort();
    const expected = [
      'log_sha256',
      'record_count',
      'schema_version',
      'status',
      'total_result_bytes',
    ];
    if (keys.join('\0') !== expected.join('\0')) {
      throw new Error('fusion tool-call audit completion seal keys mismatch');
    }
    if (parsed['schema_version'] !== FUSION_TOOL_CALL_SEAL_SCHEMA_VERSION) {
      throw new Error('fusion tool-call audit completion seal schema mismatch');
    }
    if (parsed['status'] !== 'complete') {
      throw new Error('fusion tool-call audit completion seal reports a failed audit');
    }
    const recordCount = requireUsageInteger(parsed, 'record_count', 'fusion tool-call audit seal');
    const totalResultBytes = requireUsageInteger(
      parsed,
      'total_result_bytes',
      'fusion tool-call audit seal',
    );
    const logSha256 = requireSha256(parsed, 'log_sha256', 'fusion tool-call audit seal');
    if (recordCount !== trace.summary.count) {
      throw new Error('fusion tool-call audit completion seal record count mismatch');
    }
    if (recordCount > FUSION_CHILD_MAX_TOOL_CALLS) {
      throw new Error(
        `fusion tool-call audit exceeds tool-call limit ${String(FUSION_CHILD_MAX_TOOL_CALLS)}`,
      );
    }
    if (totalResultBytes !== trace.summary.total_result_bytes) {
      throw new Error('fusion tool-call audit completion seal result-byte total mismatch');
    }
    if (logSha256 !== sha256Buffer(trace.bytes)) {
      throw new Error('fusion tool-call audit completion seal log hash mismatch');
    }
    if (totalResultBytes > FUSION_CHILD_MAX_TOTAL_TOOL_RESULT_BYTES) {
      throw new Error(
        `fusion tool-call audit exceeds aggregate result-byte limit ${String(FUSION_CHILD_MAX_TOTAL_TOOL_RESULT_BYTES)}`,
      );
    }
  } finally {
    await handle.close();
  }
}

function sha256Buffer(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function reconstructFinalText(response: Buffer, record: FusionChildResultMetadata): string {
  const blocks: Buffer[] = [];
  let cursor = 0;
  for (const [index, block] of record.text_blocks.entries()) {
    const end = cursor + block.utf8_bytes;
    if (end > response.length)
      throw new Error(`Pi final text block ${String(index)} is shorter than its metadata length`);
    const bytes = response.subarray(cursor, end);
    if (sha256Buffer(bytes) !== block.sha256)
      throw new Error(`Pi final text block ${String(index)} hash mismatch`);
    blocks.push(bytes);
    if (response.at(end) !== 10)
      throw new Error(`Pi final text block ${String(index)} lacks its print-mode newline`);
    cursor = end + 1;
  }
  if (cursor !== response.length)
    throw new Error('Pi final text stdout contains bytes outside declared text blocks');
  const joined = Buffer.concat(blocks);
  if (sha256Buffer(joined) !== record.text_sha256)
    throw new Error('Pi final text aggregate hash mismatch');
  const text = joined.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(joined))
    throw new Error('Pi final text is not valid UTF-8');
  if (fusionJsonRenderedTextBytes(text) !== record.output_contract.json_rendered_bytes) {
    throw new Error('Pi final text JSON-rendered byte count mismatch');
  }
  if (text.trim().length === 0) throw new Error('Pi assistant response is empty');
  return text;
}

type ParsedCandidateOutputRecovery = Omit<FusionCandidateOutputRecovery, 'original_text'>;

async function readCandidateOutputRecovery(
  path: string,
  evidence: ParsedCandidateOutputRecovery,
): Promise<FusionCandidateOutputRecovery> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | FUSION_PI_CHILD_O_NOFOLLOW);
  } catch (error) {
    if (isNotFound(error))
      throw new Error('fusion oversized candidate response artifact is missing');
    if (isJsonObject(error) && error['code'] === 'ELOOP') {
      throw new Error('fusion oversized candidate response artifact is a symlink');
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error('fusion oversized candidate response artifact is not a regular file');
    }
    if (stats.size > FUSION_CHILD_STDOUT_LIMIT_BYTES) {
      throw new Error(
        `fusion oversized candidate response artifact exceeds ${String(FUSION_CHILD_STDOUT_LIMIT_BYTES)} bytes`,
      );
    }
    const bytes = await handle.readFile();
    if (sha256Buffer(bytes) !== evidence.original_text_sha256) {
      throw new Error('fusion oversized candidate response artifact hash mismatch');
    }
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      throw new Error('fusion oversized candidate response artifact is not valid UTF-8');
    }
    if (fusionJsonRenderedTextBytes(text) !== evidence.original_json_rendered_bytes) {
      throw new Error('fusion oversized candidate response JSON-rendered byte count mismatch');
    }
    if (evidence.original_json_rendered_bytes <= evidence.limit_bytes) {
      throw new Error('fusion output recovery original did not exceed the candidate contract');
    }
    return { ...evidence, original_text: text };
  } finally {
    await handle.close();
  }
}

function parsedCandidateOutputRecovery(
  records: readonly FusionChildResultMetadata[],
  status: FusionCandidateOutputRecovery['status'],
): ParsedCandidateOutputRecovery | undefined {
  const originalRecordIndex = records.findIndex(
    (record) => record.output_contract.recovery_role === 'oversized_original',
  );
  if (originalRecordIndex < 0) return undefined;
  const original = records[originalRecordIndex];
  if (original === undefined) throw new Error('Pi output recovery original record disappeared');
  const replacementRecordIndex = records.findIndex(
    (record) => record.output_contract.recovery_role === 'replacement',
  );
  const replacement = replacementRecordIndex < 0 ? undefined : records[replacementRecordIndex];
  return {
    kind: 'same_session_compression',
    limit_bytes: FUSION_CANDIDATE_MAX_OUTPUT_BYTES,
    original_record_index: originalRecordIndex,
    replacement_record_index: replacementRecordIndex < 0 ? null : replacementRecordIndex,
    original_json_rendered_bytes: original.output_contract.json_rendered_bytes,
    replacement_json_rendered_bytes: replacement?.output_contract.json_rendered_bytes ?? null,
    original_text_sha256: original.text_sha256,
    status,
  };
}

export class FusionPiCompactResultParser {
  private readonly expectedProvider: string;
  private readonly expectedModel: string;

  constructor(expectedProvider: string, expectedModel: string) {
    this.expectedProvider = expectedProvider;
    this.expectedModel = expectedModel;
  }

  snapshot(stderr: Buffer): ObservedChildSnapshot {
    try {
      const parsed = parseFusionChildStderr(stderr);
      return this.observedFromRecords(parsed.records);
    } catch {
      return { usage: createEmptyFusionUsage() };
    }
  }

  finishOutputRecoveryFailure(
    response: Buffer,
    stderr: Buffer,
  ): {
    usage: FusionUsage;
    provider: string;
    model: string;
    qualifiedId: string;
    events: Buffer;
    diagnostics: Buffer;
    outputRecovery: ParsedCandidateOutputRecovery;
  } {
    const parsed = parseFusionChildStderr(stderr);
    const settlement = parseFusionChildSettlement(stderr);
    if (settlement === undefined) throw new Error('Pi child emitted no terminal result settlement');
    const expectedSettlement = buildFusionChildSettlement(parsed.records);
    if (JSON.stringify(settlement) !== JSON.stringify(expectedSettlement)) {
      throw new Error('Pi child terminal result settlement does not match the metadata stream');
    }
    if (settlement.status !== 'failed' || settlement.failure_reason !== 'output_recovery') {
      throw new Error('Pi child did not report a failed candidate output recovery');
    }
    if (parsed.diagnostics.includes(PI_EXTENSION_ERROR_PREFIX_BYTES)) {
      throw new Error('Pi child reported an extension error diagnostic');
    }
    const final = parsed.records.at(-1);
    if (final === undefined) throw new Error('Pi child emitted no compact result metadata');
    for (const record of parsed.records) this.assertModel(record);
    this.assertCacheObservationOrdinals(parsed.records);
    this.assertTranscriptStopReasons(parsed.records);
    reconstructFinalText(response, final);
    const outputRecovery = parsedCandidateOutputRecovery(parsed.records, 'failed');
    if (outputRecovery === undefined) {
      throw new Error('Pi child output-recovery failure omitted the oversized original');
    }
    const observed = this.observedFromRecords(parsed.records);
    return {
      usage: observed.usage,
      provider: final.provider,
      model: final.model,
      qualifiedId: `${final.provider}/${final.model}`,
      events: parsed.events,
      diagnostics: parsed.diagnostics,
      outputRecovery,
    };
  }

  finish(
    response: Buffer,
    stderr: Buffer,
  ): {
    text: string;
    usage: FusionUsage;
    firstRequestUsage: FusionUsage;
    providerRequestCount: number;
    provider: string;
    model: string;
    qualifiedId: string;
    events: Buffer;
    diagnostics: Buffer;
    outputRecovery: ParsedCandidateOutputRecovery | undefined;
  } {
    const parsed = parseFusionChildStderr(stderr);
    const runtimeGuard = parseFusionRuntimeGuard(stderr);
    if (runtimeGuard !== undefined) {
      throw new Error(`Pi child runtime guard refused the run: ${runtimeGuard.message}`);
    }
    const settlement = parseFusionChildSettlement(stderr);
    if (settlement === undefined) throw new Error('Pi child emitted no terminal result settlement');
    const expectedSettlement = buildFusionChildSettlement(parsed.records);
    if (JSON.stringify(settlement) !== JSON.stringify(expectedSettlement)) {
      throw new Error('Pi child terminal result settlement does not match the metadata stream');
    }
    if (parsed.diagnostics.includes(PI_EXTENSION_ERROR_PREFIX_BYTES)) {
      throw new Error('Pi child reported an extension error diagnostic');
    }
    const final = parsed.records.at(-1);
    if (final === undefined) throw new Error('Pi child emitted no compact result metadata');
    for (const record of parsed.records) this.assertModel(record);
    this.assertCacheObservationOrdinals(parsed.records);
    this.assertTranscriptStopReasons(parsed.records);
    if (settlement.status !== 'complete') {
      throw new Error(
        `Pi child terminal result settlement failed: ${settlement.failure_reason ?? 'unknown'}`,
      );
    }
    const observed = this.observedFromRecords(parsed.records);
    const text = reconstructFinalText(response, final);
    return {
      text,
      usage: observed.usage,
      firstRequestUsage: cloneFusionUsage(parsed.records[0]?.usage ?? createEmptyFusionUsage()),
      providerRequestCount: parsed.records.length,
      provider: final.provider,
      model: final.model,
      qualifiedId: `${final.provider}/${final.model}`,
      events: parsed.events,
      diagnostics: parsed.diagnostics,
      outputRecovery: parsedCandidateOutputRecovery(parsed.records, 'completed'),
    };
  }

  private assertModel(record: FusionChildResultMetadata): void {
    if (record.provider !== this.expectedProvider || record.model !== this.expectedModel) {
      throw new Error(
        `Pi assistant model mismatch: expected ${this.expectedProvider}/${this.expectedModel}, observed ${record.provider}/${record.model}`,
      );
    }
  }

  private assertCacheObservationOrdinals(records: readonly FusionChildResultMetadata[]): void {
    let priorOrdinal = 0;
    for (const [index, record] of records.entries()) {
      const ordinal = record.cache_observation.request_ordinal;
      if (ordinal <= priorOrdinal) {
        throw new Error(
          `Pi child cache observation ordinal is not increasing at result ${String(index)}: previous ${String(priorOrdinal)}, observed ${String(ordinal)}`,
        );
      }
      priorOrdinal = ordinal;
    }
  }

  private assertTranscriptStopReasons(records: readonly FusionChildResultMetadata[]): void {
    for (const [index, record] of records.entries()) {
      const isFinal = index === records.length - 1;
      if (isFinal) {
        if (record.stop_reason !== 'stop') {
          throw new Error(this.stopReasonError('final', 'stop', record.stop_reason, true));
        }
      } else if (
        record.stop_reason !== 'toolUse' &&
        !isRecoverableFusionChildErrorRecord(record) &&
        record.output_contract.recovery_role !== 'oversized_original'
      ) {
        throw new Error(
          this.stopReasonError(
            `non-final record ${index}`,
            'toolUse, a settled zero-usage retry marker, or one oversized original',
            record.stop_reason,
            true,
          ),
        );
      }
    }
  }

  private stopReasonError(
    position: string,
    expected: string,
    observed: string,
    includeStopDetail: boolean,
  ): string {
    const prefix = `Pi ${position} stop reason is not ${expected}: ${observed}`;
    if (!includeStopDetail) return prefix;
    switch (observed) {
      case 'length':
        return `${prefix} (model output was truncated)`;
      case 'error':
        return `${prefix} (Pi reported an error stop)`;
      case 'aborted':
        return `${prefix} (Pi reported an aborted stop)`;
      case 'pending':
        return `${prefix} (Pi reported a pending stop)`;
      default:
        return prefix;
    }
  }

  private observedFromRecords(
    records: readonly FusionChildResultMetadata[],
  ): ObservedChildSnapshot {
    const usage = createEmptyFusionUsage();
    for (const record of records) addFusionUsage(usage, record.usage);
    const final = records.at(-1);
    if (final === undefined) return { usage };
    return {
      usage,
      provider: final.provider,
      model: final.model,
      qualifiedId: `${final.provider}/${final.model}`,
    };
  }
}

function appendCapped(
  chunks: Buffer[],
  currentBytes: number,
  chunk: Buffer,
  limit: number,
): { bytes: number; accepted: Buffer; exceeded: boolean } {
  if (currentBytes >= limit)
    return { bytes: currentBytes, accepted: Buffer.alloc(0), exceeded: true };
  const remaining = limit - currentBytes;
  if (chunk.length <= remaining) {
    chunks.push(chunk);
    return { bytes: currentBytes + chunk.length, accepted: chunk, exceeded: false };
  }
  const accepted = chunk.subarray(0, remaining);
  if (accepted.length > 0) chunks.push(accepted);
  return { bytes: limit, accepted, exceeded: true };
}

function codeOf(error: unknown): string | undefined {
  return isJsonObject(error) && typeof error['code'] === 'string' ? error['code'] : undefined;
}

function isTransientSpawnCode(code: string | undefined): boolean {
  return code === 'EAGAIN' || code === 'EMFILE' || code === 'ENFILE';
}

function childError(
  message: string,
  code: FusionError['code'],
  input: Pick<RunPiChildOptions, 'stage' | 'slot' | 'attempt'>,
  transient = false,
  childCreated = true,
): FusionError {
  const details: FusionErrorDetails = {
    code,
    stage: input.stage,
    attempt: input.attempt,
    transient,
    childCreated,
  };
  if (input.slot !== undefined) details.slot = input.slot;
  return new FusionError(message, details);
}

function withCleanupErrors(error: FusionError, cleanupErrors: readonly string[]): FusionError {
  if (cleanupErrors.length === 0) return error;
  const details: FusionErrorDetails = {
    code: error.code,
    transient: error.transient,
    childCreated: error.childCreated,
  };
  if (error.stage !== undefined) details.stage = error.stage;
  if (error.slot !== undefined) details.slot = error.slot;
  if (error.attempt !== undefined) details.attempt = error.attempt;
  if (error.artifactDir !== undefined) details.artifactDir = error.artifactDir;
  return new FusionError(
    `${error.message}; process cleanup issues: ${cleanupErrors.join('; ')}`,
    details,
  );
}

function defaultSpawn(command: string, args: string[], options: SpawnOptions): FusionChildProcess {
  return nodeSpawn(command, args, options);
}

/**
 * Termination timers must keep the event loop alive.
 *
 * The SIGTERM grace, SIGKILL wait, overall timeout, and idle timeout timers
 * are the only things that settle the run promise when a child stops emitting events. An
 * unref'd timer lets the loop drain first, leaving the promise pending forever
 * ("Promise resolution is still pending but the event loop has already
 * resolved"). Every timer stored here is cleared in the `finally` of
 * `runPiChild` via `cleanupTimers`, so keeping them referenced cannot leak.
 */
function trackTimer(timer: NodeJS.Timeout): NodeJS.Timeout {
  return timer;
}

function rememberCleanupErrors(
  state: ProcessState,
  signal: NodeJS.Signals,
  errors: readonly string[],
): void {
  for (const error of errors) state.cleanupErrors.push(`${signal}: ${error}`);
}

function terminateChild(
  child: FusionChildProcess,
  state: ProcessState,
  platform: NodeJS.Platform,
  killProcess: FusionKillProcess,
  killGraceMs: number,
  sigkillWaitMs: number,
  settleSyntheticClose: (close: CloseRecord) => void,
): void {
  if (state.settled || state.terminationStarted) return;
  state.terminationStarted = true;
  const termResult = sendSignal(child, platform, killProcess, 'SIGTERM');
  rememberCleanupErrors(state, 'SIGTERM', termResult.errors);
  if (!termResult.sent && state.primaryError === undefined) {
    state.primaryError = new FusionError(
      `Pi child SIGTERM failed: ${termResult.errors.join('; ')}`,
      {
        code: 'child_exit_failed',
        childCreated: true,
      },
    );
  }
  state.termTimer = trackTimer(
    setTimeout(() => {
      if (state.settled) return;
      const killResult = sendSignal(child, platform, killProcess, 'SIGKILL');
      rememberCleanupErrors(state, 'SIGKILL', killResult.errors);
      if (!killResult.sent && state.primaryError === undefined) {
        state.primaryError = new FusionError(
          `Pi child SIGKILL failed: ${killResult.errors.join('; ')}`,
          {
            code: 'child_exit_failed',
            childCreated: true,
          },
        );
      }
    }, killGraceMs),
  );
  state.waitTimer = trackTimer(
    setTimeout(() => {
      if (state.settled) return;
      const message = 'Pi child did not emit close after SIGKILL wait';
      state.cleanupErrors.push(message);
      if (state.primaryError === undefined) {
        state.primaryError = new FusionError(message, {
          code: 'child_exit_failed',
          childCreated: true,
        });
      }
      settleSyntheticClose({ code: null, signal: 'SIGKILL' });
    }, killGraceMs + sigkillWaitMs),
  );
}

function sendSignal(
  child: FusionChildProcess,
  platform: NodeJS.Platform,
  killProcess: FusionKillProcess,
  signal: NodeJS.Signals,
): { sent: boolean; errors: readonly string[] } {
  const errors: string[] = [];
  const pid = child.pid;
  if (platform !== 'win32' && pid !== undefined) {
    try {
      if (killProcess(-pid, signal)) return { sent: true, errors };
      errors.push('process group kill returned false');
    } catch (error) {
      errors.push(
        `process group kill failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  try {
    if (child.kill(signal)) return { sent: true, errors };
    errors.push('child kill returned false');
  } catch (error) {
    errors.push(`child kill failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { sent: false, errors };
}

function cleanupTimers(state: ProcessState): void {
  if (state.termTimer !== undefined) clearTimeout(state.termTimer);
  if (state.waitTimer !== undefined) clearTimeout(state.waitTimer);
  if (state.timeoutTimer !== undefined) clearTimeout(state.timeoutTimer);
  if (state.idleTimer !== undefined) clearTimeout(state.idleTimer);
  state.termTimer = undefined;
  state.waitTimer = undefined;
  state.timeoutTimer = undefined;
  state.idleTimer = undefined;
}

async function writePromptToStdin(child: FusionChildProcess, prompt: string): Promise<void> {
  const stdin = child.stdin;
  if (stdin === undefined || stdin === null) throw new Error('Pi child stdin pipe is unavailable');
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      stdin.off('error', fail);
      reject(error);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      stdin.off('error', fail);
      resolve();
    };
    stdin.once('error', fail);
    stdin.write(Buffer.from(prompt, 'utf8'), (error?: Error | null) => {
      if (error !== undefined && error !== null) {
        fail(error);
        return;
      }
      stdin.end(finish);
    });
  });
}

export async function runPiChild(options: RunPiChildOptions): Promise<FusionChildRunResult> {
  if (options.signal?.aborted) {
    throw childError(
      'Pi child launch cancelled before spawn',
      'child_cancelled',
      options,
      false,
      false,
    );
  }
  const spawnImpl = options.spawn ?? defaultSpawn;
  const killProcess = options.killProcess ?? process.kill.bind(process);
  const platform = options.platform ?? process.platform;
  const capability = options.capability ?? FUSION_NO_TOOLS_CAPABILITY;
  const env = fusionPiChildEnv(options.env ?? process.env, options.model.provider);
  if (options.candidateOutputRecoveryPath !== undefined) {
    if (options.stage !== 'candidate') {
      throw childError(
        'candidate output recovery may be enabled only for candidate children',
        'orchestration_failed',
        options,
        false,
        false,
      );
    }
    env[FUSION_CANDIDATE_OUTPUT_RECOVERY_PATH_ENV] = options.candidateOutputRecoveryPath;
  }
  if (capability !== 'reason') {
    if (options.toolCallLogPath === undefined) {
      throw childError(
        `fusion ${capability} child requires a tool-call log path`,
        'orchestration_failed',
        options,
        false,
        false,
      );
    }
    env[FUSION_TOOL_CALL_LOG_PATH_ENV] = options.toolCallLogPath;
    if (capability === 'research') {
      if (options.sourcePolicy === undefined) {
        throw childError(
          'fusion research child requires a source-policy path and hash',
          'orchestration_failed',
          options,
          false,
          false,
        );
      }
      env[FUSION_RESEARCH_ENABLED_ENV] = '1';
      env[FUSION_SOURCE_POLICY_PATH_ENV] = options.sourcePolicy.path;
      env[FUSION_SOURCE_POLICY_SHA256_ENV] = options.sourcePolicy.sha256;
    }
  }
  const stdoutLimit = options.stdoutLimitBytes ?? FUSION_CHILD_STDOUT_LIMIT_BYTES;
  const stderrLimit = options.stderrLimitBytes ?? FUSION_CHILD_STDERR_LIMIT_BYTES;
  const timeoutMs = options.timeoutMs ?? FUSION_CHILD_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? FUSION_CHILD_IDLE_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? FUSION_CHILD_KILL_GRACE_MS;
  const sigkillWaitMs = options.sigkillWaitMs ?? FUSION_CHILD_SIGKILL_WAIT_MS;
  const argv = buildFusionPiChildArgv(
    options.model,
    options.systemPrompt,
    options.childExtensionPath ?? resolveFusionChildExtensionPath(),
    capability,
  );
  const parser = new FusionPiCompactResultParser(options.model.provider, options.model.model);
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const state: ProcessState = {
    primaryError: undefined,
    cleanupErrors: [],
    terminationStarted: false,
    termTimer: undefined,
    waitTimer: undefined,
    timeoutTimer: undefined,
    idleTimer: undefined,
    settled: false,
  };

  let child: FusionChildProcess;
  try {
    const launchDeps =
      options.piLaunchDependencies === undefined
        ? { platform }
        : { ...options.piLaunchDependencies, platform };
    const launch = resolvePiLaunch(launchDeps);
    assertWindowsCommandLineWithinLimit(launch, argv, platform, `fusion-${options.stage}`);
    child = spawnImpl(launch.executable, piLaunchArgv(launch, argv), {
      cwd: options.cwd,
      detached: platform !== 'win32',
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    });
  } catch (error) {
    const code = codeOf(error);
    throw childError(
      `Pi child spawn failed: ${error instanceof Error ? error.message : String(error)}`,
      'child_spawn_failed',
      options,
      isTransientSpawnCode(code),
      false,
    );
  }

  let settleClose: (close: CloseRecord) => void = () => undefined;
  const closePromise = new Promise<CloseRecord>((resolve) => {
    settleClose = (close) => {
      if (state.settled) return;
      state.settled = true;
      resolve(close);
    };
  });

  const resetIdleTimer = () => {
    if (state.settled) return;
    if (state.idleTimer !== undefined) clearTimeout(state.idleTimer);
    state.idleTimer = trackTimer(
      setTimeout(() => {
        if (state.settled) return;
        if (state.primaryError === undefined) {
          state.primaryError = childError(
            `Pi child produced no output for ${String(idleTimeoutMs)}ms (stalled)`,
            'child_timeout',
            options,
          );
        }
        terminateChild(
          child,
          state,
          platform,
          killProcess,
          killGraceMs,
          sigkillWaitMs,
          settleClose,
        );
      }, idleTimeoutMs),
    );
  };
  const abortListener = () => {
    if (state.settled) return;
    if (state.primaryError === undefined) {
      state.primaryError = childError('Pi child cancelled', 'child_cancelled', options);
    }
    terminateChild(child, state, platform, killProcess, killGraceMs, sigkillWaitMs, settleClose);
  };
  const stdoutListener = (data: Buffer | string) => {
    resetIdleTimer();
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const appended = appendCapped(stdoutChunks, stdoutBytes, chunk, stdoutLimit);
    stdoutBytes = appended.bytes;
    if (appended.exceeded && state.primaryError === undefined) {
      state.primaryError = childError(
        `Pi child final response exceeded ${String(stdoutLimit)} bytes`,
        'child_output_cap',
        options,
      );
      terminateChild(child, state, platform, killProcess, killGraceMs, sigkillWaitMs, settleClose);
    }
  };
  const stderrListener = (data: Buffer | string) => {
    resetIdleTimer();
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const appended = appendCapped(stderrChunks, stderrBytes, chunk, stderrLimit);
    stderrBytes = appended.bytes;
    if (appended.exceeded && state.primaryError === undefined) {
      state.primaryError = childError(
        `Pi child stderr exceeded ${String(stderrLimit)} bytes`,
        'child_output_cap',
        options,
      );
      terminateChild(child, state, platform, killProcess, killGraceMs, sigkillWaitMs, settleClose);
    }
  };
  const errorListener = (error: Error) => {
    if (state.settled) return;
    if (state.primaryError === undefined) {
      const code = codeOf(error);
      const childCreated = child.pid !== undefined;
      state.primaryError = childError(
        `Pi child process error: ${error.message}`,
        'child_spawn_failed',
        options,
        isTransientSpawnCode(code),
        childCreated,
      );
    }
    if (child.pid === undefined) settleClose({ code: null, signal: null });
  };
  const closeListener = (code: number | null, signal: NodeJS.Signals | null) => {
    settleClose({ code, signal });
  };

  child.stdout?.on('data', stdoutListener);
  child.stderr?.on('data', stderrListener);
  child.once('error', errorListener);
  child.once('close', closeListener);
  options.signal?.addEventListener('abort', abortListener, { once: true });
  if (options.signal?.aborted) abortListener();
  resetIdleTimer();
  state.timeoutTimer = trackTimer(
    setTimeout(() => {
      if (state.primaryError === undefined) {
        state.primaryError = childError(
          `Pi child timed out after ${String(timeoutMs)}ms`,
          'child_timeout',
          options,
        );
      }
      terminateChild(child, state, platform, killProcess, killGraceMs, sigkillWaitMs, settleClose);
    }, timeoutMs),
  );

  try {
    try {
      if (state.primaryError === undefined) await writePromptToStdin(child, options.userPrompt);
    } catch (error) {
      if (state.primaryError === undefined) {
        state.primaryError = childError(
          `Pi child stdin write failed: ${error instanceof Error ? error.message : String(error)}`,
          'child_stdin_failed',
          options,
        );
      }
      terminateChild(child, state, platform, killProcess, killGraceMs, sigkillWaitMs, settleClose);
    }

    const close = await closePromise;
    const response = Buffer.concat(stdoutChunks);
    const rawStderr = Buffer.concat(stderrChunks);
    const observed = parser.snapshot(rawStderr);
    let compactEvents: Buffer = Buffer.alloc(0);
    let diagnostics: Buffer = rawStderr;
    try {
      const decoded = parseFusionChildStderr(rawStderr);
      compactEvents = decoded.events;
      diagnostics = decoded.diagnostics;
    } catch {
      // A primary process/cap error remains authoritative; malformed metadata is
      // surfaced below when the child otherwise exits successfully.
    }
    const readPartialOutputRecovery = async (): Promise<
      FusionCandidateOutputRecovery | undefined
    > => {
      let parsedRecords: readonly FusionChildResultMetadata[];
      try {
        parsedRecords = parseFusionChildStderr(rawStderr).records;
      } catch {
        return undefined;
      }
      const evidence = parsedCandidateOutputRecovery(parsedRecords, 'failed');
      if (evidence === undefined) return undefined;
      if (options.candidateOutputRecoveryPath === undefined) {
        throw new Error('fusion child emitted output-recovery evidence without an artifact path');
      }
      return readCandidateOutputRecovery(options.candidateOutputRecoveryPath, evidence);
    };
    const primary = state.primaryError;
    if (primary !== undefined) {
      let outputRecovery: FusionCandidateOutputRecovery | undefined;
      try {
        outputRecovery = await readPartialOutputRecovery();
      } catch (error) {
        state.cleanupErrors.push(
          `output recovery evidence invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw new FusionChildRunError(
        withCleanupErrors(primary, state.cleanupErrors),
        compactEvents,
        response,
        diagnostics,
        close,
        observed,
        outputRecovery,
      );
    }
    let terminalSettlement: FusionChildSettlementRecord | undefined;
    try {
      terminalSettlement = parseFusionChildSettlement(rawStderr);
    } catch (error) {
      throw new FusionChildRunError(
        withCleanupErrors(
          childError(
            `Pi child terminal settlement invalid: ${error instanceof Error ? error.message : String(error)}`,
            'child_event_invalid',
            options,
          ),
          state.cleanupErrors,
        ),
        compactEvents,
        response,
        diagnostics,
        close,
        observed,
      );
    }
    if (terminalSettlement?.failure_reason === 'output_recovery') {
      try {
        const failure = parser.finishOutputRecoveryFailure(response, rawStderr);
        if (options.candidateOutputRecoveryPath === undefined) {
          throw new Error(
            'fusion child output-recovery failure omitted the configured artifact path',
          );
        }
        const outputRecovery = await readCandidateOutputRecovery(
          options.candidateOutputRecoveryPath,
          failure.outputRecovery,
        );
        const recoveryMessage =
          outputRecovery.replacement_json_rendered_bytes === null
            ? `Pi child could not complete its one allowed same-session candidate compression continuation; the ${String(outputRecovery.original_json_rendered_bytes)}-byte original is preserved and nothing was truncated`
            : `Pi child compressed candidate response is still ${String(outputRecovery.replacement_json_rendered_bytes)} JSON-rendered bytes, exceeding the ${String(outputRecovery.limit_bytes)}-byte output contract; both responses are preserved and nothing was truncated`;
        throw new FusionChildRunError(
          withCleanupErrors(
            childError(recoveryMessage, 'child_output_cap', options),
            state.cleanupErrors,
          ),
          failure.events,
          response,
          failure.diagnostics,
          close,
          {
            usage: failure.usage,
            provider: failure.provider,
            model: failure.model,
            qualifiedId: failure.qualifiedId,
          },
          outputRecovery,
        );
      } catch (error) {
        if (error instanceof FusionChildRunError) throw error;
        throw new FusionChildRunError(
          withCleanupErrors(
            childError(
              `Pi child output-recovery evidence invalid: ${error instanceof Error ? error.message : String(error)}`,
              'child_event_invalid',
              options,
            ),
            state.cleanupErrors,
          ),
          compactEvents,
          response,
          diagnostics,
          close,
          observed,
        );
      }
    }
    if (close.code !== 0 || close.signal !== null) {
      let runtimeGuard: FusionRuntimeGuardRecord | undefined;
      try {
        runtimeGuard = parseFusionRuntimeGuard(rawStderr);
        if (runtimeGuard !== undefined) {
          assertFusionRuntimeGuardMatchesModel(runtimeGuard, options.model);
        }
      } catch (error) {
        throw new FusionChildRunError(
          withCleanupErrors(
            childError(
              `Pi child runtime guard evidence invalid: ${error instanceof Error ? error.message : String(error)}`,
              'child_event_invalid',
              options,
            ),
            state.cleanupErrors,
          ),
          compactEvents,
          response,
          diagnostics,
          close,
          observed,
        );
      }
      throw new FusionChildRunError(
        withCleanupErrors(
          childError(
            runtimeGuard?.message ??
              `Pi child exited with code ${close.code === null ? 'null' : String(close.code)}${close.signal === null ? '' : ` (${close.signal})`}`,
            runtimeGuard === undefined
              ? 'child_exit_failed'
              : runtimeGuard.code === 'claude_cache_policy'
                ? 'child_cache_policy_invalid'
                : runtimeGuard.code === 'provider_payload_invalid'
                  ? 'child_runtime_payload_invalid'
                  : 'child_runtime_limit_exceeded',
            options,
          ),
          state.cleanupErrors,
        ),
        compactEvents,
        response,
        diagnostics,
        close,
        observed,
      );
    }
    let parsed: ReturnType<FusionPiCompactResultParser['finish']>;
    try {
      parsed = parser.finish(response, rawStderr);
    } catch (error) {
      throw new FusionChildRunError(
        withCleanupErrors(
          childError(
            `Pi child compact result invalid: ${error instanceof Error ? error.message : String(error)}`,
            'child_event_invalid',
            options,
          ),
          state.cleanupErrors,
        ),
        compactEvents,
        response,
        diagnostics,
        close,
        observed,
      );
    }
    let outputRecovery: FusionCandidateOutputRecovery | undefined;
    if (parsed.outputRecovery !== undefined) {
      if (options.candidateOutputRecoveryPath === undefined) {
        throw new FusionChildRunError(
          childError(
            'Pi child output-recovery evidence has no configured artifact path',
            'child_event_invalid',
            options,
          ),
          parsed.events,
          response,
          parsed.diagnostics,
          close,
          observed,
        );
      }
      try {
        outputRecovery = await readCandidateOutputRecovery(
          options.candidateOutputRecoveryPath,
          parsed.outputRecovery,
        );
      } catch (error) {
        throw new FusionChildRunError(
          childError(
            `Pi child output-recovery artifact invalid: ${error instanceof Error ? error.message : String(error)}`,
            'child_event_invalid',
            options,
          ),
          parsed.events,
          response,
          parsed.diagnostics,
          close,
          observed,
        );
      }
    }
    let toolCallTrace: FusionToolCallTrace | undefined;
    if (capability !== 'reason') {
      // The launch path above refuses to spawn a tool-enabled child without a log path, so
      // this is unreachable. Assert rather than defaulting: a `?? ''` here would silently
      // read an empty path if that guard were ever refactored away, turning a missing
      // audit trail into a successful run.
      const logPath = options.toolCallLogPath;
      if (logPath === undefined) {
        throw childError(
          `fusion ${capability} child completed without a tool-call log path`,
          'orchestration_failed',
          options,
        );
      }
      try {
        toolCallTrace = await readFusionToolCallLog(logPath);
        await assertFusionToolCallLogSeal(logPath, toolCallTrace);
        await assertCompletedToolPolicy(toolCallTrace, capability, options.sourcePolicy);
      } catch (error) {
        throw new FusionChildRunError(
          withCleanupErrors(
            childError(
              `Pi child tool-call log invalid: ${error instanceof Error ? error.message : String(error)}`,
              'child_event_invalid',
              options,
            ),
            state.cleanupErrors,
          ),
          compactEvents,
          response,
          diagnostics,
          close,
          observed,
          outputRecovery,
        );
      }
    }
    const result: FusionChildRunResult = {
      stage: options.stage,
      attempt: options.attempt,
      provider: parsed.provider,
      model: parsed.model,
      qualifiedId: parsed.qualifiedId,
      text: parsed.text,
      usage: parsed.usage,
      firstRequestUsage: parsed.firstRequestUsage,
      providerRequestCount: parsed.providerRequestCount,
      events: parsed.events,
      stderr: parsed.diagnostics,
      exitCode: close.code,
      signal: close.signal,
    };
    if (options.slot !== undefined) result.slot = options.slot;
    if (outputRecovery !== undefined) result.outputRecovery = outputRecovery;
    if (toolCallTrace !== undefined) result.toolCallTrace = toolCallTrace;
    return result;
  } finally {
    cleanupTimers(state);
    options.signal?.removeEventListener('abort', abortListener);
    child.stdout?.off('data', stdoutListener);
    child.stderr?.off('data', stderrListener);
    child.off('error', errorListener);
    child.off('close', closeListener);
  }
}
