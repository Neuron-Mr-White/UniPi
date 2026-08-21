import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { canonicalJson } from '../attested-pi-run.js';
import { replaceFileDurable } from '../durable-fs.js';
import { resolveAnthropicAttributionExtensionPath } from '../anthropic-attribution-path.js';
import { join } from 'node:path';
import { DelegateArtifactStore, discardDelegateArtifactRoot } from './artifacts.js';
import {
  buildDelegateChildArgv,
  delegateChildEnv,
  ensureDelegateChildSessionDir,
  preflightDelegateLaunch,
  resolveDelegateChildExtensionPath,
  type DelegatePreflightInput,
  type DelegatePreflightResult,
} from './launch.js';
import {
  DELEGATE_INLINE_ANSWER_BYTES,
} from './budget.js';
import { verifyDelegateResultPackage, type VerifiedDelegateResult } from './result-package.js';
import {
  DelegateError,
  type DelegateAutoDeliverMode,
  type DelegateExtensionMode,
  type DelegateResultPackageV1,
} from './types.js';
import type { DelegateTaskFacts, DelegateTaskOutcome } from '../types.js';

/**
 * Delegate launch preparation and terminal evaluation.
 *
 * Separated from the background-task registry so the ordering property that
 * matters most — preflight refusals create nothing — is testable without
 * spawning anything.
 */

export interface PreparedDelegateLaunch {
  preflight: DelegatePreflightResult;
  store: DelegateArtifactStore;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  facts: DelegateTaskFacts;
  childSessionDirAbs: string;
  seedPathAbs: string;
  /** Exact prompt bytes delivered to the child over stdin. */
  stdinBytes: Buffer;
}

export interface PrepareDelegateLaunchInput extends DelegatePreflightInput {
  cwd: string;
  sessionId: string | undefined;
  autoDeliver: DelegateAutoDeliverMode;
  extensionMode: DelegateExtensionMode;
  childExtensionPath?: string | undefined;
  attributionExtensionPath?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  now?: (() => Date) | undefined;
}

/**
 * Prepare a delegate launch.
 *
 * Preflight runs first and completes entirely before the artifact directory is
 * created, so every admission refusal leaves zero children AND zero artifacts.
 * When a step after directory creation fails, the partially created directory
 * is removed, so a refused launch never leaves a half-formed run behind.
 */
export async function prepareDelegateLaunch(
  input: PrepareDelegateLaunchInput,
): Promise<PreparedDelegateLaunch> {
  // Resolve the guard extension before anything is created: a package missing
  // its child guard must refuse rather than spawn an unguarded child.
  const childExtensionPath =
    input.childExtensionPath ?? resolveDelegateChildExtensionPath();
  let attributionExtensionPath: string | undefined;
  if (input.route.provider === 'anthropic') {
    try {
      attributionExtensionPath =
        input.attributionExtensionPath ?? resolveAnthropicAttributionExtensionPath();
    } catch (error) {
      throw new DelegateError(
        `Anthropic delegate attribution extension could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
        {
          code: 'delegate_isolation_unsupported',
          childCreated: false,
          remediation: ['Reinstall the package; Anthropic delegates require attribution.'],
        },
      );
    }
  }

  const preflight = preflightDelegateLaunch(input);

  const store = await DelegateArtifactStore.create({
    cwd: input.cwd,
    taskId: preflight.taskId,
    launchNonce: preflight.launchNonce,
    sessionId: input.sessionId,
    childSessionId: preflight.childSessionId,
    childSessionDir: '',
    extensionMode: input.extensionMode,
    route: input.route,
    limits: preflight.limits,
    seedSha256: preflight.seed.sha256,
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  try {
    const seedRef = await store.writeSeed(preflight.seed.serialized);
    // The persisted seed bytes are the bytes the child reads. Nothing
    // re-serializes them between here and the child, and the child verifies the
    // hash before its first model call.
    if (seedRef.sha256 !== preflight.seed.sha256) {
      throw new DelegateError(
        'delegate seed hash changed between construction and persistence',
        {
          code: 'seed_persist_failed',
          childCreated: false,
          taskId: preflight.taskId,
          artifactDir: store.artifactDir,
        },
      );
    }
    await store.writeLedger(preflight.seed.ledger);
    await store.writeBudgetPlan(preflight.plan);
    const childSessionDirAbs = await ensureDelegateChildSessionDir(store.artifactDirAbs);
    const seedPathAbs = join(store.artifactDirAbs, 'seed.json');
    const argv = buildDelegateChildArgv({
      route: input.route,
      capability: input.capability,
      extensionMode: input.extensionMode,
      childSessionId: preflight.childSessionId,
      childSessionDir: childSessionDirAbs,
      childExtensionPath,
      attributionExtensionPath,
      systemPrompt: preflight.childSystemPrompt,
    });
    const env = delegateChildEnv(
      {
        artifactDirAbs: store.artifactDirAbs,
        seedPathAbs,
        seedSha256: preflight.seed.sha256,
        taskId: preflight.taskId,
        launchNonce: preflight.launchNonce,
      },
      input.env ?? process.env,
    );
    const facts: DelegateTaskFacts = {
      taskId: preflight.taskId,
      launchNonce: preflight.launchNonce,
      artifactDir: store.artifactDir,
      artifactDirAbs: store.artifactDirAbs,
      seedSha256: preflight.seed.sha256,
      childSessionId: preflight.childSessionId,
      route: {
        provider: input.route.provider,
        model: input.route.model,
        qualifiedId: input.route.qualified_id,
      },
      budget: {
        family: preflight.plan.route.family,
        rate_source: preflight.plan.route.rate_source,
        conservative_rate_source: preflight.plan.conservative_estimate.rateSource,
      },
      extensionMode: input.extensionMode,
      autoDeliver: input.autoDeliver,
    };
    const stdinBytes = Buffer.from(preflight.childPrompt, 'utf8');
    // The persisted prompt bytes must equal the bytes sent to the child, so the
    // artifact is evidence of what the child actually received.
    await store.writeChildPrompt(stdinBytes);
    return {
      preflight,
      store,
      argv,
      env,
      facts,
      childSessionDirAbs,
      seedPathAbs,
      stdinBytes,
    };
  } catch (error) {
    // A failure after directory creation must not leave a half-formed run.
    await discardDelegateArtifactRoot(store.artifactDirAbs);
    throw error;
  }
}

export interface DelegateTerminalEvaluation {
  outcome: DelegateTaskOutcome;
  result?: VerifiedDelegateResult | undefined;
  error?: DelegateError | undefined;
}

export interface EvaluateDelegateTerminalInput {
  artifactDirAbs: string;
  taskId: string;
  launchNonce: string;
  seedSha256: string;
  route: { provider: string; model: string };
  /** Terminal status observed by the background task registry. */
  taskStatus: 'completed' | 'failed' | 'killed';
  taskError: string | undefined;
  /** Real merged child output owned by the background-task registry. */
  taskOutputPath?: string | undefined;
  taskOutputAbsPath?: string | undefined;
}

/**
 * Evaluate a finished delegate child.
 *
 * The committed result package is the sole answer data plane. Its presence under
 * its final name is the success signal; its absence means no answer was
 * accepted, whatever the process exit code happened to be. A child that exits 0
 * without committing is a typed `child_exited_without_commit`, never a silent
 * empty success.
 */
export async function evaluateDelegateTerminal(
  input: EvaluateDelegateTerminalInput,
): Promise<DelegateTerminalEvaluation> {
  const evaluation = await adjudicateDelegateTerminal(input);
  // Record the parent's adjudicated view separately from the child-written
  // result package, so neither writer can overwrite the other's claim.
  try {
    await replaceFileDurable(
      join(input.artifactDirAbs, 'outcome.json'),
      `${canonicalJson({
        schema_version: 'pi-background-tasks.delegate-outcome.v1',
        task_id: input.taskId,
        launch_nonce: input.launchNonce,
        observed_task_status: input.taskStatus,
        outcome: evaluation.outcome,
        error_code: evaluation.error?.code ?? null,
      })}\n`,
    );
  } catch {
    // Failing to record the adjudication must not change the adjudication
    // itself, which is returned to the caller either way.
  }
  return evaluation;
}

async function adjudicateDelegateTerminal(
  input: EvaluateDelegateTerminalInput,
): Promise<DelegateTerminalEvaluation> {
  const resultPath = join(input.artifactDirAbs, 'result.json');
  const terminalPath = join(input.artifactDirAbs, 'child-terminal.json');
  if (!existsSync(resultPath)) {
    const recorded = existsSync(terminalPath)
      ? await readChildTerminal(terminalPath)
      : undefined;
    const cancelled = input.taskStatus === 'killed';
    const code = recorded?.code ?? (cancelled ? 'child_cancelled' : 'child_exited_without_commit');
    const detail =
      recorded?.message ??
      input.taskError ??
      'the delegate child exited without committing a result package';
    const preserved = ['seed.json', 'budget-plan.json', 'child-terminal.json', 'runtime-budget.json']
      .filter((name) => existsSync(join(input.artifactDirAbs, name)));
    if (
      input.taskOutputPath !== undefined &&
      input.taskOutputAbsPath !== undefined &&
      existsSync(input.taskOutputAbsPath)
    ) {
      preserved.push(input.taskOutputPath);
    }
    const diagnosticTargets = preserved.filter(
      (name) => name === 'child-terminal.json' || name === 'runtime-budget.json' || name === input.taskOutputPath,
    );
    const diagnostic = diagnosticTargets.length === 0
      ? 'No child terminal record or merged task output exists; inspect the preserved launch artifacts listed above.'
      : `Inspect the preserved diagnostic evidence: ${diagnosticTargets.join(', ')}.`;
    const error = new DelegateError(
      `bg_delegate produced no committed answer: ${detail}`,
      {
        code: isDelegateErrorCode(code) ? code : 'child_exited_without_commit',
        childCreated: true,
        taskId: input.taskId,
        artifactDir: input.artifactDirAbs,
        preserved,
        remediation: [
          diagnostic,
          'No partial answer is returned; nothing was truncated to look like success.',
        ],
      },
    );
    const outcome: DelegateTaskOutcome = {
      status: cancelled ? 'cancelled' : 'failed',
      errorCode: error.code,
    };
    return { outcome, error };
  }

  let raw: string;
  try {
    raw = await readFile(resultPath, 'utf8');
  } catch (error) {
    const failure = new DelegateError(
      `bg_delegate could not read its committed result package: ${error instanceof Error ? error.message : String(error)}`,
      {
        code: 'artifact_read_failed',
        childCreated: true,
        taskId: input.taskId,
        artifactDir: input.artifactDirAbs,
      },
    );
    return { outcome: { status: 'failed', errorCode: failure.code }, error: failure };
  }

  try {
    const verified = verifyDelegateResultPackage(raw, {
      taskId: input.taskId,
      launchNonce: input.launchNonce,
      seedSha256: input.seedSha256,
      route: input.route,
    });
    return {
      outcome: {
        status: 'committed',
        answerBytes: verified.package.answer.byte_length,
        answerSha256: verified.package.answer.sha256,
        turns: verified.package.turns,
        toolCalls: verified.package.tool_calls,
      },
      result: verified,
    };
  } catch (error) {
    if (error instanceof DelegateError) {
      return { outcome: { status: 'failed', errorCode: error.code }, error };
    }
    throw error;
  }
}

interface ChildTerminalRecord {
  code: string;
  message: string;
}

async function readChildTerminal(path: string): Promise<ChildTerminalRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const code: unknown = Reflect.get(parsed, 'code');
    const message: unknown = Reflect.get(parsed, 'message');
    if (typeof code !== 'string' || typeof message !== 'string') return undefined;
    return { code, message };
  } catch {
    // A missing or malformed child-terminal record must not mask the primary
    // "no committed answer" failure, which is reported by the caller either way.
    return undefined;
  }
}

const DELEGATE_ERROR_CODE_SET = new Set<string>([
  'delegate_hook_contract_unsupported',
  'delegate_isolation_unsupported',
  'route_unresolved',
  'route_capacity_unknown',
  'seed_projection_failed',
  'seed_budget_exceeded',
  'seed_persist_failed',
  'invalid_arguments',
  'child_spawn_failed',
  'child_startup_failed',
  'child_timeout',
  'child_cancelled',
  'child_turn_limit',
  'child_tool_call_limit',
  'child_exited_without_commit',
  'provider_context_budget_exhausted',
  'aggregate_tool_output_cap',
  'child_model_output_limit',
  'child_capture_limit',
  'child_result_invalid',
  'child_result_encoding_invalid',
  'route_attestation_missing',
  'route_mismatch',
  'seed_hash_mismatch',
  'answer_hash_mismatch',
  'artifact_spill_failed',
  'artifact_read_failed',
  'artifact_error',
  'result_not_ready',
  'result_unavailable',
  'result_too_large_for_inline',
  'task_unknown',
]);

function isDelegateErrorCode(value: string): value is DelegateError['code'] {
  return DELEGATE_ERROR_CODE_SET.has(value);
}

export interface DelegateInlineDecision {
  mode: 'inline' | 'artifact';
  reason: string;
}

/**
 * Decide inline versus artifact delivery.
 *
 * The cap is applied to the exact serialized answer bytes. An answer over the
 * cap degrades to an artifact reference explicitly and is never shortened to
 * fit.
 */
export function decideDelegateDelivery(
  answerBytes: number,
  requested: 'inline' | 'artifact' | undefined,
  cap = DELEGATE_INLINE_ANSWER_BYTES,
): DelegateInlineDecision {
  if (requested === 'artifact') {
    return { mode: 'artifact', reason: 'artifact delivery was requested explicitly' };
  }
  if (answerBytes <= cap) {
    return {
      mode: 'inline',
      reason: `the answer is ${String(answerBytes)} bytes, within the ${String(cap)}-byte inline cap`,
    };
  }
  return {
    mode: 'artifact',
    reason: `the answer is ${String(answerBytes)} bytes, over the ${String(cap)}-byte inline cap`,
  };
}

/** Raised when inline delivery was explicitly requested for an oversized answer. */
export function inlineTooLarge(
  taskId: string,
  artifactDir: string,
  answerBytes: number,
  cap = DELEGATE_INLINE_ANSWER_BYTES,
): DelegateError {
  return new DelegateError(
    `bg_result cannot return this answer inline: it is ${String(answerBytes)} bytes, over the ${String(cap)}-byte inline cap. The complete verified answer is preserved at ${join(artifactDir, 'result.json')}. It is not truncated to fit.`,
    {
      code: 'result_too_large_for_inline',
      childCreated: true,
      taskId,
      artifactDir,
      preserved: [join(artifactDir, 'result.json')],
      remediation: [
        'Call bg_result with delivery:"artifact" to receive the verified metadata plus the artifact reference.',
        'Read the answer from the artifact path directly if the full text is required.',
      ],
    },
  );
}

export type { DelegateResultPackageV1 };
