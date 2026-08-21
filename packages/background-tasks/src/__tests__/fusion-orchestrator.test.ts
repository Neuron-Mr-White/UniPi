import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseJsonText } from '../types.js';
import { FusionOrchestrator, type FusionChildRunner } from '../fusion/orchestrator.js';
import { FusionArtifactStore } from '../fusion/artifacts.js';
import { buildFusionCleanTaskCanonicalInput } from '../fusion/clean-context.js';
import { FUSION_RESEARCH_WORKFLOW } from '../fusion/workflows.js';
import { defaultFusionModelConfig } from '../fusion/config.js';
import {
  FUSION_CANDIDATE_RESEARCH_SYSTEM_PROMPT,
  FUSION_CANDIDATE_SYSTEM_PROMPT,
} from '../fusion/prompts.js';
import {
  FUSION_COMMAND_CONTEXT_POLICY_ID,
  FUSION_CONTEXT_TRANSFORM_ID,
  FUSION_EVALUATION_SCHEMA_VERSION,
  FUSION_INPUT_SCHEMA_VERSION,
  FusionError,
  type FusionCanonicalInputV3,
  type FusionChildRunResult,
  type FusionContextOmissionLedgerV2,
  type FusionEvaluationV1,
  type FusionUsage,
  type ResolvedFusionModel,
  type ResolvedFusionModels,
} from '../fusion/types.js';
import {
  FusionChildRunError,
  buildFusionPiChildArgv,
  type RunPiChildOptions,
} from '../fusion/pi-child.js';
import { emptyLedger } from './helpers/fusion-canonical.js';

const ledger: FusionContextOmissionLedgerV2 = emptyLedger(FUSION_COMMAND_CONTEXT_POLICY_ID);

function resolved(qualifiedId: string, contextWindow = 200_000): ResolvedFusionModel {
  const slash = qualifiedId.indexOf('/');
  const provider = qualifiedId.slice(0, slash);
  const model = qualifiedId.slice(slash + 1);
  return {
    selection: '$current',
    source: 'current',
    provider,
    model,
    qualifiedId,
    thinkingLevel: 'high',
    contextWindow,
    maxOutputTokens: 32_768,
  };
}

function models(): ResolvedFusionModels {
  return {
    candidates: [resolved('p/c1'), resolved('p/c2'), resolved('p/c3')],
    evaluator: resolved('p/eval'),
    merger: resolved('p/merge'),
  };
}

function canonicalInput(text = 'hello'): FusionCanonicalInputV3 {
  return {
    schema_version: FUSION_INPUT_SCHEMA_VERSION,
    cwd: '/tmp/project',
    system_prompt: 'system',
    request: {
      source: 'command',
      authority: 'directive_over_projected_conversation',
      text: 'solve',
      sha256: 'b'.repeat(64),
    },
    conversation_projection: {
      policy: {
        id: FUSION_COMMAND_CONTEXT_POLICY_ID,
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
      },
      branch_filter: {
        id: 'exclude-active-fusion-subtree-v1',
        tool_name: 'fusion_reason',
        tool_call_id: null,
        active_tool_call_leaf_excluded: false,
      },
      entries: [['t', 'u', 0, 0, text]],
      accounting: {
        message_count: 1,
        included_text_entry_count: 1,
        included_user_text_bytes: Buffer.byteLength(text, 'utf8'),
        included_assistant_text_bytes: 0,
        included_image_marker_count: 0,
        empty_text_block_count: 0,
        omitted_run_count: 0,
        omitted_event_count: 0,
        omitted_thinking_bytes: 0,
        omitted_tool_call_count: 0,
        omitted_tool_call_argument_bytes: 0,
        omitted_tool_result_text_count: 0,
        omitted_tool_result_text_bytes: 0,
        omitted_tool_result_image_count: 0,
        omitted_tool_result_image_bytes: 0,
        tool_call_names: [],
        ledger_entry_count: 0,
        ledger_root_sha256: 'a'.repeat(64),
        omission_receipt_utf8_bytes: 0,
      },
    },
  };
}

function evaluation(): FusionEvaluationV1 {
  return {
    schema_version: FUSION_EVALUATION_SCHEMA_VERSION,
    candidate_assessments: [
      {
        candidate_id: 'A',
        summary: 'a',
        strengths: ['a'],
        limitations: ['a'],
        useful_contributions: ['a'],
        risks: ['a'],
      },
      {
        candidate_id: 'B',
        summary: 'b',
        strengths: ['b'],
        limitations: ['b'],
        useful_contributions: ['b'],
        risks: ['b'],
      },
      {
        candidate_id: 'C',
        summary: 'c',
        strengths: ['c'],
        limitations: ['c'],
        useful_contributions: ['c'],
        risks: ['c'],
      },
    ],
    agreements: ['agree'],
    conflicts: [],
    synthesis_plan: {
      must_include: [{ candidate_id: 'A', contribution: 'a' }],
      must_resolve: [],
      must_avoid: [],
    },
  };
}

function childResult(options: RunPiChildOptions, text: string): FusionChildRunResult {
  const result: FusionChildRunResult = {
    stage: options.stage,
    attempt: options.attempt,
    provider: options.model.provider,
    model: options.model.model,
    qualifiedId: options.model.qualifiedId,
    text,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    },
    events: Buffer.from('{"schema_version":"pi-background-tasks.fusion-child-result.v4"}\n'),
    stderr: Buffer.alloc(0),
    exitCode: 0,
    signal: null,
  };
  if (options.slot !== undefined) result.slot = options.slot;
  return result;
}

function observedUsage(totalTokens: number): FusionUsage {
  const costUnit = totalTokens / 1000;
  return {
    input: totalTokens,
    output: totalTokens + 1,
    cacheRead: totalTokens + 2,
    cacheWrite: totalTokens + 3,
    totalTokens,
    cost: {
      input: costUnit,
      output: costUnit * 2,
      cacheRead: costUnit * 3,
      cacheWrite: costUnit * 4,
      total: costUnit * 10,
    },
  };
}

function childRunError(
  options: RunPiChildOptions,
  message: string,
  totalTokens: number,
  code: FusionError['code'] = 'child_exit_failed',
): FusionChildRunError {
  const details = {
    code,
    stage: options.stage,
    attempt: options.attempt,
  };
  const fusionError = new FusionError(
    message,
    options.slot === undefined ? details : { ...details, slot: options.slot },
  );
  return new FusionChildRunError(
    fusionError,
    Buffer.from('{"schema_version":"pi-background-tasks.fusion-child-result.v4"}\n'),
    Buffer.alloc(0),
    Buffer.alloc(0),
    {
      code: code === 'child_exit_failed' ? 1 : null,
      signal: code === 'child_cancelled' ? 'SIGTERM' : null,
    },
    {
      usage: observedUsage(totalTokens),
      provider: options.model.provider,
      model: options.model.model,
      qualifiedId: options.model.qualifiedId,
    },
  );
}

function parseObject(text: string): object {
  const parsed = parseJsonText(text);
  assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed));
  return parsed;
}

function field(record: object, key: string): unknown {
  return Reflect.get(record, key);
}

function objectValue(value: unknown, label: string): object {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value;
}

function objectField(record: object, key: string): object {
  return objectValue(field(record, key), key);
}

function numberField(record: object, key: string): number {
  const value = field(record, key);
  if (typeof value !== 'number') throw new Error(`${key} must be a number`);
  return value;
}

function stringField(record: object, key: string): string {
  const value = field(record, key);
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value;
}

function attemptRecords(manifest: object): object[] {
  const attempts = field(manifest, 'attempts');
  if (!Array.isArray(attempts)) throw new Error('attempts must be an array');
  return attempts.map((attempt, index) => objectValue(attempt, `attempt ${String(index)}`));
}

function usageFromRecord(record: object): FusionUsage {
  const usage = objectField(record, 'usage');
  const cost = objectField(usage, 'cost');
  return {
    input: numberField(usage, 'input'),
    output: numberField(usage, 'output'),
    cacheRead: numberField(usage, 'cacheRead'),
    cacheWrite: numberField(usage, 'cacheWrite'),
    totalTokens: numberField(usage, 'totalTokens'),
    cost: {
      input: numberField(cost, 'input'),
      output: numberField(cost, 'output'),
      cacheRead: numberField(cost, 'cacheRead'),
      cacheWrite: numberField(cost, 'cacheWrite'),
      total: numberField(cost, 'total'),
    },
  };
}

function addExpectedUsage(target: FusionUsage, delta: FusionUsage): void {
  target.input += delta.input;
  target.output += delta.output;
  target.cacheRead += delta.cacheRead;
  target.cacheWrite += delta.cacheWrite;
  target.totalTokens += delta.totalTokens;
  target.cost.input += delta.cost.input;
  target.cost.output += delta.cost.output;
  target.cost.cacheRead += delta.cost.cacheRead;
  target.cost.cacheWrite += delta.cost.cacheWrite;
  target.cost.total += delta.cost.total;
}

function assertCostClose(actual: FusionUsage['cost'], expected: FusionUsage['cost']): void {
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) {
    assert.ok(
      Math.abs(actual[key] - expected[key]) < 1e-12,
      `aggregate cost.${key} must equal attempt sum`,
    );
  }
}

function assertManifestUsageEqualsAttemptSum(manifest: object): void {
  const expected: FusionUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const attempt of attemptRecords(manifest))
    addExpectedUsage(expected, usageFromRecord(attempt));
  const actual = usageFromRecord(manifest);
  assert.deepEqual(
    {
      input: actual.input,
      output: actual.output,
      cacheRead: actual.cacheRead,
      cacheWrite: actual.cacheWrite,
      totalTokens: actual.totalTokens,
    },
    {
      input: expected.input,
      output: expected.output,
      cacheRead: expected.cacheRead,
      cacheWrite: expected.cacheWrite,
      totalTokens: expected.totalTokens,
    },
  );
  assertCostClose(actual.cost, expected.cost);
}

async function failedManifest(root: string, runner: FusionChildRunner): Promise<object> {
  const orchestrator = new FusionOrchestrator({ childRunner: runner });
  const canonical = canonicalInput();
  let thrown: unknown;
  try {
    await orchestrator.run({
      source: 'command',
      cwd: root,
      canonicalInput: canonical,
      canonicalInputSerialized: JSON.stringify(canonical),
        contextLedger: ledger,
      config: defaultFusionModelConfig(),
      models: models(),
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof FusionError);
  assert.ok(thrown.artifactDir, 'failed fusion error must include artifact dir');
  const manifest = parseObject(
    await readFile(join(root, thrown.artifactDir, 'manifest.json'), 'utf8'),
  );
  assert.equal(field(manifest, 'state'), 'failed');
  const artifacts = objectField(manifest, 'artifacts');
  assert.ok(field(artifacts, 'failure-summary.json'), 'failed runs must bind one failure summary');
  return manifest;
}

async function waitForCalls(calls: readonly RunPiChildOptions[], count: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (calls.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${String(count)} child calls`);
}

void describe('fusion orchestrator', () => {
  void it('runs parallel candidates, schema repair, and final merge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-orchestrator-'));
    try {
      const calls: RunPiChildOptions[] = [];
      let releaseCandidates: () => void = () => undefined;
      const candidatesStarted = new Promise<void>((resolve) => {
        releaseCandidates = resolve;
      });
      const runner: FusionChildRunner = async (options) => {
        calls.push(options);
        if (options.stage === 'candidate') {
          if (calls.filter((call) => call.stage === 'candidate').length === 3) releaseCandidates();
          await candidatesStarted;
          return childResult(options, `candidate-${String(options.slot)}`);
        }
        if (options.stage === 'evaluation') {
          if (options.attempt === 1) return childResult(options, '{"not":"valid"}');
          return childResult(options, JSON.stringify(evaluation()));
        }
        assert.match(options.userPrompt, /candidate-/);
        assert.match(options.userPrompt, /synthesis_plan/);
        return childResult(options, 'merged final');
      };
      const orchestrator = new FusionOrchestrator({
        childRunner: runner,
        randomBytes: () => Buffer.from([0, 0, 0, 0]),
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      });
      const canonical = canonicalInput();
      const result = await orchestrator.run({
        source: 'command',
        cwd: root,
        sessionId: 's1',
        canonicalInput: canonical,
        canonicalInputSerialized: JSON.stringify(canonical),
        contextLedger: ledger,
        config: defaultFusionModelConfig(),
        models: models(),
      });
      assert.equal(result.mergedText, 'merged final');
      assert.equal(result.details.evaluator_attempts, 2);
      assert.equal(result.details.usage.totalTokens, 12);
      assertCostClose(result.details.usage.cost, {
        input: 0.06,
        output: 0.12,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.18,
      });
      assert.deepEqual(
        calls.slice(0, 3).map((call) => call.slot),
        [1, 2, 3],
      );
      assert.equal(calls[3]?.stage, 'evaluation');
      assert.equal(calls[4]?.attempt, 2);
      assert.equal(calls[5]?.stage, 'merge');
      const defaultCandidates = calls.filter((call) => call.stage === 'candidate');
      assert.deepEqual(
        defaultCandidates.map((call) => call.capability),
        ['reason', 'reason', 'reason'],
      );
      for (const call of defaultCandidates) {
        assert.equal(call.systemPrompt, FUSION_CANDIDATE_SYSTEM_PROMPT);
        assert.equal(call.toolCallLogPath, undefined);
      }
      assert.deepEqual(
        calls.filter((call) => call.stage !== 'candidate').map((call) => call.capability),
        ['reason', 'reason', 'reason'],
      );
      const candidatePrompts = calls
        .filter((call) => call.stage === 'candidate')
        .map((call) => call.userPrompt);
      assert.equal(candidatePrompts[0], candidatePrompts[1]);
      assert.equal(candidatePrompts[1], candidatePrompts[2]);
      const manifestPath = join(root, result.details.artifact_dir, 'manifest.json');
      const manifest = parseObject(await readFile(manifestPath, 'utf8'));
      assert.equal(field(manifest, 'state'), 'completed');
      const completedArtifacts = objectField(manifest, 'artifacts');
      assert.equal(field(completedArtifacts, 'failure-summary.json'), undefined);
      const attempts = field(manifest, 'attempts');
      assert.ok(Array.isArray(attempts));
      assert.equal(attempts.length, 6);
      const map = field(manifest, 'anonymous_map');
      assert.ok(typeof map === 'object' && map !== null);
      assert.equal(field(map, 'A'), 2);
      assert.equal(field(map, 'B'), 3);
      assert.equal(field(map, 'C'), 1);
      assert.equal(
        await readFile(join(root, result.details.artifact_dir, 'merged.md'), 'utf8'),
        'merged final',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('rejects validation accounting from non-validation evaluators instead of replacing the merge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-accounting-scope-'));
    try {
      const calls: RunPiChildOptions[] = [];
      const runner: FusionChildRunner = async (options) => {
        calls.push(options);
        if (options.stage === 'candidate') return childResult(options, `candidate-${String(options.slot)}`);
        if (options.stage === 'evaluation') {
          const value =
            options.attempt === 1
              ? {
                  ...evaluation(),
                  validation_accounting: { findings: [], decisions: [], groups: [] },
                }
              : evaluation();
          return childResult(options, JSON.stringify(value));
        }
        return childResult(options, 'normal merged answer');
      };
      const canonical = canonicalInput();
      const result = await new FusionOrchestrator({ childRunner: runner }).run({
        source: 'command',
        cwd: root,
        canonicalInput: canonical,
        canonicalInputSerialized: JSON.stringify(canonical),
        contextLedger: ledger,
        config: defaultFusionModelConfig(),
        models: models(),
      });
      assert.equal(result.mergedText, 'normal merged answer');
      assert.equal(result.details.evaluator_attempts, 2);
      assert.equal(
        calls.filter((call) => call.stage === 'evaluation').length,
        2,
        'unexpected validation accounting must trigger schema repair',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('keeps evaluator and merger reasoning-only when candidates research', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-orchestrator-capability-'));
    try {
      const calls: RunPiChildOptions[] = [];
      const runner: FusionChildRunner = async (options) => {
        calls.push(options);
        if (options.stage === 'evaluation')
          return childResult(options, JSON.stringify(evaluation()));
        if (options.stage === 'merge') return childResult(options, 'merged final');
        return childResult(options, `candidate-${String(options.slot)}`);
      };
      const orchestrator = new FusionOrchestrator({
        childRunner: runner,
        randomBytes: () => Buffer.from([0, 0, 0, 0]),
      });
      const built = buildFusionCleanTaskCanonicalInput({
        cwd: root,
        source: 'tool',
        workflow: 'research',
        request: 'research declared source',
        declaredSources: [{ url: 'https://example.com/source', purpose: 'unit' }],
      });
      await orchestrator.run({
        source: 'tool',
        cwd: root,
        canonicalInput: built.input,
        canonicalInputSerialized: built.serialized,
        config: defaultFusionModelConfig(),
        models: models(),
        profile: FUSION_RESEARCH_WORKFLOW,
      });
      const candidateCalls = calls.filter((call) => call.stage === 'candidate');
      assert.deepEqual(
        candidateCalls.map((call) => call.capability),
        ['research', 'research', 'research'],
      );
      assert.deepEqual(
        candidateCalls.map((call) => call.systemPrompt),
        [
          FUSION_CANDIDATE_RESEARCH_SYSTEM_PROMPT,
          FUSION_CANDIDATE_RESEARCH_SYSTEM_PROMPT,
          FUSION_CANDIDATE_RESEARCH_SYSTEM_PROMPT,
        ],
      );
      assert.notEqual(candidateCalls[0]?.systemPrompt, FUSION_CANDIDATE_SYSTEM_PROMPT);
      for (const [index, call] of candidateCalls.entries()) {
        assert.match(
          (call.toolCallLogPath ?? '').replaceAll('\\', '/'),
          new RegExp(`candidate-${String(index + 1)}\\.attempt-1\\.tool-calls\\.jsonl$`),
        );
      }
      const evaluationCalls = calls.filter((call) => call.stage === 'evaluation');
      const mergeCalls = calls.filter((call) => call.stage === 'merge');
      assert.deepEqual(evaluationCalls.map((call) => call.capability), ['reason']);
      assert.deepEqual(mergeCalls.map((call) => call.capability), ['reason']);
      assert.deepEqual(evaluationCalls.map((call) => call.toolCallLogPath), [undefined]);
      assert.deepEqual(mergeCalls.map((call) => call.toolCallLogPath), [undefined]);
      for (const call of [...evaluationCalls, ...mergeCalls]) {
        const argv = buildFusionPiChildArgv(
          call.model,
          call.systemPrompt,
          'extension.js',
          call.capability,
        );
        assert.ok(argv.includes('--no-tools'));
        assert.equal(argv.includes('--no-builtin-tools'), false);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('does not launch candidates when the workflow signal is already aborted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-orchestrator-abort-'));
    try {
      const calls: RunPiChildOptions[] = [];
      const controller = new AbortController();
      controller.abort();
      const orchestrator = new FusionOrchestrator({
        childRunner: async (options) => {
          calls.push(options);
          return childResult(options, 'unexpected');
        },
      });
      const canonical = canonicalInput();
      await assert.rejects(
        orchestrator.run({
          source: 'tool',
          cwd: root,
          canonicalInput: canonical,
          canonicalInputSerialized: JSON.stringify(canonical),
        contextLedger: ledger,
          config: defaultFusionModelConfig(),
          models: models(),
          signal: controller.signal,
        }),
        /cancelled before launch/,
      );
      assert.equal(calls.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('writes one manifest-bound summary for a stored cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-orchestrator-cancel-summary-'));
    try {
      const controller = new AbortController();
      controller.abort();
      const canonical = canonicalInput();
      let thrown: unknown;
      try {
        await new FusionOrchestrator().run({
          source: 'tool',
          cwd: root,
          canonicalInput: canonical,
          canonicalInputSerialized: JSON.stringify(canonical),
          contextLedger: ledger,
          config: defaultFusionModelConfig(),
          models: models(),
          signal: controller.signal,
        });
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown instanceof FusionError);
      assert.equal(thrown.code, 'child_cancelled');
      assert.ok(thrown.artifactDir);
      const manifest = parseObject(
        await readFile(join(root, thrown.artifactDir, 'manifest.json'), 'utf8'),
      );
      assert.equal(field(manifest, 'state'), 'cancelled');
      assert.ok(field(objectField(manifest, 'artifacts'), 'failure-summary.json'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('cancels sibling candidates on first failure and never degrades to evaluation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-orchestrator-fail-'));
    try {
      const calls: RunPiChildOptions[] = [];
      const runner: FusionChildRunner = async (options) => {
        calls.push(options);
        if (options.stage !== 'candidate') return childResult(options, 'unexpected later stage');
        if (options.slot === 1) {
          await waitForCalls(calls, 3);
          throw new FusionError('candidate one failed', {
            code: 'child_exit_failed',
            stage: 'candidate',
            slot: 1,
            attempt: 1,
          });
        }
        const slot = options.slot;
        if (slot === undefined) throw new Error('candidate slot is required');
        await new Promise<void>((_resolve, reject) => {
          const signal = options.signal;
          if (signal?.aborted === true) {
            reject(
              new FusionError('candidate cancelled', {
                code: 'child_cancelled',
                stage: 'candidate',
                slot,
                attempt: 1,
              }),
            );
            return;
          }
          signal?.addEventListener(
            'abort',
            () => {
              reject(
                new FusionError('candidate cancelled', {
                  code: 'child_cancelled',
                  stage: 'candidate',
                  slot,
                  attempt: 1,
                }),
              );
            },
            { once: true },
          );
        });
        return childResult(options, 'unreachable');
      };
      const orchestrator = new FusionOrchestrator({ childRunner: runner });
      const canonical = canonicalInput();
      await assert.rejects(
        orchestrator.run({
          source: 'tool',
          cwd: root,
          canonicalInput: canonical,
          canonicalInputSerialized: JSON.stringify(canonical),
        contextLedger: ledger,
          config: defaultFusionModelConfig(),
          models: models(),
        }),
        /candidate one failed/,
      );
      assert.equal(calls.filter((call) => call.stage === 'candidate').length, 3);
      assert.equal(
        calls.some((call) => call.stage === 'evaluation' || call.stage === 'merge'),
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('aggregates observed usage exactly once for failed and cancelled candidate attempts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-orchestrator-candidate-usage-'));
    try {
      const calls: RunPiChildOptions[] = [];
      const runner: FusionChildRunner = async (options) => {
        calls.push(options);
        if (options.stage !== 'candidate') return childResult(options, 'unexpected later stage');
        if (options.slot === 1) {
          await waitForCalls(calls, 3);
          throw childRunError(options, 'candidate one failed after usage', 5);
        }
        const slot = options.slot;
        if (slot === undefined) throw new Error('candidate slot is required');
        await new Promise<void>((_resolve, reject) => {
          const failCancelled = () => {
            reject(
              childRunError(
                options,
                `candidate ${String(slot)} cancelled after usage`,
                slot === 2 ? 7 : 11,
                'child_cancelled',
              ),
            );
          };
          if (options.signal?.aborted === true) {
            failCancelled();
            return;
          }
          options.signal?.addEventListener('abort', failCancelled, { once: true });
        });
        return childResult(options, 'unreachable');
      };
      const manifest = await failedManifest(root, runner);
      const attempts = attemptRecords(manifest);
      assert.equal(attempts.length, 3);
      assert.equal(
        attempts.filter((attempt) => stringField(attempt, 'stage') === 'candidate').length,
        3,
      );
      assert.equal(
        attempts.filter((attempt) => stringField(attempt, 'status') === 'cancelled').length,
        2,
      );
      assertManifestUsageEqualsAttemptSum(manifest);
      assert.equal(numberField(objectField(manifest, 'usage'), 'totalTokens'), 23);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('aggregates observed usage exactly once for failed evaluator, repair, and merger attempts', async () => {
    const cases: Array<{ name: string; expectedTotalTokens: number; runner: FusionChildRunner }> = [
      {
        name: 'evaluator',
        expectedTotalTokens: 19,
        runner: async (options) => {
          if (options.stage === 'candidate')
            return childResult(options, `candidate-${String(options.slot)}`);
          if (options.stage === 'evaluation')
            throw childRunError(options, 'evaluator failed after usage', 13);
          return childResult(options, 'unexpected merge');
        },
      },
      {
        name: 'repair',
        expectedTotalTokens: 25,
        runner: async (options) => {
          if (options.stage === 'candidate')
            return childResult(options, `candidate-${String(options.slot)}`);
          if (options.stage === 'evaluation' && options.attempt === 1)
            return childResult(options, '{"not":"valid"}');
          if (options.stage === 'evaluation')
            throw childRunError(options, 'repair failed after usage', 17);
          return childResult(options, 'unexpected merge');
        },
      },
      {
        name: 'merger',
        expectedTotalTokens: 27,
        runner: async (options) => {
          if (options.stage === 'candidate')
            return childResult(options, `candidate-${String(options.slot)}`);
          if (options.stage === 'evaluation')
            return childResult(options, JSON.stringify(evaluation()));
          throw childRunError(options, 'merge failed after usage', 19);
        },
      },
    ];
    for (const item of cases) {
      const root = await mkdtemp(join(tmpdir(), `pi-fusion-orchestrator-${item.name}-usage-`));
      try {
        const manifest = await failedManifest(root, item.runner);
        assertManifestUsageEqualsAttemptSum(manifest);
        assert.equal(
          numberField(objectField(manifest, 'usage'), 'totalTokens'),
          item.expectedTotalTokens,
          item.name,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  void it('persists usage and bounded schema errors when both evaluator attempts fail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-orchestrator-eval-fail-'));
    try {
      const runner: FusionChildRunner = async (options) => {
        if (options.stage === 'candidate')
          return childResult(options, `candidate-${String(options.slot)}`);
        if (options.stage === 'evaluation')
          return childResult(
            options,
            JSON.stringify({ schema_version: FUSION_EVALUATION_SCHEMA_VERSION, bad: true }),
          );
        return childResult(options, 'unexpected merge');
      };
      const orchestrator = new FusionOrchestrator({ childRunner: runner });
      const canonical = canonicalInput();
      let thrown: unknown;
      try {
        await orchestrator.run({
          source: 'command',
          cwd: root,
          canonicalInput: canonical,
          canonicalInputSerialized: JSON.stringify(canonical),
        contextLedger: ledger,
          config: defaultFusionModelConfig(),
          models: models(),
        });
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown instanceof FusionError);
      assert.equal(thrown.code, 'evaluation_invalid');
      assert.match(thrown.message, /schema repair failed/);
      assert.doesNotMatch(thrown.message, /unexpected merge/);
      const artifactDir = thrown.artifactDir;
      assert.ok(artifactDir);
      const manifest = parseObject(
        await readFile(join(root, artifactDir, 'manifest.json'), 'utf8'),
      );
      assert.equal(field(manifest, 'state'), 'failed');
      const usageRecord = field(manifest, 'usage');
      assert.ok(typeof usageRecord === 'object' && usageRecord !== null);
      assert.equal(field(usageRecord, 'totalTokens'), 10);
      const attempts = field(manifest, 'attempts');
      assert.ok(Array.isArray(attempts));
      assert.equal(attempts.length, 5);
      for (const attempt of attempts) {
        assert.ok(typeof attempt === 'object' && attempt !== null);
        assert.ok(typeof field(attempt, 'usage') === 'object');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('reports durable completed, failed, and not-started stage truth on late budget failures', async () => {
    const cases: Array<{
      name: string;
      models: ResolvedFusionModels;
      runner: FusionChildRunner;
      blockedStage: 'evaluation' | 'merge';
      expectedEvaluationStatus: 'not_started' | 'incomplete' | 'completed';
      expectedUsage: number;
    }> = [
      {
        name: 'evaluation launch',
        models: {
          ...models(),
          evaluator: resolved('p/eval', 180_000),
        },
        runner: (options) =>
          Promise.resolve(
            childResult(
              options,
              options.stage === 'candidate' ? 'c'.repeat(48_000) : 'unexpected downstream child',
            ),
          ),
        blockedStage: 'evaluation',
        expectedEvaluationStatus: 'not_started',
        expectedUsage: 6,
      },
      {
        name: 'evaluation repair launch',
        models: {
          ...models(),
          evaluator: resolved('p/eval', 100_000),
        },
        runner: (options) =>
          Promise.resolve(
            childResult(
              options,
              options.stage === 'candidate'
                ? 'candidate'
                : options.stage === 'evaluation'
                  ? 'x'.repeat(60_000)
                  : 'unexpected merge',
            ),
          ),
        blockedStage: 'evaluation',
        expectedEvaluationStatus: 'incomplete',
        expectedUsage: 8,
      },
      {
        name: 'merge launch',
        models: {
          ...models(),
          evaluator: resolved('p/eval', 300_000),
          merger: resolved('p/merge', 180_000),
        },
        runner: (options) =>
          Promise.resolve(
            childResult(
              options,
              options.stage === 'candidate'
                ? 'c'.repeat(48_000)
                : options.stage === 'evaluation'
                  ? JSON.stringify(evaluation())
                  : 'unexpected merge',
            ),
          ),
        blockedStage: 'merge',
        expectedEvaluationStatus: 'completed',
        expectedUsage: 8,
      },
    ];

    for (const item of cases) {
      const root = await mkdtemp(
        join(tmpdir(), `pi-fusion-progress-${item.name.replaceAll(' ', '-')}-`),
      );
      try {
        const calls: RunPiChildOptions[] = [];
        let failedProgressMessage = '';
        const canonical = canonicalInput();
        let thrown: unknown;
        try {
          await new FusionOrchestrator({
            childRunner: async (options) => {
              calls.push(options);
              return item.runner(options);
            },
          }).run({
            source: 'command',
            cwd: root,
            canonicalInput: canonical,
            canonicalInputSerialized: JSON.stringify(canonical),
            contextLedger: ledger,
            config: defaultFusionModelConfig(),
            models: item.models,
            onProgress: (event) => {
              if (event.type === 'failed') failedProgressMessage = event.error;
            },
          });
        } catch (error) {
          thrown = error;
        }
        assert.ok(thrown instanceof FusionError, item.name);
        assert.equal(thrown.code, 'prompt_budget_exceeded_measured', item.name);
        assert.doesNotMatch(thrown.message, /No child was created\./, item.name);
        assert.match(
          thrown.message,
          item.blockedStage === 'merge'
            ? /The merger child was not created\./
            : /The evaluator(?:-repair)? child was not created\./,
          item.name,
        );
        assert.equal(failedProgressMessage, thrown.message, item.name);
        const progress = thrown.runProgress;
        assert.ok(progress, item.name);
        assert.equal(progress.candidates.status, 'completed', item.name);
        assert.equal(progress.candidates.children_created, 3, item.name);
        assert.equal(progress.candidates.children_completed, 3, item.name);
        assert.equal(progress.evaluation.status, item.expectedEvaluationStatus, item.name);
        assert.equal(progress.merge.status, 'not_started', item.name);
        assert.equal(progress.usage_so_far.totalTokens, item.expectedUsage, item.name);
        assert.match(thrown.message, new RegExp(`totalTokens=${String(item.expectedUsage)}`));
        assert.equal(
          calls.some(
            (call) =>
              call.stage === item.blockedStage &&
              (item.name !== 'evaluation repair launch' || call.attempt === 2),
          ),
          false,
          item.name,
        );
        assert.ok(thrown.artifactDir);
        const manifest = parseObject(
          await readFile(join(root, thrown.artifactDir, 'manifest.json'), 'utf8'),
        );
        assertManifestUsageEqualsAttemptSum(manifest);
        assert.equal(
          stringField(manifest, 'error'),
          thrown.message,
          'durable error and thrown error must carry identical run truth',
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  void it('keeps terminal publication when one subordinate summary write fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-summary-write-failure-'));
    try {
      let summaryWrites = 0;
      let reported = '';
      const orchestrator = new FusionOrchestrator({
        childRunner: async (options) => {
          throw new FusionError('candidate failed', {
            code: 'child_exit_failed',
            stage: 'candidate',
            attempt: options.attempt,
            childCreated: true,
          });
        },
        createArtifactStore: async (options) => {
          const store = await FusionArtifactStore.create(options);
          store.writeFailureSummary = async () => {
            summaryWrites += 1;
            throw new Error('summary disk failure');
          };
          return store;
        },
      });
      const canonical = canonicalInput();
      let thrown: unknown;
      try {
        await orchestrator.run({
          source: 'tool',
          cwd: root,
          canonicalInput: canonical,
          canonicalInputSerialized: JSON.stringify(canonical),
          contextLedger: ledger,
          config: defaultFusionModelConfig(),
          models: models(),
          onProgress: (event) => {
            if (event.type === 'failed') reported = event.error;
          },
        });
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown instanceof FusionError);
      assert.equal(thrown.code, 'child_exit_failed');
      assert.match(thrown.message, /failure-summary\.json unavailable after terminal publication/);
      assert.equal(reported, thrown.message);
      assert.equal(summaryWrites, 1);
      assert.ok(thrown.artifactDir);
      const manifest = parseObject(
        await readFile(join(root, thrown.artifactDir, 'manifest.json'), 'utf8'),
      );
      assert.equal(field(manifest, 'state'), 'failed');
      assert.equal(field(objectField(manifest, 'artifacts'), 'failure-summary.json'), undefined);
      assert.doesNotMatch(stringField(manifest, 'error'), /failure-summary\.json unavailable/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('preserves writeError failure semantics and never attempts a summary afterward', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-write-error-failure-'));
    try {
      let summaryWrites = 0;
      const orchestrator = new FusionOrchestrator({
        childRunner: async (options) => {
          throw new FusionError('candidate failed', {
            code: 'child_exit_failed',
            stage: 'candidate',
            attempt: options.attempt,
            childCreated: true,
          });
        },
        createArtifactStore: async (options) => {
          const store = await FusionArtifactStore.create(options);
          store.writeError = async () => {
            throw new Error('writeError persistence failure');
          };
          store.writeFailureSummary = async () => {
            summaryWrites += 1;
            throw new Error('must not be called');
          };
          return store;
        },
      });
      const canonical = canonicalInput();
      await assert.rejects(
        orchestrator.run({
          source: 'tool',
          cwd: root,
          canonicalInput: canonical,
          canonicalInputSerialized: JSON.stringify(canonical),
          contextLedger: ledger,
          config: defaultFusionModelConfig(),
          models: models(),
        }),
        /candidate failed; additionally failed to write terminal fusion artifacts: writeError persistence failure/,
      );
      assert.equal(summaryWrites, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('retries only transient pre-creation spawn failures and supports concurrent workflows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-orchestrator-concurrent-'));
    try {
      const calls: RunPiChildOptions[] = [];
      let transientThrown = false;
      const runner: FusionChildRunner = async (options) => {
        calls.push(options);
        if (!transientThrown && options.stage === 'candidate' && options.slot === 1) {
          transientThrown = true;
          throw new FusionError('spawn EAGAIN', {
            code: 'child_spawn_failed',
            stage: 'candidate',
            slot: 1,
            attempt: 1,
            transient: true,
            childCreated: false,
          });
        }
        if (options.stage === 'candidate')
          return childResult(options, `candidate-${String(options.slot)}`);
        if (options.stage === 'evaluation')
          return childResult(options, JSON.stringify(evaluation()));
        return childResult(options, `merged ${options.cwd.endsWith('a') ? 'a' : 'b'}`);
      };
      const orchestrator = new FusionOrchestrator({ childRunner: runner });
      const canonical = canonicalInput();
      const firstCwd = join(root, 'a');
      const secondCwd = join(root, 'b');
      await Promise.all([mkdir(firstCwd), mkdir(secondCwd)]);
      const [first, second] = await Promise.all([
        orchestrator.run({
          source: 'command',
          cwd: firstCwd,
          canonicalInput: canonical,
          canonicalInputSerialized: JSON.stringify(canonical),
        contextLedger: ledger,
          config: defaultFusionModelConfig(),
          models: models(),
        }),
        orchestrator.run({
          source: 'command',
          cwd: secondCwd,
          canonicalInput: canonical,
          canonicalInputSerialized: JSON.stringify(canonical),
        contextLedger: ledger,
          config: defaultFusionModelConfig(),
          models: models(),
        }),
      ]);
      assert.equal(first.mergedText, 'merged a');
      assert.equal(second.mergedText, 'merged b');
      assert.equal(calls.filter((call) => call.stage === 'candidate' && call.slot === 1).length, 3);
      assert.equal(calls.filter((call) => call.stage === 'merge').length, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
