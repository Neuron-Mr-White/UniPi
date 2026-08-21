import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { canonicalJson, sha256Buffer } from '../attested-pi-run.js';
import { sanitizePathSegment } from '../types.js';
import { replaceFileDurable } from '../durable-fs.js';
import {
  EMPTY_FUSION_USAGE,
  FUSION_COMMITTED_RESULT_SCHEMA_VERSION,
  FUSION_FAILURE_SUMMARY_SCHEMA_VERSION,
  FUSION_MANIFEST_SCHEMA_VERSION,
  FUSION_VALIDATE_CANDIDATE_CONTRACT_EVENT_SCHEMA_VERSION,
  FusionError,
  cloneFusionUsage,
  type FusionArtifactManifest,
  type FusionArtifactRef,
  type FusionFailureArtifactClassification,
  type FusionFailureAttemptMetadata,
  type FusionFailureEvidenceArtifact,
  type FusionFailureSummaryV1,
  type FusionRunProgress,
  type FusionAttemptArtifactRecord,
  type FusionBudgetPlanV1,
  type FusionCalibrationViolation,
  type FusionCandidateId,
  type FusionCandidateOutputRecovery,
  type FusionCapability,
  type FusionContextOmissionLedgerV2,
  type FusionChildRunResult,
  type FusionCommittedResultV1,
  type FusionResultDetails,
  type FusionModelConfigV1,
  type FusionSource,
  type FusionStage,
  type FusionState,
  type FusionTerminalState,
  type FusionUsage,
  type FusionWorkflowId,
  type ResolvedFusionModels,
} from './types.js';
import { fusionWorkflowProfile, type FusionWorkflowProfile } from './workflows.js';
import {
  FUSION_CANDIDATE_MAX_OUTPUT_BYTES,
  fusionJsonRenderedTextBytes,
} from './output-contract.js';

/**
 * Run ids are prefixed by workflow so an artifact directory is self-describing.
 * The prefix set is closed: an unknown prefix must fail rather than be accepted.
 */
const RUN_ID_PATTERN = /^(reason|investigate|research|validate)-[0-9a-f]{32}$/;

interface MutableFusionArtifactManifest {
  schema_version: typeof FUSION_MANIFEST_SCHEMA_VERSION;
  run_id: string;
  workflow: FusionWorkflowId;
  source: FusionSource;
  state: FusionState;
  created_at: string;
  updated_at: string;
  cwd: string;
  config: FusionModelConfigV1;
  models: {
    candidates: [string, string, string];
    evaluator: string;
    merger: string;
    thinking_level: string;
  };
  capabilities: {
    candidate: FusionCapability;
    evaluation: FusionCapability;
    merge: FusionCapability;
  };
  context: {
    kind: import('./types.js').FusionContextKind;
    policy_id: string;
    ledger_artifact?: string;
    source_policy_artifact?: string;
  };
  tool_policy: {
    candidate_tools: readonly string[];
    evaluation_tools: readonly [];
    merge_tools: readonly [];
  };
  usage: FusionUsage;
  attempts: FusionAttemptArtifactRecord[];
  artifacts: Record<string, FusionArtifactRef>;
  anonymous_map?: Record<FusionCandidateId, 1 | 2 | 3>;
  error?: string;
}

export interface CreateFusionArtifactStoreOptions {
  cwd: string;
  sessionId?: string | undefined;
  runId?: string | undefined;
  profile?: FusionWorkflowProfile | undefined;
  source: FusionSource;
  config: FusionModelConfigV1;
  models: ResolvedFusionModels;
  capabilities?: {
    candidate: FusionCapability;
    evaluation: FusionCapability;
    merge: FusionCapability;
  };
  now?: () => Date;
}

export interface RecordFusionChildAttemptInput {
  result: FusionChildRunResult;
  systemPrompt: string;
  prompt: string;
  responseKind: 'md' | 'txt';
}

export type RecordValidationCandidateContractEventInput =
  | {
      candidateId: FusionCandidateId;
      slot: 1 | 2 | 3;
      status: 'normalized';
      detail: {
        normalization: 'markdown_json_fence' | 'prose_then_markdown_json_fence';
        original_sha256: string;
        forwarded_sha256: string;
        warning: string;
      };
    }
  | {
      candidateId: FusionCandidateId;
      slot: 1 | 2 | 3;
      status: 'dropped';
      detail: {
        response_sha256: string;
        error: string;
        warning: string;
      };
    };

export interface RecordFusionFailedAttemptInput {
  stage: FusionStage;
  slot?: 1 | 2 | 3;
  attempt: number;
  systemPrompt: string;
  prompt: string;
  events: Buffer;
  partialResponse: Buffer;
  stderr: Buffer;
  error: string;
  status: 'failed' | 'cancelled';
  childCreated: boolean;
  responseKind: 'md' | 'txt';
  outputRecovery?: FusionCandidateOutputRecovery;
  provider?: string;
  model?: string;
  qualifiedId?: string;
  usage?: FusionUsage;
}

function makeRunId(profile: FusionWorkflowProfile): string {
  return `${profile.runIdPrefix}${randomBytes(16).toString('hex')}`;
}

function modelsForManifest(models: ResolvedFusionModels): MutableFusionArtifactManifest['models'] {
  const first = models.candidates[0].qualifiedId;
  const second = models.candidates[1].qualifiedId;
  const third = models.candidates[2].qualifiedId;
  return {
    candidates: [first, second, third],
    evaluator: models.evaluator.qualifiedId,
    merger: models.merger.qualifiedId,
    thinking_level: models.evaluator.thinkingLevel,
  };
}

function terminalStates(): ReadonlySet<FusionState> {
  return new Set<FusionState>(['completed', 'failed', 'cancelled']);
}

const TERMINAL_STATES = terminalStates();

const NEXT_STATES: Readonly<Record<FusionState, readonly FusionState[]>> = {
  initializing: ['candidates_running', 'failed', 'cancelled'],
  candidates_running: ['candidates_complete', 'failed', 'cancelled'],
  candidates_complete: ['evaluating', 'failed', 'cancelled'],
  evaluating: ['evaluation_complete', 'failed', 'cancelled'],
  evaluation_complete: ['merging', 'failed', 'cancelled'],
  merging: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

function canTransition(from: FusionState, to: FusionState): boolean {
  return NEXT_STATES[from].includes(to);
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return (
    rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'))
  );
}

function errorForArtifact(message: string): FusionError {
  return new FusionError(message, { code: 'artifact_error', childCreated: false });
}

async function writePrivateFile(
  absPath: string,
  data: Buffer | string,
): Promise<FusionArtifactRef> {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  await replaceFileDurable(absPath, data);
  return { path: basename(absPath), byte_length: bytes.length, sha256: sha256Buffer(bytes) };
}

async function writeJsonAtomic(absPath: string, value: unknown): Promise<FusionArtifactRef> {
  return writePrivateFile(absPath, `${JSON.stringify(value, null, 2)}\n`);
}

function publicManifest(manifest: MutableFusionArtifactManifest): FusionArtifactManifest {
  const out: FusionArtifactManifest = {
    schema_version: manifest.schema_version,
    run_id: manifest.run_id,
    workflow: manifest.workflow,
    source: manifest.source,
    state: manifest.state,
    created_at: manifest.created_at,
    updated_at: manifest.updated_at,
    cwd: manifest.cwd,
    config: manifest.config,
    models: manifest.models,
    capabilities: manifest.capabilities,
    context: { ...manifest.context },
    tool_policy: {
      candidate_tools: [...manifest.tool_policy.candidate_tools],
      evaluation_tools: [],
      merge_tools: [],
    },
    usage: cloneFusionUsage(manifest.usage),
    attempts: [...manifest.attempts],
    artifacts: { ...manifest.artifacts },
  };
  if (manifest.anonymous_map !== undefined) out.anonymous_map = { ...manifest.anonymous_map };
  if (manifest.error !== undefined) out.error = manifest.error;
  return out;
}

function attemptPrefix(stage: FusionStage, slot: 1 | 2 | 3 | undefined, attempt: number): string {
  if (stage === 'candidate') {
    if (slot === undefined) throw errorForArtifact('candidate attempt requires slot');
    return `candidate-${String(slot)}.attempt-${String(attempt)}`;
  }
  if (slot !== undefined)
    throw errorForArtifact(`${stage} attempt must not include candidate slot`);
  return `${stage === 'evaluation' ? 'evaluation' : 'merge'}.attempt-${String(attempt)}`;
}

function responseName(prefix: string, kind: 'md' | 'txt'): string {
  return `${prefix}.response.${kind}`;
}

function calibrationViolationName(prefix: string): string {
  return `${prefix}.calibration-violation.json`;
}

function oversizedResponseName(prefix: string, kind: 'md' | 'txt'): string {
  return `${prefix}.response.oversized.${kind}`;
}

function validateOutputRecovery(
  recovery: FusionCandidateOutputRecovery,
  replacementText?: string,
): void {
  if (recovery.limit_bytes !== FUSION_CANDIDATE_MAX_OUTPUT_BYTES) {
    throw errorForArtifact('fusion output recovery limit mismatches the candidate contract');
  }
  const originalBytes = Buffer.from(recovery.original_text, 'utf8');
  if (createHash('sha256').update(originalBytes).digest('hex') !== recovery.original_text_sha256) {
    throw errorForArtifact('fusion output recovery original text hash mismatch');
  }
  if (
    fusionJsonRenderedTextBytes(recovery.original_text) !== recovery.original_json_rendered_bytes
  ) {
    throw errorForArtifact('fusion output recovery original JSON-rendered byte count mismatch');
  }
  if (recovery.original_json_rendered_bytes <= recovery.limit_bytes) {
    throw errorForArtifact('fusion output recovery original did not exceed the candidate contract');
  }
  if (replacementText !== undefined) {
    const replacementBytes = fusionJsonRenderedTextBytes(replacementText);
    if (replacementBytes !== recovery.replacement_json_rendered_bytes) {
      throw errorForArtifact(
        'fusion output recovery replacement JSON-rendered byte count mismatch',
      );
    }
    if (recovery.status === 'completed' && replacementBytes > recovery.limit_bytes) {
      throw errorForArtifact('completed fusion output recovery replacement exceeds the contract');
    }
  }
}

function outputRecoveryRecord(
  recovery: FusionCandidateOutputRecovery,
  path: string,
): NonNullable<FusionAttemptArtifactRecord['output_recovery']> {
  return {
    kind: recovery.kind,
    status: recovery.status,
    limit_bytes: recovery.limit_bytes,
    original_response_path: path,
    original_record_index: recovery.original_record_index,
    replacement_record_index: recovery.replacement_record_index,
    original_json_rendered_bytes: recovery.original_json_rendered_bytes,
    replacement_json_rendered_bytes: recovery.replacement_json_rendered_bytes,
    original_text_sha256: recovery.original_text_sha256,
  };
}

function artifactRefSha256Hex(value: string): string {
  const hex = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
  if (!/^[0-9a-f]{64}$/u.test(hex)) {
    throw errorForArtifact(`fusion artifact sha256 is not a lowercase hex digest: ${value}`);
  }
  return hex;
}

/** A manifest artifact reference is always one safe basename below its run directory. */
export function assertFusionArtifactBasename(name: string): string {
  if (
    name.length === 0 ||
    name !== basename(name) ||
    name.includes('/') ||
    name.includes('\\') ||
    name === '.' ||
    name === '..' ||
    Buffer.byteLength(name, 'utf8') > 255
  ) {
    throw errorForArtifact(`invalid fusion artifact name: ${name}`);
  }
  return name;
}

export const FUSION_FAILURE_SUMMARY_INLINE_MESSAGE_BYTES = 1024;
export const FUSION_FAILURE_SUMMARY_ATTEMPT_CAP = 12;
export const FUSION_FAILURE_SUMMARY_EVIDENCE_CAP = 24;
export const FUSION_FAILURE_SUMMARY_MAX_BYTES = 32 * 1024;

function compareArtifactText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface FusionProgressManifest {
  state: FusionState;
  artifacts: Readonly<Record<string, FusionArtifactRef>>;
  attempts: readonly {
    stage: FusionStage;
    slot?: 1 | 2 | 3 | undefined;
    status: 'completed' | 'failed' | 'cancelled';
    child_created: boolean;
  }[];
  usage: FusionUsage;
}

function failureStageProgress(
  manifest: FusionProgressManifest,
  stage: FusionStage,
): FusionRunProgress['candidates'] {
  const attempts = manifest.attempts.filter((attempt) => attempt.stage === stage);
  const created = attempts.filter((attempt) => attempt.child_created).length;
  const completed = attempts.filter(
    (attempt) => attempt.child_created && attempt.status === 'completed',
  ).length;
  const failed = attempts.filter(
    (attempt) => attempt.child_created && attempt.status === 'failed',
  ).length;
  const cancelled = attempts.filter(
    (attempt) => attempt.child_created && attempt.status === 'cancelled',
  ).length;
  const completedByState =
    stage === 'candidate'
      ? completed >= 3
      : stage === 'evaluation'
        ? manifest.artifacts['evaluation.json'] !== undefined ||
          manifest.state === 'evaluation_complete' ||
          manifest.state === 'merging' ||
          manifest.state === 'completed'
        : manifest.artifacts['merged.md'] !== undefined || manifest.state === 'completed';
  const progress: FusionRunProgress['candidates'] = {
    status: completedByState ? 'completed' : created === 0 ? 'not_started' : 'incomplete',
    attempts_recorded: attempts.length,
    children_created: created,
    children_completed: completed,
    children_failed: failed,
    children_cancelled: cancelled,
  };
  if (stage === 'candidate') {
    const createdSlots = new Set(
      attempts.flatMap((attempt) =>
        attempt.child_created && attempt.slot !== undefined ? [attempt.slot] : [],
      ),
    );
    progress.not_started_slots = 3 - createdSlots.size;
  }
  return progress;
}

/** Derive terminal progress solely from the durable manifest. */
export function buildFusionRunProgress(manifest: FusionProgressManifest): FusionRunProgress {
  return {
    manifest_state: manifest.state,
    candidates: failureStageProgress(manifest, 'candidate'),
    evaluation: failureStageProgress(manifest, 'evaluation'),
    merge: failureStageProgress(manifest, 'merge'),
    usage_so_far: cloneFusionUsage(manifest.usage),
  };
}

function terminalMessageMetadata(message: string): FusionFailureSummaryV1['failure']['message'] {
  const bytes = Buffer.from(message, 'utf8');
  return {
    byte_length: bytes.length,
    sha256: sha256Buffer(bytes),
    ...(bytes.length <= FUSION_FAILURE_SUMMARY_INLINE_MESSAGE_BYTES
      ? { inline_message: message }
      : { omission_reason: 'exceeds_inline_message_bytes_cap' as const }),
  };
}

function failureArtifactClassification(
  name: string,
  ref: FusionArtifactRef,
  manifest: FusionArtifactManifest,
): FusionFailureArtifactClassification {
  for (const attempt of manifest.attempts) {
    if (attempt.response_path === name) {
      return ref.byte_length === 0 && attempt.status !== 'completed'
        ? 'empty_rejected_output'
        : 'complete_stage_output';
    }
    if (attempt.partial_response_path === name) return 'partial_stage_output';
    if (attempt.output_recovery?.original_response_path === name) return 'oversized_original';
  }
  return 'evidence_only';
}

function failureAttemptMetadata(manifest: FusionArtifactManifest): readonly FusionFailureAttemptMetadata[] {
  return manifest.attempts
    .map((attempt) => ({
      stage: attempt.stage,
      ...(attempt.slot === undefined ? {} : { slot: attempt.slot }),
      attempt: attempt.attempt,
      status: attempt.status,
      child_created: attempt.child_created,
    }))
    .sort((left, right) =>
      compareArtifactText(left.stage, right.stage) ||
      (left.slot ?? 0) - (right.slot ?? 0) ||
      left.attempt - right.attempt,
    );
}

export function buildFusionFailureSummary(input: {
  manifest: FusionArtifactManifest;
  terminalError: FusionError;
  progress: FusionRunProgress;
  terminalState: Exclude<FusionTerminalState, 'completed'>;
  createdAt: string;
}): FusionFailureSummaryV1 {
  if (
    (input.terminalState !== 'failed' && input.terminalState !== 'cancelled') ||
    input.manifest.state !== input.terminalState
  ) {
    throw errorForArtifact('failure summary requires a matching failed/cancelled terminal manifest');
  }
  if (input.manifest.error !== input.terminalError.message) {
    throw errorForArtifact('failure summary terminal error does not match the durable manifest');
  }
  if (canonicalJson(input.progress) !== canonicalJson(buildFusionRunProgress(input.manifest))) {
    throw errorForArtifact('failure summary progress does not match the durable terminal manifest');
  }
  if (input.manifest.artifacts['failure-summary.json'] !== undefined) {
    throw errorForArtifact('failure summary already exists in the terminal manifest');
  }
  const attempts = failureAttemptMetadata(input.manifest);
  const evidence: FusionFailureEvidenceArtifact[] = Object.entries(input.manifest.artifacts)
    .map(([name, ref]) => ({
      name: assertFusionArtifactBasename(name),
      classification: failureArtifactClassification(name, ref, input.manifest),
      ref: { ...ref },
    }))
    .sort((left, right) => compareArtifactText(left.name, right.name));
  return {
    schema_version: FUSION_FAILURE_SUMMARY_SCHEMA_VERSION,
    run_id: input.manifest.run_id,
    workflow: input.manifest.workflow,
    source: input.manifest.source,
    terminal_state: input.terminalState,
    created_at: input.createdAt,
    answer: { present: false, reason: 'run_did_not_commit' },
    failure: {
      code: input.terminalError.code,
      ...(input.terminalError.stage === undefined ? {} : { stage: input.terminalError.stage }),
      ...(input.terminalError.slot === undefined ? {} : { slot: input.terminalError.slot }),
      ...(input.terminalError.attempt === undefined
        ? {}
        : { attempt: input.terminalError.attempt }),
      child_created: input.terminalError.childCreated,
      message: terminalMessageMetadata(input.terminalError.message),
    },
    progress: input.progress,
    usage_so_far: cloneFusionUsage(input.manifest.usage),
    attempts: {
      listed: attempts.filter((_attempt, index) => index < FUSION_FAILURE_SUMMARY_ATTEMPT_CAP),
      omitted_count:
        attempts.length - Math.min(attempts.length, FUSION_FAILURE_SUMMARY_ATTEMPT_CAP),
    },
    evidence_artifacts: {
      listed: evidence.filter((_artifact, index) => index < FUSION_FAILURE_SUMMARY_EVIDENCE_CAP),
      omitted_count:
        evidence.length - Math.min(evidence.length, FUSION_FAILURE_SUMMARY_EVIDENCE_CAP),
    },
    remediation_ids: [
      'inspect_manifest_bound_evidence',
      'inspect_terminal_error',
      'split_or_reduce_work',
      'retry_same_route_after_operator_review',
    ],
  };
}

export class FusionArtifactStore {
  private readonly runDirAbs: string;
  private readonly runDirDisplay: string;
  private readonly now: () => Date;
  private manifest: MutableFusionArtifactManifest;
  private manifestWriteChain: Promise<void> = Promise.resolve();

  private constructor(
    runDirAbs: string,
    runDirDisplay: string,
    now: () => Date,
    manifest: MutableFusionArtifactManifest,
  ) {
    this.runDirAbs = runDirAbs;
    this.runDirDisplay = runDirDisplay;
    this.now = now;
    this.manifest = manifest;
  }

  static async create(options: CreateFusionArtifactStoreOptions): Promise<FusionArtifactStore> {
    const profile = fusionWorkflowProfile(options.profile?.id ?? 'reason');
    const runId = options.runId ?? makeRunId(profile);
    if (!RUN_ID_PATTERN.test(runId)) throw errorForArtifact(`invalid fusion run id: ${runId}`);
    if (!runId.startsWith(profile.runIdPrefix)) {
      throw errorForArtifact(
        `fusion run id ${runId} does not carry the ${profile.id} workflow prefix ${profile.runIdPrefix}`,
      );
    }
    const sessionSegment = sanitizePathSegment(
      options.sessionId ?? `session-${String(process.pid)}`,
    );
    const sessionDirName = `${sessionSegment}-${String(process.pid)}`;
    const runDirAbs = join(options.cwd, '.pi', 'fusion', sessionDirName, runId);
    const runDirDisplay = join('.pi', 'fusion', sessionDirName, runId);
    await mkdir(runDirAbs, { recursive: true, mode: 0o700 });
    await chmod(runDirAbs, 0o700);
    const timestamp = (options.now ?? (() => new Date()))().toISOString();
    const manifest: MutableFusionArtifactManifest = {
      schema_version: FUSION_MANIFEST_SCHEMA_VERSION,
      run_id: runId,
      workflow: profile.id,
      source: options.source,
      state: 'initializing',
      created_at: timestamp,
      updated_at: timestamp,
      cwd: options.cwd,
      config: options.config,
      models: modelsForManifest(options.models),
      capabilities: options.capabilities ?? {
        candidate: 'reason',
        evaluation: 'reason',
        merge: 'reason',
      },
      context: {
        kind: profile.contextKind,
        policy_id:
          profile.contextKind === 'session_projection'
            ? 'fusion-session-projection-v1'
            : 'fusion-clean-task-v1',
      },
      tool_policy: {
        candidate_tools: profile.candidateTools,
        evaluation_tools: [],
        merge_tools: [],
      },
      usage: cloneFusionUsage(EMPTY_FUSION_USAGE),
      attempts: [],
      artifacts: {},
    };
    const store = new FusionArtifactStore(
      runDirAbs,
      runDirDisplay,
      options.now ?? (() => new Date()),
      manifest,
    );
    await store.writeManifest();
    return store;
  }

  get runId(): string {
    return this.manifest.run_id;
  }

  get artifactDir(): string {
    return this.runDirDisplay;
  }

  get artifactDirAbs(): string {
    return this.runDirAbs;
  }

  childToolCallLogPath(stage: FusionStage, slot: 1 | 2 | 3 | undefined, attempt: number): string {
    return this.artifactPath(`${attemptPrefix(stage, slot, attempt)}.tool-calls.jsonl`);
  }

  childOutputRecoveryPath(slot: 1 | 2 | 3, attempt: number, responseKind: 'md' | 'txt'): string {
    return this.artifactPath(
      oversizedResponseName(attemptPrefix('candidate', slot, attempt), responseKind),
    );
  }

  snapshot(): FusionArtifactManifest {
    return publicManifest(this.manifest);
  }

  async transition(to: FusionState): Promise<void> {
    await this.updateManifest((manifest) => {
      if (!canTransition(manifest.state, to)) {
        throw new FusionError(`illegal fusion state transition ${manifest.state} -> ${to}`, {
          code: 'state_transition_invalid',
          childCreated: false,
        });
      }
      if (
        to === 'completed' &&
        (manifest.artifacts['merged.md'] === undefined ||
          manifest.artifacts['result.json'] === undefined)
      ) {
        throw new FusionError(
          'fusion cannot complete before merged.md and result.json are durable',
          {
            code: 'state_transition_invalid',
            childCreated: false,
          },
        );
      }
      manifest.state = to;
    });
  }

  async setAnonymousMap(map: Record<FusionCandidateId, 1 | 2 | 3>): Promise<void> {
    await this.updateManifest((manifest) => {
      manifest.anonymous_map = { ...map };
    });
  }

  async setUsage(usage: FusionUsage): Promise<void> {
    await this.updateManifest((manifest) => {
      manifest.usage = cloneFusionUsage(usage);
    });
  }

  async writeCanonicalInput(serialized: string): Promise<void> {
    await this.writeArtifact('canonical-input.json', serialized);
  }

  /**
   * Complete, source-ordered ledger of every omitted conversation event. Kept in
   * a separate artifact so canonical input carries only compact run receipts
   * while the full omission accounting stays locally auditable.
   */
  async writeContextLedger(ledger: FusionContextOmissionLedgerV2): Promise<void> {
    const ref = await this.writeArtifact('context-omission-ledger.json', canonicalJson(ledger));
    await this.updateManifest((manifest) => {
      manifest.context.ledger_artifact = ref.path;
    });
  }

  async writeSourcePolicy(serialized: string): Promise<void> {
    const ref = await this.writeArtifact('source-policy.private.json', serialized);
    await this.updateManifest((manifest) => {
      manifest.context.source_policy_artifact = ref.path;
    });
  }

  sourcePolicyLaunchReference(): { path: string; sha256: string } {
    const ref = this.manifest.artifacts['source-policy.private.json'];
    if (ref === undefined) throw errorForArtifact('research source policy has not been written');
    return { path: this.artifactPath(ref.path), sha256: artifactRefSha256Hex(ref.sha256) };
  }

  /** Route capacities and the pre-candidate whole-workflow feasibility decision. */
  async writeBudgetPlan(plan: FusionBudgetPlanV1): Promise<void> {
    await this.writeArtifact('budget-plan.json', canonicalJson(plan));
  }

  async writeBlindCandidates(serialized: string): Promise<void> {
    await this.writeArtifact('blind-candidates.json', serialized);
  }

  async writeEvaluationJson(value: unknown): Promise<void> {
    await this.writeArtifact('evaluation.json', canonicalJson(value));
  }

  async writeMerged(text: string): Promise<FusionArtifactRef> {
    return this.writeArtifact('merged.md', text);
  }

  async writeCommittedResult(
    merged: FusionArtifactRef,
    details: FusionResultDetails,
  ): Promise<FusionArtifactRef> {
    const value: FusionCommittedResultV1 = {
      schema_version: FUSION_COMMITTED_RESULT_SCHEMA_VERSION,
      run_id: this.runId,
      merged,
      details,
    };
    return this.writeArtifact('result.json', `${canonicalJson(value)}\n`);
  }

  async writeError(state: Exclude<FusionTerminalState, 'completed'>, error: string): Promise<void> {
    await this.writeArtifact('error.json', `${JSON.stringify({ state, error }, null, 2)}\n`);
    await this.updateManifest((manifest) => {
      if (!TERMINAL_STATES.has(state)) throw errorForArtifact(`invalid terminal state ${state}`);
      if (!canTransition(manifest.state, state)) {
        throw new FusionError(`illegal fusion state transition ${manifest.state} -> ${state}`, {
          code: 'state_transition_invalid',
          childCreated: false,
        });
      }
      manifest.state = state;
      manifest.error = error;
    });
  }

  /**
   * Writes the terminal evidence summary exactly once after writeError has made
   * the manifest terminal. The summary deliberately contains refs only, never
   * stage-output bodies.
   */
  async writeFailureSummary(summary: FusionFailureSummaryV1): Promise<FusionArtifactRef> {
    if (
      this.manifest.state !== 'failed' &&
      this.manifest.state !== 'cancelled'
    ) {
      throw errorForArtifact('failure summary requires a failed/cancelled terminal manifest');
    }
    if (summary.terminal_state !== this.manifest.state) {
      throw errorForArtifact('failure summary terminal state does not match the manifest');
    }
    if (
      summary.run_id !== this.manifest.run_id ||
      summary.workflow !== this.manifest.workflow ||
      summary.source !== this.manifest.source
    ) {
      throw errorForArtifact('failure summary identity does not match the terminal manifest');
    }
    if (
      summary.answer?.present !== false ||
      summary.answer.reason !== 'run_did_not_commit'
    ) {
      throw errorForArtifact('failure summary must assert that no answer was committed');
    }
    if (this.manifest.error === undefined || this.manifest.artifacts['error.json'] === undefined) {
      throw errorForArtifact('failure summary requires durable terminal error evidence');
    }
    if (
      canonicalJson(summary.failure.message) !==
      canonicalJson(terminalMessageMetadata(this.manifest.error))
    ) {
      throw errorForArtifact('failure summary terminal error metadata does not match the manifest');
    }
    if (canonicalJson(summary.progress) !== canonicalJson(buildFusionRunProgress(this.snapshot()))) {
      throw errorForArtifact('failure summary progress does not match the terminal manifest');
    }
    if (canonicalJson(summary.usage_so_far) !== canonicalJson(this.manifest.usage)) {
      throw errorForArtifact('failure summary usage does not match the terminal manifest');
    }
    if (this.manifest.artifacts['failure-summary.json'] !== undefined) {
      throw errorForArtifact('failure summary is already bound in the manifest');
    }
    const bytes = Buffer.from(`${canonicalJson(summary)}\n`, 'utf8');
    if (bytes.length > FUSION_FAILURE_SUMMARY_MAX_BYTES) {
      throw errorForArtifact('failure summary exceeds its bounded diagnostics artifact limit');
    }
    return this.writeArtifact('failure-summary.json', bytes);
  }

  async recordChildAttempt(input: RecordFusionChildAttemptInput): Promise<void> {
    const prefix = attemptPrefix(input.result.stage, input.result.slot, input.result.attempt);
    await this.writeArtifact(`${prefix}.system-prompt.txt`, input.systemPrompt);
    const promptRef = await this.writeArtifact(`${prefix}.prompt.txt`, input.prompt);
    const eventsRef = await this.writeArtifact(`${prefix}.events.jsonl`, input.result.events);
    const stderrRef = await this.writeArtifact(`${prefix}.stderr.txt`, input.result.stderr);
    const responseRef = await this.writeArtifact(
      responseName(prefix, input.responseKind),
      input.result.text,
    );
    const toolCallsRef =
      input.result.toolCallTrace === undefined
        ? undefined
        : await this.writeArtifact(`${prefix}.tool-calls.jsonl`, input.result.toolCallTrace.bytes);
    if (input.result.outputRecovery !== undefined) {
      validateOutputRecovery(input.result.outputRecovery, input.result.text);
    }
    const outputRecoveryRef =
      input.result.outputRecovery === undefined
        ? undefined
        : await this.writeArtifact(
            oversizedResponseName(prefix, input.responseKind),
            input.result.outputRecovery.original_text,
          );
    await this.updateManifest((manifest) => {
      const record: FusionAttemptArtifactRecord = {
        stage: input.result.stage,
        attempt: input.result.attempt,
        status: 'completed',
        child_created: true,
        prompt_path: promptRef.path,
        events_path: eventsRef.path,
        stderr_path: stderrRef.path,
        response_path: responseRef.path,
        provider: input.result.provider,
        model: input.result.model,
        qualifiedId: input.result.qualifiedId,
        usage: cloneFusionUsage(input.result.usage),
      };
      if (toolCallsRef !== undefined && input.result.toolCallTrace !== undefined) {
        record.tool_calls_path = toolCallsRef.path;
        record.tool_calls = { ...input.result.toolCallTrace.summary };
      }
      if (outputRecoveryRef !== undefined && input.result.outputRecovery !== undefined) {
        record.output_recovery = outputRecoveryRecord(
          input.result.outputRecovery,
          outputRecoveryRef.path,
        );
      }
      if (input.result.slot !== undefined) record.slot = input.result.slot;
      manifest.attempts.push(record);
    });
  }

  async recordCalibrationViolation(input: {
    stage: FusionStage;
    slot?: 1 | 2 | 3;
    attempt: number;
    violation: FusionCalibrationViolation;
  }): Promise<FusionArtifactRef> {
    const prefix = attemptPrefix(input.stage, input.slot, input.attempt);
    return this.writeArtifact(
      calibrationViolationName(prefix),
      `${canonicalJson(input.violation)}\n`,
    );
  }

  async recordValidationCandidateContractEvent(
    input: RecordValidationCandidateContractEventInput,
  ): Promise<FusionArtifactRef> {
    const name = `candidate-${String(input.slot)}.output-contract-${input.status}.json`;
    return this.writeArtifact(
      name,
      `${canonicalJson({
        schema_version: FUSION_VALIDATE_CANDIDATE_CONTRACT_EVENT_SCHEMA_VERSION,
        ...input.detail,
        candidate_id: input.candidateId,
        slot: input.slot,
        status: input.status,
      })}\n`,
    );
  }

  async recordFailedAttempt(input: RecordFusionFailedAttemptInput): Promise<void> {
    const prefix = attemptPrefix(input.stage, input.slot, input.attempt);
    await this.writeArtifact(`${prefix}.system-prompt.txt`, input.systemPrompt);
    const promptRef = await this.writeArtifact(`${prefix}.prompt.txt`, input.prompt);
    const eventsRef = await this.writeArtifact(`${prefix}.events.jsonl`, input.events);
    const stderrRef = await this.writeArtifact(`${prefix}.stderr.txt`, input.stderr);
    const responseRef = await this.writeArtifact(responseName(prefix, input.responseKind), '');
    const partialResponseRef =
      input.partialResponse.length === 0
        ? undefined
        : await this.writeArtifact(
            `${prefix}.response.partial.${input.responseKind}`,
            input.partialResponse,
          );
    if (input.outputRecovery !== undefined) validateOutputRecovery(input.outputRecovery);
    const outputRecoveryRef =
      input.outputRecovery === undefined
        ? undefined
        : await this.writeArtifact(
            oversizedResponseName(prefix, input.responseKind),
            input.outputRecovery.original_text,
          );
    await this.updateManifest((manifest) => {
      const record: FusionAttemptArtifactRecord = {
        stage: input.stage,
        attempt: input.attempt,
        status: input.status,
        child_created: input.childCreated,
        prompt_path: promptRef.path,
        events_path: eventsRef.path,
        stderr_path: stderrRef.path,
        response_path: responseRef.path,
        error: input.error,
      };
      if (partialResponseRef !== undefined) record.partial_response_path = partialResponseRef.path;
      if (outputRecoveryRef !== undefined && input.outputRecovery !== undefined) {
        record.output_recovery = outputRecoveryRecord(input.outputRecovery, outputRecoveryRef.path);
      }
      if (input.provider !== undefined) record.provider = input.provider;
      if (input.model !== undefined) record.model = input.model;
      if (input.qualifiedId !== undefined) record.qualifiedId = input.qualifiedId;
      if (input.usage !== undefined) record.usage = cloneFusionUsage(input.usage);
      if (input.slot !== undefined) record.slot = input.slot;
      manifest.attempts.push(record);
    });
  }

  /** Writes a durable artifact then binds its exact bytes in the manifest. */
  private async writeArtifact(name: string, data: Buffer | string): Promise<FusionArtifactRef> {
    const absPath = this.artifactPath(name);
    const ref = await writePrivateFile(absPath, data);
    await this.updateManifest((manifest) => {
      manifest.artifacts[name] = ref;
    });
    return ref;
  }

  private artifactPath(name: string): string {
    assertFusionArtifactBasename(name);
    const absPath = join(this.runDirAbs, name);
    if (!pathInside(this.runDirAbs, absPath)) {
      throw errorForArtifact(`fusion artifact path escapes run directory: ${name}`);
    }
    return absPath;
  }

  private async writeManifest(): Promise<void> {
    await writeJsonAtomic(join(this.runDirAbs, 'manifest.json'), publicManifest(this.manifest));
  }

  private async updateManifest(
    mutator: (manifest: MutableFusionArtifactManifest) => void,
  ): Promise<void> {
    const write = async () => {
      mutator(this.manifest);
      this.manifest.updated_at = this.now().toISOString();
      await this.writeManifest();
    };
    const next = this.manifestWriteChain.then(write, write);
    this.manifestWriteChain = next.catch(() => undefined);
    await next;
  }
}
