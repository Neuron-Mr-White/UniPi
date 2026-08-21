import { createHash } from 'node:crypto';
import { canonicalJson } from '../attested-pi-run.js';
import {
  UnsupportedConversationBlockError,
  projectVisibleConversationV2,
  type ProjectedConversationV2,
} from '../context-visible-conversation-v2.js';
import {
  snapshotParentConversation,
  type ParentContextSource,
  type ParentSnapshotOptions,
} from '../context-parent-snapshot.js';
import {
  DELEGATE_BRANCH_FILTER_ID,
  DELEGATE_CONTEXT_POLICY_ID,
  DELEGATE_LEDGER_SCHEMA_VERSION,
  DELEGATE_SEED_SCHEMA_VERSION,
  DELEGATE_TOOL_NAME,
  DelegateError,
  type DelegateBranchFilterDescriptor,
  type DelegateCapability,
  type DelegateContextPolicyDescriptor,
  type DelegateConversationProjection,
  type DelegateLedgerV1,
  type DelegateExtensionMode,
  type DelegateLimits,
  type DelegatePinnedRoute,
  type DelegateSeedV1,
  type DelegateTaskDirective,
} from './types.js';

export interface BuildDelegateSeedOptions {
  taskId: string;
  launchNonce: string;
  toolCallId: string | undefined;
  directive: string;
  capability: DelegateCapability;
  extensionMode: DelegateExtensionMode;
  route: DelegatePinnedRoute;
  limits: DelegateLimits;
}

export interface BuiltDelegateSeed {
  seed: DelegateSeedV1;
  /** Exact bytes persisted and written to the child. Nothing re-serializes them. */
  serialized: string;
  sha256: string;
  ledger: DelegateLedgerV1;
}

function sha256Text(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

function policyDescriptor(): DelegateContextPolicyDescriptor {
  return {
    id: DELEGATE_CONTEXT_POLICY_ID,
    transform: 'visible-conversation-ledger-v2',
    version: 1,
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

/**
 * Seal the shared transform under delegate's own envelope.
 *
 * Delegate never imports Fusion's canonical-input builder and never emits
 * `fusion-input.v4`. The ledger root commits only to ledger rows, so the two
 * consumers can seal identical bodies without either affecting the other.
 */
function sealDelegateProjection(
  projected: ProjectedConversationV2,
  branchFilter: DelegateBranchFilterDescriptor,
): { projection: DelegateConversationProjection; ledger: DelegateLedgerV1 } {
  return {
    projection: {
      policy: policyDescriptor(),
      branch_filter: branchFilter,
      entries: projected.entries,
      accounting: projected.accounting,
    },
    ledger: {
      schema_version: DELEGATE_LEDGER_SCHEMA_VERSION,
      policy_id: DELEGATE_CONTEXT_POLICY_ID,
      transform: 'visible-conversation-ledger-v2',
      entries: projected.ledger.entries,
      projection_map: projected.ledger.projection_map,
      root_sha256: projected.ledger.root_sha256,
    },
  };
}

/**
 * Build the frozen delegate seed.
 *
 * The projection excludes the assistant message carrying the in-flight
 * `bg_delegate` call. That message is excluded as a whole, so when several
 * `bg_delegate` calls share one assistant message every sibling call is excluded
 * for every child: two delegates launched together receive identical projected
 * history, and neither can observe the other's arguments.
 *
 * The directive is authoritative; projected history is supporting, untrusted
 * context. That relationship is stated to the child explicitly in its system
 * prompt, and recorded structurally here as `authority: 'explicit_text'`.
 */
export function buildDelegateSeed(
  ctx: ParentContextSource,
  options: BuildDelegateSeedOptions,
): BuiltDelegateSeed {
  const directiveText = options.directive;
  if (directiveText.trim().length === 0) {
    throw new DelegateError('bg_delegate prompt must not be blank', {
      code: 'invalid_arguments',
      childCreated: false,
      remediation: ['Provide a non-blank prompt describing what the delegate should investigate.'],
    });
  }
  const snapshotOptions: ParentSnapshotOptions = {
    toolName: DELEGATE_TOOL_NAME,
    excludeActiveToolCallLeaf: true,
  };
  if (options.toolCallId !== undefined) snapshotOptions.toolCallId = options.toolCallId;

  let snapshot: ReturnType<typeof snapshotParentConversation>;
  let projected: ProjectedConversationV2;
  try {
    snapshot = snapshotParentConversation(ctx, snapshotOptions);
    projected = projectVisibleConversationV2(snapshot.messages);
  } catch (error) {
    if (error instanceof UnsupportedConversationBlockError) {
      throw new DelegateError(
        `bg_delegate could not project the parent conversation: ${error.message}`,
        {
          code: 'seed_projection_failed',
          childCreated: false,
          remediation: [
            'The parent conversation contains a block type this package version does not know how to project.',
            'Nothing was dropped or guessed and no child was created. Report the block type so the transform can be versioned.',
          ],
        },
      );
    }
    throw error;
  }

  const branchFilter: DelegateBranchFilterDescriptor = {
    id: DELEGATE_BRANCH_FILTER_ID,
    tool_name: DELEGATE_TOOL_NAME,
    tool_call_id: options.toolCallId ?? null,
    active_tool_call_leaf_excluded: snapshot.activeToolCallLeafExcluded,
  };
  const sealed = sealDelegateProjection(projected, branchFilter);
  const directive: DelegateTaskDirective = {
    text: directiveText,
    sha256: sha256Text(directiveText),
    authority: 'explicit_text',
  };
  const seed: DelegateSeedV1 = {
    schema_version: DELEGATE_SEED_SCHEMA_VERSION,
    task_id: options.taskId,
    launch_nonce: options.launchNonce,
    cwd: ctx.cwd,
    capability: options.capability,
    extension_mode: options.extensionMode,
    route: options.route,
    parent_system_prompt: ctx.getSystemPrompt(),
    parent_leaf_id: snapshot.leafId,
    directive,
    conversation_projection: sealed.projection,
    limits: options.limits,
  };
  const serialized = canonicalJson(seed);
  return { seed, serialized, sha256: sha256Text(serialized), ledger: sealed.ledger };
}

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Receive-side seed validation performed inside the child before its first model
 * call. A seed that does not match its declared length, hash, schema, task id,
 * and launch nonce is a loud refusal, never a best-effort continue.
 */
export function verifyDelegateSeedBytes(
  raw: string,
  expected: { sha256: string; taskId: string; launchNonce: string },
): DelegateSeedV1 {
  const actual = sha256Text(raw);
  if (actual !== expected.sha256) {
    throw new DelegateError(
      `delegate seed hash mismatch: expected ${expected.sha256}, received ${actual}`,
      {
        code: 'seed_hash_mismatch',
        childCreated: true,
        taskId: expected.taskId,
        remediation: ['The seed bytes delivered to the child differ from the persisted seed.'],
      },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DelegateError(
      `delegate seed is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { code: 'seed_hash_mismatch', childCreated: true, taskId: expected.taskId },
    );
  }
  if (!isRecord(parsed)) {
    throw new DelegateError('delegate seed must be a JSON object', {
      code: 'seed_hash_mismatch',
      childCreated: true,
      taskId: expected.taskId,
    });
  }
  if (parsed['schema_version'] !== DELEGATE_SEED_SCHEMA_VERSION) {
    throw new DelegateError(
      `delegate seed schema_version must be ${DELEGATE_SEED_SCHEMA_VERSION}`,
      { code: 'seed_hash_mismatch', childCreated: true, taskId: expected.taskId },
    );
  }
  if (parsed['task_id'] !== expected.taskId || parsed['launch_nonce'] !== expected.launchNonce) {
    throw new DelegateError('delegate seed task identity does not match this child', {
      code: 'seed_hash_mismatch',
      childCreated: true,
      taskId: expected.taskId,
    });
  }
  // The hash pins the exact bytes; this rebuild pins the shape the child is
  // allowed to act on. Every field the child reads is validated and copied
  // explicitly, so a structurally malformed seed cannot reach the agent loop by
  // way of an unchecked assertion.
  return rebuildSeed(parsed, expected.taskId);
}

function requireString(
  record: Record<PropertyKey, unknown>,
  key: string,
  taskId: string,
): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new DelegateError(`delegate seed field ${key} must be a string`, {
      code: 'seed_hash_mismatch',
      childCreated: true,
      taskId,
    });
  }
  return value;
}

function requireRecord(
  record: Record<PropertyKey, unknown>,
  key: string,
  taskId: string,
): Record<PropertyKey, unknown> {
  const value = record[key];
  if (!isRecord(value)) {
    throw new DelegateError(`delegate seed field ${key} must be an object`, {
      code: 'seed_hash_mismatch',
      childCreated: true,
      taskId,
    });
  }
  return value;
}

function requireNonNegativeInteger(
  record: Record<PropertyKey, unknown>,
  key: string,
  taskId: string,
): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DelegateError(`delegate seed field ${key} must be a non-negative safe integer`, {
      code: 'seed_hash_mismatch',
      childCreated: true,
      taskId,
    });
  }
  return value;
}

/** Explicit, field-by-field reconstruction of the seed fields the child consumes. */
function rebuildSeed(record: Record<PropertyKey, unknown>, taskId: string): DelegateSeedV1 {
  const capability = requireString(record, 'capability', taskId);
  if (capability !== 'inspect') {
    throw new DelegateError(`delegate seed capability ${capability} is not supported`, {
      code: 'delegate_isolation_unsupported',
      childCreated: true,
      taskId,
    });
  }
  const extensionMode = requireString(record, 'extension_mode', taskId);
  if (extensionMode !== 'isolated' && extensionMode !== 'ambient') {
    throw new DelegateError(`delegate seed extension mode ${extensionMode} is not recognised`, {
      code: 'seed_hash_mismatch',
      childCreated: true,
      taskId,
    });
  }
  const routeRecord = requireRecord(record, 'route', taskId);
  const routeOrigin = requireString(routeRecord, 'origin', taskId);
  if (routeOrigin !== 'parent_current' && routeOrigin !== 'explicit') {
    throw new DelegateError(`delegate seed route origin ${routeOrigin} is not recognised`, {
      code: 'seed_hash_mismatch',
      childCreated: true,
      taskId,
    });
  }
  const route: DelegatePinnedRoute = {
    provider: requireString(routeRecord, 'provider', taskId),
    model: requireString(routeRecord, 'model', taskId),
    qualified_id: requireString(routeRecord, 'qualified_id', taskId),
    context_window_tokens: requireNonNegativeInteger(routeRecord, 'context_window_tokens', taskId),
    thinking_level: requireString(routeRecord, 'thinking_level', taskId),
    origin: routeOrigin,
  };
  const limitsRecord = requireRecord(record, 'limits', taskId);
  const limits: DelegateLimits = {
    max_turns: requireNonNegativeInteger(limitsRecord, 'max_turns', taskId),
    max_tool_calls: requireNonNegativeInteger(limitsRecord, 'max_tool_calls', taskId),
    timeout_seconds: requireNonNegativeInteger(limitsRecord, 'timeout_seconds', taskId),
    max_tool_result_bytes: requireNonNegativeInteger(limitsRecord, 'max_tool_result_bytes', taskId),
    max_total_tool_output_bytes: requireNonNegativeInteger(
      limitsRecord,
      'max_total_tool_output_bytes',
      taskId,
    ),
    max_answer_bytes: requireNonNegativeInteger(limitsRecord, 'max_answer_bytes', taskId),
    allowed_input_tokens: requireNonNegativeInteger(limitsRecord, 'allowed_input_tokens', taskId),
  };
  const directiveRecord = requireRecord(record, 'directive', taskId);
  const authority = requireString(directiveRecord, 'authority', taskId);
  if (authority !== 'explicit_text') {
    throw new DelegateError(`delegate seed directive authority ${authority} is not recognised`, {
      code: 'seed_hash_mismatch',
      childCreated: true,
      taskId,
    });
  }
  const directive: DelegateTaskDirective = {
    text: requireString(directiveRecord, 'text', taskId),
    sha256: requireString(directiveRecord, 'sha256', taskId),
    authority,
  };
  if (sha256Text(directive.text) !== directive.sha256) {
    throw new DelegateError('delegate seed directive hash does not match its text', {
      code: 'seed_hash_mismatch',
      childCreated: true,
      taskId,
    });
  }
  const parentLeafId = record['parent_leaf_id'];
  if (parentLeafId !== null && typeof parentLeafId !== 'string') {
    throw new DelegateError('delegate seed parent_leaf_id must be a string or null', {
      code: 'seed_hash_mismatch',
      childCreated: true,
      taskId,
    });
  }
  const projection = requireRecord(record, 'conversation_projection', taskId);
  const projectionPolicy = requireRecord(projection, 'policy', taskId);
  if (requireString(projectionPolicy, 'id', taskId) !== DELEGATE_CONTEXT_POLICY_ID) {
    throw new DelegateError('delegate seed projection policy id is not the delegate policy', {
      code: 'seed_hash_mismatch',
      childCreated: true,
      taskId,
    });
  }
  if (!Array.isArray(projection['entries'])) {
    throw new DelegateError('delegate seed projection entries must be an array', {
      code: 'seed_hash_mismatch',
      childCreated: true,
      taskId,
    });
  }
  return {
    schema_version: DELEGATE_SEED_SCHEMA_VERSION,
    task_id: requireString(record, 'task_id', taskId),
    launch_nonce: requireString(record, 'launch_nonce', taskId),
    cwd: requireString(record, 'cwd', taskId),
    capability,
    extension_mode: extensionMode,
    route,
    parent_system_prompt: requireString(record, 'parent_system_prompt', taskId),
    parent_leaf_id: parentLeafId,
    directive,
    conversation_projection: readDelegateProjection(projection),
    limits,
  };
}

/**
 * The projection body is already hash-pinned by the seed digest verified above,
 * so it is carried through without re-deriving values that would only duplicate
 * the parent's computation.
 */
function readDelegateProjection(record: Record<PropertyKey, unknown>): DelegateConversationProjection {
  const projection: unknown = record;
  if (!isDelegateProjection(projection)) {
    throw new DelegateError('delegate seed conversation_projection is malformed', {
      code: 'seed_hash_mismatch',
      childCreated: true,
    });
  }
  return projection;
}

function isDelegateProjection(value: unknown): value is DelegateConversationProjection {
  if (!isRecord(value)) return false;
  if (!isRecord(value['policy']) || !isRecord(value['branch_filter'])) return false;
  if (!isRecord(value['accounting'])) return false;
  return Array.isArray(value['entries']);
}
