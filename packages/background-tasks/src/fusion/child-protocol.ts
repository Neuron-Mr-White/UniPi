import { createHash } from 'node:crypto';
import type { Usage } from '@earendil-works/pi-ai';
import type { FusionClaudeCacheObservation } from './claude-cache.js';
import {
  FUSION_CANDIDATE_MAX_OUTPUT_BYTES,
  fusionJsonRenderedTextBytes,
} from './output-contract.js';

export const FUSION_CHILD_RESULT_SCHEMA_VERSION =
  'pi-background-tasks.fusion-child-result.v4' as const;
export const FUSION_CHILD_RESULT_PREFIX = '\u001ePI_FUSION_CHILD_RESULT ';
export const FUSION_CHILD_SETTLEMENT_SCHEMA_VERSION =
  'pi-background-tasks.fusion-child-settlement.v3' as const;
export const FUSION_CHILD_SETTLEMENT_PREFIX = '\u001ePI_FUSION_CHILD_SETTLEMENT ';
export const FUSION_TOOL_CALL_LOG_PATH_ENV = 'PI_FUSION_TOOL_CALL_LOG_PATH';
export const FUSION_CANDIDATE_OUTPUT_RECOVERY_PATH_ENV = 'PI_FUSION_CANDIDATE_OUTPUT_RECOVERY_PATH';
export const FUSION_RESEARCH_ENABLED_ENV = 'PI_FUSION_RESEARCH_ENABLED';
export const FUSION_SOURCE_POLICY_PATH_ENV = 'PI_FUSION_SOURCE_POLICY_PATH';
export const FUSION_SOURCE_POLICY_SHA256_ENV = 'PI_FUSION_SOURCE_POLICY_SHA256';
export const FUSION_TOOL_CALL_SEAL_SCHEMA_VERSION =
  'pi-background-tasks.fusion-tool-call-seal.v1' as const;
export const FUSION_TOOL_CALL_SEAL_SUFFIX = '.seal.json';
export const FUSION_RUNTIME_GUARD_SCHEMA_VERSION =
  'pi-background-tasks.fusion-runtime-guard.v2' as const;
export const FUSION_RUNTIME_GUARD_PREFIX = '\u001ePI_FUSION_RUNTIME_GUARD ';
export const FUSION_CHILD_MAX_PROVIDER_REQUESTS = 550;
export const FUSION_CHILD_MAX_TOOL_CALLS = 600;

/**
 * Aggregate ceiling on tool-result bytes a single candidate child may accumulate.
 *
 * The byte ceiling complements the tool/request count limits and pre-spawn stage
 * budgets. It remains an independent bound on total tool material across the child run.
 */
export const FUSION_CHILD_MAX_TOTAL_TOOL_RESULT_BYTES = 32 * 1024 * 1024;

export type FusionRuntimeGuardCode =
  | 'provider_request_limit'
  | 'provider_payload_invalid'
  | 'claude_cache_policy'
  | 'tool_call_limit';

export interface FusionRuntimeGuardRecord {
  schema_version: typeof FUSION_RUNTIME_GUARD_SCHEMA_VERSION;
  code: FusionRuntimeGuardCode;
  provider: string;
  model: string;
  request_ordinal: number;
  tool_call_count: number;
  payload_bytes: number;
  payload_sha256: string;
  message: string;
}

export interface FusionChildTextBlockMetadata {
  utf8_bytes: number;
  sha256: string;
}

export type FusionChildResultUsageMetadata = Usage;

export type FusionChildOutputRecoveryRole = 'none' | 'oversized_original' | 'replacement';

export interface FusionChildOutputContractMetadata {
  json_rendered_bytes: number;
  candidate_limit_bytes: number | null;
  recovery_role: FusionChildOutputRecoveryRole;
}

export interface FusionChildResultMetadata {
  schema_version: typeof FUSION_CHILD_RESULT_SCHEMA_VERSION;
  provider: string;
  model: string;
  stop_reason: string;
  text_blocks: FusionChildTextBlockMetadata[];
  text_sha256: string;
  usage: FusionChildResultUsageMetadata;
  cache_observation: FusionClaudeCacheObservation;
  output_contract: FusionChildOutputContractMetadata;
}

export type FusionChildSettlementFailureReason =
  | 'no_records'
  | 'final_not_stop'
  | 'invalid_non_final'
  | 'runtime_guard'
  | 'cache_observation'
  | 'output_recovery';

export interface FusionChildSettlementRecord {
  schema_version: typeof FUSION_CHILD_SETTLEMENT_SCHEMA_VERSION;
  status: 'complete' | 'failed';
  record_count: number;
  records_sha256: string;
  final_record_index: number | null;
  final_text_sha256: string | null;
  recovered_error_ordinals: number[];
  recovered_output_cap_ordinals: number[];
  failure_reason: FusionChildSettlementFailureReason | null;
}

function protocolSha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function serializeFusionChildResultRecords(
  records: readonly FusionChildResultMetadata[],
): Buffer {
  return Buffer.from(
    records.length === 0 ? '' : `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
}

function hasZeroUsage(record: FusionChildResultMetadata): boolean {
  const usage = record.usage;
  return (
    usage.input === 0 &&
    usage.output === 0 &&
    usage.cacheRead === 0 &&
    usage.cacheWrite === 0 &&
    usage.totalTokens === 0 &&
    usage.cost.input === 0 &&
    usage.cost.output === 0 &&
    usage.cost.cacheRead === 0 &&
    usage.cost.cacheWrite === 0 &&
    usage.cost.total === 0
  );
}

export function isRecoverableFusionChildErrorRecord(record: FusionChildResultMetadata): boolean {
  return (
    record.stop_reason === 'error' &&
    record.text_blocks.length === 0 &&
    record.text_sha256 === protocolSha256(Buffer.alloc(0)) &&
    hasZeroUsage(record) &&
    record.output_contract.recovery_role === 'none'
  );
}

function isOversizedOriginal(record: FusionChildResultMetadata): boolean {
  const output = record.output_contract;
  return (
    output.recovery_role === 'oversized_original' &&
    output.candidate_limit_bytes === FUSION_CANDIDATE_MAX_OUTPUT_BYTES &&
    output.json_rendered_bytes > FUSION_CANDIDATE_MAX_OUTPUT_BYTES &&
    record.stop_reason === 'stop'
  );
}

function outputRecoveryProtocolInvalid(records: readonly FusionChildResultMetadata[]): boolean {
  const originals = records.flatMap((record, ordinal) =>
    record.output_contract.recovery_role === 'oversized_original' ? [ordinal] : [],
  );
  const replacements = records.flatMap((record, ordinal) =>
    record.output_contract.recovery_role === 'replacement' ? [ordinal] : [],
  );
  for (const record of records) {
    const output = record.output_contract;
    if (
      output.candidate_limit_bytes !== null &&
      output.candidate_limit_bytes !== FUSION_CANDIDATE_MAX_OUTPUT_BYTES
    ) {
      return true;
    }
    if (output.recovery_role !== 'none' && output.candidate_limit_bytes === null) return true;
    if (output.recovery_role === 'oversized_original' && !isOversizedOriginal(record)) return true;
  }
  if (originals.length === 0 && replacements.length === 0) return false;
  if (originals.length !== 1 || replacements.length !== 1) return true;
  const original = originals[0];
  const replacement = replacements[0];
  return (
    original === undefined ||
    replacement === undefined ||
    original !== records.length - 2 ||
    replacement !== records.length - 1
  );
}

function finalCandidateOutputExceedsContract(
  records: readonly FusionChildResultMetadata[],
): boolean {
  const final = records.at(-1);
  if (final === undefined) return false;
  const output = final.output_contract;
  return (
    output.candidate_limit_bytes === FUSION_CANDIDATE_MAX_OUTPUT_BYTES &&
    output.json_rendered_bytes > FUSION_CANDIDATE_MAX_OUTPUT_BYTES
  );
}

export function buildFusionChildSettlement(
  records: readonly FusionChildResultMetadata[],
  runtimeGuardFailed = false,
  cacheObservationFailed = false,
  outputRecoveryFailed = false,
): FusionChildSettlementRecord {
  const finalRecordIndex = records.length === 0 ? null : records.length - 1;
  const final = records.at(-1);
  const recoveredErrorOrdinals = records.flatMap((record, ordinal) =>
    ordinal < records.length - 1 && isRecoverableFusionChildErrorRecord(record) ? [ordinal] : [],
  );
  const recoveredOutputCapOrdinals = records.flatMap((record, ordinal) =>
    ordinal < records.length - 1 && isOversizedOriginal(record) ? [ordinal] : [],
  );
  const invalidRecovery = outputRecoveryProtocolInvalid(records);
  const invalidNonFinal = records.some(
    (record, ordinal) =>
      ordinal < records.length - 1 &&
      record.stop_reason !== 'toolUse' &&
      !isRecoverableFusionChildErrorRecord(record) &&
      !isOversizedOriginal(record),
  );
  let failureReason: FusionChildSettlementFailureReason | null = null;
  if (runtimeGuardFailed) failureReason = 'runtime_guard';
  else if (cacheObservationFailed) failureReason = 'cache_observation';
  else if (final === undefined) failureReason = 'no_records';
  else if (final.stop_reason !== 'stop') failureReason = 'final_not_stop';
  else if (
    outputRecoveryFailed ||
    invalidRecovery ||
    finalCandidateOutputExceedsContract(records)
  ) {
    failureReason = 'output_recovery';
  } else if (invalidNonFinal) failureReason = 'invalid_non_final';
  return {
    schema_version: FUSION_CHILD_SETTLEMENT_SCHEMA_VERSION,
    status: failureReason === null ? 'complete' : 'failed',
    record_count: records.length,
    records_sha256: protocolSha256(serializeFusionChildResultRecords(records)),
    final_record_index: finalRecordIndex,
    final_text_sha256: final?.text_sha256 ?? null,
    recovered_error_ordinals: recoveredErrorOrdinals,
    recovered_output_cap_ordinals: recoveredOutputCapOrdinals,
    failure_reason: failureReason,
  };
}

export function buildFusionChildResultMetadata(
  message: {
    provider: string;
    model: string;
    stopReason: string;
    content: ReadonlyArray<{ type: string; text?: string }>;
    usage: Usage;
  },
  cacheObservation: FusionClaudeCacheObservation,
  outputContract: {
    candidateLimitBytes: number | null;
    recoveryRole: FusionChildOutputRecoveryRole;
  } = { candidateLimitBytes: null, recoveryRole: 'none' },
): FusionChildResultMetadata {
  if (
    outputContract.candidateLimitBytes !== null &&
    outputContract.candidateLimitBytes !== FUSION_CANDIDATE_MAX_OUTPUT_BYTES
  ) {
    throw new Error('fusion child candidate output limit does not match the shared contract');
  }
  if (outputContract.recoveryRole !== 'none' && outputContract.candidateLimitBytes === null) {
    throw new Error('fusion child output recovery role requires the candidate output contract');
  }
  const textBlocks = message.content.flatMap((part) =>
    part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
  );
  const text = textBlocks.join('');
  const usage: FusionChildResultUsageMetadata = {
    input: message.usage.input,
    output: message.usage.output,
    cacheRead: message.usage.cacheRead,
    cacheWrite: message.usage.cacheWrite,
    ...(message.usage.cacheWrite1h === undefined
      ? {}
      : { cacheWrite1h: message.usage.cacheWrite1h }),
    ...(message.usage["reasoning" as keyof typeof message.usage] === undefined
      ? {}
      : { reasoning: message.usage["reasoning" as keyof typeof message.usage] as number }),
    totalTokens: message.usage.totalTokens,
    cost: {
      input: message.usage.cost.input,
      output: message.usage.cost.output,
      cacheRead: message.usage.cost.cacheRead,
      cacheWrite: message.usage.cost.cacheWrite,
      total: message.usage.cost.total,
    },
  };
  return {
    schema_version: FUSION_CHILD_RESULT_SCHEMA_VERSION,
    provider: message.provider,
    model: message.model,
    stop_reason: message.stopReason,
    text_blocks: textBlocks.map((blockText) => ({
      utf8_bytes: Buffer.byteLength(blockText, 'utf8'),
      sha256: protocolSha256(blockText),
    })),
    text_sha256: protocolSha256(text),
    usage,
    cache_observation: cacheObservation,
    output_contract: {
      json_rendered_bytes: fusionJsonRenderedTextBytes(text),
      candidate_limit_bytes: outputContract.candidateLimitBytes,
      recovery_role: outputContract.recoveryRole,
    },
  };
}
