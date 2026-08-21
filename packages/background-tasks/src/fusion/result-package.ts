import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, sha256Buffer } from '../attested-pi-run.js';
import { parseJsonText, type JsonObject } from '../types.js';
import {
  FUSION_FAILURE_SUMMARY_ATTEMPT_CAP,
  FUSION_FAILURE_SUMMARY_EVIDENCE_CAP,
  FUSION_FAILURE_SUMMARY_INLINE_MESSAGE_BYTES,
  FUSION_FAILURE_SUMMARY_MAX_BYTES,
  assertFusionArtifactBasename,
  buildFusionRunProgress,
} from './artifacts.js';
import {
  FUSION_COMMITTED_RESULT_SCHEMA_VERSION,
  FUSION_FAILURE_SUMMARY_SCHEMA_VERSION,
  FUSION_LEGACY_MANIFEST_SCHEMA_VERSION,
  FUSION_MANIFEST_SCHEMA_VERSION,
  FUSION_RESULT_SCHEMA_VERSION,
  FusionError,
  type FusionArtifactRef,
  type FusionFailureAttemptMetadata,
  type FusionFailureEvidenceArtifact,
  type FusionFailureList,
  type FusionFailureResultView,
  type FusionFailureSummaryV1,
  type FusionResultDetails,
  type FusionRunResult,
  type FusionUsage,
  type FusionWorkflowId,
  type FusionRunProgress,
  type FusionSource,
  type FusionStage,
} from './types.js';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string, artifactDir: string): never {
  throw new FusionError(`fusion committed result invalid: ${message}`, {
    code: 'artifact_error',
    childCreated: true,
    artifactDir,
  });
}

function assertOnlyKeys(
  value: JsonObject,
  allowed: readonly string[],
  label: string,
  artifactDir: string,
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0)
    fail(`${label} contains unexpected keys: ${unexpected.join(', ')}`, artifactDir);
}

function artifactRef(value: unknown, label: string, artifactDir: string): FusionArtifactRef {
  if (!isRecord(value)) fail(`${label} must be an object`, artifactDir);
  assertOnlyKeys(value, ['path', 'byte_length', 'sha256'], label, artifactDir);
  const path = value['path'];
  const byteLength = value['byte_length'];
  const sha256 = value['sha256'];
  if (typeof path !== 'string') fail(`${label}.path is invalid`, artifactDir);
  try {
    assertFusionArtifactBasename(path);
  } catch {
    fail(`${label}.path is invalid`, artifactDir);
  }
  if (!Number.isSafeInteger(byteLength) || Number(byteLength) < 0) {
    fail(`${label}.byte_length is invalid`, artifactDir);
  }
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    fail(`${label}.sha256 is invalid`, artifactDir);
  }
  return { path, byte_length: Number(byteLength), sha256 };
}

function usage(value: unknown, artifactDir: string): FusionUsage {
  if (!isRecord(value)) fail('details.usage must be an object', artifactDir);
  assertOnlyKeys(
    value,
    [
      'input',
      'output',
      'cacheRead',
      'cacheWrite',
      'cacheWrite1h',
      'reasoning',
      'totalTokens',
      'cost',
    ],
    'details.usage',
    artifactDir,
  );
  const cost = value['cost'];
  if (!isRecord(cost)) fail('details.usage.cost must be an object', artifactDir);
  assertOnlyKeys(
    cost,
    ['input', 'output', 'cacheRead', 'cacheWrite', 'total'],
    'details.usage.cost',
    artifactDir,
  );
  const finiteNonnegative = (entry: unknown, label: string): number => {
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0)
      fail(`${label} is invalid`, artifactDir);
    return entry;
  };
  const output = finiteNonnegative(value['output'], 'details.usage.output');
  const cacheWrite = finiteNonnegative(value['cacheWrite'], 'details.usage.cacheWrite');
  const cacheWrite1h =
    value['cacheWrite1h'] === undefined
      ? undefined
      : finiteNonnegative(value['cacheWrite1h'], 'details.usage.cacheWrite1h');
  const reasoning =
    value['reasoning'] === undefined
      ? undefined
      : finiteNonnegative(value['reasoning'], 'details.usage.reasoning');
  if (cacheWrite1h !== undefined && cacheWrite1h > cacheWrite) {
    fail('details.usage.cacheWrite1h must not exceed cacheWrite', artifactDir);
  }
  if (reasoning !== undefined && reasoning > output) {
    fail('details.usage.reasoning must not exceed output', artifactDir);
  }
  return {
    input: finiteNonnegative(value['input'], 'details.usage.input'),
    output,
    cacheRead: finiteNonnegative(value['cacheRead'], 'details.usage.cacheRead'),
    cacheWrite,
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
    ...(reasoning === undefined ? {} : { reasoning }),
    totalTokens: finiteNonnegative(value['totalTokens'], 'details.usage.totalTokens'),
    cost: {
      input: finiteNonnegative(cost['input'], 'details.usage.cost.input'),
      output: finiteNonnegative(cost['output'], 'details.usage.cost.output'),
      cacheRead: finiteNonnegative(cost['cacheRead'], 'details.usage.cost.cacheRead'),
      cacheWrite: finiteNonnegative(cost['cacheWrite'], 'details.usage.cost.cacheWrite'),
      total: finiteNonnegative(cost['total'], 'details.usage.cost.total'),
    },
  };
}

function resultDetails(
  value: unknown,
  expected: { runId: string; workflow: FusionWorkflowId; artifactDir: string },
): FusionResultDetails {
  if (!isRecord(value)) fail('details must be an object', expected.artifactDir);
  assertOnlyKeys(
    value,
    [
      'schema_version',
      'run_id',
      'workflow',
      'source',
      'status',
      'context',
      'tool_policy',
      'artifact_dir',
      'models',
      'evaluator_attempts',
      'usage',
      'budget',
    ],
    'details',
    expected.artifactDir,
  );
  if (value['schema_version'] !== FUSION_RESULT_SCHEMA_VERSION)
    fail('details schema version mismatch', expected.artifactDir);
  if (value['run_id'] !== expected.runId) fail('details run id mismatch', expected.artifactDir);
  if (value['workflow'] !== expected.workflow)
    fail('details workflow mismatch', expected.artifactDir);
  if (value['source'] !== 'command' && value['source'] !== 'tool')
    fail('details source is invalid', expected.artifactDir);
  if (value['status'] !== 'completed')
    fail('details status is not completed', expected.artifactDir);
  if (value['artifact_dir'] !== expected.artifactDir)
    fail('details artifact directory mismatch', expected.artifactDir);
  const context = value['context'];
  const toolPolicy = value['tool_policy'];
  const models = value['models'];
  const budget = value['budget'];
  if (!isRecord(context) || !isRecord(toolPolicy) || !isRecord(models) || !isRecord(budget)) {
    fail('details nested contract is malformed', expected.artifactDir);
  }
  assertOnlyKeys(context, ['kind', 'policy_id'], 'details.context', expected.artifactDir);
  if (
    (context['kind'] !== 'session_projection' && context['kind'] !== 'clean_task') ||
    typeof context['policy_id'] !== 'string'
  ) {
    fail('details.context is invalid', expected.artifactDir);
  }
  assertOnlyKeys(
    toolPolicy,
    ['candidate_tools', 'evaluation_tools', 'merge_tools'],
    'details.tool_policy',
    expected.artifactDir,
  );
  const stringArray = (entry: unknown): entry is string[] =>
    Array.isArray(entry) && entry.every((item) => typeof item === 'string');
  if (
    !stringArray(toolPolicy['candidate_tools']) ||
    !Array.isArray(toolPolicy['evaluation_tools']) ||
    toolPolicy['evaluation_tools'].length !== 0 ||
    !Array.isArray(toolPolicy['merge_tools']) ||
    toolPolicy['merge_tools'].length !== 0
  ) {
    fail('details.tool_policy is invalid', expected.artifactDir);
  }
  assertOnlyKeys(
    models,
    ['candidates', 'evaluator', 'merger', 'thinking_level'],
    'details.models',
    expected.artifactDir,
  );
  if (
    !stringArray(models['candidates']) ||
    models['candidates'].length !== 3 ||
    typeof models['evaluator'] !== 'string' ||
    typeof models['merger'] !== 'string' ||
    typeof models['thinking_level'] !== 'string'
  ) {
    fail('details.models is invalid', expected.artifactDir);
  }
  assertOnlyKeys(
    budget,
    [
      'policy_id',
      'calibration_version',
      'route_table',
      'rate_sources',
      'unknown_provider_warnings',
      'calibration_warnings',
    ],
    'details.budget',
    expected.artifactDir,
  );
  if (
    typeof budget['policy_id'] !== 'string' ||
    typeof budget['calibration_version'] !== 'string' ||
    !Array.isArray(budget['route_table']) ||
    !Array.isArray(budget['rate_sources']) ||
    !stringArray(budget['unknown_provider_warnings']) ||
    !Array.isArray(budget['calibration_warnings'])
  ) {
    fail('details.budget is invalid', expected.artifactDir);
  }
  if (
    !Number.isSafeInteger(value['evaluator_attempts']) ||
    ![1, 2].includes(Number(value['evaluator_attempts']))
  ) {
    fail('details evaluator_attempts is invalid', expected.artifactDir);
  }
  const checkedUsage = usage(value['usage'], expected.artifactDir);
  const candidates = models['candidates'];
  if (!stringArray(candidates) || candidates.length !== 3)
    fail('details.models candidates are invalid', expected.artifactDir);
  const candidate1 = candidates[0];
  const candidate2 = candidates[1];
  const candidate3 = candidates[2];
  if (candidate1 === undefined || candidate2 === undefined || candidate3 === undefined) {
    fail('details.models candidates are incomplete', expected.artifactDir);
  }
  const source = value['source'];
  const contextKind = context['kind'];
  return {
    schema_version: FUSION_RESULT_SCHEMA_VERSION,
    run_id: expected.runId,
    workflow: expected.workflow,
    source,
    status: 'completed',
    context: { kind: contextKind, policy_id: context['policy_id'] },
    tool_policy: {
      candidate_tools: [...toolPolicy['candidate_tools']],
      evaluation_tools: [],
      merge_tools: [],
    },
    artifact_dir: expected.artifactDir,
    models: {
      candidates: [candidate1, candidate2, candidate3],
      evaluator: models['evaluator'],
      merger: models['merger'],
      thinking_level: models['thinking_level'],
    },
    evaluator_attempts: Number(value['evaluator_attempts']),
    usage: checkedUsage,
    budget: {
      policy_id: budget['policy_id'],
      calibration_version: budget['calibration_version'],
      route_table: budget['route_table'] as FusionResultDetails['budget']['route_table'],
      rate_sources: budget['rate_sources'] as FusionResultDetails['budget']['rate_sources'],
      unknown_provider_warnings: [...budget['unknown_provider_warnings']],
      calibration_warnings: budget[
        'calibration_warnings'
      ] as FusionResultDetails['budget']['calibration_warnings'],
    },
  };
}

function sameRef(left: FusionArtifactRef, right: FusionArtifactRef): boolean {
  return (
    left.path === right.path &&
    left.byte_length === right.byte_length &&
    left.sha256 === right.sha256
  );
}

async function readUtf8(
  path: string,
  label: string,
  artifactDir: string,
): Promise<{ bytes: Buffer; text: string }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    fail(
      `${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      artifactDir,
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} is not well-formed UTF-8`, artifactDir);
  }
  return { bytes, text };
}

/** Failure retrieval has an additional bounded, no-symlink evidence-file policy. */
async function readFailureUtf8(
  path: string,
  label: string,
  artifactDir: string,
  maxBytes: number,
): Promise<{ bytes: Buffer; text: string }> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail(`${label} is not a regular artifact file`, artifactDir);
    }
    if (metadata.size > maxBytes) fail(`${label} exceeds its bounded artifact size`, artifactDir);
  } catch (error) {
    if (error instanceof FusionError) throw error;
    fail(
      `${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      artifactDir,
    );
  }
  const file = await readUtf8(path, label, artifactDir);
  if (file.bytes.length > maxBytes) fail(`${label} exceeds its bounded artifact size`, artifactDir);
  return file;
}

export interface ReadFusionCommittedResultOptions {
  artifactDirAbs: string;
  artifactDir: string;
  runId: string;
  workflow: FusionWorkflowId;
}

/** Verify the manifest-bound Fusion commit before returning merged bytes. */
export async function readFusionCommittedResult(
  options: ReadFusionCommittedResultOptions,
): Promise<FusionRunResult> {
  const manifestFile = await readUtf8(
    join(options.artifactDirAbs, 'manifest.json'),
    'manifest.json',
    options.artifactDir,
  );
  let manifestValue: unknown;
  try {
    manifestValue = parseJsonText(manifestFile.text);
  } catch (error) {
    fail(
      `manifest.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      options.artifactDir,
    );
  }
  if (!isRecord(manifestValue)) fail('manifest.json must be an object', options.artifactDir);
  if (manifestValue['schema_version'] !== FUSION_MANIFEST_SCHEMA_VERSION)
    fail('manifest schema version mismatch', options.artifactDir);
  if (manifestValue['run_id'] !== options.runId || manifestValue['workflow'] !== options.workflow)
    fail('manifest identity mismatch', options.artifactDir);
  if (manifestValue['state'] !== 'completed')
    fail('manifest is not committed', options.artifactDir);
  const artifacts = manifestValue['artifacts'];
  if (!isRecord(artifacts)) fail('manifest artifacts map is invalid', options.artifactDir);
  const manifestMerged = artifactRef(
    artifacts['merged.md'],
    'manifest artifacts merged.md',
    options.artifactDir,
  );
  const manifestResult = artifactRef(
    artifacts['result.json'],
    'manifest artifacts result.json',
    options.artifactDir,
  );
  if (manifestMerged.path !== 'merged.md' || manifestResult.path !== 'result.json')
    fail('manifest fixed artifact paths are invalid', options.artifactDir);

  const resultFile = await readUtf8(
    join(options.artifactDirAbs, 'result.json'),
    'result.json',
    options.artifactDir,
  );
  if (
    resultFile.bytes.length !== manifestResult.byte_length ||
    sha256Buffer(resultFile.bytes) !== manifestResult.sha256
  ) {
    fail('result.json does not match its manifest hash and length', options.artifactDir);
  }
  let resultValue: unknown;
  try {
    resultValue = parseJsonText(resultFile.text);
  } catch (error) {
    fail(
      `result.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      options.artifactDir,
    );
  }
  if (!isRecord(resultValue)) fail('result.json must be an object', options.artifactDir);
  assertOnlyKeys(
    resultValue,
    ['schema_version', 'run_id', 'merged', 'details'],
    'result.json',
    options.artifactDir,
  );
  if (
    resultValue['schema_version'] !== FUSION_COMMITTED_RESULT_SCHEMA_VERSION ||
    resultValue['run_id'] !== options.runId
  ) {
    fail('result.json identity mismatch', options.artifactDir);
  }
  const committedMerged = artifactRef(
    resultValue['merged'],
    'result.json merged',
    options.artifactDir,
  );
  if (!sameRef(committedMerged, manifestMerged))
    fail('result.json merged reference does not match manifest', options.artifactDir);
  const details = resultDetails(resultValue['details'], options);

  const mergedFile = await readUtf8(
    join(options.artifactDirAbs, 'merged.md'),
    'merged.md',
    options.artifactDir,
  );
  if (
    mergedFile.bytes.length !== committedMerged.byte_length ||
    sha256Buffer(mergedFile.bytes) !== committedMerged.sha256
  ) {
    fail('merged.md does not match its committed hash and length', options.artifactDir);
  }
  return { mergedText: mergedFile.text, details };
}

// The public tool adds a small task envelope and text receipt around this view.
// Keep the verified details below 8 KiB even after that model-visible envelope.
const FAILURE_VIEW_MAX_BYTES = 6 * 1024;
const FAILURE_CODES = new Set([
  'config_invalid', 'config_conflict', 'model_unavailable', 'context_capture_failed',
  'context_policy_unsupported_block', 'prompt_budget_exceeded_forecast',
  'prompt_budget_exceeded_measured', 'model_capacity_unknown', 'child_spawn_failed',
  'child_stdin_failed', 'child_event_invalid', 'child_exit_failed',
  'child_runtime_limit_exceeded', 'child_runtime_payload_invalid',
  'child_cache_policy_invalid', 'child_timeout', 'child_output_cap', 'child_cancelled',
  'evaluation_invalid', 'artifact_error', 'state_transition_invalid', 'orchestration_failed',
]);
const FAILURE_REMEDIATION_IDS = new Set([
  'inspect_manifest_bound_evidence', 'inspect_terminal_error', 'split_or_reduce_work',
  'retry_same_route_after_operator_review',
]);
const FAILURE_CLASSIFICATIONS = new Set([
  'complete_stage_output', 'partial_stage_output', 'oversized_original',
  'empty_rejected_output', 'evidence_only',
]);

interface TrustedFailureManifest {
  schemaVersion: string;
  source: FusionSource;
  state: 'failed' | 'cancelled';
  usage: FusionUsage;
  artifacts: Readonly<Record<string, FusionArtifactRef>>;
  attempts: readonly FusionFailureAttemptMetadata[];
  classifications: Readonly<Record<string, FusionFailureEvidenceArtifact['classification']>>;
  error?: string | undefined;
}

function failureUnavailable(
  state: 'failed' | 'cancelled',
  status: 'unavailable' | 'integrity_failed',
): FusionFailureResultView {
  return {
    schema_version: FUSION_FAILURE_SUMMARY_SCHEMA_VERSION,
    summary_status: status,
    terminal_state: state,
    answer: { present: false, reason: 'run_did_not_commit' },
    summary_unavailable_reason: status === 'unavailable' ? 'manifest_untrusted' : 'summary_integrity_failed',
  };
}

function failureString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function failureInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new Error(`${label} must be a nonnegative integer`);
  return Number(value);
}

function compareFailureText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function failureStage(value: unknown, label: string): FusionStage {
  if (value === 'candidate' || value === 'evaluation' || value === 'merge') return value;
  throw new Error(`${label} is invalid`);
}

function failureUsage(value: unknown, artifactDir: string): FusionUsage {
  return usage(value, artifactDir);
}

function failureRef(value: unknown, label: string, artifactDir: string): FusionArtifactRef {
  return artifactRef(value, label, artifactDir);
}

function sameFailureRef(left: FusionArtifactRef, right: FusionArtifactRef): boolean {
  return left.path === right.path && left.byte_length === right.byte_length && left.sha256 === right.sha256;
}

function trustedFailureManifest(
  value: unknown,
  options: ReadFusionCommittedResultOptions,
): TrustedFailureManifest {
  if (!isRecord(value)) throw new Error('manifest must be an object');
  const schemaVersion = value['schema_version'];
  if (schemaVersion !== FUSION_MANIFEST_SCHEMA_VERSION && schemaVersion !== FUSION_LEGACY_MANIFEST_SCHEMA_VERSION)
    throw new Error('manifest schema version mismatch');
  if (value['run_id'] !== options.runId || value['workflow'] !== options.workflow)
    throw new Error('manifest identity mismatch');
  const state = value['state'];
  if (state !== 'failed' && state !== 'cancelled') throw new Error('manifest is not failed or cancelled');
  const source = value['source'];
  if (source !== 'command' && source !== 'tool') throw new Error('manifest source is invalid');
  const artifactsValue = value['artifacts'];
  if (!isRecord(artifactsValue)) throw new Error('manifest artifacts are invalid');
  const artifacts: Record<string, FusionArtifactRef> = {};
  for (const [name, ref] of Object.entries(artifactsValue)) {
    assertFusionArtifactBasename(name);
    const checked = failureRef(ref, `manifest artifact ${name}`, options.artifactDir);
    if (checked.path !== name) throw new Error('manifest artifact key/ref divergence');
    artifacts[name] = checked;
  }
  const attemptsValue = value['attempts'];
  if (!Array.isArray(attemptsValue)) throw new Error('manifest attempts are invalid');
  const attempts: FusionFailureAttemptMetadata[] = [];
  const classifications: Record<string, FusionFailureEvidenceArtifact['classification']> = {};
  const attemptArtifact = (entry: unknown, label: string): string | undefined => {
    if (entry === undefined) return undefined;
    const name = failureString(entry, label);
    assertFusionArtifactBasename(name);
    if (artifacts[name] === undefined) throw new Error(`${label} is not manifest-bound`);
    return name;
  };
  for (const attemptValue of attemptsValue) {
    if (!isRecord(attemptValue)) throw new Error('manifest attempt is invalid');
    const metadata = failureAttempt({
      stage: attemptValue['stage'], slot: attemptValue['slot'], attempt: attemptValue['attempt'],
      status: attemptValue['status'], child_created: attemptValue['child_created'],
    });
    attempts.push(metadata);
    const response = attemptArtifact(attemptValue['response_path'], 'manifest response_path');
    if (response !== undefined) {
      const responseRef = artifacts[response];
      if (responseRef === undefined) throw new Error('manifest response_path is not manifest-bound');
      classifications[response] =
        responseRef.byte_length === 0 && metadata.status !== 'completed'
          ? 'empty_rejected_output'
          : 'complete_stage_output';
    }
    const partial = attemptArtifact(
      attemptValue['partial_response_path'],
      'manifest partial_response_path',
    );
    if (partial !== undefined) classifications[partial] = 'partial_stage_output';
    const recovery = attemptValue['output_recovery'];
    if (recovery !== undefined) {
      if (!isRecord(recovery)) throw new Error('manifest output_recovery is invalid');
      const original = attemptArtifact(
        recovery['original_response_path'],
        'manifest output_recovery.original_response_path',
      );
      if (original === undefined) throw new Error('manifest output recovery has no original response');
      classifications[original] = 'oversized_original';
    }
  }
  attempts.sort((left, right) =>
    compareFailureText(left.stage, right.stage) ||
    (left.slot ?? 0) - (right.slot ?? 0) ||
    left.attempt - right.attempt,
  );
  const manifestUsage = failureUsage(value['usage'], options.artifactDir);
  const error = value['error'];
  if (error !== undefined && typeof error !== 'string') throw new Error('manifest error is invalid');
  return { schemaVersion, source, state, usage: manifestUsage, artifacts, attempts, classifications, ...(error === undefined ? {} : { error }) };
}

function failureMessage(value: unknown): FusionFailureSummaryV1['failure']['message'] {
  if (!isRecord(value)) throw new Error('failure message is invalid');
  assertOnlyKeys(value, ['byte_length', 'sha256', 'inline_message', 'omission_reason'], 'failure message', 'failure-summary.json');
  const byteLength = failureInteger(value['byte_length'], 'failure message byte_length');
  const sha256 = failureString(value['sha256'], 'failure message sha256');
  if (!SHA256_PATTERN.test(sha256)) throw new Error('failure message sha256 is invalid');
  const inline = value['inline_message'];
  const omission = value['omission_reason'];
  if ((inline === undefined) === (omission === undefined)) throw new Error('failure message must have exactly one representation');
  if (inline !== undefined) {
    if (
      typeof inline !== 'string' ||
      byteLength > FUSION_FAILURE_SUMMARY_INLINE_MESSAGE_BYTES ||
      Buffer.byteLength(inline, 'utf8') !== byteLength ||
      sha256Buffer(Buffer.from(inline, 'utf8')) !== sha256
    ) {
      throw new Error('failure inline message does not match its metadata');
    }
    return { byte_length: byteLength, sha256, inline_message: inline };
  }
  if (omission !== 'exceeds_inline_message_bytes_cap')
    throw new Error('failure message omission reason is invalid');
  return { byte_length: byteLength, sha256, omission_reason: omission };
}

function failureList<T>(
  value: unknown,
  label: string,
  cap: number,
  parseEntry: (entry: unknown) => T,
): FusionFailureList<T> {
  if (!isRecord(value)) throw new Error(`${label} is invalid`);
  assertOnlyKeys(value, ['listed', 'omitted_count'], label, 'failure-summary.json');
  if (!Array.isArray(value['listed']) || value['listed'].length > cap)
    throw new Error(`${label}.listed is invalid`);
  return {
    listed: value['listed'].map(parseEntry),
    omitted_count: failureInteger(value['omitted_count'], `${label}.omitted_count`),
  };
}

function failureAttempt(value: unknown): FusionFailureAttemptMetadata {
  if (!isRecord(value)) throw new Error('failure attempt is invalid');
  assertOnlyKeys(value, ['stage', 'slot', 'attempt', 'status', 'child_created'], 'failure attempt', 'failure-summary.json');
  const stage = failureStage(value['stage'], 'failure attempt stage');
  const slot = value['slot'];
  if (slot !== undefined && slot !== 1 && slot !== 2 && slot !== 3)
    throw new Error('failure attempt slot is invalid');
  if ((stage === 'candidate') !== (slot !== undefined))
    throw new Error('failure attempt stage/slot is inconsistent');
  const status = value['status'];
  if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') throw new Error('failure attempt status is invalid');
  if (typeof value['child_created'] !== 'boolean') throw new Error('failure attempt child_created is invalid');
  const attempt = failureInteger(value['attempt'], 'failure attempt number');
  if (attempt === 0) throw new Error('failure attempt number must be positive');
  return { stage, ...(slot === undefined ? {} : { slot }), attempt, status, child_created: value['child_created'] };
}

function failureEvidence(
  value: unknown,
  manifest: TrustedFailureManifest,
  artifactDir: string,
): FusionFailureEvidenceArtifact {
  if (!isRecord(value)) throw new Error('failure evidence row is invalid');
  assertOnlyKeys(value, ['name', 'classification', 'ref'], 'failure evidence row', artifactDir);
  const name = failureString(value['name'], 'failure evidence name');
  assertFusionArtifactBasename(name);
  const classification = value['classification'];
  if (typeof classification !== 'string' || !FAILURE_CLASSIFICATIONS.has(classification))
    throw new Error('failure evidence classification is invalid');
  const ref = failureRef(value['ref'], 'failure evidence ref', artifactDir);
  const manifestRef = manifest.artifacts[name];
  if (manifestRef === undefined || !sameFailureRef(ref, manifestRef))
    throw new Error('failure evidence ref diverges from manifest');
  const expectedClassification = manifest.classifications[name] ?? 'evidence_only';
  if (classification !== expectedClassification) throw new Error('failure evidence classification diverges from manifest');
  return { name, classification: expectedClassification, ref };
}

function failureProgress(value: unknown, manifest: TrustedFailureManifest, artifactDir: string): FusionRunProgress {
  if (!isRecord(value)) throw new Error('failure progress is invalid');
  assertOnlyKeys(value, ['manifest_state', 'candidates', 'evaluation', 'merge', 'usage_so_far'], 'failure progress', artifactDir);
  if (value['manifest_state'] !== manifest.state) throw new Error('failure progress state diverges from manifest');
  const stage = (entry: unknown, label: string, candidates: boolean): FusionRunProgress['candidates'] => {
    if (!isRecord(entry)) throw new Error(`${label} is invalid`);
    assertOnlyKeys(entry, ['status', 'attempts_recorded', 'children_created', 'children_completed', 'children_failed', 'children_cancelled', 'not_started_slots'], label, artifactDir);
    const status = entry['status'];
    if (status !== 'not_started' && status !== 'incomplete' && status !== 'completed') throw new Error(`${label}.status is invalid`);
    const notStarted = entry['not_started_slots'];
    if (candidates ? !Number.isSafeInteger(notStarted) || Number(notStarted) < 0 || Number(notStarted) > 3 : notStarted !== undefined)
      throw new Error(`${label}.not_started_slots is invalid`);
    return {
      status,
      attempts_recorded: failureInteger(entry['attempts_recorded'], `${label}.attempts_recorded`),
      children_created: failureInteger(entry['children_created'], `${label}.children_created`),
      children_completed: failureInteger(entry['children_completed'], `${label}.children_completed`),
      children_failed: failureInteger(entry['children_failed'], `${label}.children_failed`),
      children_cancelled: failureInteger(entry['children_cancelled'], `${label}.children_cancelled`),
      ...(candidates ? { not_started_slots: Number(notStarted) } : {}),
    };
  };
  const usageSoFar = failureUsage(value['usage_so_far'], artifactDir);
  if (canonicalJson(usageSoFar) !== canonicalJson(manifest.usage)) throw new Error('failure progress usage diverges from manifest');
  return { manifest_state: manifest.state, candidates: stage(value['candidates'], 'failure candidates', true), evaluation: stage(value['evaluation'], 'failure evaluation', false), merge: stage(value['merge'], 'failure merge', false), usage_so_far: usageSoFar };
}

function parseFailureSummary(
  value: unknown,
  manifest: TrustedFailureManifest,
  options: ReadFusionCommittedResultOptions,
): FusionFailureSummaryV1 {
  if (!isRecord(value)) throw new Error('failure summary must be an object');
  assertOnlyKeys(value, ['schema_version', 'run_id', 'workflow', 'source', 'terminal_state', 'created_at', 'answer', 'failure', 'progress', 'usage_so_far', 'attempts', 'evidence_artifacts', 'remediation_ids'], 'failure summary', options.artifactDir);
  if (value['schema_version'] !== FUSION_FAILURE_SUMMARY_SCHEMA_VERSION || value['run_id'] !== options.runId || value['workflow'] !== options.workflow || value['source'] !== manifest.source || value['terminal_state'] !== manifest.state || typeof value['created_at'] !== 'string')
    throw new Error('failure summary identity is invalid');
  const answer = value['answer'];
  if (!isRecord(answer) || answer['present'] !== false || answer['reason'] !== 'run_did_not_commit') throw new Error('failure summary answer assertion is invalid');
  const failure = value['failure'];
  if (!isRecord(failure)) throw new Error('failure summary failure metadata is invalid');
  assertOnlyKeys(failure, ['code', 'stage', 'slot', 'attempt', 'child_created', 'message'], 'failure metadata', options.artifactDir);
  const code = failure['code'];
  if (code !== null && (typeof code !== 'string' || !FAILURE_CODES.has(code))) throw new Error('failure code is invalid');
  const stageValue = failure['stage'];
  const stage = stageValue === undefined ? undefined : failureStage(stageValue, 'failure stage');
  const slot = failure['slot'];
  if (slot !== undefined && slot !== 1 && slot !== 2 && slot !== 3) throw new Error('failure slot is invalid');
  if (failure['attempt'] !== undefined) failureInteger(failure['attempt'], 'failure attempt');
  if (typeof failure['child_created'] !== 'boolean') throw new Error('failure child_created is invalid');
  const progress = failureProgress(value['progress'], manifest, options.artifactDir);
  const expectedProgress = buildFusionRunProgress(manifest);
  if (canonicalJson(progress) !== canonicalJson(expectedProgress))
    throw new Error('failure progress diverges from durable attempts');
  const usageSoFar = failureUsage(value['usage_so_far'], options.artifactDir);
  if (canonicalJson(usageSoFar) !== canonicalJson(manifest.usage))
    throw new Error('summary usage diverges from manifest');
  const attempts = failureList(
    value['attempts'],
    'failure attempts',
    FUSION_FAILURE_SUMMARY_ATTEMPT_CAP,
    failureAttempt,
  );
  const expectedAttempts = manifest.attempts;
  const expectedAttemptListedCount = Math.min(
    expectedAttempts.length,
    FUSION_FAILURE_SUMMARY_ATTEMPT_CAP,
  );
  if (
    attempts.listed.length !== expectedAttemptListedCount ||
    attempts.omitted_count !== expectedAttempts.length - expectedAttemptListedCount ||
    canonicalJson(attempts.listed) !==
      canonicalJson(
        expectedAttempts.filter((_attempt, index) => index < expectedAttemptListedCount),
      )
  ) {
    throw new Error('failure attempt metadata diverges from manifest');
  }
  const evidence = failureList(
    value['evidence_artifacts'],
    'failure evidence artifacts',
    FUSION_FAILURE_SUMMARY_EVIDENCE_CAP,
    (entry) => failureEvidence(entry, manifest, options.artifactDir),
  );
  const expectedEvidence = Object.entries(manifest.artifacts)
    .filter(([name]) => name !== 'failure-summary.json')
    .map(([name, ref]) => ({ name, classification: manifest.classifications[name] ?? 'evidence_only', ref }))
    .sort((left, right) => compareFailureText(left.name, right.name));
  const expectedEvidenceListedCount = Math.min(
    expectedEvidence.length,
    FUSION_FAILURE_SUMMARY_EVIDENCE_CAP,
  );
  if (
    evidence.listed.length !== expectedEvidenceListedCount ||
    evidence.omitted_count !== expectedEvidence.length - expectedEvidenceListedCount ||
    canonicalJson(evidence.listed) !==
      canonicalJson(
        expectedEvidence.filter((_evidence, index) => index < expectedEvidenceListedCount),
      )
  ) {
    throw new Error('failure evidence metadata diverges from manifest');
  }
  const remediationIds = value['remediation_ids'];
  const expectedRemediationIds = [
    'inspect_manifest_bound_evidence',
    'inspect_terminal_error',
    'split_or_reduce_work',
    'retry_same_route_after_operator_review',
  ];
  if (
    !Array.isArray(remediationIds) ||
    !remediationIds.every((id) => typeof id === 'string' && FAILURE_REMEDIATION_IDS.has(id)) ||
    canonicalJson(remediationIds) !== canonicalJson(expectedRemediationIds)
  ) {
    throw new Error('failure remediation ids are invalid');
  }
  const terminalMessage = failureMessage(failure['message']);
  if (manifest.error === undefined) throw new Error('manifest terminal error is unavailable');
  const manifestErrorBytes = Buffer.from(manifest.error, 'utf8');
  const expectedMessage = {
    byte_length: manifestErrorBytes.length,
    sha256: sha256Buffer(manifestErrorBytes),
    ...(manifestErrorBytes.length <= FUSION_FAILURE_SUMMARY_INLINE_MESSAGE_BYTES
      ? { inline_message: manifest.error }
      : { omission_reason: 'exceeds_inline_message_bytes_cap' as const }),
  };
  if (canonicalJson(terminalMessage) !== canonicalJson(expectedMessage))
    throw new Error('failure message diverges from manifest terminal error');
  return {
    schema_version: FUSION_FAILURE_SUMMARY_SCHEMA_VERSION, run_id: options.runId, workflow: options.workflow,
    source: manifest.source, terminal_state: manifest.state, created_at: value['created_at'],
    answer: { present: false, reason: 'run_did_not_commit' },
    failure: { code: code as FusionFailureSummaryV1['failure']['code'], ...(stage === undefined ? {} : { stage }), ...(slot === undefined ? {} : { slot }), ...(failure['attempt'] === undefined ? {} : { attempt: Number(failure['attempt']) }), child_created: failure['child_created'], message: terminalMessage },
    progress, usage_so_far: usageSoFar, attempts, evidence_artifacts: evidence,
    remediation_ids: [...remediationIds] as FusionFailureSummaryV1['remediation_ids'],
  };
}

interface FailureViewSource {
  terminal_state: Exclude<FusionFailureResultView['terminal_state'], 'completed'>;
  failure?: FusionFailureResultView['failure'] | undefined;
  progress: FusionRunProgress;
  usage_so_far: FusionUsage;
  attempts: FusionFailureList<FusionFailureAttemptMetadata>;
  evidence_artifacts: FusionFailureList<FusionFailureEvidenceArtifact>;
  remediation_ids: FusionFailureSummaryV1['remediation_ids'];
}

function boundedFailureView(
  source: FailureViewSource,
  status: FusionFailureResultView['summary_status'],
  summaryRef?: FusionArtifactRef,
): FusionFailureResultView {
  const attempts = { listed: [...source.attempts.listed], omitted_count: source.attempts.omitted_count };
  const evidence = { listed: [...source.evidence_artifacts.listed], omitted_count: source.evidence_artifacts.omitted_count };
  const failure = source.failure;
  const view: FusionFailureResultView = {
    schema_version: FUSION_FAILURE_SUMMARY_SCHEMA_VERSION,
    summary_status: status,
    terminal_state: source.terminal_state,
    answer: { present: false, reason: 'run_did_not_commit' },
    ...(failure === undefined
      ? {}
      : { failure: { ...failure, message: { ...failure.message } } }),
    progress: source.progress,
    usage_so_far: source.usage_so_far,
    attempts,
    evidence_artifacts: evidence,
    remediation_ids: source.remediation_ids,
    ...(summaryRef === undefined ? {} : { failure_summary_ref: summaryRef }),
  };
  const fits = (): boolean => Buffer.byteLength(canonicalJson(view), 'utf8') <= FAILURE_VIEW_MAX_BYTES;
  if (!fits() && view.failure?.message.inline_message !== undefined) {
    const message = view.failure.message;
    view.failure = {
      ...view.failure,
      message: {
        byte_length: message.byte_length,
        sha256: message.sha256,
        omission_reason: 'result_view_byte_budget',
      },
    };
  }
  while (!fits() && evidence.listed.length > 0) { evidence.listed.pop(); evidence.omitted_count += 1; }
  while (!fits() && attempts.listed.length > 0) { attempts.listed.pop(); attempts.omitted_count += 1; }
  if (!fits()) throw new Error('failure result view exceeds its byte budget without a safe whole-section omission');
  return view;
}

function legacyFailureSource(
  manifest: TrustedFailureManifest,
): FailureViewSource {
  const message =
    manifest.error === undefined
      ? undefined
      : (() => {
          const bytes = Buffer.from(manifest.error, 'utf8');
          return bytes.length <= FUSION_FAILURE_SUMMARY_INLINE_MESSAGE_BYTES
            ? {
                byte_length: bytes.length,
                sha256: sha256Buffer(bytes),
                inline_message: manifest.error,
              }
            : {
                byte_length: bytes.length,
                sha256: sha256Buffer(bytes),
                omission_reason: 'exceeds_inline_message_bytes_cap' as const,
              };
        })();
  const evidence = Object.entries(manifest.artifacts)
    .map(([name, ref]) => ({
      name,
      classification: manifest.classifications[name] ?? 'evidence_only',
      ref: { ...ref },
    }))
    .sort((left, right) => compareFailureText(left.name, right.name));
  const attempts = manifest.attempts;
  return {
    terminal_state: manifest.state,
    ...(message === undefined ? {} : { failure: { message } }),
    progress: buildFusionRunProgress(manifest),
    usage_so_far: manifest.usage,
    attempts: {
      listed: attempts.filter((_attempt, index) => index < FUSION_FAILURE_SUMMARY_ATTEMPT_CAP),
      omitted_count: attempts.length - Math.min(attempts.length, FUSION_FAILURE_SUMMARY_ATTEMPT_CAP),
    },
    evidence_artifacts: {
      listed: evidence.filter((_evidence, index) => index < FUSION_FAILURE_SUMMARY_EVIDENCE_CAP),
      omitted_count: evidence.length - Math.min(evidence.length, FUSION_FAILURE_SUMMARY_EVIDENCE_CAP),
    },
    remediation_ids: ['inspect_manifest_bound_evidence', 'inspect_terminal_error'],
  };
}

/** Read only terminal failure metadata; it never reads stage-output bodies. */
export async function readFusionFailureResult(
  options: ReadFusionCommittedResultOptions,
): Promise<FusionFailureResultView> {
  let manifest: TrustedFailureManifest;
  try {
    const file = await readUtf8(join(options.artifactDirAbs, 'manifest.json'), 'manifest.json', options.artifactDir);
    manifest = trustedFailureManifest(parseJsonText(file.text), options);
  } catch {
    return failureUnavailable('failed', 'unavailable');
  }
  const summaryRef = manifest.artifacts['failure-summary.json'];
  if (summaryRef === undefined) {
    return boundedFailureView(legacyFailureSource(manifest), 'legacy_manifest_only');
  }
  if (manifest.schemaVersion !== FUSION_MANIFEST_SCHEMA_VERSION || summaryRef.path !== 'failure-summary.json')
    return failureUnavailable(manifest.state, 'integrity_failed');
  try {
    if (summaryRef.byte_length > FUSION_FAILURE_SUMMARY_MAX_BYTES)
      throw new Error('failure summary exceeds its bounded artifact size');
    const file = await readFailureUtf8(
      join(options.artifactDirAbs, summaryRef.path),
      'failure-summary.json',
      options.artifactDir,
      FUSION_FAILURE_SUMMARY_MAX_BYTES,
    );
    if (file.bytes.length !== summaryRef.byte_length || sha256Buffer(file.bytes) !== summaryRef.sha256)
      throw new Error('failure summary hash/length mismatch');
    const summary = parseFailureSummary(parseJsonText(file.text), manifest, options);
    return boundedFailureView(summary, 'verified', summaryRef);
  } catch {
    return failureUnavailable(manifest.state, 'integrity_failed');
  }
}
