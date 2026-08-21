import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type, type Static } from 'typebox';
import type { BgTask, BgTaskSnapshot, StartDelegateTaskOptions } from './types.js';
import { truncateChars } from './types.js';
import { sha256Buffer } from './attested-pi-run.js';
import { readFusionCommittedResult, readFusionFailureResult } from './fusion/result-package.js';
import {
  cloneFusionUsage,
  type FusionFailureResultView,
  type FusionUsage,
  type FusionWorkflowId,
} from './fusion/types.js';
import {
  DELEGATE_AUTO_DELIVER_MODES,
  DELEGATE_CAPABILITIES,
  DELEGATE_EXTENSION_MODES,
  DELEGATE_RESULT_TOOL_NAME,
  DELEGATE_TOOL_NAME,
  DelegateError,
  type DelegateAutoDeliverMode,
  type DelegateCapability,
  type DelegateDeliveryMode,
  type DelegateBudgetRouteSource,
  type DelegateExtensionMode,
  type DelegateRoute,
} from './delegate/types.js';
import {
  DELEGATE_INLINE_ANSWER_BYTES,
  DELEGATE_DEFAULT_MAX_TOOL_CALLS,
  DELEGATE_DEFAULT_MAX_TURNS,
  DELEGATE_DEFAULT_TIMEOUT_SECONDS,
} from './delegate/budget.js';
import { resolveDelegateRoute } from './delegate/launch.js';
import {
  decideDelegateDelivery,
  evaluateDelegateTerminal,
  inlineTooLarge,
  prepareDelegateLaunch,
} from './delegate/runner.js';
import { loadDelegateHookContractEvidence } from './delegate/launch.js';
import type { DelegateHookContractEvidence } from './delegate/hook-contract.js';

/**
 * `bg_delegate` and `bg_result` registration.
 *
 * `bg_delegate` launches one background child Pi agent seeded with a frozen
 * projection of the current conversation. `bg_result` retrieves that child's
 * hash-verified answer. They ship together: a delegate without a safe retrieval
 * path would have no way to return its work.
 */

/**
 * Shipped copy of the observed Pi hook-contract evidence.
 *
 * It is produced by executing a real Pi agent loop in
 * `tests/scripted-provider/pi-hook-contract.test.ts`, and a package test asserts
 * the shipped copy is byte-identical to the recorded one, so the runtime gate
 * and the gate that proved it can never drift apart.
 */
const HOOK_EVIDENCE_PATH = fileURLToPath(
  new URL('./delegate/hook-contract-evidence.json', import.meta.url),
);

export const DelegateParams = Type.Object(
  {
    name: Type.String({
      description: 'Short human-readable task name shown in the bg footer dock. Use 2-6 words.',
    }),
    prompt: Type.String({
      description:
        'Authoritative instruction for the delegate. The projected conversation is supporting background only.',
    }),
    route: Type.Optional(
      Type.Object(
        {
          provider: Type.String({ description: 'Exact provider name to pin.' }),
          model: Type.String({ description: 'Exact provider-local model id to pin.' }),
        },
        {
          additionalProperties: false,
          description: 'Explicit route. Defaults to the current model.',
        },
      ),
    ),
    capability: Type.Optional(
      Type.String({
        description: `Capability profile. Only "inspect" (read/search/list, no shell, no writes, no network, no recursion) is supported.`,
      }),
    ),
    extensionMode: Type.Optional(
      Type.String({
        description:
          'Extension discovery: isolated | ambient. Default isolated. Ambient is for extension-registered providers and executes arbitrary discovered extension code, weakening process isolation.',
      }),
    ),
    maxTurns: Type.Optional(
      Type.Number({
        description: `Maximum agent turns. Default ${String(DELEGATE_DEFAULT_MAX_TURNS)}.`,
      }),
    ),
    maxToolCalls: Type.Optional(
      Type.Number({
        description: `Maximum tool calls. Default ${String(DELEGATE_DEFAULT_MAX_TOOL_CALLS)}.`,
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({
        description: `Wall-clock timeout. Default ${String(DELEGATE_DEFAULT_TIMEOUT_SECONDS)}.`,
      }),
    ),
    autoDeliver: Type.Optional(
      Type.String({
        description:
          'Whether the completion notification carries the answer: never | when_small | always. Default never; retrieve with bg_result.',
      }),
    ),
    notifyOnCompletion: Type.Optional(
      Type.Boolean({ description: 'Deliver the durable terminal notification. Default true.' }),
    ),
    triggerOnCompletion: Type.Optional(
      Type.Boolean({ description: 'Let that notification start a follow-up turn. Default true.' }),
    ),
  },
  { additionalProperties: false },
);

const ResultParams = Type.Object(
  {
    taskId: Type.String({
      description: 'Background delegate or Fusion task id returned by its launch tool.',
    }),
    delivery: Type.Optional(
      Type.String({
        description:
          'inline returns the verified answer text; artifact returns metadata plus the artifact reference. Oversized answers are never truncated.',
      }),
    ),
  },
  { additionalProperties: false },
);

type DelegateParamsValue = Static<typeof DelegateParams>;
type ResultParamsValue = Static<typeof ResultParams>;

const DELEGATE_PARAM_KEYS = new Set([
  'name',
  'prompt',
  'route',
  'capability',
  'extensionMode',
  'maxTurns',
  'maxToolCalls',
  'timeoutSeconds',
  'autoDeliver',
  'notifyOnCompletion',
  'triggerOnCompletion',
]);

export interface DelegateLaunchDetails {
  schema_version: 'unipi-background-tasks.delegate-launch.v1';
  task: BgTaskSnapshot;
  route: { provider: string; model: string; qualified_id: string; origin: string };
  child_session_id: string;
  artifact_dir: string;
  seed_sha256: string;
  seed_utf8_bytes: number;
  budget: DelegateBudgetRouteSource;
  extension_mode: DelegateExtensionMode;
  auto_deliver: DelegateAutoDeliverMode;
  notify_on_completion: boolean;
  trigger_on_completion: boolean;
}

export interface FusionBackgroundResultDetails {
  schema_version: 'unipi-background-tasks.fusion-result-view.v1';
  task_id: string;
  state: 'running' | 'committed' | 'failed' | 'cancelled';
  delivery: DelegateDeliveryMode | 'none';
  workflow: FusionWorkflowId;
  artifact_dir: string;
  answer_bytes?: number | undefined;
  answer_sha256?: string | undefined;
  usage_delivered?: boolean | undefined;
  answer?: { present: false; reason: 'run_did_not_commit' } | undefined;
  summary_status?: FusionFailureResultView['summary_status'] | undefined;
  failure_summary_ref?: FusionFailureResultView['failure_summary_ref'] | undefined;
  failure?: FusionFailureResultView['failure'] | undefined;
  progress?: FusionFailureResultView['progress'] | undefined;
  usage_so_far?: FusionFailureResultView['usage_so_far'] | undefined;
  attempts?: FusionFailureResultView['attempts'] | undefined;
  evidence_artifacts?: FusionFailureResultView['evidence_artifacts'] | undefined;
  remediation_ids?: FusionFailureResultView['remediation_ids'] | undefined;
  summary_unavailable_reason?: FusionFailureResultView['summary_unavailable_reason'] | undefined;
}

export type BackgroundResultDetails = DelegateResultDetails | FusionBackgroundResultDetails;

export interface DelegateResultDetails {
  schema_version: 'unipi-background-tasks.delegate-result-view.v1';
  task_id: string;
  state: 'running' | 'committed' | 'failed' | 'cancelled';
  delivery: DelegateDeliveryMode | 'none';
  route?: { provider: string; model: string } | undefined;
  budget?: DelegateBudgetRouteSource | undefined;
  extension_mode?: DelegateExtensionMode | undefined;
  answer_bytes?: number | undefined;
  answer_sha256?: string | undefined;
  turns?: number | undefined;
  tool_calls?: number | undefined;
  usage?: { status: string } | undefined;
  artifact_dir?: string | undefined;
  error_code?: string | undefined;
}

function textContent(text: string) {
  return [{ type: 'text' as const, text }];
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireCapability(value: unknown): DelegateCapability {
  if (value === undefined) return 'inspect';
  if (value === 'inspect') return 'inspect';
  throw new DelegateError(
    `bg_delegate capability must be one of ${DELEGATE_CAPABILITIES.join(', ')}. Writable profiles are deliberately out of scope in this version.`,
    { code: 'invalid_arguments', childCreated: false },
  );
}

function requireExtensionMode(value: unknown): DelegateExtensionMode {
  if (value === undefined) return 'isolated';
  if (value === 'isolated' || value === 'ambient') return value;
  throw new DelegateError(
    `bg_delegate extensionMode must be one of ${DELEGATE_EXTENSION_MODES.join(', ')}`,
    { code: 'invalid_arguments', childCreated: false },
  );
}

function requireAutoDeliver(value: unknown): DelegateAutoDeliverMode {
  if (value === undefined) return 'never';
  if (value === 'never' || value === 'when_small' || value === 'always') return value;
  throw new DelegateError(
    `bg_delegate autoDeliver must be one of ${DELEGATE_AUTO_DELIVER_MODES.join(', ')}`,
    { code: 'invalid_arguments', childCreated: false },
  );
}

function requireDelivery(value: unknown): DelegateDeliveryMode | undefined {
  if (value === undefined) return undefined;
  if (value === 'inline' || value === 'artifact') return value;
  throw new DelegateError('bg_result delivery must be inline or artifact', {
    code: 'invalid_arguments',
    childCreated: false,
  });
}

function requireRoute(value: unknown): DelegateRoute | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new DelegateError('bg_delegate route must be an object', {
      code: 'invalid_arguments',
      childCreated: false,
    });
  }
  const provider = value['provider'];
  const model = value['model'];
  if (typeof provider !== 'string' || provider.length === 0)
    throw new DelegateError('bg_delegate route.provider must be a non-empty string', {
      code: 'invalid_arguments',
      childCreated: false,
    });
  if (typeof model !== 'string' || model.length === 0)
    throw new DelegateError('bg_delegate route.model must be a non-empty string', {
      code: 'invalid_arguments',
      childCreated: false,
    });
  return { provider, model };
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  )
    throw new DelegateError(`bg_delegate ${label} must be a positive integer`, {
      code: 'invalid_arguments',
      childCreated: false,
    });
  return value;
}

export interface DelegateExtensionDependencies {
  startDelegateTask: (ctx: ExtensionContext, options: StartDelegateTaskOptions) => Promise<BgTask>;
  snapshot: (task: BgTask) => BgTaskSnapshot;
  resolveTask: (idOrPrefix: string) => BgTask;
  claimFusionUsage: (task: BgTask) => Promise<boolean>;
  /** Overridable so tests can supply observed evidence without touching disk. */
  loadHookEvidence?: (() => Promise<DelegateHookContractEvidence>) | undefined;
}

async function defaultHookEvidence(): Promise<DelegateHookContractEvidence> {
  let raw: string;
  try {
    raw = await readFile(HOOK_EVIDENCE_PATH, 'utf8');
  } catch (error) {
    throw new DelegateError(
      `bg_delegate cannot verify the Pi hook contract: the recorded evidence at ${HOOK_EVIDENCE_PATH} is unreadable (${error instanceof Error ? error.message : String(error)}). No child was created.`,
      {
        code: 'delegate_hook_contract_unsupported',
        childCreated: false,
        remediation: [
          'Run the Pi hook characterisation gate to regenerate the evidence for this Pi build.',
          'The guard is never bypassed when its evidence is missing.',
        ],
      },
    );
  }
  return loadDelegateHookContractEvidence(raw);
}

export function registerDelegateExtension(
  pi: ExtensionAPI,
  deps: DelegateExtensionDependencies,
): void {
  const loadEvidence = deps.loadHookEvidence ?? defaultHookEvidence;

  pi.registerTool<typeof DelegateParams, DelegateLaunchDetails>({
    name: DELEGATE_TOOL_NAME,
    label: 'Background Delegate',
    description:
      'Launch one background Pi agent seeded with a frozen projection of the current conversation, then return a launch receipt immediately. The child has its own session, a route pinned at launch that is never substituted, and read-only tools. Extension discovery is isolated by default; ambient mode supports extension-registered providers but executes arbitrary discovered extension code. Retrieve its verified answer with bg_result.',
    promptSnippet:
      'Delegate an investigation to a background agent that already has this conversation as context',
    promptGuidelines: [
      'Use bg_delegate when work should continue in the background and the worker needs what you already know: it is seeded with a projection of this conversation.',
      'The prompt is authoritative. State exactly what you want investigated and what the answer should contain.',
      'The delegate is inspect-only at the model-visible tool boundary: it can read, search, and list files, but cannot run shell commands, edit or write files, use the network, or delegate further.',
      'Extension discovery is isolated by default. Use extensionMode:"ambient" only when the pinned provider is registered by an ambient user/project extension.',
      'Ambient mode executes arbitrary discovered extension code in the child process. Tool allowlists do not sandbox extension code, so ambient mode weakens inspect-only process isolation.',
      'Facts that exist only inside omitted tool output are not available to the delegate. Restate such findings in the prompt.',
      'bg_delegate returns immediately. Do not poll; retrieve the answer with bg_result after the terminal notification arrives.',
    ],
    parameters: DelegateParams,
    prepareArguments(args): DelegateParamsValue {
      if (!isRecord(args))
        throw new DelegateError('bg_delegate arguments must be an object', {
          code: 'invalid_arguments',
          childCreated: false,
        });
      const unknownKeys = Object.keys(args).filter((key) => !DELEGATE_PARAM_KEYS.has(key));
      if (unknownKeys.length > 0) {
        throw new DelegateError(
          `bg_delegate contains unsupported key(s): ${unknownKeys.sort().join(', ')}`,
          { code: 'invalid_arguments', childCreated: false },
        );
      }
      const name = args['name'];
      const prompt = args['prompt'];
      if (typeof name !== 'string' || name.trim().length === 0)
        throw new DelegateError('bg_delegate requires a non-empty name', {
          code: 'invalid_arguments',
          childCreated: false,
        });
      if (typeof prompt !== 'string' || prompt.trim().length === 0)
        throw new DelegateError('bg_delegate requires a non-blank prompt', {
          code: 'invalid_arguments',
          childCreated: false,
        });
      const prepared: DelegateParamsValue = { name, prompt };
      const route = requireRoute(args['route']);
      if (route !== undefined) prepared.route = route;
      prepared.capability = requireCapability(args['capability']);
      prepared.extensionMode = requireExtensionMode(args['extensionMode']);
      prepared.autoDeliver = requireAutoDeliver(args['autoDeliver']);
      const maxTurns = optionalPositiveInteger(args['maxTurns'], 'maxTurns');
      if (maxTurns !== undefined) prepared.maxTurns = maxTurns;
      const maxToolCalls = optionalPositiveInteger(args['maxToolCalls'], 'maxToolCalls');
      if (maxToolCalls !== undefined) prepared.maxToolCalls = maxToolCalls;
      const timeoutSeconds = optionalPositiveInteger(args['timeoutSeconds'], 'timeoutSeconds');
      if (timeoutSeconds !== undefined) prepared.timeoutSeconds = timeoutSeconds;
      const notify = args['notifyOnCompletion'];
      if (typeof notify === 'boolean') prepared.notifyOnCompletion = notify;
      const trigger = args['triggerOnCompletion'];
      if (typeof trigger === 'boolean') prepared.triggerOnCompletion = trigger;
      return prepared;
    },
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const capability = requireCapability(params.capability);
      const extensionMode = requireExtensionMode(params.extensionMode);
      const autoDeliver = requireAutoDeliver(params.autoDeliver);
      const hookEvidence = await loadEvidence();
      const route = resolveDelegateRoute({
        requested: params.route,
        currentModel:
          ctx.model === undefined
            ? undefined
            : {
                provider: ctx.model.provider,
                id: ctx.model.id,
                contextWindow: ctx.model.contextWindow,
              },
        availableModels: ctx.modelRegistry.getAll().map((model) => ({
          provider: model.provider,
          id: model.id,
          contextWindow: model.contextWindow,
        })),
        thinkingLevel: pi.getThinkingLevel(),
      });

      const prepared = await prepareDelegateLaunch({
        ctx: {
          cwd: ctx.cwd,
          sessionManager: ctx.sessionManager,
          getSystemPrompt: () => ctx.getSystemPrompt(),
        },
        toolCallId,
        prompt: params.prompt,
        capability,
        extensionMode,
        route,
        limitOverrides: {
          maxTurns: params.maxTurns,
          maxToolCalls: params.maxToolCalls,
          timeoutSeconds: params.timeoutSeconds,
        },
        hookEvidence,
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
        autoDeliver,
      });

      const launchOptions: StartDelegateTaskOptions = {
        name: params.name,
        argv: prepared.argv,
        stdinBytes: prepared.stdinBytes,
        env: prepared.env,
        facts: prepared.facts,
        notifyOnCompletion: params.notifyOnCompletion ?? true,
        triggerOnCompletion: params.triggerOnCompletion ?? true,
        timeoutSeconds: prepared.preflight.limits.timeout_seconds,
      };
      const task = await deps.startDelegateTask(ctx, launchOptions);

      const details: DelegateLaunchDetails = {
        schema_version: 'unipi-background-tasks.delegate-launch.v1',
        task: deps.snapshot(task),
        route: {
          provider: route.provider,
          model: route.model,
          qualified_id: route.qualified_id,
          origin: route.origin,
        },
        child_session_id: prepared.preflight.childSessionId,
        artifact_dir: prepared.facts.artifactDir,
        seed_sha256: prepared.facts.seedSha256,
        seed_utf8_bytes: Buffer.byteLength(prepared.preflight.seed.serialized, 'utf8'),
        budget: prepared.facts.budget,
        extension_mode: extensionMode,
        auto_deliver: autoDeliver,
        notify_on_completion: launchOptions.notifyOnCompletion,
        trigger_on_completion: launchOptions.triggerOnCompletion,
      };
      return {
        content: textContent(
          [
            `Started delegate ${params.name} (${task.id})`,
            `Route pinned: ${route.qualified_id} (${route.origin}); it is never substituted.`,
            `Child session: ${prepared.preflight.childSessionId} (separate from this session)`,
            `Artifacts: ${prepared.facts.artifactDir}`,
            `Seed: ${String(Buffer.byteLength(prepared.preflight.seed.serialized, 'utf8'))} bytes, sha256 ${prepared.facts.seedSha256}`,
            `Child prompt: ${String(prepared.preflight.plan.child_prompt_utf8_bytes)} bytes; launch estimate ${String(prepared.preflight.plan.launch_input_tokens_upper_bound)} / ${String(prepared.preflight.plan.route.allowed_input_tokens)} allowed input tokens; protected retained-growth runway ${String(prepared.preflight.plan.retained_growth_budget_tokens)} tokens.`,
            `Estimator: family ${prepared.facts.budget.family}, source ${prepared.facts.budget.rate_source.source}, rate ${String(prepared.facts.budget.rate_source.effective_rate_bytes_per_token_x100)}/100 B/tok + ${String(prepared.facts.budget.rate_source.affine_f_tokens)} tokens${prepared.facts.budget.rate_source.warning === null ? '' : `; warning: ${prepared.facts.budget.rate_source.warning}`}`,
            `Capability: ${capability} (read/search/list only)`,
            `Extension mode: ${extensionMode}${extensionMode === 'ambient' ? ' — WARNING: arbitrary discovered extension code executes in the child; the tool allowlist does not sandbox it, so inspect-only process isolation is weakened.' : ' (ambient extension discovery disabled)'}`,
            `Limits: ${String(prepared.preflight.limits.max_turns)} turns, ${String(prepared.preflight.limits.max_tool_calls)} tool calls, ${String(prepared.preflight.limits.timeout_seconds)}s`,
            `Auto-deliver: ${autoDeliver}`,
            launchOptions.notifyOnCompletion
              ? `Terminal notification: enabled.${launchOptions.triggerOnCompletion ? ' It will start a follow-up turn.' : ' It will not start a turn.'}`
              : 'Terminal notification: disabled.',
            `Retrieve the verified answer with ${DELEGATE_RESULT_TOOL_NAME}({taskId:"${task.id}"}). Do not poll.`,
          ].join('\n'),
        ),
        details,
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('bg_delegate '))}${theme.fg('muted', truncateChars(args.name, 60))}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details;
      return new Text(
        `${theme.fg('success', '✓ delegated')} ${theme.fg('accent', details.task.id)}\n${theme.fg('dim', `route ${details.route.qualified_id} · extensions ${details.extension_mode} · seed ${String(details.seed_utf8_bytes)}B · ${details.artifact_dir}`)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool<typeof ResultParams, BackgroundResultDetails>({
    name: DELEGATE_RESULT_TOOL_NAME,
    label: 'Background Result',
    description:
      'Retrieve a hash-verified result from a bg_delegate or background Fusion task. Never blocks: a running task returns a typed not-ready result. Oversized answers are never truncated.',
    promptSnippet: 'Retrieve the verified answer from a completed delegate or Fusion task',
    promptGuidelines: [
      'Call bg_result once the delegate or Fusion terminal notification has arrived. It never blocks and must not be polled.',
      'A not-ready result means the task is still running; end the turn and wait for the notification.',
    ],
    parameters: ResultParams,
    prepareArguments(args): ResultParamsValue {
      if (!isRecord(args))
        throw new DelegateError('bg_result arguments must be an object', {
          code: 'invalid_arguments',
          childCreated: false,
        });
      const taskId = args['taskId'];
      if (typeof taskId !== 'string' || taskId.trim().length === 0)
        throw new DelegateError('bg_result requires taskId', {
          code: 'invalid_arguments',
          childCreated: false,
        });
      const prepared: ResultParamsValue = { taskId };
      const delivery = requireDelivery(args['delivery']);
      if (delivery !== undefined) prepared.delivery = delivery;
      return prepared;
    },
    async execute(_toolCallId, params) {
      let task: BgTask;
      try {
        task = deps.resolveTask(params.taskId);
      } catch (error) {
        throw new DelegateError(
          `bg_result does not know task ${params.taskId}: ${error instanceof Error ? error.message : String(error)}`,
          { code: 'task_unknown', childCreated: false },
        );
      }
      const fusion = task.fusion;
      if (fusion !== undefined) {
        const requestedDelivery = requireDelivery(params.delivery);
        if (task.status === 'running') {
          const details: FusionBackgroundResultDetails = {
            schema_version: 'unipi-background-tasks.fusion-result-view.v1',
            task_id: task.id,
            state: 'running',
            delivery: 'none',
            workflow: fusion.workflow,
            artifact_dir: fusion.artifactDir,
          };
          return {
            content: textContent(
              `Fusion ${task.id} is still running. bg_result never blocks. End this turn; the terminal notification will wake you, then call bg_result again.`,
            ),
            details,
          };
        }
        if (task.status !== 'completed' || fusion.outcome?.status !== 'committed') {
          const terminal = await readFusionFailureResult({
            artifactDirAbs: fusion.artifactDirAbs,
            artifactDir: fusion.artifactDir,
            runId: fusion.runId,
            workflow: fusion.workflow,
          });
          const state =
            fusion.outcome?.status === 'cancelled' || task.status === 'killed'
              ? 'cancelled'
              : 'failed';
          const details: FusionBackgroundResultDetails = {
            schema_version: 'unipi-background-tasks.fusion-result-view.v1',
            task_id: task.id,
            state,
            delivery: 'none',
            workflow: fusion.workflow,
            artifact_dir: fusion.artifactDir,
            answer: terminal.answer,
            summary_status: terminal.summary_status,
            ...(terminal.failure_summary_ref === undefined
              ? {}
              : { failure_summary_ref: terminal.failure_summary_ref }),
            ...(terminal.failure === undefined ? {} : { failure: terminal.failure }),
            ...(terminal.progress === undefined ? {} : { progress: terminal.progress }),
            ...(terminal.usage_so_far === undefined ? {} : { usage_so_far: terminal.usage_so_far }),
            ...(terminal.attempts === undefined ? {} : { attempts: terminal.attempts }),
            ...(terminal.evidence_artifacts === undefined
              ? {}
              : { evidence_artifacts: terminal.evidence_artifacts }),
            ...(terminal.remediation_ids === undefined
              ? {}
              : { remediation_ids: terminal.remediation_ids }),
            ...(terminal.summary_unavailable_reason === undefined
              ? {}
              : { summary_unavailable_reason: terminal.summary_unavailable_reason }),
          };
          return {
            content: textContent(
              `Fusion ${task.id} ${state}; no answer was committed. Terminal evidence status: ${terminal.summary_status}. Delivery is none; use only the manifest-bound artifact references in details.`,
            ),
            details,
          };
        }
        const verified = await readFusionCommittedResult({
          artifactDirAbs: fusion.artifactDirAbs,
          artifactDir: fusion.artifactDir,
          runId: fusion.runId,
          workflow: fusion.workflow,
        });
        const answerBytes = Buffer.byteLength(verified.mergedText, 'utf8');
        const answerSha256 = sha256Buffer(Buffer.from(verified.mergedText, 'utf8'));
        const useArtifact =
          requestedDelivery === 'artifact' ||
          (requestedDelivery === undefined && answerBytes > DELEGATE_INLINE_ANSWER_BYTES);
        if (requestedDelivery === 'inline' && answerBytes > DELEGATE_INLINE_ANSWER_BYTES) {
          throw new Error(
            `Fusion result ${task.id} is ${String(answerBytes)} bytes, above the ${String(DELEGATE_INLINE_ANSWER_BYTES)}-byte inline limit. Use delivery:"artifact"; nothing was truncated.`,
          );
        }
        const usageDelivered = await deps.claimFusionUsage(task);
        const details: FusionBackgroundResultDetails = {
          schema_version: 'unipi-background-tasks.fusion-result-view.v1',
          task_id: task.id,
          state: 'committed',
          delivery: useArtifact ? 'artifact' : 'inline',
          workflow: fusion.workflow,
          artifact_dir: fusion.artifactDir,
          answer_bytes: answerBytes,
          answer_sha256: answerSha256,
          usage_delivered: usageDelivered,
        };
        const header = [
          `Fusion ${task.id} completed (${fusion.workflow}).`,
          `Answer: ${String(answerBytes)} bytes, ${answerSha256} (verified).`,
          `Artifacts: ${fusion.artifactDir}`,
          usageDelivered
            ? 'Usage: attached to this retrieval exactly once.'
            : 'Usage: already attached by an earlier retrieval; not counted again.',
        ].join('\n');
        const result = useArtifact
          ? {
              content: textContent(
                `${header}\nDelivery: artifact. The complete answer is ${fusion.artifactDir}/merged.md; it was not truncated.`,
              ),
              details,
            }
          : { content: textContent(`${header}\n\n${verified.mergedText}`), details };
        if (!usageDelivered) return result;
        const resultWithUsage: typeof result & { usage: FusionUsage } = {
          ...result,
          usage: cloneFusionUsage(verified.details.usage),
        };
        return resultWithUsage;
      }

      const facts = task.delegate;
      if (facts === undefined) {
        throw new DelegateError(
          `bg_result task ${task.id} has no retrievable delegate or Fusion result; use bg_logs for ordinary background tasks`,
          { code: 'task_unknown', childCreated: false },
        );
      }
      if (task.status === 'running') {
        const details: DelegateResultDetails = {
          schema_version: 'unipi-background-tasks.delegate-result-view.v1',
          task_id: task.id,
          state: 'running',
          delivery: 'none',
          artifact_dir: facts.artifactDir,
          budget: facts.budget,
          extension_mode: facts.extensionMode,
        };
        return {
          content: textContent(
            `Delegate ${task.id} is still running. This is not an error and bg_result never blocks. End this turn; the terminal notification will wake you, then call bg_result again.`,
          ),
          details,
        };
      }

      const terminal = await evaluateDelegateTerminal({
        artifactDirAbs: facts.artifactDirAbs,
        taskId: facts.taskId,
        launchNonce: facts.launchNonce,
        seedSha256: facts.seedSha256,
        route: { provider: facts.route.provider, model: facts.route.model },
        taskStatus: task.status === 'completed' ? 'completed' : task.status,
        taskError: task.error,
        taskOutputPath: task.outputPath,
        taskOutputAbsPath: task.outputAbsPath,
      });

      if (terminal.error !== undefined || terminal.result === undefined) {
        const failure =
          terminal.error ??
          new DelegateError(`delegate ${task.id} produced no verified answer`, {
            code: 'result_unavailable',
            childCreated: true,
            taskId: task.id,
            artifactDir: facts.artifactDir,
          });
        throw new Error(failure.describe(), { cause: failure });
      }

      const verified = terminal.result;
      const requestedDelivery = requireDelivery(params.delivery);
      const decision = decideDelegateDelivery(
        verified.package.answer.byte_length,
        requestedDelivery,
      );
      if (requestedDelivery === 'inline' && decision.mode === 'artifact') {
        const failure = inlineTooLarge(
          task.id,
          facts.artifactDir,
          verified.package.answer.byte_length,
        );
        throw new Error(failure.describe(), { cause: failure });
      }

      const details: DelegateResultDetails = {
        schema_version: 'unipi-background-tasks.delegate-result-view.v1',
        task_id: task.id,
        state: 'committed',
        delivery: decision.mode,
        route: verified.package.route,
        budget: facts.budget,
        extension_mode: facts.extensionMode,
        answer_bytes: verified.package.answer.byte_length,
        answer_sha256: verified.package.answer.sha256,
        turns: verified.package.turns,
        tool_calls: verified.package.tool_calls,
        usage: { status: verified.package.usage.status },
        artifact_dir: facts.artifactDir,
      };
      const header = [
        `Delegate ${task.id} completed on ${verified.package.route.provider}/${verified.package.route.model}.`,
        `Answer: ${String(verified.package.answer.byte_length)} bytes, sha256 ${verified.package.answer.sha256} (verified).`,
        `Turns: ${String(verified.package.turns)} · tool calls: ${String(verified.package.tool_calls)} · usage: ${verified.package.usage.status}`,
        `Artifacts: ${facts.artifactDir}`,
        `Estimator: family ${facts.budget.family}, source ${facts.budget.rate_source.source}, rate ${String(facts.budget.rate_source.effective_rate_bytes_per_token_x100)}/100 B/tok + ${String(facts.budget.rate_source.affine_f_tokens)} tokens${facts.budget.rate_source.warning === null ? '' : `; warning: ${facts.budget.rate_source.warning}`}`,
      ].join('\n');
      if (decision.mode === 'artifact') {
        return {
          content: textContent(
            `${header}\nDelivery: artifact (${decision.reason}). The complete verified answer is in ${facts.artifactDir}/result.json. It was not truncated.`,
          ),
          details,
        };
      }
      return { content: textContent(`${header}\n\n${verified.answer}`), details };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('bg_result '))}${theme.fg('accent', args.taskId)}`,
        0,
        0,
      );
    },
    renderResult(result, options: ToolRenderResultOptions, theme: Theme) {
      void options;
      const details = result.details;
      const fusion = details.schema_version === 'unipi-background-tasks.fusion-result-view.v1';
      if (details.state === 'running')
        return new Text(
          theme.fg('warning', `${fusion ? 'fusion' : 'delegate'} ${details.task_id} still running`),
          0,
          0,
        );
      if (fusion && (details.state === 'failed' || details.state === 'cancelled')) {
        return new Text(
          theme.fg('warning', `${details.state} fusion; no committed answer · ${details.summary_status ?? 'unavailable'}`),
          0,
          0,
        );
      }
      return new Text(
        `${theme.fg('success', fusion ? '✓ fusion answer' : '✓ delegate answer')} ${theme.fg('dim', `${String(details.answer_bytes ?? 0)}B · ${details.delivery}`)}`,
        0,
        0,
      );
    },
  });

  pi.on('session_start', () => {
    const active = pi.getActiveTools();
    const missing = [DELEGATE_TOOL_NAME, DELEGATE_RESULT_TOOL_NAME].filter(
      (name) => !active.includes(name),
    );
    if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
  });
}

export { DELEGATE_INLINE_ANSWER_BYTES };
