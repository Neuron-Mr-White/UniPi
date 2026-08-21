import { createHash } from 'node:crypto';
import { canonicalJson } from '../attested-pi-run.js';
import {
  projectVisibleConversationV2,
  type OmittedRunCounts,
  type ProjectedConversationV2,
  type ProjectionEntry,
} from '../context-visible-conversation-v2.js';
import {
  snapshotParentConversation,
  type ParentContextSource,
  type ParentSnapshotOptions,
  type ReadonlyParentSessionManager,
} from '../context-parent-snapshot.js';
import type { Message } from '@earendil-works/pi-ai';
import { FUSION_REASON_TOOL_NAME } from './workflows.js';
import {
  FUSION_BRANCH_FILTER_ID,
  FUSION_COMMAND_CONTEXT_POLICY_ID,
  FUSION_CONTEXT_LEDGER_SCHEMA_VERSION,
  FUSION_CONTEXT_TRANSFORM_ID,
  FUSION_INPUT_SCHEMA_VERSION,
  FUSION_TOOL_CONTEXT_POLICY_ID,
  FusionError,
  type FusionBranchFilterDescriptor,
  type FusionCanonicalRequestV3,
  type FusionSessionProjectionCanonicalInputV5,
  type FusionWorkflowId,
  type FusionContextOmissionLedgerV2,
  type FusionContextPolicyDescriptor,
  type FusionConversationProjectionV3,
  type FusionProjectionEntry,
  type FusionProjectionOmissionCounts,
  type FusionRequestAuthority,
  type FusionSource,
} from './types.js';

/**
 * Re-exported from the workflow registry, which owns every workflow's tool name.
 * Kept here so existing importers of this module keep working unchanged.
 */
export {
  FUSION_BRAINSTORM_TOOL_NAME,
  FUSION_REASON_TOOL_NAME,
  FUSION_INVESTIGATE_TOOL_NAME,
  FUSION_RESEARCH_TOOL_NAME,
  FUSION_VALIDATE_TOOL_NAME,
} from './workflows.js';

/** Retained for source compatibility; Fusion's session access is the shared adapter. */
export type FusionReadonlySessionManager = ReadonlyParentSessionManager;
export type FusionContextSource = ParentContextSource;

export interface BuildFusionCanonicalInputOptions {
  source: FusionSource;
  request: string;
  toolCallId?: string;
  toolName?: string;
  workflow?: FusionWorkflowId;
}

export interface BuiltFusionCanonicalInput {
  input: FusionSessionProjectionCanonicalInputV5;
  serialized: string;
  ledger: FusionContextOmissionLedgerV2;
  transcriptLeafId: string | null;
}

export function normalizeFusionCommandRequest(args: string): string {
  return args.trim();
}

function sha256Text(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

function contextPolicyId(source: FusionSource): string {
  return source === 'tool' ? FUSION_TOOL_CONTEXT_POLICY_ID : FUSION_COMMAND_CONTEXT_POLICY_ID;
}

function requestAuthority(source: FusionSource): FusionRequestAuthority {
  return source === 'tool' ? 'explicit_text' : 'directive_over_projected_conversation';
}

function policyDescriptor(source: FusionSource): FusionContextPolicyDescriptor {
  return {
    id: contextPolicyId(source),
    transform: FUSION_CONTEXT_TRANSFORM_ID,
    version: 2,
    receipt_format: 'omitted_activity.v2',
    user_text: 'verbatim',
    assistant_text: 'verbatim',
    assistant_thinking: 'ledger_only',
    tool_call_arguments: 'ledger_only',
    tool_results: 'ledger_only',
    tool_payload_preview_bytes: 0,
    images: 'marker_or_ledger_only',
    unknown_block_behavior: 'error',
  };
}

function compactOmissionCounts(counts: OmittedRunCounts): FusionProjectionOmissionCounts {
  return [
    counts.assistant_thinking ?? 0,
    counts.tool_calls ?? 0,
    counts.tool_result_texts ?? 0,
  ];
}

function expandOmissionCounts(counts: FusionProjectionOmissionCounts): OmittedRunCounts {
  const out: OmittedRunCounts = {};
  const [assistantThinking, toolCalls, toolResults] = counts;
  if (assistantThinking > 0) out.assistant_thinking = assistantThinking;
  if (toolCalls > 0) out.tool_calls = toolCalls;
  if (toolResults > 0) out.tool_result_texts = toolResults;
  return out;
}

export function compactFusionProjectionEntry(entry: ProjectionEntry): FusionProjectionEntry {
  if (entry.kind === 'text') {
    return [
      't',
      entry.role === 'user' ? 'u' : 'a',
      entry.source_ordinal,
      entry.block_ordinal,
      entry.text,
    ];
  }
  return ['o', [entry.at[0], entry.at[1]], entry.bytes, compactOmissionCounts(entry.counts)];
}

export function expandFusionProjectionEntry(entry: FusionProjectionEntry): ProjectionEntry {
  if (entry[0] === 't') {
    return {
      kind: 'text',
      source_ordinal: entry[2],
      block_ordinal: entry[3],
      role: entry[1] === 'u' ? 'user' : 'assistant',
      text: entry[4],
    };
  }
  return {
    kind: 'omitted_activity',
    at: [entry[1][0], entry[1][1]],
    bytes: entry[2],
    counts: expandOmissionCounts(entry[3]),
  };
}

function compactFusionProjectionEntries(
  entries: readonly ProjectionEntry[],
): readonly FusionProjectionEntry[] {
  return entries.map(compactFusionProjectionEntry);
}

function compactOmissionReceiptBytes(entries: readonly FusionProjectionEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    if (entry[0] === 'o') total += Buffer.byteLength(canonicalJson(entry), 'utf8');
  }
  return total;
}

/**
 * Seal the shared transform output into Fusion's versioned envelopes.
 *
 * Fusion v4 compacts only the child-facing projection entries. Ledger rows are
 * carried through unchanged, so the ledger root commits to exactly the same
 * omitted payload records before and after tuple encoding. Golden tests pin the
 * new canonical-input bytes and the unchanged ledger bytes.
 */
function sealFusionProjection(
  projected: ProjectedConversationV2,
  source: FusionSource,
  branchFilter: FusionBranchFilterDescriptor,
): { projection: FusionConversationProjectionV3; ledger: FusionContextOmissionLedgerV2 } {
  const entries = compactFusionProjectionEntries(projected.entries);
  return {
    projection: {
      policy: policyDescriptor(source),
      branch_filter: branchFilter,
      entries,
      accounting: {
        ...projected.accounting,
        omission_receipt_utf8_bytes: compactOmissionReceiptBytes(entries),
      },
    },
    ledger: {
      schema_version: FUSION_CONTEXT_LEDGER_SCHEMA_VERSION,
      policy_id: contextPolicyId(source),
      transform: FUSION_CONTEXT_TRANSFORM_ID,
      entries: projected.ledger.entries,
      projection_map: projected.ledger.projection_map,
      root_sha256: projected.ledger.root_sha256,
    },
  };
}

/** Preserved public entry point; delegates to the shared frozen transform. */
export function projectFusionConversation(
  messages: readonly Message[],
  source: FusionSource,
  branchFilter: FusionBranchFilterDescriptor,
): { projection: FusionConversationProjectionV3; ledger: FusionContextOmissionLedgerV2 } {
  return sealFusionProjection(projectVisibleConversationV2(messages), source, branchFilter);
}

export function buildFusionCanonicalInput(
  ctx: FusionContextSource,
  options: BuildFusionCanonicalInputOptions,
): BuiltFusionCanonicalInput {
  if (options.request.trim().length === 0) {
    throw new FusionError('fusion request must not be blank', {
      code: 'context_capture_failed',
      childCreated: false,
    });
  }
  const workflow = options.workflow ?? 'reason';
  if (workflow !== 'reason') {
    throw new FusionError('parent session projection is available only to the reason workflow', {
      code: 'context_capture_failed',
      childCreated: false,
    });
  }
  const toolName = options.toolName ?? FUSION_REASON_TOOL_NAME;
  const snapshotOptions: ParentSnapshotOptions = {
    toolName,
    excludeActiveToolCallLeaf: options.source === 'tool',
  };
  if (options.toolCallId !== undefined) snapshotOptions.toolCallId = options.toolCallId;
  const snapshot = snapshotParentConversation(ctx, snapshotOptions);
  const branchFilter: FusionBranchFilterDescriptor = {
    id: FUSION_BRANCH_FILTER_ID,
    tool_name: toolName,
    tool_call_id: options.source === 'tool' ? (options.toolCallId ?? null) : null,
    active_tool_call_leaf_excluded: snapshot.activeToolCallLeafExcluded,
  };
  const projected = projectFusionConversation(snapshot.messages, options.source, branchFilter);
  const request: FusionCanonicalRequestV3 = {
    source: options.source,
    authority: requestAuthority(options.source),
    text: options.request,
    sha256: sha256Text(options.request),
  };
  const input: FusionSessionProjectionCanonicalInputV5 = {
    schema_version: FUSION_INPUT_SCHEMA_VERSION,
    workflow: 'reason',
    cwd: ctx.cwd,
    request,
    system_prompt: ctx.getSystemPrompt(),
    conversation_projection: projected.projection,
    context: {
      kind: 'session_projection',
      policy_id: 'fusion-session-projection-v1',
      system_prompt: ctx.getSystemPrompt(),
      conversation_projection: projected.projection,
    },
  };
  return {
    input,
    serialized: canonicalJson(input),
    ledger: projected.ledger,
    transcriptLeafId: snapshot.leafId,
  };
}
