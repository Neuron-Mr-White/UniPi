import { createHash } from 'node:crypto';
import {
  TOKEN_BUDGET_AFFINE_F_TOKENS,
  TOKEN_BUDGET_CALIBRATION_VERSION,
  TOKEN_BUDGET_FAMILY_CALIBRATIONS,
  TOKEN_BUDGET_LARGE_PROMPT_MIN_BYTES,
  TOKEN_BUDGET_RATE_SCALE,
  estimateInputTokens,
  knownTextSegment,
  maxKnownTextBytesForTokens,
  resolveTokenBudgetFamily,
  unknownOutputContractSegment,
  allowedInputTokens,
  isUsableContextWindow,
} from '../context-token-budget.js';
import {
  buildBlindEvaluationInput,
  buildCandidatePrompt,
  buildEvaluationPrompt,
  buildEvaluationRepairPrompt,
  buildMergeInput,
  buildMergePrompt,
  type AnonymousFusionCandidate,
} from './prompts.js';
import { FUSION_REASON_WORKFLOW, type FusionWorkflowProfile } from './workflows.js';
import {
  FUSION_CANDIDATE_MAX_OUTPUT_BYTES,
  FUSION_DIAGNOSTICS_MAX_BYTES,
  FUSION_EVALUATION_MAX_OUTPUT_BYTES,
  FUSION_MERGE_MAX_OUTPUT_BYTES,
} from './output-contract.js';
export {
  FUSION_CANDIDATE_MAX_OUTPUT_BYTES,
  FUSION_DIAGNOSTICS_MAX_BYTES,
  FUSION_EVALUATION_MAX_OUTPUT_BYTES,
  FUSION_MERGE_MAX_OUTPUT_BYTES,
  assertChildOutputWithinContract,
  fusionOutputContractBytes,
} from './output-contract.js';
import {
  FUSION_BUDGET_PLAN_SCHEMA_VERSION,
  FUSION_CALIBRATION_VIOLATION_SCHEMA_VERSION,
  FUSION_EVALUATION_SCHEMA_VERSION,
  FusionError,
  type FusionBudgetBlocker,
  type FusionBudgetCheckKind,
  type FusionBudgetComponentBreakdown,
  type FusionBudgetCounterfactuals,
  type FusionBudgetEmptyRequestVerdict,
  type FusionBudgetErrorDetail,
  type FusionBudgetPlanV1,
  type FusionBudgetPolicyDescriptor,
  type FusionBudgetRouteTableEntry,
  type FusionBudgetStage,
  type FusionBudgetStageComposition,
  type FusionBudgetWarning,
  type FusionCalibrationViolation,
  type FusionCanonicalInputV3,
  type FusionCapability,
  type FusionEvaluationV1,
  type FusionRouteCapacity,
  type FusionStage,
  type FusionStageBudgetPlanEntry,
  type FusionChildRunResult,
  type ResolvedFusionModel,
  type ResolvedFusionModels,
} from './types.js';

export const FUSION_CALIBRATED_BYTES_PER_TOKEN = TOKEN_BUDGET_FAMILY_CALIBRATIONS;

const FUSION_OUTPUT_RESERVE_RATE_X100 = 200;
export const FUSION_UTILIZATION_WARNING_THRESHOLD_BASIS_POINTS = 8000;
const BASIS_POINTS_DENOMINATOR = 10_000;

function ceilDiv(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || numerator < 0) {
    throw new TypeError('ceilDiv numerator must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new TypeError('ceilDiv denominator must be a positive safe integer');
  }
  if (numerator === 0) return 0;
  return Math.floor((numerator - 1) / denominator) + 1;
}

export const FUSION_RESERVED_OUTPUT_TOKENS = ceilDiv(
  FUSION_MERGE_MAX_OUTPUT_BYTES * TOKEN_BUDGET_RATE_SCALE,
  FUSION_OUTPUT_RESERVE_RATE_X100,
);
export const FUSION_FRAMING_RESERVE_TOKENS = 0;
export const FUSION_SAFETY_RESERVE_TOKENS = 4_096;
export const FUSION_MIN_CANONICAL_INPUT_TOKENS = 8_192;
export const FUSION_MIN_CONTEXT_WINDOW_TOKENS =
  FUSION_MIN_CANONICAL_INPUT_TOKENS +
  FUSION_RESERVED_OUTPUT_TOKENS +
  FUSION_FRAMING_RESERVE_TOKENS +
  FUSION_SAFETY_RESERVE_TOKENS;

export const FUSION_BUDGET_POLICY: FusionBudgetPolicyDescriptor = {
  id: 'fusion-budget-policy-v4',
  route_output_reserve_strategy: 'max_fusion_contract_or_model_max',
  calibration_version: TOKEN_BUDGET_CALIBRATION_VERSION,
  calibration_table: FUSION_CALIBRATED_BYTES_PER_TOKEN,
  reserved_output_tokens: FUSION_RESERVED_OUTPUT_TOKENS,
  framing_reserve_tokens: FUSION_FRAMING_RESERVE_TOKENS,
  safety_reserve_tokens: FUSION_SAFETY_RESERVE_TOKENS,
  candidate_output_contract_bytes: FUSION_CANDIDATE_MAX_OUTPUT_BYTES,
  evaluation_output_contract_bytes: FUSION_EVALUATION_MAX_OUTPUT_BYTES,
  merge_output_contract_bytes: FUSION_MERGE_MAX_OUTPUT_BYTES,
  diagnostics_contract_bytes: FUSION_DIAGNOSTICS_MAX_BYTES,
  utilization_warning_threshold_basis_points: FUSION_UTILIZATION_WARNING_THRESHOLD_BASIS_POINTS,
};

const REASON_EMPTY_REMEDIATION: readonly string[] = Object.freeze([
  'Start a fresh Pi conversation, or run fusion_reason earlier in the session.',
  "Raise the route's context window with a larger-context subscription model via /fusion-models.",
  'Restate only the required prior findings in the fusion_reason prompt.',
]);

const REASON_REQUEST_REMEDIATION: readonly string[] = Object.freeze([
  'Provide a shorter fusion_reason prompt.',
  'Start a fresh Pi conversation, or run fusion_reason earlier in the session.',
  "Raise the route's context window with a larger-context subscription model via /fusion-models.",
]);

const INVESTIGATE_EMPTY_REMEDIATION: readonly string[] = Object.freeze([
  'Split the repository investigation into smaller independently complete path or subsystem scopes.',
  "Raise the route's context window with a larger-context subscription model via /fusion-models.",
]);
const INVESTIGATE_REQUEST_REMEDIATION: readonly string[] = Object.freeze([
  'Narrow the fusion_investigate objective, repository scope, or required evidence.',
  "Raise the route's context window with a larger-context subscription model via /fusion-models.",
]);
const RESEARCH_EMPTY_REMEDIATION: readonly string[] = Object.freeze([
  'Split the research into smaller independently complete source sets.',
  "Raise the route's context window with a larger-context subscription model via /fusion-models.",
]);
const RESEARCH_REQUEST_REMEDIATION: readonly string[] = Object.freeze([
  'Narrow the fusion_research question or split large declared-source sets across independent runs.',
  "Raise the route's context window with a larger-context subscription model via /fusion-models.",
]);
const VALIDATE_EMPTY_REMEDIATION: readonly string[] = Object.freeze([
  'Split validation into smaller independently complete change or acceptance-criterion scopes.',
  "Raise the route's context window with a larger-context subscription model via /fusion-models.",
]);
const VALIDATE_REQUEST_REMEDIATION: readonly string[] = Object.freeze([
  'Narrow the fusion_validate scope, acceptance criteria, or supplied verification evidence.',
  "Raise the route's context window with a larger-context subscription model via /fusion-models.",
]);

function cleanRemediation(
  profile: FusionWorkflowProfile,
  requestDeterminesFeasibility: boolean,
): readonly string[] {
  if (profile.id === 'investigate') {
    return requestDeterminesFeasibility
      ? INVESTIGATE_REQUEST_REMEDIATION
      : INVESTIGATE_EMPTY_REMEDIATION;
  }
  if (profile.id === 'research') {
    return requestDeterminesFeasibility ? RESEARCH_REQUEST_REMEDIATION : RESEARCH_EMPTY_REMEDIATION;
  }
  if (profile.id === 'validate') {
    return requestDeterminesFeasibility ? VALIDATE_REQUEST_REMEDIATION : VALIDATE_EMPTY_REMEDIATION;
  }
  return requestDeterminesFeasibility ? REASON_REQUEST_REMEDIATION : REASON_EMPTY_REMEDIATION;
}

const RESERVATION_REMEDIATION: readonly string[] = Object.freeze([
  'Route the blocking stage to a model with larger byte capacity.',
  'Keep producer output contracts intact; do not shrink or truncate child answers.',
  'Inspect budget-plan.json for the advisory reservation component before retrying.',
]);

const DENSE_REMEDIATION: readonly string[] = Object.freeze([
  'Remove or externalize low-whitespace dense ASCII payloads (base64, minified code, PEM/hex blocks), then retry.',
  'The prompt is preserved; no content was clipped to fit.',
]);

const MULTIBYTE_REMEDIATION: readonly string[] = Object.freeze([
  'This rejection is dominated by multibyte UTF-8 content; use a larger-context route or split the non-Latin/CJK-heavy task.',
  'The budget plan includes the stricter multibyte advisory ceiling separately from the fatal estimate.',
  'The prompt is preserved; no content was clipped to fit.',
]);

const EMPTY_CANDIDATES: readonly [
  AnonymousFusionCandidate,
  AnonymousFusionCandidate,
  AnonymousFusionCandidate,
] = Object.freeze([
  Object.freeze({ candidate_id: 'A', response: '' }),
  Object.freeze({ candidate_id: 'B', response: '' }),
  Object.freeze({ candidate_id: 'C', response: '' }),
]);

const EMPTY_EVALUATION: FusionEvaluationV1 = Object.freeze({
  schema_version: FUSION_EVALUATION_SCHEMA_VERSION,
  candidate_assessments: Object.freeze([
    Object.freeze({
      candidate_id: 'A',
      summary: '',
      strengths: Object.freeze([]),
      limitations: Object.freeze([]),
      useful_contributions: Object.freeze([]),
      risks: Object.freeze([]),
    }),
    Object.freeze({
      candidate_id: 'B',
      summary: '',
      strengths: Object.freeze([]),
      limitations: Object.freeze([]),
      useful_contributions: Object.freeze([]),
      risks: Object.freeze([]),
    }),
    Object.freeze({
      candidate_id: 'C',
      summary: '',
      strengths: Object.freeze([]),
      limitations: Object.freeze([]),
      useful_contributions: Object.freeze([]),
      risks: Object.freeze([]),
    }),
  ]) as readonly [
    FusionEvaluationV1['candidate_assessments'][0],
    FusionEvaluationV1['candidate_assessments'][1],
    FusionEvaluationV1['candidate_assessments'][2],
  ],
  agreements: Object.freeze([]),
  conflicts: Object.freeze([]),
  synthesis_plan: Object.freeze({
    must_include: Object.freeze([]),
    must_resolve: Object.freeze([]),
    must_avoid: Object.freeze([]),
  }),
});

interface StageForecastDraft {
  budget_stage: FusionBudgetStage;
  slot?: 1 | 2 | 3;
  route: FusionRouteCapacity;
  conditional: boolean;
  system_prompt: string;
  empty_user_prompt: string;
  upstream_output_contract_bytes: number;
}

export function fusionTokenUpperBound(utf8Bytes: number): number {
  return estimateInputTokens({
    family: 'unknown',
    scope: 'conservative',
    segments: [{ kind: 'known_text', bytes: utf8Bytes, multibyteBytes: 0, denseBytes: 0 }],
  }).tokens;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requirePositiveContextWindow(model: ResolvedFusionModel, role: string): number {
  const value = model.contextWindow;
  if (!isUsableContextWindow(value)) {
    throw new FusionError(
      `fusion ${role} route ${model.qualifiedId} has no usable context window capacity`,
      { code: 'model_capacity_unknown', childCreated: false },
    );
  }
  return value;
}

function formatRateX100(value: number): string {
  const whole = Math.floor(value / TOKEN_BUDGET_RATE_SCALE);
  const frac = String(value % TOKEN_BUDGET_RATE_SCALE).padStart(2, '0');
  return `${String(whole)}.${frac}`;
}

function routeCapacity(
  model: ResolvedFusionModel,
  role: FusionRouteCapacity['role'],
): FusionRouteCapacity {
  const contextWindow = requirePositiveContextWindow(model, role);
  const reservedOutputTokens = Math.max(FUSION_RESERVED_OUTPUT_TOKENS, model.maxOutputTokens);
  const allowed = allowedInputTokens(contextWindow, {
    reservedOutputTokens,
    framingReserveTokens: FUSION_FRAMING_RESERVE_TOKENS,
    safetyReserveTokens: FUSION_SAFETY_RESERVE_TOKENS,
  });
  if (allowed < FUSION_MIN_CANONICAL_INPUT_TOKENS) {
    const minimumContextWindow =
      reservedOutputTokens +
      FUSION_FRAMING_RESERVE_TOKENS +
      FUSION_SAFETY_RESERVE_TOKENS +
      FUSION_MIN_CANONICAL_INPUT_TOKENS;
    throw new FusionError(
      `fusion ${role} route ${model.qualifiedId} has a ${String(contextWindow)}-token context window, but Fusion requires at least ${String(minimumContextWindow)} tokens: ${String(reservedOutputTokens)} reserved for the route's configured maximum output + ${String(FUSION_FRAMING_RESERVE_TOKENS)} framing + ${String(FUSION_SAFETY_RESERVE_TOKENS)} safety + ${String(FUSION_MIN_CANONICAL_INPUT_TOKENS)} usable input. Choose a larger-context or lower-max-output subscription model for this slot with /fusion-models.`,
      { code: 'model_capacity_unknown', childCreated: false },
    );
  }
  const family = resolveTokenBudgetFamily({ provider: model.provider, model: model.model });
  const rateSource = estimateInputTokens({
    family: family.family,
    calibrationBacked: family.backed,
    familyResolution: family.resolution,
    allowedInputTokens: allowed,
    scope: 'fusion',
    segments: [
      {
        kind: 'known_text',
        bytes: TOKEN_BUDGET_LARGE_PROMPT_MIN_BYTES,
        multibyteBytes: 0,
        denseBytes: 0,
        asciiWhitespaceBytes: TOKEN_BUDGET_LARGE_PROMPT_MIN_BYTES,
      },
    ],
  }).rateSource;
  return {
    role,
    provider: model.provider,
    model: model.model,
    qualified_id: model.qualifiedId,
    context_window_tokens: contextWindow,
    reserved_output_tokens: reservedOutputTokens,
    framing_reserve_tokens: FUSION_FRAMING_RESERVE_TOKENS,
    safety_reserve_tokens: FUSION_SAFETY_RESERVE_TOKENS,
    allowed_input_tokens: allowed,
    family: family.family,
    rate_source: rateSource,
    byte_capacity_utf8_bytes: Math.floor(
      (allowed * rateSource.effective_rate_bytes_per_token_x100) / TOKEN_BUDGET_RATE_SCALE,
    ),
  };
}

export function fusionRouteCapacities(models: ResolvedFusionModels): readonly FusionRouteCapacity[] {
  return [
    routeCapacity(models.candidates[0], 'candidate-1'),
    routeCapacity(models.candidates[1], 'candidate-2'),
    routeCapacity(models.candidates[2], 'candidate-3'),
    routeCapacity(models.evaluator, 'evaluator'),
    routeCapacity(models.merger, 'merger'),
  ];
}

export function fusionLimitingRoute(
  routes: readonly FusionRouteCapacity[],
): FusionRouteCapacity {
  let limiting: FusionRouteCapacity | undefined;
  for (const route of routes) {
    if (
      limiting === undefined ||
      route.byte_capacity_utf8_bytes < limiting.byte_capacity_utf8_bytes ||
      (route.byte_capacity_utf8_bytes === limiting.byte_capacity_utf8_bytes &&
        route.role.localeCompare(limiting.role) < 0)
    ) {
      limiting = route;
    }
  }
  if (limiting === undefined) {
    throw new FusionError('fusion budget planning received no configured routes', {
      code: 'model_capacity_unknown',
      childCreated: false,
    });
  }
  return limiting;
}

function routeByRole(
  routes: readonly FusionRouteCapacity[],
  role: FusionRouteCapacity['role'],
): FusionRouteCapacity {
  const route = routes.find((item) => item.role === role);
  if (route === undefined) {
    throw new FusionError(`fusion budget route ${role} is missing`, {
      code: 'model_capacity_unknown',
      childCreated: false,
    });
  }
  return route;
}

function candidateRole(slot: 1 | 2 | 3): FusionRouteCapacity['role'] {
  if (slot === 1) return 'candidate-1';
  if (slot === 2) return 'candidate-2';
  return 'candidate-3';
}

function estimateRouteInput(
  route: FusionRouteCapacity,
  segments: Parameters<typeof estimateInputTokens>[0]['segments'],
) {
  return estimateInputTokens({
    family: route.family,
    calibrationBacked: route.rate_source.backed,
    familyResolution: route.rate_source.model_resolution,
    allowedInputTokens: route.allowed_input_tokens,
    scope: 'fusion',
    segments,
  });
}

function utilizationBasisPoints(tokens: number, allowed: number): number {
  return ceilDiv(tokens * BASIS_POINTS_DENOMINATOR, allowed);
}

function forecastEntry(draft: StageForecastDraft): FusionStageBudgetPlanEntry {
  const inputSegments = [knownTextSegment(draft.system_prompt), knownTextSegment(draft.empty_user_prompt)];
  const inputBytes = inputSegments.reduce((sum, segment) => sum + segment.bytes, 0);
  const inputOnly = estimateRouteInput(draft.route, inputSegments);
  const reservationSegments =
    draft.upstream_output_contract_bytes === 0
      ? inputSegments
      : [...inputSegments, unknownOutputContractSegment(draft.upstream_output_contract_bytes)];
  const reservation = estimateRouteInput(draft.route, reservationSegments);
  const forecastUtf8Bytes = inputBytes + draft.upstream_output_contract_bytes;
  const entry: FusionStageBudgetPlanEntry = {
    budget_stage: draft.budget_stage,
    route: draft.route,
    conditional: draft.conditional,
    check_kind: 'input_only_preflight',
    input_utf8_bytes: inputBytes,
    upstream_output_contract_bytes: draft.upstream_output_contract_bytes,
    forecast_utf8_bytes: forecastUtf8Bytes,
    input_only_input_tokens_upper_bound: inputOnly.tokens,
    forecast_input_tokens_upper_bound: reservation.tokens,
    allowed_input_tokens: draft.route.allowed_input_tokens,
    input_only_signed_headroom_tokens: draft.route.allowed_input_tokens - inputOnly.tokens,
    signed_headroom_tokens: draft.route.allowed_input_tokens - reservation.tokens,
    input_only_utilization_basis_points: utilizationBasisPoints(
      inputOnly.tokens,
      draft.route.allowed_input_tokens,
    ),
    utilization_basis_points: utilizationBasisPoints(
      reservation.tokens,
      draft.route.allowed_input_tokens,
    ),
    input_only_estimate: inputOnly,
    reservation_estimate: reservation,
    fits: inputOnly.tokens <= draft.route.allowed_input_tokens,
    reservation_fits: reservation.tokens <= draft.route.allowed_input_tokens,
  };
  if (draft.slot !== undefined) entry.slot = draft.slot;
  return entry;
}

function maxKnownTextBytes(route: FusionRouteCapacity): number {
  return maxKnownTextBytesForTokens({
    family: route.family,
    calibrationBacked: route.rate_source.backed,
    familyResolution: route.rate_source.model_resolution,
    allowedInputTokens: route.allowed_input_tokens,
    scope: 'fusion',
  });
}

function blockerFromEntry(entry: FusionStageBudgetPlanEntry): FusionBudgetBlocker {
  return {
    ...entry,
    overage_tokens: Math.max(0, entry.input_only_input_tokens_upper_bound - entry.allowed_input_tokens),
    bytes_over: Math.max(0, entry.input_utf8_bytes - maxKnownTextBytes(entry.route)),
  };
}

function blockerOrder(blocker: FusionBudgetBlocker): number {
  if (blocker.budget_stage === 'candidate') return blocker.slot ?? 1;
  if (blocker.budget_stage === 'evaluation') return 4;
  if (blocker.budget_stage === 'merge') return 5;
  return 6;
}

function selectBlockers(entries: readonly FusionStageBudgetPlanEntry[]): readonly FusionBudgetBlocker[] {
  return entries.filter((entry) => !entry.fits).map(blockerFromEntry).sort((left, right) => {
    const byOrder = blockerOrder(left) - blockerOrder(right);
    if (byOrder !== 0) return byOrder;
    return left.route.role.localeCompare(right.route.role);
  });
}

function selectPrimaryBlocker(
  blockers: readonly FusionBudgetBlocker[],
): FusionBudgetBlocker | undefined {
  const mandatory = blockers.find((blocker) => !blocker.conditional);
  return mandatory ?? blockers[0];
}

function replaceRequestText(input: FusionCanonicalInputV3, text: string): FusionCanonicalInputV3 {
  return {
    ...input,
    request: {
      ...input.request,
      text,
      sha256: sha256Hex(text),
    },
  };
}

function visibleTextBytes(input: FusionCanonicalInputV3): number {
  const projection = input.context?.kind === 'session_projection'
    ? input.context.conversation_projection
    : 'conversation_projection' in input
      ? input.conversation_projection
      : undefined;
  if (projection === undefined) return 0;
  let total = 0;
  for (const entry of projection.entries) {
    if (entry[0] === 't') total += utf8Bytes(JSON.stringify(entry[4]));
  }
  return total;
}

function omissionReceiptBytes(input: FusionCanonicalInputV3): number {
  const projection = input.context?.kind === 'session_projection'
    ? input.context.conversation_projection
    : 'conversation_projection' in input
      ? input.conversation_projection
      : undefined;
  if (projection === undefined) return 0;
  let total = 0;
  for (const entry of projection.entries) {
    if (entry[0] === 'o') total += utf8Bytes(JSON.stringify(entry));
  }
  return total;
}

function warningFromEntry(entry: FusionStageBudgetPlanEntry): FusionBudgetWarning | undefined {
  if (!entry.fits) return undefined;
  if (!entry.reservation_fits) {
    return {
      ...entry,
      warning_kind: 'worst_case_reservation',
      threshold_basis_points: FUSION_UTILIZATION_WARNING_THRESHOLD_BASIS_POINTS,
    };
  }
  if (entry.utilization_basis_points >= FUSION_UTILIZATION_WARNING_THRESHOLD_BASIS_POINTS) {
    return {
      ...entry,
      warning_kind: 'input_utilization',
      threshold_basis_points: FUSION_UTILIZATION_WARNING_THRESHOLD_BASIS_POINTS,
    };
  }
  return undefined;
}

function warningsFor(entries: readonly FusionStageBudgetPlanEntry[]): readonly FusionBudgetWarning[] {
  return entries.flatMap((entry) => {
    const warning = warningFromEntry(entry);
    return warning === undefined ? [] : [warning];
  });
}

function entryLabel(entry: FusionStageBudgetPlanEntry): string {
  const slot = entry.slot === undefined ? '' : `-${String(entry.slot)}`;
  const conditional = entry.conditional ? ' (conditional)' : '';
  return `${entry.budget_stage}${slot}${conditional}`;
}

function blockingChildLabel(entry: FusionStageBudgetPlanEntry): string {
  if (entry.budget_stage === 'candidate') return `candidate-${String(entry.slot ?? 1)}`;
  if (entry.budget_stage === 'evaluation_repair') return 'evaluator-repair';
  if (entry.budget_stage === 'evaluation') return 'evaluator';
  return 'merger';
}

function formatTable(entries: readonly FusionStageBudgetPlanEntry[]): string {
  const lines = entries.map(
    (entry) =>
      `${entryLabel(entry)} | route=${entry.route.qualified_id} | input=${String(entry.input_only_input_tokens_upper_bound)} | reserved=${String(entry.forecast_input_tokens_upper_bound)} | allowed=${String(entry.allowed_input_tokens)} | input_headroom=${String(entry.input_only_signed_headroom_tokens)} | reservation_headroom=${String(entry.signed_headroom_tokens)} | ${entry.fits ? 'input-fits' : 'input-over'} | ${entry.reservation_fits ? 'reservation-fits' : 'reservation-warn'}`,
  );
  return lines.join('\n');
}

function formatComposition(composition: FusionBudgetStageComposition): string {
  return [
    `visible text ${String(composition.visible_text_bytes)} B`,
    `omission receipts ${String(composition.omission_receipt_bytes)} B`,
    `projection metadata ${String(composition.projection_metadata_bytes)} B`,
    `request ${String(composition.request_bytes)} B`,
    `static stage framing ${String(composition.static_stage_framing_bytes)} B`,
    `upstream output contracts ${String(composition.upstream_output_contract_bytes)} B`,
  ].join('; ');
}

function dominantRemediation(
  verdict: FusionBudgetEmptyRequestVerdict,
  composition: FusionBudgetStageComposition | undefined,
  dominantByteClass: string,
  profile: FusionWorkflowProfile,
): readonly string[] {
  if (dominantByteClass === 'dense_ascii') return DENSE_REMEDIATION;
  if (dominantByteClass === 'multibyte') return MULTIBYTE_REMEDIATION;
  if (composition === undefined) return remediationFor(verdict, profile);
  const entries = [
    { name: 'visible', bytes: composition.visible_text_bytes },
    { name: 'request', bytes: composition.request_bytes },
    { name: 'reservation', bytes: composition.upstream_output_contract_bytes },
  ].sort((left, right) => right.bytes - left.bytes);
  const dominant = entries[0];
  if (dominant?.name === 'reservation') return RESERVATION_REMEDIATION;
  if (dominant?.name === 'request' && !verdict.still_fails_with_empty_request) {
    return profile.contextKind === 'clean_task'
      ? cleanRemediation(profile, true)
      : REASON_REQUEST_REMEDIATION;
  }
  if (profile.contextKind === 'clean_task') return cleanRemediation(profile, false);
  return REASON_EMPTY_REMEDIATION;
}

function remediationFor(
  verdict: FusionBudgetEmptyRequestVerdict,
  profile: FusionWorkflowProfile,
): readonly string[] {
  if (profile.contextKind === 'clean_task') {
    return cleanRemediation(profile, !verdict.still_fails_with_empty_request);
  }
  return verdict.still_fails_with_empty_request
    ? REASON_EMPTY_REMEDIATION
    : REASON_REQUEST_REMEDIATION;
}

function formatEmptyRequestVerdict(verdict: FusionBudgetEmptyRequestVerdict): string {
  if (verdict.still_fails_with_empty_request) {
    return `Empty-request counterfactual: still fails with ${String(verdict.blockers_with_empty_request.length)} blocking stage(s), so shortening the request cannot make this workflow fit.`;
  }
  if (verdict.minimum_request_byte_reduction === 0) {
    return 'Empty-request counterfactual: fits; no request reduction is required by the current plan.';
  }
  return `Empty-request counterfactual: fits, so request size determines feasibility; reduce the request by at least ${String(verdict.minimum_request_byte_reduction)} UTF-8 bytes, leaving at most ${String(verdict.maximum_safe_request_utf8_bytes)} UTF-8 bytes.`;
}

function stageFromBudgetStage(stage: FusionBudgetStage): FusionStage {
  if (stage === 'merge') return 'merge';
  if (stage === 'candidate') return 'candidate';
  return 'evaluation';
}

function routeTable(routes: readonly FusionRouteCapacity[]): readonly FusionBudgetRouteTableEntry[] {
  return [...routes]
    .sort((left, right) => {
      const byCapacity = left.byte_capacity_utf8_bytes - right.byte_capacity_utf8_bytes;
      if (byCapacity !== 0) return byCapacity;
      return left.role.localeCompare(right.role);
    })
    .map((route) => ({
      role: route.role,
      qualified_id: route.qualified_id,
      allowed_input_tokens: route.allowed_input_tokens,
      family: route.family,
      effective_rate_bytes_per_token_x100: route.rate_source.effective_rate_bytes_per_token_x100,
      byte_capacity_utf8_bytes: route.byte_capacity_utf8_bytes,
      backed: route.rate_source.backed,
    }));
}

function segmentTokensForBytes(route: FusionRouteCapacity, bytes: number): number {
  if (bytes <= 0) return 0;
  const estimate = estimateRouteInput(route, [
    { kind: 'known_text', bytes, multibyteBytes: 0, denseBytes: 0 },
  ]);
  const segment = estimate.perSegment[0];
  return segment === undefined ? 0 : segment.tokens;
}

function contractTokens(bytes: number): number {
  return bytes;
}

function componentBreakdown(
  composition: FusionBudgetStageComposition | undefined,
  route: FusionRouteCapacity,
): FusionBudgetComponentBreakdown {
  const empty = {
    visible_text_bytes: 0,
    omission_receipt_bytes: 0,
    projection_metadata_bytes: 0,
    request_bytes: 0,
    static_stage_framing_bytes: 0,
    upstream_output_contract_bytes: 0,
  } satisfies FusionBudgetStageComposition;
  const item = composition ?? empty;
  return {
    visible_text: {
      bytes: item.visible_text_bytes,
      tokens: segmentTokensForBytes(route, item.visible_text_bytes),
    },
    omission_receipts: {
      bytes: item.omission_receipt_bytes,
      tokens: segmentTokensForBytes(route, item.omission_receipt_bytes),
    },
    projection_metadata: {
      bytes: item.projection_metadata_bytes,
      tokens: segmentTokensForBytes(route, item.projection_metadata_bytes),
    },
    request: {
      bytes: item.request_bytes,
      tokens: segmentTokensForBytes(route, item.request_bytes),
    },
    static_stage_framing: {
      bytes: item.static_stage_framing_bytes,
      tokens: segmentTokensForBytes(route, item.static_stage_framing_bytes),
    },
    upstream_output_contracts: {
      bytes: item.upstream_output_contract_bytes,
      tokens: contractTokens(item.upstream_output_contract_bytes),
    },
  };
}

function medianCounterfactual(primary: FusionBudgetBlocker): FusionBudgetCounterfactuals['at_median_rate'] {
  if (!primary.route.rate_source.backed) {
    return { forecast_input_tokens_upper_bound: null, signed_headroom_tokens: null, fits: null };
  }
  const median = primary.route.rate_source.provenance.median_bpt_x1000;
  if (median === null) return { forecast_input_tokens_upper_bound: null, signed_headroom_tokens: null, fits: null };
  const variableTokens = ceilDiv(primary.input_utf8_bytes * 1000, median);
  const tokens = variableTokens + TOKEN_BUDGET_AFFINE_F_TOKENS;
  return {
    forecast_input_tokens_upper_bound: tokens,
    signed_headroom_tokens: primary.allowed_input_tokens - tokens,
    fits: tokens <= primary.allowed_input_tokens,
  };
}

function inputCounterfactuals(
  primary: FusionBudgetBlocker,
  plan: FusionBudgetPlanV1,
): FusionBudgetCounterfactuals {
  return {
    empty_request: plan.empty_request,
    without_reservation: {
      forecast_input_tokens_upper_bound: primary.input_only_input_tokens_upper_bound,
      signed_headroom_tokens: primary.input_only_signed_headroom_tokens,
      fits: primary.fits,
    },
    at_median_rate: medianCounterfactual(primary),
  };
}

function budgetErrorCode(
  checkKind: FusionBudgetCheckKind,
): 'prompt_budget_exceeded_forecast' | 'prompt_budget_exceeded_measured' {
  return checkKind === 'rendered_prompt'
    ? 'prompt_budget_exceeded_measured'
    : 'prompt_budget_exceeded_forecast';
}

export class FusionBudget {
  readonly routes: readonly FusionRouteCapacity[];
  readonly limiting: FusionRouteCapacity;
  private readonly contextPolicyId: string;
  private readonly candidateCapability: FusionCapability;
  private readonly profile: FusionWorkflowProfile;

  constructor(
    models: ResolvedFusionModels,
    contextPolicyId: string,
    candidateCapability: FusionCapability = FUSION_REASON_WORKFLOW.candidateCapability,
    profile: FusionWorkflowProfile = FUSION_REASON_WORKFLOW,
  ) {
    this.routes = fusionRouteCapacities(models);
    this.limiting = fusionLimitingRoute(this.routes);
    this.contextPolicyId = contextPolicyId;
    this.candidateCapability = candidateCapability;
    this.profile = profile;
  }

  get allowedInputTokens(): number {
    return this.limiting.allowed_input_tokens;
  }

  get resultRateSources() {
    return this.routes.map((route) => route.rate_source);
  }

  get unknownProviderWarnings(): readonly string[] {
    return this.routes.flatMap((route) => {
      const warning = route.rate_source.warning;
      return route.rate_source.backed || warning === null
        ? []
        : [`${route.qualified_id}: ${warning}`];
    });
  }

  private routeForStage(stage: FusionBudgetStage, slot?: 1 | 2 | 3): FusionRouteCapacity {
    if (stage === 'candidate') return routeByRole(this.routes, candidateRole(slot ?? 1));
    if (stage === 'merge') return routeByRole(this.routes, 'merger');
    return routeByRole(this.routes, 'evaluator');
  }

  private drafts(input: FusionCanonicalInputV3): readonly StageForecastDraft[] {
    const candidateSystemPrompt = this.profile.candidateSystemPrompt(this.candidateCapability);
    const candidatePrompt = buildCandidatePrompt(input);
    const blindInput = buildBlindEvaluationInput(input, EMPTY_CANDIDATES);
    const evaluationPrompt = buildEvaluationPrompt(blindInput);
    const repairPrompt = buildEvaluationRepairPrompt({
      schema_version: 'pi-background-tasks.fusion-evaluation-repair-input.v1',
      original_blind_input: blindInput,
      invalid_output: '',
      validation_errors: [],
    });
    const mergePrompt = buildMergePrompt(buildMergeInput(input, EMPTY_CANDIDATES, EMPTY_EVALUATION));
    return [
      {
        budget_stage: 'candidate',
        slot: 1,
        route: this.routeForStage('candidate', 1),
        conditional: false,
        system_prompt: candidateSystemPrompt,
        empty_user_prompt: candidatePrompt,
        upstream_output_contract_bytes: 0,
      },
      {
        budget_stage: 'candidate',
        slot: 2,
        route: this.routeForStage('candidate', 2),
        conditional: false,
        system_prompt: candidateSystemPrompt,
        empty_user_prompt: candidatePrompt,
        upstream_output_contract_bytes: 0,
      },
      {
        budget_stage: 'candidate',
        slot: 3,
        route: this.routeForStage('candidate', 3),
        conditional: false,
        system_prompt: candidateSystemPrompt,
        empty_user_prompt: candidatePrompt,
        upstream_output_contract_bytes: 0,
      },
      {
        budget_stage: 'evaluation',
        route: this.routeForStage('evaluation'),
        conditional: false,
        system_prompt: this.profile.evaluatorSystemPrompt,
        empty_user_prompt: evaluationPrompt,
        upstream_output_contract_bytes: 3 * FUSION_CANDIDATE_MAX_OUTPUT_BYTES,
      },
      {
        budget_stage: 'merge',
        route: this.routeForStage('merge'),
        conditional: false,
        system_prompt: this.profile.mergerSystemPrompt,
        empty_user_prompt: mergePrompt,
        upstream_output_contract_bytes:
          3 * FUSION_CANDIDATE_MAX_OUTPUT_BYTES + FUSION_EVALUATION_MAX_OUTPUT_BYTES,
      },
      {
        budget_stage: 'evaluation_repair',
        route: this.routeForStage('evaluation_repair'),
        conditional: true,
        system_prompt: this.profile.evaluationRepairSystemPrompt,
        empty_user_prompt: repairPrompt,
        upstream_output_contract_bytes:
          3 * FUSION_CANDIDATE_MAX_OUTPUT_BYTES +
          FUSION_EVALUATION_MAX_OUTPUT_BYTES +
          FUSION_DIAGNOSTICS_MAX_BYTES,
      },
    ];
  }

  private entries(input: FusionCanonicalInputV3): readonly FusionStageBudgetPlanEntry[] {
    return this.drafts(input).map(forecastEntry);
  }

  private composition(
    input: FusionCanonicalInputV3,
    blocker: FusionBudgetBlocker,
  ): FusionBudgetStageComposition {
    const canonicalBytes = utf8Bytes(buildCandidatePrompt(input));
    const emptyRequestCanonicalBytes = utf8Bytes(buildCandidatePrompt(replaceRequestText(input, '')));
    const requestBytes = canonicalBytes - emptyRequestCanonicalBytes;
    const visible = visibleTextBytes(input);
    const omissions = omissionReceiptBytes(input);
    const projectionMetadata = canonicalBytes - requestBytes - visible - omissions;
    const draft = this.drafts(input).find(
      (item) => item.budget_stage === blocker.budget_stage && item.slot === blocker.slot,
    );
    if (draft === undefined) {
      throw new FusionError('primary budget blocker disappeared during composition', {
        code: 'orchestration_failed',
        childCreated: false,
      });
    }
    return {
      visible_text_bytes: visible,
      omission_receipt_bytes: omissions,
      projection_metadata_bytes: projectionMetadata,
      request_bytes: requestBytes,
      static_stage_framing_bytes:
        utf8Bytes(draft.system_prompt) + utf8Bytes(draft.empty_user_prompt) - canonicalBytes,
      upstream_output_contract_bytes: draft.upstream_output_contract_bytes,
    };
  }

  private emptyRequestVerdict(
    input: FusionCanonicalInputV3,
    entries: readonly FusionStageBudgetPlanEntry[],
  ): FusionBudgetEmptyRequestVerdict {
    const emptyEntries = this.entries(replaceRequestText(input, ''));
    const emptyBlockers = selectBlockers(emptyEntries);
    let reduction = 0;
    for (const entry of entries) {
      reduction = Math.max(reduction, entry.input_utf8_bytes - maxKnownTextBytes(entry.route));
    }
    reduction = Math.max(0, reduction);
    const requestBytes = utf8Bytes(input.request.text);
    return {
      request_utf8_bytes: requestBytes,
      still_fails_with_empty_request: emptyBlockers.length > 0,
      shortening_request_can_help: emptyBlockers.length === 0,
      minimum_request_byte_reduction: reduction,
      maximum_safe_request_utf8_bytes: Math.max(0, requestBytes - reduction),
      blockers_with_empty_request: emptyBlockers,
    };
  }

  private failure(
    primary: FusionBudgetBlocker,
    plan: FusionBudgetPlanV1,
    artifactDir: string,
    measurementKind: FusionBudgetErrorDetail['measurement_kind'],
    checkKind: FusionBudgetCheckKind,
  ): FusionError {
    const composition = plan.primary_blocker_composition;
    const dominantByteClass = primary.input_only_estimate.rateSource.dominant_byte_class;
    const remediation = dominantRemediation(
      plan.empty_request,
      composition,
      dominantByteClass,
      this.profile,
    );
    const tokensOver = primary.input_only_input_tokens_upper_bound - primary.allowed_input_tokens;
    const budget: FusionBudgetErrorDetail = {
      budget_stage: primary.budget_stage,
      measurement_kind: measurementKind,
      check_kind: checkKind,
      measured_utf8_bytes: primary.input_utf8_bytes,
      measured_input_tokens_upper_bound: primary.input_only_input_tokens_upper_bound,
      allowed_input_tokens: primary.allowed_input_tokens,
      limiting_model: {
        provider: primary.route.provider,
        model: primary.route.model,
        qualified_id: primary.route.qualified_id,
        context_window_tokens: primary.route.context_window_tokens,
      },
      rate_source: primary.input_only_estimate.rateSource,
      backed: primary.input_only_estimate.rateSource.backed,
      dominant_byte_class: dominantByteClass,
      component_breakdown: componentBreakdown(composition, primary.route),
      byte_class_breakdown: primary.input_only_estimate.byte_class_breakdown,
      dense_regions: [],
      bytes_over: primary.bytes_over,
      tokens_over: Math.max(0, tokensOver),
      required_allowed_tokens: primary.input_only_input_tokens_upper_bound,
      route_table: routeTable(this.routes),
      counterfactuals: inputCounterfactuals(primary, plan),
      stage_upstream_actuals: [],
      policy_id: FUSION_BUDGET_POLICY.id,
      calibration_version: TOKEN_BUDGET_CALIBRATION_VERSION,
      context_policy_id: this.contextPolicyId,
      remediation,
      blockers: plan.blockers,
      artifact_dir: artifactDir,
    };
    if (primary.slot !== undefined) budget.slot = primary.slot;
    const compositionText = composition === undefined ? 'unavailable' : formatComposition(composition);
    const additional = plan.blockers
      .filter((blocker) => blocker !== primary)
      .map((blocker) => `${entryLabel(blocker)} route=${blocker.route.qualified_id}`)
      .join('; ');
    const rateText = `${primary.route.family} ${formatRateX100(primary.input_only_estimate.rateSource.effective_rate_bytes_per_token_x100)} B/tok + ${String(primary.input_only_estimate.rateSource.affine_f_tokens)} tokens (${primary.input_only_estimate.rateSource.source}, backed=${String(primary.input_only_estimate.rateSource.backed)}, dominant=${dominantByteClass})`;
    const sourceWarning = primary.input_only_estimate.rateSource.warning;
    const routeWarning = sourceWarning === null ? '' : ` Rate warning: ${sourceWarning}.`;
    const checkText =
      checkKind === 'input_only_preflight'
        ? 'input-only preflight forecast'
        : 'exact rendered prompt measurement';
    const dominantText =
      dominantByteClass === 'multibyte'
        ? ' Dominant byte class is multibyte UTF-8; the fatal gate uses the conservative multibyte rate and the plan separately records the provable 1.00 B/tok advisory ceiling.'
        : dominantByteClass === 'dense_ascii'
          ? ' Dominant byte class is dense ASCII/low-whitespace content; the whitespace gate is a heuristic token-density proxy, not a bound.'
          : ` Dominant byte class is ${dominantByteClass}.`;
    const message =
      `Fusion prompt budget exceeded by ${checkText} before ${blockingChildLabel(primary)} child creation. Primary blocking stage: ${entryLabel(primary)} on route ${primary.route.qualified_id}. ` +
      `Forecast ${String(primary.input_utf8_bytes)} UTF-8 bytes (<= ${String(primary.input_only_input_tokens_upper_bound)} input tokens) against ${String(primary.allowed_input_tokens)} allowed input tokens, over by ${String(Math.max(0, tokensOver))} tokens. ` +
      `Estimator: ${rateText}.${routeWarning}${dominantText} ` +
      `The ${blockingChildLabel(primary)} child was not created. Nothing was clipped, dropped, or substituted. Artifact directory: ${artifactDir}.\n` +
      `Per-stage forecast table:\n${formatTable(plan.stages)}\n` +
      `Primary blocker byte composition: ${compositionText}.\n` +
      `Additional blockers: ${additional.length === 0 ? 'none' : additional}.\n` +
      `${formatEmptyRequestVerdict(plan.empty_request)}\n` +
      `Route byte-capacity order: ${routeTable(this.routes).map((route) => `${route.qualified_id}=${String(route.byte_capacity_utf8_bytes)}B`).join(', ')}.\n` +
      `Remediation: ${remediation.join(' ')}`;
    const details = {
      code: budgetErrorCode(checkKind),
      childCreated: false,
      budget,
      stage: stageFromBudgetStage(primary.budget_stage),
    };
    if (primary.slot !== undefined) return new FusionError(message, { ...details, slot: primary.slot });
    return new FusionError(message, details);
  }

  private planMetadata(input?: FusionCanonicalInputV3): Pick<FusionBudgetPlanV1, 'workflow' | 'context' | 'fixed_candidate_policy' | 'tool_policy'> {
    return {
      workflow: this.profile.id,
      context: {
        kind: this.profile.contextKind,
        policy_id: input?.context?.policy_id ?? this.contextPolicyId,
      },
      fixed_candidate_policy: {
        capability: this.candidateCapability,
        tools: this.profile.candidateTools,
      },
      tool_policy: {
        candidate_tools: this.profile.candidateTools,
        evaluation_tools: [] as readonly [],
        merge_tools: [] as readonly [],
      },
    };
  }

  plan(input: FusionCanonicalInputV3): FusionBudgetPlanV1 {
    const stages = this.entries(input);
    const blockers = selectBlockers(stages);
    const primary = selectPrimaryBlocker(blockers);
    const emptyRequest = this.emptyRequestVerdict(input, stages);
    const base: FusionBudgetPlanV1 = {
      schema_version: FUSION_BUDGET_PLAN_SCHEMA_VERSION,
      ...this.planMetadata(input),
      policy: FUSION_BUDGET_POLICY,
      routes: this.routes,
      stages,
      blockers,
      empty_request: emptyRequest,
      warnings: warningsFor(stages),
    };
    if (primary === undefined) return base;
    return {
      ...base,
      primary_blocker: primary,
      primary_blocker_composition: this.composition(input, primary),
    };
  }

  assertPlanFits(plan: FusionBudgetPlanV1, artifactDir: string): void {
    if (plan.primary_blocker !== undefined) {
      throw this.failure(
        plan.primary_blocker,
        plan,
        artifactDir,
        'stage_forecast',
        'input_only_preflight',
      );
    }
  }

  assertStagePrompt(
    stage: FusionBudgetStage,
    systemPrompt: string,
    userPrompt: string,
    slot?: 1 | 2 | 3,
  ): void {
    const route = this.routeForStage(stage, slot);
    const inputSegments = [knownTextSegment(systemPrompt), knownTextSegment(userPrompt)];
    const inputBytes = inputSegments.reduce((sum, segment) => sum + segment.bytes, 0);
    const estimate = estimateRouteInput(route, inputSegments);
    if (estimate.tokens <= route.allowed_input_tokens) return;
    const entry: FusionStageBudgetPlanEntry = {
      budget_stage: stage,
      route,
      conditional: stage === 'evaluation_repair',
      check_kind: 'input_only_preflight',
      input_utf8_bytes: inputBytes,
      upstream_output_contract_bytes: 0,
      forecast_utf8_bytes: inputBytes,
      input_only_input_tokens_upper_bound: estimate.tokens,
      forecast_input_tokens_upper_bound: estimate.tokens,
      allowed_input_tokens: route.allowed_input_tokens,
      input_only_signed_headroom_tokens: route.allowed_input_tokens - estimate.tokens,
      signed_headroom_tokens: route.allowed_input_tokens - estimate.tokens,
      input_only_utilization_basis_points: utilizationBasisPoints(estimate.tokens, route.allowed_input_tokens),
      utilization_basis_points: utilizationBasisPoints(estimate.tokens, route.allowed_input_tokens),
      input_only_estimate: estimate,
      reservation_estimate: estimate,
      fits: false,
      reservation_fits: false,
    };
    if (slot !== undefined) entry.slot = slot;
    const blocker = blockerFromEntry(entry);
    const plan: FusionBudgetPlanV1 = {
      schema_version: FUSION_BUDGET_PLAN_SCHEMA_VERSION,
      ...this.planMetadata(),
      policy: FUSION_BUDGET_POLICY,
      routes: this.routes,
      stages: [entry],
      blockers: [blocker],
      primary_blocker: blocker,
      empty_request: {
        request_utf8_bytes: 0,
        still_fails_with_empty_request: true,
        shortening_request_can_help: false,
        minimum_request_byte_reduction: blocker.bytes_over,
        maximum_safe_request_utf8_bytes: 0,
        blockers_with_empty_request: [blocker],
      },
      warnings: [],
    };
    throw this.failure(blocker, plan, 'stage prompt re-measurement', 'rendered_prompt', 'rendered_prompt');
  }

  calibrationViolationForCompletedChild(
    stage: FusionStage,
    systemPrompt: string,
    userPrompt: string,
    result: FusionChildRunResult,
    slot?: 1 | 2 | 3,
  ): FusionCalibrationViolation | undefined {
    const route = this.routeForStage(stage, slot);
    const inputSegments = [knownTextSegment(systemPrompt), knownTextSegment(userPrompt)];
    const promptUtf8Bytes = inputSegments.reduce((sum, segment) => sum + segment.bytes, 0);
    const estimate = estimateRouteInput(route, inputSegments);
    // The forecast is a one-request admission estimate. Compare it only with
    // the first provider request, never with aggregate agent-loop/cache usage.
    // Custom child runners predating this observation field remain compatible,
    // but cannot produce a calibration verdict without like-for-like evidence.
    const observedUsage = result.firstRequestUsage;
    if (observedUsage === undefined) return undefined;
    const billedInput = observedUsage.input + observedUsage.cacheRead + observedUsage.cacheWrite;
    if (billedInput <= estimate.tokens) return undefined;
    const violation: FusionCalibrationViolation = {
      schema_version: FUSION_CALIBRATION_VIOLATION_SCHEMA_VERSION,
      stage,
      attempt: result.attempt,
      route: {
        provider: result.provider,
        model: result.model,
        qualified_id: result.qualifiedId,
      },
      family: route.family,
      rate_source: estimate.rateSource,
      prompt_utf8_bytes: promptUtf8Bytes,
      prompt_sha256: sha256Hex(`${systemPrompt}\u0000${userPrompt}`),
      observation_scope: 'first_provider_request',
      provider_request_count: result.providerRequestCount ?? 1,
      forecast_input_tokens: estimate.tokens,
      billed_input_tokens: billedInput,
      billed_input_breakdown: {
        input: observedUsage.input,
        cache_read: observedUsage.cacheRead,
        cache_write: observedUsage.cacheWrite,
      },
      under_forecast_tokens: billedInput - estimate.tokens,
      byte_class_breakdown: estimate.byte_class_breakdown,
      dominant_byte_class: estimate.rateSource.dominant_byte_class,
    };
    if (slot !== undefined) violation.slot = slot;
    return violation;
  }
}
