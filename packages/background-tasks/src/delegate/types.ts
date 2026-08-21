import type { Usage } from '@earendil-works/pi-ai';
import type {
  TokenBudgetByteClassBreakdown,
  TokenBudgetDominantByteClass,
  TokenBudgetFamily,
  TokenBudgetRateSource,
} from '../context-token-budget.js';
import type {
  ContextProjectionMapEntry,
  OmittedEventRecord,
  ProjectionAccounting,
  ProjectionEntry,
} from '../context-visible-conversation-v2.js';

export const DELEGATE_SEED_SCHEMA_VERSION = 'pi-background-tasks.delegate-seed.v2' as const;
export const DELEGATE_LEDGER_SCHEMA_VERSION = 'pi-background-tasks.delegate-ledger.v1' as const;
export const DELEGATE_RESULT_PACKAGE_SCHEMA_VERSION =
  'pi-background-tasks.delegate-result.v1' as const;
export const DELEGATE_RECEIPT_SCHEMA_VERSION = 'pi-background-tasks.delegate-receipt.v1' as const;
export const DELEGATE_BUDGET_PLAN_SCHEMA_VERSION =
  'pi-background-tasks.delegate-budget-plan.v3' as const;
export const DELEGATE_MANIFEST_SCHEMA_VERSION = 'pi-background-tasks.delegate-manifest.v2' as const;

/**
 * Delegate's own context policy id. It shares the frozen
 * `visible-conversation-ledger-v2` transform with Fusion but is a distinct
 * consumer identity, so a delegate artifact can never be mistaken for a Fusion
 * artifact and neither can claim the other's provenance.
 */
export const DELEGATE_CONTEXT_POLICY_ID = 'delegate-inspect-v1';
export const DELEGATE_BRANCH_FILTER_ID = 'exclude-active-delegate-batch-v1';
export const DELEGATE_TOOL_NAME = 'bg_delegate';
export const DELEGATE_RESULT_TOOL_NAME = 'bg_result';

export const DELEGATE_CAPABILITIES = ['inspect'] as const;
export type DelegateCapability = (typeof DELEGATE_CAPABILITIES)[number];

/**
 * Controls only Pi's ambient extension discovery for delegate children.
 * Tool and project-resource restrictions remain independently enforced.
 */
export const DELEGATE_EXTENSION_MODES = ['isolated', 'ambient'] as const;
export type DelegateExtensionMode = (typeof DELEGATE_EXTENSION_MODES)[number];

export const DELEGATE_AUTO_DELIVER_MODES = ['never', 'when_small', 'always'] as const;
export type DelegateAutoDeliverMode = (typeof DELEGATE_AUTO_DELIVER_MODES)[number];

export const DELEGATE_DELIVERY_MODES = ['inline', 'artifact'] as const;
export type DelegateDeliveryMode = (typeof DELEGATE_DELIVERY_MODES)[number];

export interface DelegateRoute {
  provider: string;
  model: string;
}

export interface DelegatePinnedRoute extends DelegateRoute {
  qualified_id: string;
  context_window_tokens: number;
  thinking_level: string;
  /** Whether the route came from the parent's current model or an explicit argument. */
  origin: 'parent_current' | 'explicit';
}

export interface DelegateBudgetRouteSource {
  family: TokenBudgetFamily;
  rate_source: TokenBudgetRateSource;
  conservative_rate_source?: TokenBudgetRateSource | undefined;
}

export interface DelegateContextPolicyDescriptor {
  id: typeof DELEGATE_CONTEXT_POLICY_ID;
  transform: 'visible-conversation-ledger-v2';
  version: 1;
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

export interface DelegateBranchFilterDescriptor {
  id: typeof DELEGATE_BRANCH_FILTER_ID;
  tool_name: typeof DELEGATE_TOOL_NAME;
  tool_call_id: string | null;
  active_tool_call_leaf_excluded: boolean;
}

export interface DelegateConversationProjection {
  policy: DelegateContextPolicyDescriptor;
  branch_filter: DelegateBranchFilterDescriptor;
  entries: readonly ProjectionEntry[];
  accounting: ProjectionAccounting;
}

export interface DelegateLedgerV1 {
  schema_version: typeof DELEGATE_LEDGER_SCHEMA_VERSION;
  policy_id: typeof DELEGATE_CONTEXT_POLICY_ID;
  transform: 'visible-conversation-ledger-v2';
  entries: readonly OmittedEventRecord[];
  projection_map: readonly ContextProjectionMapEntry[];
  root_sha256: string;
}

export interface DelegateTaskDirective {
  /** Verbatim operator/agent prompt. Always authoritative over projected history. */
  text: string;
  sha256: string;
  authority: 'explicit_text';
}

export interface DelegateSeedV1 {
  schema_version: typeof DELEGATE_SEED_SCHEMA_VERSION;
  task_id: string;
  launch_nonce: string;
  cwd: string;
  capability: DelegateCapability;
  extension_mode: DelegateExtensionMode;
  route: DelegatePinnedRoute;
  parent_system_prompt: string;
  parent_leaf_id: string | null;
  directive: DelegateTaskDirective;
  conversation_projection: DelegateConversationProjection;
  limits: DelegateLimits;
}

export interface DelegateLimits {
  max_turns: number;
  max_tool_calls: number;
  timeout_seconds: number;
  /** Per-tool-result transcript cap; larger results spill to hashed artifacts. */
  max_tool_result_bytes: number;
  /** Cumulative spilled+inline tool output across the whole run. */
  max_total_tool_output_bytes: number;
  /** Cap on the child's captured final answer. */
  max_answer_bytes: number;
  /** Usable input tokens for the pinned route after reserves. */
  allowed_input_tokens: number;
}

export interface DelegateAnswerBlock {
  kind: 'text';
  byte_length: number;
  sha256: string;
  data_base64: string;
}

export interface DelegateRouteAttestation {
  provider: string;
  model: string;
  stop_reason: string;
}

/**
 * Usage that is explicitly absent is reported as absent.
 *
 * A child that never produced a usable usage record must not be reported as
 * having cost zero, so the status is carried alongside the value.
 */
export type DelegateUsageReport =
  | { status: 'observed'; usage: Usage }
  | { status: 'unavailable'; reason: string };

/**
 * The single atomically-committed answer data plane.
 *
 * The child writes exactly this document to a temporary file, fsyncs it, and
 * renames it into place. The rename is the commit point: a package that exists
 * under its final name is complete, and one that does not exist means the child
 * produced no accepted answer. There is no second channel to reconcile.
 */
export interface DelegateResultPackageV1 {
  schema_version: typeof DELEGATE_RESULT_PACKAGE_SCHEMA_VERSION;
  task_id: string;
  launch_nonce: string;
  seed_sha256: string;
  directive_sha256: string;
  route: DelegateRoute;
  route_attestations: readonly DelegateRouteAttestation[];
  stop_reason: string;
  turns: number;
  tool_calls: number;
  usage: DelegateUsageReport;
  answer: {
    encoding: 'utf-8';
    byte_length: number;
    sha256: string;
    blocks: readonly DelegateAnswerBlock[];
  };
  spilled_artifacts: readonly DelegateSpillReceipt[];
}

export type DelegateSpillContentFormat =
  | 'single_text_utf8'
  | 'tool_result_content_json_v1'
  | 'opaque_bytes';

export interface DelegateSpillReceipt {
  schema_version: typeof DELEGATE_RECEIPT_SCHEMA_VERSION;
  artifact: string;
  tool_name: string;
  tool_call_id: string;
  turn_sequence: number;
  source_call_index: number;
  byte_length: number;
  sha256: string;
  /**
   * Encoding of the hashed artifact bytes. Optional only for compatibility
   * with v1 receipts written before content formats were recorded.
   */
  content_format?: DelegateSpillContentFormat | undefined;
}

export const DELEGATE_ERROR_CODES = [
  // Admission failures. No child process exists in these states.
  'delegate_hook_contract_unsupported',
  'delegate_isolation_unsupported',
  'route_unresolved',
  'route_capacity_unknown',
  'seed_projection_failed',
  'seed_budget_exceeded',
  'seed_persist_failed',
  'invalid_arguments',
  // Launch and execution.
  'child_spawn_failed',
  'child_startup_failed',
  'child_timeout',
  'child_cancelled',
  'child_turn_limit',
  'child_tool_call_limit',
  'child_exited_without_commit',
  // Budget, split by which budget was exhausted.
  'provider_context_budget_exhausted',
  'aggregate_tool_output_cap',
  'child_model_output_limit',
  'child_capture_limit',
  // Integrity.
  'child_result_invalid',
  'child_result_encoding_invalid',
  'route_attestation_missing',
  'route_mismatch',
  'seed_hash_mismatch',
  'answer_hash_mismatch',
  'artifact_spill_failed',
  'artifact_read_failed',
  'artifact_error',
  // Retrieval states and outcomes.
  'result_not_ready',
  'result_unavailable',
  'result_too_large_for_inline',
  'task_unknown',
] as const;

export type DelegateErrorCode = (typeof DELEGATE_ERROR_CODES)[number];

export interface DelegateBudgetErrorDetail {
  measurement_kind: 'launch_admission' | 'runtime_context';
  measured_utf8_bytes: number;
  measured_input_tokens_upper_bound: number;
  allowed_input_tokens: number;
  rate_source: TokenBudgetRateSource;
  backed: boolean;
  dominant_byte_class: TokenBudgetDominantByteClass;
  byte_class_breakdown: TokenBudgetByteClassBreakdown;
}

export interface DelegateErrorDetails {
  code: DelegateErrorCode;
  /** True only when an OS process was actually created. Admission failures are false. */
  childCreated?: boolean;
  taskId?: string;
  artifactDir?: string;
  budget?: DelegateBudgetErrorDetail;
  /** What is preserved on disk despite the failure. */
  preserved?: readonly string[];
  /** Concrete operator actions. */
  remediation?: readonly string[];
}

/**
 * Typed delegate failure.
 *
 * Every instance states what happened, what was preserved, and what the operator
 * can do. There is no untyped delegate failure path.
 */
export class DelegateError extends Error {
  readonly code: DelegateErrorCode;
  readonly childCreated: boolean;
  readonly taskId: string | undefined;
  readonly artifactDir: string | undefined;
  readonly budget: DelegateBudgetErrorDetail | undefined;
  readonly preserved: readonly string[];
  readonly remediation: readonly string[];

  constructor(message: string, details: DelegateErrorDetails) {
    super(message);
    this.name = 'DelegateError';
    this.code = details.code;
    this.childCreated = details.childCreated ?? false;
    this.taskId = details.taskId;
    this.artifactDir = details.artifactDir;
    this.budget = details.budget;
    this.preserved = details.preserved ?? [];
    this.remediation = details.remediation ?? [];
  }

  /** Operator-facing rendering: cause, preserved evidence, and next action. */
  describe(): string {
    const lines = [`[${this.code}] ${this.message}`];
    lines.push(`Child process created: ${this.childCreated ? 'yes' : 'no'}`);
    if (this.artifactDir !== undefined) lines.push(`Artifacts: ${this.artifactDir}`);
    lines.push(
      this.preserved.length > 0
        ? `Preserved: ${this.preserved.join(', ')}`
        : 'Preserved: nothing was written for this failure',
    );
    if (this.remediation.length > 0) lines.push(`Remediation: ${this.remediation.join(' ')}`);
    return lines.join('\n');
  }
}
