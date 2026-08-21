import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { canonicalJson } from '../attested-pi-run.js';
import { parseJsonText } from '../types.js';
import { FUSION_BUDGET_POLICY, FusionBudget } from './budget.js';
import { assertChildOutputWithinContract } from './output-contract.js';
import {
  FusionArtifactStore,
  buildFusionFailureSummary,
  buildFusionRunProgress as deriveFusionRunProgress,
  type CreateFusionArtifactStoreOptions,
  type RecordFusionFailedAttemptInput,
} from './artifacts.js';
import {
  boundedEvaluationErrors,
  formatEvaluationErrors,
  parseFusionValidationCandidateReport,
  recoverFencedFusionValidationCandidateReport,
  renderValidatedFusionValidationReport,
  validateFusionEvaluation,
  validateFusionFindingAccounting,
} from './evaluation.js';
import { FusionChildRunError, runPiChild, type RunPiChildOptions } from './pi-child.js';
import {
  buildBlindEvaluationInput,
  buildCandidatePrompt,
  buildEvaluationPrompt,
  buildEvaluationRepairPrompt,
  buildMergeInput,
  buildMergePrompt,
  type AnonymousFusionCandidate,
} from './prompts.js';
import {
  assertWorkflowCapability,
  fusionWorkflowProfile,
  type FusionWorkflowProfile,
} from './workflows.js';
import { buildFusionSourcePolicy, sourcePolicyCanonicalBytes } from './source-policy.js';
import {
  FUSION_INPUT_SCHEMA_VERSION,
  FUSION_NO_TOOLS_CAPABILITY,
  FUSION_RESULT_SCHEMA_VERSION,
  FUSION_VALIDATE_CANDIDATE_SCHEMA_VERSION,
  FusionError,
  addFusionUsage,
  createEmptyFusionUsage,
  type FusionCalibrationViolation,
  type FusionCapability,
  type FusionCanonicalInputV3,
  type FusionCandidateId,
  type FusionContextOmissionLedgerV2,
  type FusionChildRunResult,
  type FusionErrorDetails,
  type FusionEvaluationV1,
  type FusionModelConfigV1,
  type FusionProgressEvent,
  type FusionRunProgress,
  type FusionRunResult,
  type FusionSource,
  type FusionStage,
  type FusionUsage,
  type FusionValidationFindingRecord,
  type ResolvedFusionModel,
  type ResolvedFusionModels,
} from './types.js';

export type FusionChildRunner = (options: RunPiChildOptions) => Promise<FusionChildRunResult>;
export type FusionProgressSink = (event: FusionProgressEvent) => void;
export type FusionRandomBytes = (size: number) => Buffer;

export interface FusionRunReady {
  runId: string;
  artifactDir: string;
  artifactDirAbs: string;
}

type CandidateSlot = 1 | 2 | 3;

export interface FusionWorkflowInput {
  source: FusionSource;
  cwd: string;
  sessionId?: string | undefined;
  canonicalInput: FusionCanonicalInputV3;
  canonicalInputSerialized: string;
  contextLedger?: FusionContextOmissionLedgerV2 | undefined;
  config: FusionModelConfigV1;
  models: ResolvedFusionModels;
  candidateCapability?: FusionCapability | undefined;
  /** Mandatory v5 workflow profile. */
  profile?: FusionWorkflowProfile | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: FusionProgressSink | undefined;
  /**
   * Optional no-child-yet handoff. The orchestrator pauses here after durable
   * preflight and budget admission, allowing a background registry receipt to
   * become durable before candidate launch.
   */
  onReady?: ((ready: FusionRunReady) => Promise<void>) | undefined;
}

export interface FusionOrchestratorOptions {
  childRunner?: FusionChildRunner | undefined;
  randomBytes?: FusionRandomBytes | undefined;
  now?: () => Date;
  createArtifactStore?:
    | ((options: CreateFusionArtifactStoreOptions) => Promise<FusionArtifactStore>)
    | undefined;
}

interface CandidateResult {
  slot: CandidateSlot;
  result: FusionChildRunResult;
}

interface EvaluationAttemptResult {
  result: FusionChildRunResult;
  evaluation: FusionEvaluationV1 | undefined;
  errors: readonly string[];
}

function addFailedChildUsage(target: FusionUsage, error: unknown): void {
  if (error instanceof FusionChildRunError) addFusionUsage(target, error.usage);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isStrictCleanCanonicalInput(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ['schema_version', 'workflow', 'cwd', 'request', 'context']))
    return false;
  const request = value['request'];
  if (!isRecord(request)) return false;
  if (!hasOnlyKeys(request, ['source', 'authority', 'text', 'sha256'])) return false;
  const context = value['context'];
  if (!isRecord(context)) return false;
  if (!hasOnlyKeys(context, ['kind', 'policy_id', 'declared_sources'])) return false;
  if (context['kind'] !== 'clean_task') return false;
  const declaredSources = context['declared_sources'];
  if (!Array.isArray(declaredSources)) return false;
  for (const source of declaredSources) {
    if (!isRecord(source) || !hasOnlyKeys(source, ['url', 'canonical_url', 'purpose', 'sha256']))
      return false;
  }
  return true;
}

function asFusionError(error: unknown, artifactDir: string, messageOverride?: string): FusionError {
  if (error instanceof FusionError) {
    const details: FusionErrorDetails = {
      code: error.code,
      artifactDir,
      transient: error.transient,
      childCreated: error.childCreated,
    };
    if (error.stage !== undefined) details.stage = error.stage;
    if (error.slot !== undefined) details.slot = error.slot;
    if (error.attempt !== undefined) details.attempt = error.attempt;
    if (error.budget !== undefined) details.budget = error.budget;
    if (error.runProgress !== undefined) details.runProgress = error.runProgress;
    return new FusionError(messageOverride ?? error.message, details);
  }
  return new FusionError(messageOverride ?? errorText(error), {
    code: 'orchestration_failed',
    artifactDir,
    childCreated: false,
  });
}

export { buildFusionRunProgress } from './artifacts.js';

function formatFusionRunStage(name: string, stage: FusionRunProgress['candidates']): string {
  const notStarted =
    stage.not_started_slots === undefined
      ? ''
      : `, ${String(stage.not_started_slots)} slot(s) not started`;
  return `${name}=${stage.status} (${String(stage.children_created)} created, ${String(stage.children_completed)} completed, ${String(stage.children_failed)} failed, ${String(stage.children_cancelled)} cancelled${notStarted})`;
}

export function summaryUnavailableNote(error: unknown): string {
  const detail = errorText(error);
  const detailBytes = Buffer.from(detail, 'utf8');
  if (detailBytes.length > 1024) {
    return 'failure-summary.json unavailable after terminal publication; write failure detail omitted because it exceeds the 1024-byte diagnostic cap.';
  }
  return `failure-summary.json unavailable after terminal publication: ${detail}`;
}

function withSummaryUnavailableNote(error: FusionError, summaryError: unknown): FusionError {
  const details: FusionErrorDetails = {
    code: error.code,
    transient: error.transient,
    childCreated: error.childCreated,
  };
  if (error.artifactDir !== undefined) details.artifactDir = error.artifactDir;
  if (error.stage !== undefined) details.stage = error.stage;
  if (error.slot !== undefined) details.slot = error.slot;
  if (error.attempt !== undefined) details.attempt = error.attempt;
  if (error.budget !== undefined) details.budget = error.budget;
  if (error.runProgress !== undefined) details.runProgress = error.runProgress;
  return new FusionError(`${error.message}\n${summaryUnavailableNote(summaryError)}`, details);
}

function formatFusionRunProgress(progress: FusionRunProgress): string {
  const usage = progress.usage_so_far;
  const optionalUsage = [
    usage.cacheWrite1h === undefined ? undefined : `cacheWrite1h=${String(usage.cacheWrite1h)}`,
    usage.reasoning === undefined ? undefined : `reasoning=${String(usage.reasoning)}`,
  ].filter((value): value is string => value !== undefined);
  const optionalText = optionalUsage.length === 0 ? '' : `, ${optionalUsage.join(', ')}`;
  return (
    `Run progress from durable attempts: ${formatFusionRunStage('candidates', progress.candidates)}; ` +
    `${formatFusionRunStage('evaluation', progress.evaluation)}; ` +
    `${formatFusionRunStage('merge', progress.merge)}. ` +
    `Usage so far: input=${String(usage.input)}, output=${String(usage.output)}, cacheRead=${String(usage.cacheRead)}, cacheWrite=${String(usage.cacheWrite)}${optionalText}, totalTokens=${String(usage.totalTokens)}, ` +
    `cost.input=${String(usage.cost.input)}, cost.output=${String(usage.cost.output)}, cost.cacheRead=${String(usage.cost.cacheRead)}, cost.cacheWrite=${String(usage.cost.cacheWrite)}, cost.total=${String(usage.cost.total)}.`
  );
}

function withRunProgress(
  error: unknown,
  artifactDir: string,
  progress: FusionRunProgress,
): FusionError {
  const base = asFusionError(error, artifactDir);
  const details: FusionErrorDetails = {
    code: base.code,
    artifactDir,
    transient: base.transient,
    childCreated: base.childCreated,
    runProgress: progress,
  };
  if (base.stage !== undefined) details.stage = base.stage;
  if (base.slot !== undefined) details.slot = base.slot;
  if (base.attempt !== undefined) details.attempt = base.attempt;
  if (base.budget !== undefined) details.budget = base.budget;
  return new FusionError(`${base.message}\n${formatFusionRunProgress(progress)}`, details);
}

function withTerminalArtifactFailure(
  error: unknown,
  artifactDir: string,
  artifactError: unknown,
): FusionError {
  const message = `${errorText(error)}; additionally failed to write terminal fusion artifacts: ${errorText(artifactError)}`;
  return asFusionError(error, artifactDir, message);
}

function recordFailureInput(
  error: unknown,
  stage: FusionStage,
  slot: CandidateSlot | undefined,
  attempt: number,
  systemPrompt: string,
  prompt: string,
  responseKind: 'md' | 'txt',
): RecordFusionFailedAttemptInput {
  if (error instanceof FusionChildRunError) {
    const base: RecordFusionFailedAttemptInput = {
      stage,
      attempt,
      systemPrompt,
      prompt,
      events: error.events,
      partialResponse: error.response,
      stderr: error.stderr,
      error: error.message,
      status: error.code === 'child_cancelled' ? 'cancelled' : 'failed',
      responseKind,
      childCreated: error.childCreated,
      usage: error.usage,
      ...(error.outputRecovery === undefined ? {} : { outputRecovery: error.outputRecovery }),
    };
    if (slot !== undefined) base.slot = slot;
    if (error.provider !== undefined) base.provider = error.provider;
    if (error.modelName !== undefined) base.model = error.modelName;
    if (error.qualifiedId !== undefined) base.qualifiedId = error.qualifiedId;
    return base;
  }
  const base: RecordFusionFailedAttemptInput = {
    stage,
    attempt,
    systemPrompt,
    prompt,
    events: Buffer.alloc(0),
    partialResponse: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    error: errorText(error),
    status:
      error instanceof FusionError && error.code === 'child_cancelled' ? 'cancelled' : 'failed',
    responseKind,
    childCreated: error instanceof FusionError ? error.childCreated : false,
  };
  if (slot !== undefined) base.slot = slot;
  return base;
}

function retryableSpawn(error: unknown, attempt: number): boolean {
  if (!(error instanceof FusionError)) return false;
  return (
    attempt === 1 && error.code === 'child_spawn_failed' && error.transient && !error.childCreated
  );
}

function childOptions(
  input: FusionWorkflowInput,
  model: ResolvedFusionModel,
  stage: FusionStage,
  attempt: number,
  capability: FusionCapability,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal,
  slot?: CandidateSlot,
  toolCallLogPath?: string,
  sourcePolicy?: { path: string; sha256: string },
  candidateOutputRecoveryPath?: string,
): RunPiChildOptions {
  const out: RunPiChildOptions = {
    stage,
    attempt,
    cwd: input.cwd,
    model,
    capability,
    systemPrompt,
    userPrompt,
    signal,
  };
  if (slot !== undefined) out.slot = slot;
  if (toolCallLogPath !== undefined) out.toolCallLogPath = toolCallLogPath;
  if (sourcePolicy !== undefined) out.sourcePolicy = sourcePolicy;
  if (candidateOutputRecoveryPath !== undefined)
    out.candidateOutputRecoveryPath = candidateOutputRecoveryPath;
  return out;
}

function parseEvaluationAttempt(
  text: string,
  expectedValidationFindings: readonly FusionValidationFindingRecord[] | undefined,
): {
  evaluation: FusionEvaluationV1 | undefined;
  errors: readonly string[];
} {
  let parsed: unknown;
  try {
    parsed = parseJsonText(text);
  } catch (error) {
    return {
      evaluation: undefined,
      errors: [`evaluation output must be JSON only: ${errorText(error)}`],
    };
  }
  const result = validateFusionEvaluation(parsed);
  if (!result.ok) return { evaluation: undefined, errors: result.errors };
  if (
    expectedValidationFindings === undefined &&
    result.value.validation_accounting !== undefined
  ) {
    return {
      evaluation: undefined,
      errors: ['evaluation.validation_accounting is permitted only for fusion_validate'],
    };
  }
  if (expectedValidationFindings !== undefined) {
    const accountingErrors = validateEvaluationAccountsForSourceFindings(
      result.value,
      expectedValidationFindings,
    );
    if (accountingErrors.length > 0) return { evaluation: undefined, errors: accountingErrors };
  }
  return { evaluation: result.value, errors: [] };
}

function randomIndex(limit: number, randomBytes: FusionRandomBytes): number {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 0xffffffff) {
    throw new FusionError(`invalid random limit ${String(limit)}`, {
      code: 'orchestration_failed',
      childCreated: false,
    });
  }
  const range = 0x100000000;
  const ceiling = range - (range % limit);
  for (;;) {
    const bytes = randomBytes(4);
    if (bytes.length < 4) {
      throw new FusionError('random byte source returned too few bytes', {
        code: 'orchestration_failed',
        childCreated: false,
      });
    }
    const value = bytes.readUInt32BE(0);
    if (value < ceiling) return value % limit;
  }
}

function shuffledSlots(randomBytes: FusionRandomBytes): CandidateSlot[] {
  const slots: CandidateSlot[] = [1, 2, 3];
  for (let i = slots.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1, randomBytes);
    const left = slots[i];
    const right = slots[j];
    if (left === undefined || right === undefined) {
      throw new FusionError('random slot shuffle failed', {
        code: 'orchestration_failed',
        childCreated: false,
      });
    }
    slots[i] = right;
    slots[j] = left;
  }
  return slots;
}

function candidateBySlot(
  results: readonly CandidateResult[],
  slot: CandidateSlot,
): FusionChildRunResult {
  const found = results.find((candidate) => candidate.slot === slot);
  if (found === undefined) {
    throw new FusionError(`candidate slot ${String(slot)} is missing`, {
      code: 'orchestration_failed',
      childCreated: false,
    });
  }
  return found.result;
}

function candidateModel(models: ResolvedFusionModels, slot: CandidateSlot): ResolvedFusionModel {
  if (slot === 1) return models.candidates[0];
  if (slot === 2) return models.candidates[1];
  return models.candidates[2];
}

function anonymousCandidates(
  results: readonly CandidateResult[],
  slots: readonly CandidateSlot[],
): {
  map: Record<FusionCandidateId, CandidateSlot>;
  candidates: readonly [
    AnonymousFusionCandidate,
    AnonymousFusionCandidate,
    AnonymousFusionCandidate,
  ];
} {
  const firstSlot = slots[0];
  const secondSlot = slots[1];
  const thirdSlot = slots[2];
  if (firstSlot === undefined || secondSlot === undefined || thirdSlot === undefined) {
    throw new FusionError('anonymous candidate shuffle produced too few slots', {
      code: 'orchestration_failed',
      childCreated: false,
    });
  }
  const first = candidateBySlot(results, firstSlot);
  const second = candidateBySlot(results, secondSlot);
  const third = candidateBySlot(results, thirdSlot);
  return {
    map: { A: firstSlot, B: secondSlot, C: thirdSlot },
    candidates: [
      { candidate_id: 'A', response: first.text },
      { candidate_id: 'B', response: second.text },
      { candidate_id: 'C', response: third.text },
    ],
  };
}

interface ValidationSourceData {
  candidates: readonly [
    AnonymousFusionCandidate,
    AnonymousFusionCandidate,
    AnonymousFusionCandidate,
  ];
  findings: readonly FusionValidationFindingRecord[];
  verified: readonly string[];
  limitations: readonly string[];
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function boundedContractError(error: unknown): string {
  const value = errorText(error);
  return value.length <= 1_000 ? value : `${value.slice(0, 999)}…`;
}

/**
 * Enforce the validation-candidate contract without making the shared JSON
 * parser permissive. A single, tightly recognized fenced response is recovered
 * with a durable warning. One irrecoverable minority report is represented as
 * an explicit limitation; two or more still fail the workflow loudly.
 */
async function prepareValidationSourceData(
  candidates: readonly [
    AnonymousFusionCandidate,
    AnonymousFusionCandidate,
    AnonymousFusionCandidate,
  ],
  anonymousMap: Record<FusionCandidateId, CandidateSlot>,
  store: FusionArtifactStore,
): Promise<ValidationSourceData> {
  const prepared = candidates.map((candidate) => ({ ...candidate })) as [
    AnonymousFusionCandidate,
    AnonymousFusionCandidate,
    AnonymousFusionCandidate,
  ];
  const findings: FusionValidationFindingRecord[] = [];
  const verified: string[] = [];
  const limitations: string[] = [];
  let normalizationCount = 0;
  const failures: Array<{ candidate: AnonymousFusionCandidate; error: string }> = [];

  for (const candidate of prepared) {
    try {
      const report = parseFusionValidationCandidateReport(
        candidate.response,
        candidate.candidate_id,
      );
      findings.push(...report.findings);
      verified.push(...report.verified);
      limitations.push(...report.limitations);
      continue;
    } catch (strictError) {
      try {
        const recovered = recoverFencedFusionValidationCandidateReport(
          candidate.response,
          candidate.candidate_id,
        );
        if (recovered === undefined) throw strictError;
        await store.recordValidationCandidateContractEvent({
          candidateId: candidate.candidate_id,
          slot: anonymousMap[candidate.candidate_id],
          status: 'normalized',
          detail: {
            normalization: recovered.normalization,
            original_sha256: sha256Text(candidate.response),
            forwarded_sha256: sha256Text(recovered.response),
            warning:
              'Candidate output violated the bare-JSON contract; a single complete JSON fence was removed and recorded.',
          },
        });
        candidate.response = recovered.response;
        findings.push(...recovered.report.findings);
        verified.push(...recovered.report.verified);
        limitations.push(...recovered.report.limitations);
        normalizationCount += 1;
        continue;
      } catch (recoveryError) {
        failures.push({
          candidate,
          error: boundedContractError(recoveryError === strictError ? strictError : recoveryError),
        });
      }
    }
  }

  if (normalizationCount > 0) {
    limitations.push(
      `${String(normalizationCount)} validation report${normalizationCount === 1 ? '' : 's'} required audited removal of a Markdown JSON wrapper; JSON content was unchanged.`,
    );
  }

  for (const failure of failures) {
    await store.recordValidationCandidateContractEvent({
      candidateId: failure.candidate.candidate_id,
      slot: anonymousMap[failure.candidate.candidate_id],
      status: 'dropped',
      detail: {
        response_sha256: sha256Text(failure.candidate.response),
        error: failure.error,
        warning: 'Candidate output could not be parsed under the strict or fenced-JSON contract.',
      },
    });
  }
  if (failures.length > 1) {
    throw new FusionError(
      `fusion_validate cannot continue: ${String(failures.length)} of 3 candidate reports violated the structured-output contract`,
      { code: 'evaluation_invalid', stage: 'candidate' },
    );
  }
  const failure = failures[0];
  if (failure !== undefined) {
    const synthetic = canonicalJson({
      schema_version: FUSION_VALIDATE_CANDIDATE_SCHEMA_VERSION,
      findings: [],
      verified: [],
      limitations: [
        'This validation report could not be parsed after strict contract checks; no findings or verification claims from it were included.',
      ],
    });
    failure.candidate.response = synthetic;
    const report = parseFusionValidationCandidateReport(synthetic, failure.candidate.candidate_id);
    limitations.push(...report.limitations);
  }

  return { candidates: prepared, findings, verified, limitations };
}

function validateEvaluationAccountsForSourceFindings(
  evaluation: FusionEvaluationV1,
  sourceFindings: readonly FusionValidationFindingRecord[],
): readonly string[] {
  const errors: string[] = [];
  const accounting = evaluation.validation_accounting;
  if (accounting === undefined) {
    return ['validation evaluator output must include validation_accounting'];
  }
  const expected = sourceFindings.map((finding) => canonicalJson(finding)).sort();
  const actual = accounting.findings.map((finding) => canonicalJson(finding)).sort();
  if (
    expected.length !== actual.length ||
    expected.some((value, index) => value !== actual[index])
  ) {
    errors.push(
      'validation evaluator validation_accounting.findings must exactly equal host-assigned source findings',
    );
  }
  errors.push(...validateFusionFindingAccounting(accounting));
  return errors;
}

function resolveRunProfile(input: FusionWorkflowInput): FusionWorkflowProfile {
  if (input.profile !== undefined) return fusionWorkflowProfile(input.profile.id);
  const workflow = input.canonicalInput.workflow;
  const contextKind = input.canonicalInput.context?.kind;
  if (workflow !== undefined && workflow !== 'reason') {
    throw new FusionError(`fusion workflow profile is required for ${workflow} runs`, {
      code: 'orchestration_failed',
      childCreated: false,
    });
  }
  if (contextKind === 'clean_task') {
    throw new FusionError('fusion workflow profile is required for clean-task runs', {
      code: 'orchestration_failed',
      childCreated: false,
    });
  }
  return fusionWorkflowProfile('reason');
}

export class FusionOrchestrator {
  private readonly childRunner: FusionChildRunner;
  private readonly randomBytes: FusionRandomBytes;
  private readonly now: (() => Date) | undefined;
  private readonly createArtifactStore: (
    options: CreateFusionArtifactStoreOptions,
  ) => Promise<FusionArtifactStore>;

  constructor(options: FusionOrchestratorOptions = {}) {
    this.childRunner = options.childRunner ?? runPiChild;
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.now = options.now;
    this.createArtifactStore = options.createArtifactStore ?? FusionArtifactStore.create;
  }

  async run(input: FusionWorkflowInput): Promise<FusionRunResult> {
    if (input.canonicalInput.schema_version !== FUSION_INPUT_SCHEMA_VERSION) {
      throw new FusionError('fusion orchestrator accepts only v5 canonical input', {
        code: 'orchestration_failed',
        childCreated: false,
      });
    }
    const profile = resolveRunProfile(input);
    const inputWorkflow = input.canonicalInput.workflow ?? profile.id;
    const inputContextKind = input.canonicalInput.context?.kind ?? 'session_projection';
    if (inputWorkflow !== profile.id || inputContextKind !== profile.contextKind) {
      throw new FusionError(
        `fusion workflow profile ${profile.id} is incompatible with canonical input workflow=${String(inputWorkflow)} context=${String(inputContextKind)}`,
        { code: 'orchestration_failed', childCreated: false },
      );
    }
    if (
      profile.contextKind === 'clean_task' &&
      !isStrictCleanCanonicalInput(input.canonicalInput)
    ) {
      throw new FusionError(
        'clean-task fusion input must not carry parent context fields and must match the strict clean canonical shape',
        {
          code: 'orchestration_failed',
          childCreated: false,
        },
      );
    }
    const candidateCapability = assertWorkflowCapability(profile, input.candidateCapability);
    const storeOptions: CreateFusionArtifactStoreOptions = {
      cwd: input.cwd,
      profile,
      source: input.source,
      config: input.config,
      models: input.models,
      capabilities: {
        candidate: candidateCapability,
        evaluation: FUSION_NO_TOOLS_CAPABILITY,
        merge: FUSION_NO_TOOLS_CAPABILITY,
      },
    };
    if (input.sessionId !== undefined) storeOptions.sessionId = input.sessionId;
    if (this.now !== undefined) storeOptions.now = this.now;
    let serializedParsed: unknown;
    try {
      serializedParsed = parseJsonText(input.canonicalInputSerialized);
    } catch (error) {
      throw new FusionError(
        `fusion canonical input artifact is not valid JSON: ${errorText(error)}`,
        {
          code: 'orchestration_failed',
          childCreated: false,
        },
      );
    }
    if (canonicalJson(serializedParsed) !== canonicalJson(input.canonicalInput)) {
      throw new FusionError(
        'fusion canonical input serialized bytes do not match canonical input object',
        {
          code: 'orchestration_failed',
          childCreated: false,
        },
      );
    }
    const store = await this.createArtifactStore(storeOptions);
    input.onProgress?.({ type: 'state', state: 'initializing' });
    const usage = createEmptyFusionUsage();
    const calibrationWarnings: FusionCalibrationViolation[] = [];
    try {
      await store.writeCanonicalInput(input.canonicalInputSerialized);
      if (inputContextKind === 'session_projection') {
        if (input.contextLedger === undefined) {
          throw new FusionError(
            'session-projection fusion input requires an omission ledger artifact',
            {
              code: 'orchestration_failed',
              childCreated: false,
            },
          );
        }
        await store.writeContextLedger(input.contextLedger);
      } else if (input.contextLedger !== undefined) {
        throw new FusionError('clean-task fusion input must not carry a parent omission ledger', {
          code: 'orchestration_failed',
          childCreated: false,
        });
      }
      if (profile.id === 'research') {
        const cleanContext = input.canonicalInput.context;
        if (cleanContext?.kind !== 'clean_task') {
          throw new FusionError('research workflow requires a clean-task canonical input', {
            code: 'orchestration_failed',
            childCreated: false,
          });
        }
        const policy = buildFusionSourcePolicy(input.cwd, cleanContext.declared_sources);
        await store.writeSourcePolicy(sourcePolicyCanonicalBytes(policy));
      }
      // Deterministic size accounting for the whole workflow, performed before
      // a single child process exists. A rejection here launches zero children.
      const budget = new FusionBudget(
        input.models,
        input.canonicalInput.context?.policy_id ?? 'fusion-session-projection-v1',
        candidateCapability,
        profile,
      );
      const budgetPlan = budget.plan(input.canonicalInput);
      await store.writeBudgetPlan(budgetPlan);
      budget.assertPlanFits(budgetPlan, store.artifactDir);
      if (budgetPlan.warnings.length > 0) {
        input.onProgress?.({
          type: 'budget_warning',
          warnings: budgetPlan.warnings,
          error: 'fusion budget utilization warning',
        });
      }
      await input.onReady?.({
        runId: store.runId,
        artifactDir: store.artifactDir,
        artifactDirAbs: store.artifactDirAbs,
      });
      if (input.signal?.aborted === true) {
        throw new FusionError('fusion run cancelled before launch', {
          code: 'child_cancelled',
          childCreated: false,
        });
      }
      await store.transition('candidates_running');
      input.onProgress?.({ type: 'state', state: 'candidates_running' });
      const candidateResults = await this.runCandidates(
        input,
        store,
        usage,
        budget,
        calibrationWarnings,
        profile,
        candidateCapability,
      );
      await store.transition('candidates_complete');
      input.onProgress?.({ type: 'state', state: 'candidates_complete' });

      const shuffled = anonymousCandidates(candidateResults, shuffledSlots(this.randomBytes));
      // Persist the blind mapping before workflow-specific contract parsing
      // so a failed validation remains attributable to its durable slot artifact.
      await store.setAnonymousMap(shuffled.map);
      const validationData =
        profile.id === 'validate'
          ? await prepareValidationSourceData(shuffled.candidates, shuffled.map, store)
          : undefined;
      const evaluationCandidates = validationData?.candidates ?? shuffled.candidates;
      const blindInput = buildBlindEvaluationInput(
        input.canonicalInput,
        evaluationCandidates,
        validationData?.findings,
      );
      await store.writeBlindCandidates(buildEvaluationPrompt(blindInput));

      await store.transition('evaluating');
      input.onProgress?.({ type: 'state', state: 'evaluating' });
      const evaluation = await this.runEvaluation(
        input,
        store,
        usage,
        blindInput,
        budget,
        calibrationWarnings,
        profile,
        validationData?.findings,
      );
      await store.writeEvaluationJson(evaluation);
      await store.transition('evaluation_complete');
      input.onProgress?.({ type: 'state', state: 'evaluation_complete' });

      await store.transition('merging');
      input.onProgress?.({ type: 'state', state: 'merging' });
      const mergeInput = buildMergeInput(input.canonicalInput, evaluationCandidates, evaluation);
      const mergePrompt = buildMergePrompt(mergeInput);
      budget.assertStagePrompt('merge', profile.mergerSystemPrompt, mergePrompt);
      input.onProgress?.({ type: 'merge_started' });
      const merged = await this.runChildWithRetry(
        input,
        store,
        usage,
        input.models.merger,
        'merge',
        profile.mergerSystemPrompt,
        mergePrompt,
        input.signal ?? new AbortController().signal,
        // Stage policy, not caller input: evaluator and merger are always reasoning-only.
        FUSION_NO_TOOLS_CAPABILITY,
        undefined,
        'md',
      );
      addFusionUsage(usage, merged.usage);
      await store.recordChildAttempt({
        result: merged,
        systemPrompt: profile.mergerSystemPrompt,
        prompt: mergePrompt,
        responseKind: 'md',
      });
      await this.recordCalibrationObservation(
        input,
        store,
        budget,
        calibrationWarnings,
        'merge',
        profile.mergerSystemPrompt,
        mergePrompt,
        merged,
      );
      assertChildOutputWithinContract('merge', merged.text);
      let finalMergedText = merged.text;
      if (profile.id === 'validate') {
        const accounting = evaluation.validation_accounting;
        if (accounting === undefined) {
          throw new FusionError(
            'fusion_validate evaluation completed without validation accounting',
            {
              code: 'evaluation_invalid',
              stage: 'merge',
            },
          );
        }
        finalMergedText = renderValidatedFusionValidationReport(accounting, validationData);
      }
      if (finalMergedText !== merged.text)
        assertChildOutputWithinContract('merge', finalMergedText);
      const mergedRef = await store.writeMerged(finalMergedText);
      await store.setUsage(usage);
      const details: FusionRunResult['details'] = {
        schema_version: FUSION_RESULT_SCHEMA_VERSION,
        run_id: store.runId,
        workflow: profile.id,
        source: input.source,
        status: 'completed',
        artifact_dir: store.artifactDir,
        context: {
          kind: inputContextKind,
          policy_id: input.canonicalInput.context?.policy_id ?? 'fusion-session-projection-v1',
        },
        tool_policy: {
          candidate_tools: profile.candidateTools,
          evaluation_tools: [],
          merge_tools: [],
        },
        models: store.snapshot().models,
        evaluator_attempts: store
          .snapshot()
          .attempts.filter((attempt) => attempt.stage === 'evaluation').length,
        usage,
        budget: {
          policy_id: FUSION_BUDGET_POLICY.id,
          calibration_version: budgetPlan.policy.calibration_version,
          route_table: budget.routes,
          rate_sources: budget.resultRateSources,
          unknown_provider_warnings: budget.unknownProviderWarnings,
          calibration_warnings: calibrationWarnings,
        },
      };
      await store.writeCommittedResult(mergedRef, details);
      await store.transition('completed');
      input.onProgress?.({ type: 'completed', runId: store.runId, artifactDir: store.artifactDir });
      return { mergedText: finalMergedText, details };
    } catch (error) {
      const cancelled =
        input.signal?.aborted === true ||
        (error instanceof FusionError && error.code === 'child_cancelled');
      let terminalError: FusionError;
      try {
        await store.setUsage(usage);
        terminalError = withRunProgress(
          error,
          store.artifactDir,
          deriveFusionRunProgress(store.snapshot()),
        );
        const terminalState = cancelled ? 'cancelled' : 'failed';
        await store.writeError(terminalState, terminalError.message);
        // The terminal manifest/error are authoritative. Summary persistence is
        // subordinate and intentionally attempted once from that fresh snapshot.
        try {
          const terminalManifest = store.snapshot();
          await store.writeFailureSummary(
            buildFusionFailureSummary({
              manifest: terminalManifest,
              terminalError,
              progress: deriveFusionRunProgress(terminalManifest),
              terminalState,
              createdAt: terminalManifest.updated_at,
            }),
          );
        } catch (summaryError) {
          terminalError = withSummaryUnavailableNote(terminalError, summaryError);
        }
      } catch (artifactError) {
        throw withTerminalArtifactFailure(error, store.artifactDir, artifactError);
      }
      if (cancelled) {
        input.onProgress?.({
          type: 'cancelled',
          runId: store.runId,
          artifactDir: store.artifactDir,
          reason: terminalError.message,
        });
      } else {
        input.onProgress?.({
          type: 'failed',
          runId: store.runId,
          artifactDir: store.artifactDir,
          error: terminalError.message,
        });
      }
      throw terminalError;
    }
  }

  private async runCandidates(
    input: FusionWorkflowInput,
    store: FusionArtifactStore,
    usage: FusionUsage,
    budget: FusionBudget,
    calibrationWarnings: FusionCalibrationViolation[],
    profile: FusionWorkflowProfile,
    candidateCapability: FusionCapability,
  ): Promise<readonly CandidateResult[]> {
    const controller = new AbortController();
    const abortListener = () => controller.abort();
    input.signal?.addEventListener('abort', abortListener, { once: true });
    if (input.signal?.aborted) controller.abort();
    const systemPrompt = profile.candidateSystemPrompt(candidateCapability);
    const prompt = buildCandidatePrompt(input.canonicalInput);
    for (const slot of [1, 2, 3] as const) {
      budget.assertStagePrompt('candidate', systemPrompt, prompt, slot);
    }
    let primaryError: unknown;
    let completed = 0;
    try {
      if (controller.signal.aborted) {
        throw new FusionError('fusion candidate wave cancelled before launch', {
          code: 'child_cancelled',
          stage: 'candidate',
          childCreated: false,
        });
      }
      const tasks: Array<Promise<CandidateResult>> = ([1, 2, 3] as const).map((slot) => {
        const model = candidateModel(input.models, slot);
        const task = this.runChildWithRetry(
          input,
          store,
          usage,
          model,
          'candidate',
          systemPrompt,
          prompt,
          controller.signal,
          candidateCapability,
          slot,
          profile.id === 'validate' ? 'txt' : 'md',
        ).then(async (result) => {
          await store.recordChildAttempt({
            result,
            systemPrompt,
            prompt,
            responseKind: profile.id === 'validate' ? 'txt' : 'md',
          });
          await this.recordCalibrationObservation(
            input,
            store,
            budget,
            calibrationWarnings,
            'candidate',
            systemPrompt,
            prompt,
            result,
            slot,
          );
          // The response and its consumed usage are durable before the contract
          // check, so an oversized answer is preserved and accounted rather than lost.
          addFusionUsage(usage, result.usage);
          await store.setUsage(usage);
          assertChildOutputWithinContract('candidate', result.text);
          completed += 1;
          input.onProgress?.({ type: 'candidate_completed', slot, completed, total: 3 });
          return { slot, result };
        });
        return task.catch((error: unknown) => {
          if (primaryError === undefined) {
            primaryError = error;
            controller.abort();
          }
          throw error;
        });
      });
      const settled = await Promise.allSettled(tasks);
      if (primaryError !== undefined) throw primaryError;
      const results: CandidateResult[] = [];
      for (const item of settled) {
        if (item.status === 'fulfilled') results.push(item.value);
        else throw item.reason;
      }
      return results.sort((left, right) => left.slot - right.slot);
    } finally {
      input.signal?.removeEventListener('abort', abortListener);
    }
  }

  private async runEvaluation(
    input: FusionWorkflowInput,
    store: FusionArtifactStore,
    usage: FusionUsage,
    blindInput: Parameters<typeof buildEvaluationPrompt>[0],
    budget: FusionBudget,
    calibrationWarnings: FusionCalibrationViolation[],
    profile: FusionWorkflowProfile,
    expectedValidationFindings: readonly FusionValidationFindingRecord[] | undefined,
  ): Promise<FusionEvaluationV1> {
    const firstPrompt = buildEvaluationPrompt(blindInput);
    budget.assertStagePrompt('evaluation', profile.evaluatorSystemPrompt, firstPrompt);
    const first = await this.runEvaluationAttempt(
      input,
      store,
      usage,
      budget,
      calibrationWarnings,
      firstPrompt,
      1,
      false,
      profile,
      expectedValidationFindings,
    );
    if (first.evaluation !== undefined) return first.evaluation;
    const errors = boundedEvaluationErrors(first.errors);
    input.onProgress?.({ type: 'evaluation_retry', errors });
    const repairPrompt = buildEvaluationRepairPrompt({
      schema_version: 'pi-background-tasks.fusion-evaluation-repair-input.v1',
      original_blind_input: blindInput,
      invalid_output: first.result.text,
      validation_errors: errors,
    });
    budget.assertStagePrompt(
      'evaluation_repair',
      profile.evaluationRepairSystemPrompt,
      repairPrompt,
    );
    const second = await this.runEvaluationAttempt(
      input,
      store,
      usage,
      budget,
      calibrationWarnings,
      repairPrompt,
      2,
      true,
      profile,
      expectedValidationFindings,
    );
    if (second.evaluation !== undefined) return second.evaluation;
    throw new FusionError(
      `evaluation schema repair failed: ${formatEvaluationErrors(second.errors)}`,
      {
        code: 'evaluation_invalid',
        stage: 'evaluation',
        attempt: 2,
      },
    );
  }

  private async runEvaluationAttempt(
    input: FusionWorkflowInput,
    store: FusionArtifactStore,
    usage: FusionUsage,
    budget: FusionBudget,
    calibrationWarnings: FusionCalibrationViolation[],
    prompt: string,
    attempt: 1 | 2,
    repair: boolean,
    profile: FusionWorkflowProfile,
    expectedValidationFindings: readonly FusionValidationFindingRecord[] | undefined,
  ): Promise<EvaluationAttemptResult> {
    input.onProgress?.({ type: 'evaluation_started', attempt, repair });
    const systemPrompt = repair
      ? profile.evaluationRepairSystemPrompt
      : profile.evaluatorSystemPrompt;
    const result = await this.runChildWithRetry(
      input,
      store,
      usage,
      input.models.evaluator,
      'evaluation',
      systemPrompt,
      prompt,
      input.signal ?? new AbortController().signal,
      // Stage policy, not caller input: evaluator and merger are always reasoning-only.
      FUSION_NO_TOOLS_CAPABILITY,
      undefined,
      'txt',
      attempt,
    );
    addFusionUsage(usage, result.usage);
    await store.recordChildAttempt({ result, systemPrompt, prompt, responseKind: 'txt' });
    await this.recordCalibrationObservation(
      input,
      store,
      budget,
      calibrationWarnings,
      'evaluation',
      systemPrompt,
      prompt,
      result,
    );
    await store.setUsage(usage);
    // Bound the evaluator output before it can be embedded in a repair prompt.
    assertChildOutputWithinContract('evaluation', result.text);
    const parsed = parseEvaluationAttempt(result.text, expectedValidationFindings);
    return { result, evaluation: parsed.evaluation, errors: parsed.errors };
  }

  private async recordCalibrationObservation(
    input: FusionWorkflowInput,
    store: FusionArtifactStore,
    budget: FusionBudget,
    calibrationWarnings: FusionCalibrationViolation[],
    stage: FusionStage,
    systemPrompt: string,
    userPrompt: string,
    result: FusionChildRunResult,
    slot?: CandidateSlot,
  ): Promise<void> {
    const violation = budget.calibrationViolationForCompletedChild(
      stage,
      systemPrompt,
      userPrompt,
      result,
      slot,
    );
    if (violation === undefined) return;
    calibrationWarnings.push(violation);
    let artifact = 'calibration-violation artifact was not written';
    try {
      const ref = await store.recordCalibrationViolation({
        stage,
        attempt: result.attempt,
        violation,
        ...(slot === undefined ? {} : { slot }),
      });
      artifact = ref.path;
    } catch (error) {
      artifact = `calibration-violation artifact write failed: ${errorText(error)}`;
    }
    input.onProgress?.({ type: 'calibration_warning', warning: violation, artifact });
  }

  private async runChildWithRetry(
    input: FusionWorkflowInput,
    store: FusionArtifactStore,
    usage: FusionUsage,
    model: ResolvedFusionModel,
    stage: FusionStage,
    systemPrompt: string,
    userPrompt: string,
    signal: AbortSignal,
    capability: FusionCapability,
    slot: CandidateSlot | undefined,
    responseKind: 'md' | 'txt',
    fixedAttempt?: 1 | 2,
  ): Promise<FusionChildRunResult> {
    const logicalAttempt = fixedAttempt ?? 1;
    for (let launchTry = 1; launchTry <= 2; launchTry++) {
      if (stage === 'candidate' && slot !== undefined) {
        input.onProgress?.({ type: 'candidate_started', slot, attempt: logicalAttempt });
      }
      const toolCallLogPath =
        capability !== 'reason'
          ? store.childToolCallLogPath(stage, slot, logicalAttempt)
          : undefined;
      const sourcePolicy =
        capability === 'research' ? store.sourcePolicyLaunchReference() : undefined;
      const candidateOutputRecoveryPath =
        stage === 'candidate' && slot !== undefined
          ? store.childOutputRecoveryPath(slot, logicalAttempt, responseKind)
          : undefined;
      try {
        return await this.childRunner(
          childOptions(
            input,
            model,
            stage,
            logicalAttempt,
            capability,
            systemPrompt,
            userPrompt,
            signal,
            slot,
            toolCallLogPath,
            sourcePolicy,
            candidateOutputRecoveryPath,
          ),
        );
      } catch (error) {
        if (!signal.aborted && retryableSpawn(error, launchTry) && launchTry === 1) continue;
        addFailedChildUsage(usage, error);
        await store.recordFailedAttempt(
          recordFailureInput(
            error,
            stage,
            slot,
            logicalAttempt,
            systemPrompt,
            userPrompt,
            responseKind,
          ),
        );
        await store.setUsage(usage);
        throw error;
      }
    }
    const details: FusionErrorDetails = {
      code: 'orchestration_failed',
      stage,
      childCreated: false,
    };
    if (slot !== undefined) details.slot = slot;
    throw new FusionError(`${stage} child did not produce a result`, details);
  }
}
