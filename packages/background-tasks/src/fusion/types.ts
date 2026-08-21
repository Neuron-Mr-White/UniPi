import type { Usage } from '@earendil-works/pi-ai';
import type {
  EstimateInputTokensResult,
  TokenBudgetByteClassBreakdown,
  TokenBudgetDominantByteClass,
  TokenBudgetFamily,
  TokenBudgetFamilyCalibration,
  TokenBudgetRateSource,
} from '../context-token-budget.js';

export type FusionThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const FUSION_MODEL_CONFIG_SCHEMA_VERSION = 'pi-background-tasks.fusion-models.v1';
export const FUSION_LEGACY_INPUT_SCHEMA_VERSION = 'pi-background-tasks.fusion-input.v4';
export const FUSION_INPUT_SCHEMA_VERSION = 'pi-background-tasks.fusion-input.v5';
export const FUSION_EVALUATION_SCHEMA_VERSION = 'pi-background-tasks.fusion-evaluation.v1';
export const FUSION_VALIDATE_CANDIDATE_SCHEMA_VERSION =
  'pi-background-tasks.fusion-validation-candidate.v1';
export const FUSION_LEGACY_RESULT_SCHEMA_VERSION = 'pi-background-tasks.fusion-result.v4';
export const FUSION_RESULT_SCHEMA_VERSION = 'pi-background-tasks.fusion-result.v5';
export const FUSION_COMMITTED_RESULT_SCHEMA_VERSION =
  'pi-background-tasks.fusion-committed-result.v1';
export const FUSION_LEGACY_MANIFEST_SCHEMA_VERSION = 'pi-background-tasks.fusion-manifest.v3';
export const FUSION_MANIFEST_SCHEMA_VERSION = 'pi-background-tasks.fusion-manifest.v4';
export const FUSION_CONTEXT_LEDGER_SCHEMA_VERSION = 'pi-background-tasks.fusion-context-ledger.v2';
export const FUSION_SOURCE_POLICY_SCHEMA_VERSION = 'pi-background-tasks.fusion-source-policy.v1';
export const FUSION_BUDGET_PLAN_SCHEMA_VERSION = 'pi-background-tasks.fusion-budget-plan.v4';
export const FUSION_CALIBRATION_VIOLATION_SCHEMA_VERSION =
  'pi-background-tasks.fusion-calibration-violation.v2';
export const FUSION_VALIDATE_CANDIDATE_CONTRACT_EVENT_SCHEMA_VERSION =
  'pi-background-tasks.fusion-validation-candidate-contract-event.v1';
export const FUSION_TOOL_CALL_LOG_SCHEMA_VERSION = 'pi-background-tasks.fusion-tool-call.v1';
export const FUSION_FAILURE_SUMMARY_SCHEMA_VERSION =
  'pi-background-tasks.fusion-failure-summary.v1';

/**
 * Conversation-projection transform shared by every Fusion entry point.
 *
 * The transform keeps visible user/assistant conversational text verbatim and
 * replaces assistant thinking plus all tool traffic with deterministic,
 * hash-accounted omission receipts. It never truncates retained text and never
 * forwards raw image bytes.
 */
export const FUSION_CONTEXT_TRANSFORM_ID = 'visible-conversation-ledger-v2';
export const FUSION_BRANCH_FILTER_ID = 'exclude-active-fusion-subtree-v1';

/** Entry-point specific context policies. Both use the same payload-exclusion transform. */
export const FUSION_TOOL_CONTEXT_POLICY_ID = 'fusion-tool-explicit-v2';
export const FUSION_COMMAND_CONTEXT_POLICY_ID = 'fusion-command-conversation-v2';

export const FUSION_IMAGE_OMISSION_PREFIX = '[Image omitted from fusion text transcript: ';

export const FUSION_CANDIDATE_IDS = ['A', 'B', 'C'] as const;
export type FusionCandidateId = (typeof FUSION_CANDIDATE_IDS)[number];

export const FUSION_STAGE_VALUES = ['candidate', 'evaluation', 'merge'] as const;
export type FusionStage = (typeof FUSION_STAGE_VALUES)[number];

export const FUSION_CAPABILITY_VALUES = Object.freeze(['reason', 'inspect', 'research'] as const);
export type FusionCapability = (typeof FUSION_CAPABILITY_VALUES)[number];

/** No-tools capability for reason candidates, evaluator, repair, and merger. */
export const FUSION_NO_TOOLS_CAPABILITY: FusionCapability = 'reason';
/** Legacy default retained for old type imports only. New workflows never default. */
export const FUSION_BRAINSTORM_DEFAULT_CAPABILITY: FusionCapability = 'inspect';
/** @deprecated New v5 workflows have no caller capability default. */
export const FUSION_DEFAULT_CAPABILITY: FusionCapability = FUSION_BRAINSTORM_DEFAULT_CAPABILITY;

export const FUSION_WEB_FETCH_TOOL_NAME = 'fusion_web_fetch' as const;
export const FUSION_INSPECT_TOOLS = Object.freeze(['read', 'grep', 'find', 'ls'] as const);
export const FUSION_RESEARCH_TOOLS = Object.freeze([
  'read',
  'grep',
  'find',
  'ls',
  FUSION_WEB_FETCH_TOOL_NAME,
] as const);

/**
 * Workflow identities sharing one orchestrator, one context projection, one
 * evaluation schema, and one artifact store. A workflow selects stage framing and
 * capability policy only; it never changes the canonical input schema.
 */
export const FUSION_WORKFLOW_IDS = Object.freeze([
  'reason',
  'investigate',
  'research',
  'validate',
] as const);
export type FusionWorkflowId = (typeof FUSION_WORKFLOW_IDS)[number];
export const FUSION_PUBLIC_WORKFLOW_NAMES = Object.freeze([
  'fusion_reason',
  'fusion_investigate',
  'fusion_research',
  'fusion_validate',
] as const);
export type FusionPublicWorkflowName = (typeof FUSION_PUBLIC_WORKFLOW_NAMES)[number];
export type FusionContextKind = 'session_projection' | 'clean_task';

/**
 * The single capability the validate workflow ever runs candidates with.
 *
 * Deliberately separate from the caller-selectable brainstorm default. Although
 * both workflows currently give candidates read-only inspection, validation pins
 * that capability as fixed policy rather than exposing a caller override.
 */
export const FUSION_VALIDATE_CAPABILITY: FusionCapability = 'inspect';

export const FUSION_FORBIDDEN_TOOLS = Object.freeze([
  'bash',
  'edit',
  'write',
  'fusion_brainstorm',
  'fusion_reason',
  'fusion_investigate',
  'fusion_research',
  'fusion_validate',
  'bg_delegate',
  'bg_result',
  'bg_run',
  'bg_kill',
  'bg_status',
  'bg_logs',
  'bg_run_pi_attested',
] as const);

/**
 * Prompt-expansion stages guarded by deterministic size accounting. `evaluation`
 * and `evaluation_repair` share the evaluator model but render different prompts.
 */
export const FUSION_BUDGET_STAGE_VALUES = [
  'candidate',
  'evaluation',
  'evaluation_repair',
  'merge',
] as const;
export type FusionBudgetStage = (typeof FUSION_BUDGET_STAGE_VALUES)[number];

export const FUSION_SOURCE_VALUES = ['command', 'tool'] as const;
export type FusionSource = (typeof FUSION_SOURCE_VALUES)[number];

export const FUSION_STATE_VALUES = [
  'initializing',
  'candidates_running',
  'candidates_complete',
  'evaluating',
  'evaluation_complete',
  'merging',
  'completed',
  'failed',
  'cancelled',
] as const;
export type FusionState = (typeof FUSION_STATE_VALUES)[number];
export type FusionTerminalState = Extract<FusionState, 'completed' | 'failed' | 'cancelled'>;
export type FusionNonterminalState = Exclude<FusionState, FusionTerminalState>;

export const FUSION_NONTERMINAL_STATE_VALUES = [
  'initializing',
  'candidates_running',
  'candidates_complete',
  'evaluating',
  'evaluation_complete',
  'merging',
] as const satisfies readonly FusionNonterminalState[];

export const FUSION_TERMINAL_STATE_VALUES = ['completed', 'failed', 'cancelled'] as const;

export type FusionModelSelection = '$current' | string;

export interface FusionModelConfigV1 {
  schema_version: typeof FUSION_MODEL_CONFIG_SCHEMA_VERSION;
  candidates: readonly [FusionModelSelection, FusionModelSelection, FusionModelSelection];
  evaluator: FusionModelSelection;
  merger: FusionModelSelection;
}

export interface FusionModelConfigRevision {
  path: string;
  exists: boolean;
  sha256: string | null;
}

export interface LoadedFusionModelConfig {
  config: FusionModelConfigV1;
  revision: FusionModelConfigRevision;
}

export interface ResolvedFusionModel {
  selection: string;
  source: 'current' | 'configured';
  provider: string;
  model: string;
  qualifiedId: string;
  thinkingLevel: FusionThinkingLevel;
  contextWindow: number;
  maxOutputTokens: number;
}

export interface ResolvedFusionModels {
  candidates: readonly [ResolvedFusionModel, ResolvedFusionModel, ResolvedFusionModel];
  evaluator: ResolvedFusionModel;
  merger: ResolvedFusionModel;
}

export type FusionRequestAuthority = 'explicit_text' | 'directive_over_projected_conversation';

export interface FusionCanonicalRequestV3 {
  /** Entry point that produced this request. */
  source: FusionSource;
  /** How children must weigh `text` against the projected conversation. */
  authority: FusionRequestAuthority;
  /** Verbatim request text. Never clipped, never rewritten. */
  text: string;
  /** Lowercase SHA-256 of the UTF-8 request bytes. */
  sha256: string;
}

export const FUSION_OMITTED_EVENT_KINDS = [
  'assistant_thinking',
  'tool_call',
  'tool_result_text',
  'tool_result_image',
] as const;
export type FusionOmittedEventKind = (typeof FUSION_OMITTED_EVENT_KINDS)[number];

/** One omitted conversation event. Ledger rows never leave the local artifact directory. */
export interface FusionOmittedEventRecord {
  index: number;
  source_ordinal: number;
  block_ordinal: number;
  kind: FusionOmittedEventKind;
  payload_bytes: number;
  payload_sha256: string;
  tool_name?: string;
  tool_call_id?: string;
  mime_type?: string;
}

export interface FusionOmittedActivityProjectionMapEntry {
  canonical_entry_index: number;
  entry_kind: 'omitted_activity';
  ledger_index_first: number;
  ledger_index_last: number;
}

export interface FusionLedgerOnlyImageProjectionMapEntry {
  entry_kind: 'ledger_only_tool_result_image';
  ledger_index_first: number;
  ledger_index_last: number;
}

export type FusionContextProjectionMapEntry =
  | FusionOmittedActivityProjectionMapEntry
  | FusionLedgerOnlyImageProjectionMapEntry;

export interface FusionContextOmissionLedgerV2 {
  schema_version: typeof FUSION_CONTEXT_LEDGER_SCHEMA_VERSION;
  policy_id: string;
  transform: typeof FUSION_CONTEXT_TRANSFORM_ID;
  entries: readonly FusionOmittedEventRecord[];
  projection_map: readonly FusionContextProjectionMapEntry[];
  root_sha256: string;
}

export type FusionProjectionTextEntry = [
  tag: 't',
  role: 'u' | 'a',
  sourceOrdinal: number,
  blockOrdinal: number,
  text: string,
];

export type FusionProjectionOmissionCounts = [
  assistantThinking: number,
  toolCalls: number,
  toolResults: number,
];

export type FusionProjectionOmissionEntry = [
  tag: 'o',
  sourceOrdinalSpan: [first: number, last: number],
  bytes: number,
  counts: FusionProjectionOmissionCounts,
];

export type FusionProjectionEntry = FusionProjectionTextEntry | FusionProjectionOmissionEntry;

export interface FusionContextPolicyDescriptor {
  id: string;
  transform: typeof FUSION_CONTEXT_TRANSFORM_ID;
  version: 2;
  receipt_format: 'omitted_activity.v2';
  user_text: 'verbatim';
  assistant_text: 'verbatim';
  assistant_thinking: 'ledger_only';
  tool_call_arguments: 'ledger_only';
  tool_results: 'ledger_only';
  tool_payload_preview_bytes: 0;
  images: 'marker_or_ledger_only';
  unknown_block_behavior: 'error';
}

export interface FusionBranchFilterDescriptor {
  id: typeof FUSION_BRANCH_FILTER_ID;
  tool_name: string;
  tool_call_id: string | null;
  active_tool_call_leaf_excluded: boolean;
}

export interface FusionToolCallNameCount {
  name: string;
  calls: number;
}

export interface FusionProjectionAccounting {
  message_count: number;
  included_text_entry_count: number;
  included_user_text_bytes: number;
  included_assistant_text_bytes: number;
  included_image_marker_count: number;
  empty_text_block_count: number;
  omitted_run_count: number;
  omitted_event_count: number;
  omitted_thinking_bytes: number;
  omitted_tool_call_count: number;
  omitted_tool_call_argument_bytes: number;
  omitted_tool_result_text_count: number;
  omitted_tool_result_text_bytes: number;
  omitted_tool_result_image_count: number;
  omitted_tool_result_image_bytes: number;
  tool_call_names: readonly FusionToolCallNameCount[];
  ledger_entry_count: number;
  ledger_root_sha256: string;
  omission_receipt_utf8_bytes: number;
}

export interface FusionConversationProjectionV4 {
  policy: FusionContextPolicyDescriptor;
  branch_filter: FusionBranchFilterDescriptor;
  entries: readonly FusionProjectionEntry[];
  accounting: FusionProjectionAccounting;
}

export type FusionConversationProjectionV3 = FusionConversationProjectionV4;

export interface FusionDeclaredSourceV1 {
  url: string;
  canonical_url: string;
  purpose: string;
  sha256: string;
}

export interface FusionCleanTaskContextV1 {
  kind: 'clean_task';
  policy_id: 'fusion-clean-task-v1';
  declared_sources: readonly FusionDeclaredSourceV1[];
}

export interface FusionSessionProjectionContextV1 {
  kind: 'session_projection';
  policy_id: 'fusion-session-projection-v1';
  system_prompt: string;
  conversation_projection: FusionConversationProjectionV4;
}

export interface FusionCanonicalInputV5Base {
  schema_version: typeof FUSION_INPUT_SCHEMA_VERSION;
  workflow?: FusionWorkflowId | undefined;
  cwd: string;
  request: FusionCanonicalRequestV3;
}

export interface FusionSessionProjectionCanonicalInputV5 extends FusionCanonicalInputV5Base {
  workflow?: FusionWorkflowId | undefined;
  /** @deprecated v4 readability alias. Present only for session-projection inputs at runtime. */
  system_prompt: string;
  /** @deprecated v4 readability alias. Present only for session-projection inputs at runtime. */
  conversation_projection: FusionConversationProjectionV4;
  context?: FusionSessionProjectionContextV1 | undefined;
}

export interface FusionCleanTaskCanonicalInputV5 extends FusionCanonicalInputV5Base {
  workflow: Exclude<FusionWorkflowId, 'reason'>;
  context: FusionCleanTaskContextV1;
}

export type FusionCanonicalInputV5 =
  | FusionSessionProjectionCanonicalInputV5
  | FusionCleanTaskCanonicalInputV5;

/** Legacy v4 shape retained for frozen golden fixtures/readability only. */
export interface FusionCanonicalInputV4 {
  schema_version: typeof FUSION_LEGACY_INPUT_SCHEMA_VERSION;
  cwd: string;
  system_prompt: string;
  request: FusionCanonicalRequestV3;
  conversation_projection: FusionConversationProjectionV4;
}

export type FusionCanonicalInputV3 = FusionCanonicalInputV5;

export interface FusionSourcePolicyV1 {
  schema_version: typeof FUSION_SOURCE_POLICY_SCHEMA_VERSION;
  workflow: 'research';
  cwd: string;
  sources: readonly FusionDeclaredSourceV1[];
  root_sha256: string;
}

export interface FusionSourcePolicyArtifactRef extends FusionArtifactRef {
  root_sha256: string;
}

export interface CandidateAssessment {
  candidate_id: FusionCandidateId;
  summary: string;
  strengths: readonly string[];
  limitations: readonly string[];
  useful_contributions: readonly string[];
  risks: readonly string[];
}

export interface FusionConflictPosition {
  candidate_id: FusionCandidateId;
  position: string;
}

export interface FusionConflict {
  topic: string;
  positions: readonly FusionConflictPosition[];
  resolution: string;
}

export interface FusionSynthesisContribution {
  candidate_id: FusionCandidateId;
  contribution: string;
}

export interface FusionSynthesisPlan {
  must_include: readonly FusionSynthesisContribution[];
  must_resolve: readonly string[];
  must_avoid: readonly string[];
}

export type FusionValidationSeverity = 'critical' | 'high' | 'minor';

export interface FusionValidationFindingRecord {
  id: string;
  candidate_id: FusionCandidateId;
  severity: FusionValidationSeverity;
  location: string;
  evidence: string;
  impact: string;
  summary: string;
}

export interface FusionValidationFindingDecision {
  source_id: string;
  disposition: 'include' | 'exclude';
  rationale: string;
  group_id?: string | undefined;
}

export interface FusionValidationFindingGroup {
  group_id: string;
  source_ids: readonly string[];
  severity: FusionValidationSeverity;
  location: string;
  evidence: string;
  impact: string;
  summary: string;
  rationale: string;
}

export interface FusionValidationFindingAccounting {
  findings: readonly FusionValidationFindingRecord[];
  decisions: readonly FusionValidationFindingDecision[];
  groups: readonly FusionValidationFindingGroup[];
}

export interface FusionValidationCandidateReportV1 {
  schema_version: typeof FUSION_VALIDATE_CANDIDATE_SCHEMA_VERSION;
  findings: readonly Omit<FusionValidationFindingRecord, 'id' | 'candidate_id'>[];
  verified: readonly string[];
  limitations: readonly string[];
}

export interface FusionEvaluationV1 {
  schema_version: typeof FUSION_EVALUATION_SCHEMA_VERSION;
  candidate_assessments: readonly [CandidateAssessment, CandidateAssessment, CandidateAssessment];
  agreements: readonly string[];
  conflicts: readonly FusionConflict[];
  synthesis_plan: FusionSynthesisPlan;
  validation_accounting?: FusionValidationFindingAccounting | undefined;
}

/** Exact Pi usage contract used at the child, artifact, and host tool-result boundaries. */
export type FusionUsage = Omit<Usage, 'reasoning'> & { reasoning?: number | undefined };

const EMPTY_FUSION_COST: Usage['cost'] = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
});

export const EMPTY_FUSION_USAGE: FusionUsage = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: EMPTY_FUSION_COST,
});

export function createEmptyFusionUsage(): FusionUsage {
  return cloneFusionUsage(EMPTY_FUSION_USAGE);
}

export function cloneFusionUsage(usage: FusionUsage): FusionUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
    ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning as number | undefined }),
    totalTokens: usage.totalTokens,
    cost: {
      input: usage.cost.input,
      output: usage.cost.output,
      cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite,
      total: usage.cost.total,
    },
  };
}

export function addFusionUsage(target: FusionUsage, delta: FusionUsage): void {
  target.input += delta.input;
  target.output += delta.output;
  target.cacheRead += delta.cacheRead;
  target.cacheWrite += delta.cacheWrite;
  if (delta.cacheWrite1h !== undefined) {
    target.cacheWrite1h = (target.cacheWrite1h ?? 0) + delta.cacheWrite1h;
  }
  if (delta.reasoning !== undefined) {
    target.reasoning = (target.reasoning ?? 0) + delta.reasoning;
  }
  target.totalTokens += delta.totalTokens;
  target.cost.input += delta.cost.input;
  target.cost.output += delta.cost.output;
  target.cost.cacheRead += delta.cost.cacheRead;
  target.cost.cacheWrite += delta.cost.cacheWrite;
  target.cost.total += delta.cost.total;
}

export type FusionRunStageProgressStatus = 'not_started' | 'incomplete' | 'completed';

export interface FusionRunStageProgress {
  status: FusionRunStageProgressStatus;
  attempts_recorded: number;
  children_created: number;
  children_completed: number;
  children_failed: number;
  children_cancelled: number;
  not_started_slots?: number | undefined;
}

export interface FusionRunProgress {
  manifest_state: FusionState;
  candidates: FusionRunStageProgress;
  evaluation: FusionRunStageProgress;
  merge: FusionRunStageProgress;
  usage_so_far: FusionUsage;
}

export interface FusionResultBudgetDetails {
  policy_id: string;
  calibration_version: string;
  route_table: readonly FusionRouteCapacity[];
  rate_sources: readonly TokenBudgetRateSource[];
  unknown_provider_warnings: readonly string[];
  calibration_warnings: readonly FusionCalibrationViolation[];
}

export interface FusionCommittedResultV1 {
  schema_version: typeof FUSION_COMMITTED_RESULT_SCHEMA_VERSION;
  run_id: string;
  merged: FusionArtifactRef;
  details: FusionResultDetails;
}

export interface FusionResultDetails {
  schema_version: typeof FUSION_RESULT_SCHEMA_VERSION;
  run_id: string;
  workflow: FusionWorkflowId;
  source: FusionSource;
  status: 'completed';
  context: { kind: FusionContextKind; policy_id: string };
  tool_policy: {
    candidate_tools: readonly string[];
    evaluation_tools: readonly [];
    merge_tools: readonly [];
  };
  artifact_dir: string;
  models: {
    candidates: readonly [string, string, string];
    evaluator: string;
    merger: string;
    thinking_level: string;
  };
  evaluator_attempts: number;
  usage: FusionUsage;
  budget: FusionResultBudgetDetails;
}

export type FusionProgressEvent =
  | { type: 'state'; state: FusionState }
  | { type: 'candidate_started'; slot: 1 | 2 | 3; attempt: number }
  | { type: 'candidate_completed'; slot: 1 | 2 | 3; completed: number; total: 3 }
  | { type: 'evaluation_started'; attempt: 1 | 2; repair: boolean }
  | { type: 'evaluation_retry'; errors: readonly string[] }
  | { type: 'budget_warning'; warnings: readonly FusionBudgetWarning[]; error: string }
  | { type: 'calibration_warning'; warning: FusionCalibrationViolation; artifact: string }
  | { type: 'merge_started' }
  | { type: 'completed'; runId: string; artifactDir: string }
  | { type: 'failed'; runId: string; artifactDir: string; error: string }
  | { type: 'cancelled'; runId: string; artifactDir: string; reason: string };

export type FusionErrorCode =
  | 'config_invalid'
  | 'config_conflict'
  | 'model_unavailable'
  | 'context_capture_failed'
  | 'context_policy_unsupported_block'
  | 'prompt_budget_exceeded_forecast'
  | 'prompt_budget_exceeded_measured'
  | 'model_capacity_unknown'
  | 'child_spawn_failed'
  | 'child_stdin_failed'
  | 'child_event_invalid'
  | 'child_exit_failed'
  | 'child_runtime_limit_exceeded'
  | 'child_runtime_payload_invalid'
  | 'child_cache_policy_invalid'
  | 'child_timeout'
  | 'child_output_cap'
  | 'child_cancelled'
  | 'evaluation_invalid'
  | 'artifact_error'
  | 'state_transition_invalid'
  | 'orchestration_failed';

export type FusionBudgetCheckKind = 'input_only_preflight' | 'rendered_prompt';

export interface FusionBudgetComponentBreakdown {
  visible_text: { bytes: number; tokens: number };
  omission_receipts: { bytes: number; tokens: number };
  projection_metadata: { bytes: number; tokens: number };
  request: { bytes: number; tokens: number };
  static_stage_framing: { bytes: number; tokens: number };
  upstream_output_contracts: { bytes: number; tokens: number };
}

export interface FusionBudgetDenseRegion {
  offset: number;
  len: number;
  detector: 'not_implemented_step_6';
}

export interface FusionBudgetRouteTableEntry {
  role: FusionRouteCapacity['role'];
  qualified_id: string;
  allowed_input_tokens: number;
  family: TokenBudgetFamily;
  effective_rate_bytes_per_token_x100: number;
  byte_capacity_utf8_bytes: number;
  backed: boolean;
}

export interface FusionBudgetCounterfactuals {
  empty_request: FusionBudgetEmptyRequestVerdict;
  without_reservation: {
    forecast_input_tokens_upper_bound: number;
    signed_headroom_tokens: number;
    fits: boolean;
  };
  at_median_rate: {
    forecast_input_tokens_upper_bound: number | null;
    signed_headroom_tokens: number | null;
    fits: boolean | null;
  };
}

/** Structured detail attached to a split prompt-budget failure. */
export interface FusionBudgetErrorDetail {
  budget_stage: FusionBudgetStage;
  slot?: 1 | 2 | 3;
  measurement_kind: 'stage_forecast' | 'rendered_prompt';
  check_kind: FusionBudgetCheckKind;
  measured_utf8_bytes: number;
  measured_input_tokens_upper_bound: number;
  allowed_input_tokens: number;
  limiting_model: {
    provider: string;
    model: string;
    qualified_id: string;
    context_window_tokens: number;
  };
  rate_source: TokenBudgetRateSource;
  backed: boolean;
  dominant_byte_class: TokenBudgetDominantByteClass;
  component_breakdown: FusionBudgetComponentBreakdown;
  byte_class_breakdown: TokenBudgetByteClassBreakdown;
  dense_regions: readonly FusionBudgetDenseRegion[];
  bytes_over: number;
  tokens_over: number;
  required_allowed_tokens: number;
  route_table: readonly FusionBudgetRouteTableEntry[];
  counterfactuals: FusionBudgetCounterfactuals;
  stage_upstream_actuals: readonly { stage: FusionStage; bytes: number }[];
  policy_id: string;
  calibration_version: string;
  context_policy_id: string;
  remediation: readonly string[];
  blockers: readonly FusionBudgetBlocker[];
  artifact_dir: string;
}

export interface FusionErrorDetails {
  code: FusionErrorCode;
  stage?: FusionStage;
  slot?: 1 | 2 | 3;
  attempt?: number;
  artifactDir?: string;
  transient?: boolean;
  childCreated?: boolean;
  budget?: FusionBudgetErrorDetail;
  runProgress?: FusionRunProgress;
}

export class FusionError extends Error {
  readonly code: FusionErrorCode;
  readonly stage: FusionStage | undefined;
  readonly slot: 1 | 2 | 3 | undefined;
  readonly attempt: number | undefined;
  readonly artifactDir: string | undefined;
  readonly transient: boolean;
  readonly childCreated: boolean;
  readonly budget: FusionBudgetErrorDetail | undefined;
  readonly runProgress: FusionRunProgress | undefined;

  constructor(message: string, details: FusionErrorDetails) {
    super(message);
    this.name = 'FusionError';
    this.code = details.code;
    this.stage = details.stage;
    this.slot = details.slot;
    this.attempt = details.attempt;
    this.artifactDir = details.artifactDir;
    this.transient = details.transient ?? false;
    this.childCreated = details.childCreated ?? true;
    this.budget = details.budget;
    this.runProgress = details.runProgress;
  }
}

export interface FusionChildUsage extends FusionUsage {
  provider: string;
  model: string;
  qualifiedId: string;
}

export type FusionToolCallLogStatus = 'ok' | 'error';

export interface FusionToolCallLogRecord {
  schema_version: typeof FUSION_TOOL_CALL_LOG_SCHEMA_VERSION;
  ordinal: number;
  tool_name: string;
  arguments_sha256: string;
  arguments_bytes: number;
  result_bytes: number;
  result_sha256: string;
  status: FusionToolCallLogStatus;
  duration_ms: number;
  url?: string | undefined;
  /** SHA-256 of a rejected attempted fetch URL; raw rejected URLs are never persisted. */
  rejected_url_sha256?: string | undefined;
  final_url?: string | undefined;
  http_status?: number | undefined;
  response_bytes?: number | undefined;
  content_sha256?: string | undefined;
}

export interface FusionToolCallLogSummary {
  count: number;
  total_result_bytes: number;
  trace_complete: boolean;
}

export interface FusionToolCallTrace {
  bytes: Buffer;
  records: readonly FusionToolCallLogRecord[];
  summary: FusionToolCallLogSummary;
}

export interface FusionCandidateOutputRecovery {
  kind: 'same_session_compression';
  limit_bytes: number;
  original_record_index: number;
  replacement_record_index: number | null;
  original_json_rendered_bytes: number;
  replacement_json_rendered_bytes: number | null;
  original_text_sha256: string;
  original_text: string;
  status: 'completed' | 'failed';
}

export interface FusionChildRunResult {
  stage: FusionStage;
  slot?: 1 | 2 | 3;
  attempt: number;
  provider: string;
  model: string;
  qualifiedId: string;
  text: string;
  /** Aggregate usage across the complete child agent loop. */
  usage: FusionUsage;
  /** First provider request, used for like-for-like prompt forecast calibration. */
  firstRequestUsage?: FusionUsage;
  /** Number of provider requests represented by aggregate usage. */
  providerRequestCount?: number;
  outputRecovery?: FusionCandidateOutputRecovery;
  events: Buffer;
  stderr: Buffer;
  exitCode: number;
  signal: NodeJS.Signals | null;
  toolCallTrace?: FusionToolCallTrace;
}

export interface FusionAttemptOutputRecoveryRecord {
  kind: 'same_session_compression';
  status: 'completed' | 'failed';
  limit_bytes: number;
  original_response_path: string;
  original_record_index: number;
  replacement_record_index: number | null;
  original_json_rendered_bytes: number;
  replacement_json_rendered_bytes: number | null;
  original_text_sha256: string;
}

export interface FusionAttemptArtifactRecord {
  stage: FusionStage;
  slot?: 1 | 2 | 3;
  attempt: number;
  status: 'completed' | 'failed' | 'cancelled';
  child_created: boolean;
  prompt_path: string;
  events_path?: string;
  stderr_path?: string;
  response_path?: string;
  partial_response_path?: string;
  tool_calls_path?: string;
  tool_calls?: FusionToolCallLogSummary;
  output_recovery?: FusionAttemptOutputRecoveryRecord;
  provider?: string;
  model?: string;
  qualifiedId?: string;
  usage?: FusionUsage;
  error?: string;
}

export interface FusionArtifactRef {
  path: string;
  byte_length: number;
  sha256: string;
}

export type FusionFailureArtifactClassification =
  | 'complete_stage_output'
  | 'partial_stage_output'
  | 'oversized_original'
  | 'empty_rejected_output'
  | 'evidence_only';

export interface FusionFailureEvidenceArtifact {
  name: string;
  classification: FusionFailureArtifactClassification;
  ref: FusionArtifactRef;
}

export interface FusionFailureAttemptMetadata {
  stage: FusionStage;
  slot?: 1 | 2 | 3 | undefined;
  attempt: number;
  status: 'completed' | 'failed' | 'cancelled';
  child_created: boolean;
}

export interface FusionFailureList<T> {
  listed: readonly T[];
  omitted_count: number;
}

export interface FusionFailureMessageMetadata {
  byte_length: number;
  sha256: string;
  inline_message?: string | undefined;
  omission_reason?: 'exceeds_inline_message_bytes_cap' | 'result_view_byte_budget' | undefined;
}

export interface FusionFailureSummaryV1 {
  schema_version: typeof FUSION_FAILURE_SUMMARY_SCHEMA_VERSION;
  run_id: string;
  workflow: FusionWorkflowId;
  source: FusionSource;
  terminal_state: Exclude<FusionTerminalState, 'completed'>;
  created_at: string;
  answer: { present: false; reason: 'run_did_not_commit' };
  failure: {
    code: FusionErrorCode | null;
    stage?: FusionStage | undefined;
    slot?: 1 | 2 | 3 | undefined;
    attempt?: number | undefined;
    child_created: boolean;
    message: FusionFailureMessageMetadata;
  };
  progress: FusionRunProgress;
  usage_so_far: FusionUsage;
  attempts: FusionFailureList<FusionFailureAttemptMetadata>;
  evidence_artifacts: FusionFailureList<FusionFailureEvidenceArtifact>;
  remediation_ids: readonly (
    | 'inspect_manifest_bound_evidence'
    | 'inspect_terminal_error'
    | 'split_or_reduce_work'
    | 'retry_same_route_after_operator_review'
  )[];
}

export interface FusionFailureViewFailure {
  code?: FusionErrorCode | null | undefined;
  stage?: FusionStage | undefined;
  slot?: 1 | 2 | 3 | undefined;
  attempt?: number | undefined;
  child_created?: boolean | undefined;
  message: FusionFailureMessageMetadata;
}

export interface FusionFailureResultView {
  schema_version: typeof FUSION_FAILURE_SUMMARY_SCHEMA_VERSION;
  summary_status: 'verified' | 'legacy_manifest_only' | 'unavailable' | 'integrity_failed';
  terminal_state: Exclude<FusionTerminalState, 'completed'>;
  answer: { present: false; reason: 'run_did_not_commit' };
  failure?: FusionFailureViewFailure | undefined;
  progress?: FusionRunProgress | undefined;
  usage_so_far?: FusionUsage | undefined;
  attempts?: FusionFailureList<FusionFailureAttemptMetadata> | undefined;
  evidence_artifacts?: FusionFailureList<FusionFailureEvidenceArtifact> | undefined;
  remediation_ids?: FusionFailureSummaryV1['remediation_ids'] | undefined;
  failure_summary_ref?: FusionArtifactRef | undefined;
  summary_unavailable_reason?: 'no_durable_summary' | 'manifest_untrusted' | 'summary_integrity_failed' | undefined;
}

export interface FusionArtifactManifest {
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
    candidates: readonly [string, string, string];
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
    kind: FusionContextKind;
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
  attempts: readonly FusionAttemptArtifactRecord[];
  artifacts: Readonly<Record<string, FusionArtifactRef>>;
  anonymous_map?: Readonly<Record<FusionCandidateId, 1 | 2 | 3>>;
  error?: string;
}

export interface FusionRunResult {
  mergedText: string;
  details: FusionResultDetails;
}

/** Snapshot of one configured route's verified input capacity for one stage. */
export interface FusionRouteCapacity {
  role: 'candidate-1' | 'candidate-2' | 'candidate-3' | 'evaluator' | 'merger';
  provider: string;
  model: string;
  qualified_id: string;
  context_window_tokens: number;
  reserved_output_tokens: number;
  framing_reserve_tokens: number;
  safety_reserve_tokens: number;
  allowed_input_tokens: number;
  family: TokenBudgetFamily;
  rate_source: TokenBudgetRateSource;
  byte_capacity_utf8_bytes: number;
}

export interface FusionBudgetStageComposition {
  visible_text_bytes: number;
  omission_receipt_bytes: number;
  projection_metadata_bytes: number;
  request_bytes: number;
  static_stage_framing_bytes: number;
  upstream_output_contract_bytes: number;
}

export interface FusionStageBudgetPlanEntry {
  budget_stage: FusionBudgetStage;
  slot?: 1 | 2 | 3;
  route: FusionRouteCapacity;
  conditional: boolean;
  check_kind: 'input_only_preflight';
  input_utf8_bytes: number;
  upstream_output_contract_bytes: number;
  forecast_utf8_bytes: number;
  input_only_input_tokens_upper_bound: number;
  forecast_input_tokens_upper_bound: number;
  allowed_input_tokens: number;
  input_only_signed_headroom_tokens: number;
  signed_headroom_tokens: number;
  input_only_utilization_basis_points: number;
  utilization_basis_points: number;
  input_only_estimate: EstimateInputTokensResult;
  reservation_estimate: EstimateInputTokensResult;
  fits: boolean;
  reservation_fits: boolean;
}

export interface FusionBudgetBlocker extends FusionStageBudgetPlanEntry {
  overage_tokens: number;
  bytes_over: number;
}

export interface FusionBudgetWarning extends FusionStageBudgetPlanEntry {
  warning_kind: 'input_utilization' | 'worst_case_reservation';
  threshold_basis_points: number;
}

export interface FusionBudgetEmptyRequestVerdict {
  request_utf8_bytes: number;
  still_fails_with_empty_request: boolean;
  shortening_request_can_help: boolean;
  minimum_request_byte_reduction: number;
  maximum_safe_request_utf8_bytes: number;
  blockers_with_empty_request: readonly FusionBudgetBlocker[];
}

export interface FusionBudgetPlanV1 {
  schema_version: typeof FUSION_BUDGET_PLAN_SCHEMA_VERSION;
  workflow: FusionWorkflowId;
  context: { kind: FusionContextKind; policy_id: string };
  fixed_candidate_policy: { capability: FusionCapability; tools: readonly string[] };
  tool_policy: {
    candidate_tools: readonly string[];
    evaluation_tools: readonly [];
    merge_tools: readonly [];
  };
  policy: FusionBudgetPolicyDescriptor;
  routes: readonly FusionRouteCapacity[];
  stages: readonly FusionStageBudgetPlanEntry[];
  blockers: readonly FusionBudgetBlocker[];
  primary_blocker?: FusionBudgetBlocker;
  primary_blocker_composition?: FusionBudgetStageComposition;
  empty_request: FusionBudgetEmptyRequestVerdict;
  warnings: readonly FusionBudgetWarning[];
}

/** Documented, versioned budget policy. */
export interface FusionBudgetPolicyDescriptor {
  id: 'fusion-budget-policy-v4';
  route_output_reserve_strategy: 'max_fusion_contract_or_model_max';
  calibration_version: string;
  calibration_table: Readonly<Record<TokenBudgetFamily, TokenBudgetFamilyCalibration>>;
  reserved_output_tokens: number;
  framing_reserve_tokens: number;
  safety_reserve_tokens: number;
  candidate_output_contract_bytes: number;
  evaluation_output_contract_bytes: number;
  merge_output_contract_bytes: number;
  diagnostics_contract_bytes: number;
  utilization_warning_threshold_basis_points: 8000;
}

export interface FusionCalibrationViolation {
  schema_version: typeof FUSION_CALIBRATION_VIOLATION_SCHEMA_VERSION;
  stage: FusionStage;
  slot?: 1 | 2 | 3;
  attempt: number;
  route: {
    provider: string;
    model: string;
    qualified_id: string;
  };
  family: TokenBudgetFamily;
  rate_source: TokenBudgetRateSource;
  prompt_utf8_bytes: number;
  prompt_sha256: string;
  observation_scope: 'first_provider_request';
  provider_request_count: number;
  forecast_input_tokens: number;
  billed_input_tokens: number;
  billed_input_breakdown: {
    input: number;
    cache_read: number;
    cache_write: number;
  };
  under_forecast_tokens: number;
  byte_class_breakdown: TokenBudgetByteClassBreakdown;
  dominant_byte_class: TokenBudgetDominantByteClass;
}
