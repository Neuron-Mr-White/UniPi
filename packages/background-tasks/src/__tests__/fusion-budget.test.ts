import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseJsonText } from '../types.js';
import {
  FUSION_CALIBRATED_BYTES_PER_TOKEN,
  FUSION_CANDIDATE_MAX_OUTPUT_BYTES,
  FUSION_MIN_CANONICAL_INPUT_TOKENS,
  FUSION_MIN_CONTEXT_WINDOW_TOKENS,
  FUSION_DIAGNOSTICS_MAX_BYTES,
  FUSION_EVALUATION_MAX_OUTPUT_BYTES,
  FUSION_FRAMING_RESERVE_TOKENS,
  FUSION_RESERVED_OUTPUT_TOKENS,
  FUSION_SAFETY_RESERVE_TOKENS,
  FUSION_UTILIZATION_WARNING_THRESHOLD_BASIS_POINTS,
  FusionBudget,
  assertChildOutputWithinContract,
  fusionLimitingRoute,
  fusionRouteCapacities,
  fusionTokenUpperBound,
} from '../fusion/budget.js';
import { FusionOrchestrator, type FusionChildRunner } from '../fusion/orchestrator.js';
import {
  TOKEN_BUDGET_AFFINE_F_TOKENS,
  TOKEN_BUDGET_CALIBRATION_CORPUS_MIN_WHITESPACE_FRACTION_X10000,
  TOKEN_BUDGET_CONSERVATIVE_RATE_X100,
  TOKEN_BUDGET_DENSE_ASCII_WHITESPACE_THRESHOLD_X10000,
  TOKEN_BUDGET_FAMILY_CALIBRATIONS,
  TOKEN_BUDGET_HAIRCUT_BASIS_POINTS,
  TOKEN_BUDGET_LARGE_PROMPT_MIN_BYTES,
  TOKEN_BUDGET_PROVABLE_RATE_X100,
  estimateInputTokens,
  knownTextSegment,
  maxKnownTextBytesForTokens,
  resolveTokenBudgetFamily,
  utf8ByteClassBreakdown,
} from '../context-token-budget.js';
import { defaultFusionModelConfig } from '../fusion/config.js';
import { buildFusionCanonicalInput } from '../fusion/context.js';
import { buildFusionCleanTaskCanonicalInput } from '../fusion/clean-context.js';
import {
  FUSION_CANDIDATE_INSPECT_SYSTEM_PROMPT,
  FUSION_CANDIDATE_RESEARCH_SYSTEM_PROMPT,
  FUSION_CANDIDATE_SYSTEM_PROMPT,
  buildCandidatePrompt,
} from '../fusion/prompts.js';
import {
  FUSION_COMMAND_CONTEXT_POLICY_ID,
  FUSION_CONTEXT_TRANSFORM_ID,
  FUSION_EVALUATION_SCHEMA_VERSION,
  FUSION_INPUT_SCHEMA_VERSION,
  FusionError,
  type FusionCanonicalInputV3,
  type FusionChildRunResult,
  type FusionBudgetStage,
  type FusionEvaluationV1,
  type FusionStageBudgetPlanEntry,
  type ResolvedFusionModel,
  type ResolvedFusionModels,
} from '../fusion/types.js';
import type { RunPiChildOptions } from '../fusion/pi-child.js';
import {
  FUSION_INVESTIGATE_WORKFLOW,
  FUSION_RESEARCH_WORKFLOW,
  FUSION_VALIDATE_WORKFLOW,
} from '../fusion/workflows.js';
import { emptyLedger, sessionWith, userMessage } from './helpers/fusion-canonical.js';

const ledger = emptyLedger(FUSION_COMMAND_CONTEXT_POLICY_ID);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

function ceilDiv(numerator: number, denominator: number): number {
  if (numerator === 0) return 0;
  return Math.floor((numerator - 1) / denominator) + 1;
}

function resolved(qualifiedId: string, contextWindow: number, maxOutputTokens = 32_768): ResolvedFusionModel {
  const slash = qualifiedId.indexOf('/');
  return {
    selection: '$current',
    source: 'current',
    provider: qualifiedId.slice(0, slash),
    model: qualifiedId.slice(slash + 1),
    qualifiedId,
    thinkingLevel: 'high',
    contextWindow,
    maxOutputTokens,
  };
}

/** Mirrors the real reported panel: two large-window models plus a smaller one. */
function models(options: { small?: number; large?: number } = {}): ResolvedFusionModels {
  const large = options.large ?? 272_000;
  const small = options.small ?? 200_000;
  return {
    candidates: [
      resolved('openai-codex/gpt-5.6-sol', large),
      resolved('openai-codex/gpt-5.6-terra', large),
      resolved('openai-codex/gpt-5.4-mini', small),
    ],
    evaluator: resolved('openai-codex/gpt-5.6-sol', large),
    merger: resolved('openai-codex/gpt-5.6-sol', large),
  };
}

function canonicalInput(text: string): FusionCanonicalInputV3 {
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

function canonicalInputWithPromptBytes(targetBytes: number): FusionCanonicalInputV3 {
  let textBytes = targetBytes - Buffer.byteLength(buildCandidatePrompt(canonicalInput('')), 'utf8');
  assert.ok(textBytes >= 0, 'target must leave room for fixture text');
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const input = canonicalInput('x'.repeat(textBytes));
    const actual = Buffer.byteLength(buildCandidatePrompt(input), 'utf8');
    if (actual === targetBytes) return input;
    textBytes += targetBytes - actual;
    assert.ok(textBytes >= 0, 'target adjustment must stay non-negative');
  }
  const finalInput = canonicalInput('x'.repeat(textBytes));
  assert.equal(Buffer.byteLength(buildCandidatePrompt(finalInput), 'utf8'), targetBytes);
  return finalInput;
}

function planEntry(
  entries: readonly FusionStageBudgetPlanEntry[],
  stage: FusionBudgetStage,
  slot?: 1 | 2 | 3,
): FusionStageBudgetPlanEntry {
  const found = entries.find((entry) => entry.budget_stage === stage && entry.slot === slot);
  assert.ok(found, `${stage} entry must exist`);
  return found;
}

function evaluation(): FusionEvaluationV1 {
  const one = (id: 'A' | 'B' | 'C') => ({
    candidate_id: id,
    summary: id,
    strengths: [id],
    limitations: [id],
    useful_contributions: [id],
    risks: [id],
  });
  return {
    schema_version: FUSION_EVALUATION_SCHEMA_VERSION,
    candidate_assessments: [one('A'), one('B'), one('C')],
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
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    events: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    exitCode: 0,
    signal: null,
  };
  if (options.slot !== undefined) result.slot = options.slot;
  return result;
}

interface RunOutcome {
  error: FusionError;
  calls: readonly RunPiChildOptions[];
  root: string;
  artifactDir: string;
}

async function runExpectingFailure(
  input: FusionCanonicalInputV3,
  runner: FusionChildRunner,
  resolvedModels: ResolvedFusionModels = models(),
): Promise<RunOutcome> {
  const root = await mkdtemp(join(tmpdir(), 'pi-fusion-budget-'));
  const calls: RunPiChildOptions[] = [];
  const tracking: FusionChildRunner = async (options) => {
    calls.push(options);
    return runner(options);
  };
  const orchestrator = new FusionOrchestrator({ childRunner: tracking });
  let thrown: unknown;
  try {
    await orchestrator.run({
      source: 'command',
      cwd: root,
      canonicalInput: input,
      canonicalInputSerialized: JSON.stringify(input),
      contextLedger: ledger,
      config: defaultFusionModelConfig(),
      models: resolvedModels,
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof FusionError, 'run must fail with a FusionError');
  return { error: thrown, calls, root, artifactDir: thrown.artifactDir ?? '' };
}

function assertBudgetError(
  error: FusionError,
  stage: 'candidate' | 'evaluation' | 'evaluation_repair' | 'merge',
): void {
  assert.ok(
    error.code === 'prompt_budget_exceeded_forecast' ||
      error.code === 'prompt_budget_exceeded_measured',
  );
  assert.equal(error.childCreated, false, 'budget rejection must not claim a child was created');
  const budget = error.budget;
  assert.ok(budget, 'budget failure must carry structured detail');
  assert.equal(budget.budget_stage, stage);
  assert.ok(budget.measured_utf8_bytes > 0);
  assert.ok(budget.measured_input_tokens_upper_bound > budget.allowed_input_tokens);
  assert.equal(budget.required_allowed_tokens, budget.measured_input_tokens_upper_bound);
  assert.equal(budget.calibration_version, 'pi-background-tasks.input-token-calibration.v1');
  assert.ok(budget.rate_source.family.length > 0);
  assert.equal(budget.backed, budget.rate_source.backed);
  assert.equal(budget.dominant_byte_class, budget.rate_source.dominant_byte_class);
  assert.ok(budget.route_table.length > 0);
  assert.ok(budget.allowed_input_tokens > 0);
  assert.ok(budget.limiting_model.qualified_id.length > 0);
  assert.ok(budget.limiting_model.context_window_tokens > 0);
  assert.ok(budget.remediation.length > 0);
  assert.ok(budget.blockers.length > 0);
  // The human-readable message must name every actionable fact too.
  assert.match(error.message, /Primary blocking stage/);
  assert.doesNotMatch(error.message, /No child was created\./);
  assert.match(
    error.message,
    stage === 'candidate'
      ? /The candidate-\d child was not created\./
      : stage === 'evaluation_repair'
        ? /The evaluator-repair child was not created\./
        : stage === 'evaluation'
          ? /The evaluator child was not created\./
          : /The merger child was not created\./,
  );
  assert.match(error.message, /Nothing was clipped, dropped, or substituted/);
  assert.match(error.message, new RegExp(String(budget.measured_utf8_bytes)));
  assert.match(error.message, new RegExp(String(budget.allowed_input_tokens)));
  assert.match(error.message, new RegExp(budget.limiting_model.qualified_id));
  assert.match(error.message, /Remediation:/);
}

void describe('fusion stage budgets', () => {
  void it('ships the calibrated affine table with strict provenance guards', () => {
    assert.equal(fusionTokenUpperBound(0), TOKEN_BUDGET_AFFINE_F_TOKENS);
    assert.equal(FUSION_CALIBRATED_BYTES_PER_TOKEN.anthropic.rate_bytes_per_token_x100, 173);
    assert.equal(FUSION_CALIBRATED_BYTES_PER_TOKEN['openai-codex'].rate_bytes_per_token_x100, 289);
    assert.equal(FUSION_CALIBRATED_BYTES_PER_TOKEN.unknown.rate_bytes_per_token_x100, 100);
    for (const [family, entry] of Object.entries(FUSION_CALIBRATED_BYTES_PER_TOKEN)) {
      assert.equal(entry.affine_f_tokens, 512, family);
      assert.equal(Reflect.has(entry.provenance, 'sessions'), false, family);
      assert.equal(Reflect.has(entry.provenance, 'days'), false, family);
      if (family !== 'unknown') {
        assert.ok(entry.provenance.n >= 50, family);
        assert.equal(entry.provenance.backed, true, family);
        assert.ok(entry.provenance.observed_min_bpt_x1000 !== null, family);
        if (entry.provenance.observed_min_bpt_x1000 !== null) {
          const numerator = entry.provenance.observed_min_bpt_x1000 *
            (10_000 - TOKEN_BUDGET_HAIRCUT_BASIS_POINTS);
          assert.ok(
            entry.rate_bytes_per_token_x100 * 100_000 <= numerator,
            family,
          );
          assert.equal(
            entry.rate_bytes_per_token_x100,
            Math.floor(numerator / 100_000),
            `${family} rate must be floor-rounded after the haircut`,
          );
        }
      }
    }
    const backedRates = Object.values(FUSION_CALIBRATED_BYTES_PER_TOKEN)
      .filter((entry) => entry.provenance.backed)
      .map((entry) => entry.rate_bytes_per_token_x100);
    assert.ok(FUSION_CALIBRATED_BYTES_PER_TOKEN.unknown.rate_bytes_per_token_x100 <= Math.min(...backedRates));
    assert.equal(FUSION_CALIBRATED_BYTES_PER_TOKEN.unknown.provenance.backed, false);
    assert.ok(
      TOKEN_BUDGET_DENSE_ASCII_WHITESPACE_THRESHOLD_X10000 <
        TOKEN_BUDGET_CALIBRATION_CORPUS_MIN_WHITESPACE_FRACTION_X10000,
    );
    assert.deepEqual(FUSION_CALIBRATED_BYTES_PER_TOKEN, TOKEN_BUDGET_FAMILY_CALIBRATIONS);
  });

  void it('uses additive segment accounting rather than an unsafe blended divisor', () => {
    const estimate = estimateInputTokens({
      family: 'openai-codex',
      allowedInputTokens: 231_040,
      scope: 'fusion',
      segments: [
        { kind: 'known_text', bytes: 7_500, multibyteBytes: 0, denseBytes: 0 },
        { kind: 'known_text', bytes: 2_500, multibyteBytes: 2_500, denseBytes: 0 },
      ],
    });
    const arithmeticBlendRateX10000 = 75 * 289 + 25 * 100;
    const blendedTokens = ceilDiv(10_000 * 10_000, arithmeticBlendRateX10000) + 512;
    assert.ok(estimate.tokens >= blendedTokens);
    assert.equal(estimate.perSegment[1]?.multibyte_tokens, 1_250);
    assert.equal(estimate.perSegment[1]?.multibyte_provable_tokens, 2_500);
    assert.ok(estimate.advisory.input_tokens_if_multibyte_used_provable_ceiling > estimate.tokens);
    const contract = estimateInputTokens({
      family: 'openai-codex',
      allowedInputTokens: 231_040,
      scope: 'fusion',
      segments: [{ kind: 'unknown_output_contract', bytes: 4096, denseBytes: 0 }],
    });
    assert.equal(contract.perSegment[0]?.unknown_output_contract_tokens, 4096);
  });

  void it('keeps adversarial forecasts at or below bytes plus F while remaining deterministic', () => {
    const fixtures = [
      'YWJjZA=='.repeat(1024),
      '0123456789abcdef'.repeat(1024),
      '漢字仮名交じり文'.repeat(1024),
      '👩‍👩‍👧‍👦'.repeat(1024),
      'const x={a:1,b:[2,3,4]};'.repeat(1024),
      '!@#$%^&*()_+-=[]{}|;:,.<>?'.repeat(1024),
    ];
    for (const text of fixtures) {
      const breakdown = utf8ByteClassBreakdown(text);
      const estimate = estimateInputTokens({
        family: 'openai-codex',
        allowedInputTokens: 231_040,
        scope: 'fusion',
        segments: [
          {
            kind: 'known_text',
            bytes: breakdown.bytes,
            multibyteBytes: breakdown.multibyteBytes,
            denseBytes: breakdown.denseBytes,
          },
        ],
      });
      assert.ok(estimate.tokens <= breakdown.bytes + TOKEN_BUDGET_AFFINE_F_TOKENS);
    }
  });

  void it('is byte-identical across separate estimator processes', () => {
    const script = [
      "import { estimateInputTokens } from './context-token-budget.js';",
      "const result = estimateInputTokens({ family: 'openai-codex', allowedInputTokens: 231040, scope: 'fusion', segments: [{ kind: 'known_text', bytes: 290099, multibyteBytes: 0, denseBytes: 0 }] });",
      'process.stdout.write(JSON.stringify(result));',
    ].join('\n');
    // tsx is hoisted to the workspace root in our monorepo
    const cli = join(packageRoot, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const first = spawnSync(process.execPath, ['--import', 'tsx', '--eval', script], { cwd: packageRoot, encoding: 'utf8' });
    const second = spawnSync(process.execPath, ['--import', 'tsx', '--eval', script], { cwd: packageRoot, encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.stdout, second.stdout);
  });

  void it('ceilings once per rate bucket so segmentation cannot add phantom tokens', () => {
    const segment = {
      kind: 'known_text' as const,
      bytes: TOKEN_BUDGET_LARGE_PROMPT_MIN_BYTES + 1_000,
      multibyteBytes: 0,
      denseBytes: 0,
      asciiWhitespaceBytes: 1_000,
    };
    const one = estimateInputTokens({
      family: 'openai-codex',
      allowedInputTokens: 231_040,
      scope: 'fusion',
      segments: [segment],
    });
    const two = estimateInputTokens({
      family: 'openai-codex',
      allowedInputTokens: 231_040,
      scope: 'fusion',
      segments: [
        { ...segment, bytes: Math.floor(segment.bytes / 2), asciiWhitespaceBytes: 500 },
        { ...segment, bytes: segment.bytes - Math.floor(segment.bytes / 2), asciiWhitespaceBytes: 500 },
      ],
    });
    assert.equal(one.rateSource.source, 'calibrated_large_window');
    assert.equal(two.rateSource.source, 'calibrated_large_window');
    assert.equal(one.tokens, two.tokens);
    assert.deepEqual(one.rate_buckets, two.rate_buckets);
  });

  void it('scope guard keeps calibrated codex rates out of small prompts and small windows', () => {
    const smallPrompt = estimateInputTokens({
      family: 'openai-codex',
      allowedInputTokens: 231_040,
      scope: 'fusion',
      segments: [knownTextSegment('word '.repeat(400))],
    });
    assert.equal(smallPrompt.byte_class_breakdown.total_bytes, 2_000);
    assert.equal(smallPrompt.rateSource.source, 'conservative_small_prompt');
    assert.equal(smallPrompt.rateSource.effective_rate_bytes_per_token_x100, TOKEN_BUDGET_CONSERVATIVE_RATE_X100);

    const edge: ResolvedFusionModels = {
      candidates: [
        resolved('openai-codex/gpt-5.5', FUSION_MIN_CONTEXT_WINDOW_TOKENS),
        resolved('openai-codex/gpt-5.5', 272_000),
        resolved('openai-codex/gpt-5.5', 272_000),
      ],
      evaluator: resolved('openai-codex/gpt-5.5', 272_000),
      merger: resolved('openai-codex/gpt-5.5', 272_000),
    };
    const budget = new FusionBudget(edge, FUSION_COMMAND_CONTEXT_POLICY_ID);
    const firstRoute = budget.routes[0];
    assert.ok(firstRoute);
    assert.equal(firstRoute.rate_source.source, 'conservative_capacity_guard');
    assert.throws(
      () => budget.assertStagePrompt('candidate', '', 'x'.repeat(23_674), 1),
      (error: unknown) => error instanceof FusionError && error.code === 'prompt_budget_exceeded_measured',
    );
  });

  void it('falls back for low-whitespace dense ASCII before a calibrated codex under-forecast can be admitted', () => {
    const dense = 'A'.repeat(600_000);
    const beforeRelaxedForecast = ceilDiv(600_000 * 100, 289) + TOKEN_BUDGET_AFFINE_F_TOKENS;
    assert.equal(beforeRelaxedForecast, 208_125);
    const estimate = estimateInputTokens({
      family: 'openai-codex',
      allowedInputTokens: 231_040,
      scope: 'fusion',
      segments: [knownTextSegment(dense)],
    });
    assert.equal(estimate.rateSource.source, 'conservative_dense_ascii_whitespace_gate');
    assert.equal(estimate.rateSource.dense_ascii_gate.measured_whitespace_fraction_x10000, 0);
    assert.equal(estimate.rateSource.dense_ascii_gate.decision, 'conservative_fallback');
    assert.equal(estimate.rateSource.dominant_byte_class, 'dense_ascii');
    assert.equal(estimate.tokens, 300_512);
    assert.ok(estimate.tokens > 231_040);

    const budget = new FusionBudget(models({ small: 267_904, large: 267_904 }), FUSION_COMMAND_CONTEXT_POLICY_ID);
    assert.throws(
      () => budget.assertStagePrompt('candidate', '', dense, 1),
      (error: unknown) => {
        assert.ok(error instanceof FusionError);
        assert.equal(error.code, 'prompt_budget_exceeded_measured');
        assert.equal(error.budget?.rate_source.source, 'conservative_dense_ascii_whitespace_gate');
        assert.equal(error.budget?.dominant_byte_class, 'dense_ascii');
        return true;
      },
    );
  });

  void it('splits input-only fatal checks from reservation warnings', () => {
    const budget = new FusionBudget(
      models({ small: 267_904, large: 267_904 }),
      FUSION_COMMAND_CONTEXT_POLICY_ID,
    );
    const reportedInputOnly = estimateInputTokens({
      family: 'openai-codex',
      allowedInputTokens: 231_040,
      scope: 'fusion',
      segments: [knownTextSegment('A'.repeat(290_099))],
    });
    assert.equal(reportedInputOnly.tokens, 145_562);
    assert.ok(reportedInputOnly.tokens <= 231_040);
    const warningPlan = budget.plan(canonicalInputWithPromptBytes(290_099));
    assert.equal(warningPlan.blockers.length, 0);
    assert.equal(warningPlan.warnings.some((entry) => entry.warning_kind === 'worst_case_reservation'), true);
    assert.doesNotThrow(() => budget.assertPlanFits(warningPlan, 'unit-test'));

    const fatalPlan = budget.plan(canonicalInputWithPromptBytes(800_000));
    assert.ok(fatalPlan.primary_blocker);
    assert.throws(
      () => budget.assertPlanFits(fatalPlan, 'unit-test'),
      (error: unknown) => error instanceof FusionError && error.code === 'prompt_budget_exceeded_forecast',
    );
  });

  void it('bases safety on the smallest configured byte capacity, not the largest token window', () => {
    const routes = fusionRouteCapacities(models({ small: 200_000, large: 1_000_000 }));
    const limiting = fusionLimitingRoute(routes);
    assert.equal(limiting.qualified_id, 'openai-codex/gpt-5.4-mini');
    assert.equal(limiting.context_window_tokens, 200_000);
    assert.equal(
      limiting.allowed_input_tokens,
      200_000 -
        FUSION_RESERVED_OUTPUT_TOKENS -
        FUSION_FRAMING_RESERVE_TOKENS -
        FUSION_SAFETY_RESERVE_TOKENS,
    );
    // Even when the small model is the evaluator rather than a candidate.
    const evaluatorSmall: ResolvedFusionModels = {
      candidates: [
        resolved('p/big1', 1_000_000),
        resolved('p/big2', 1_000_000),
        resolved('p/big3', 1_000_000),
      ],
      evaluator: resolved('p/small', 200_000),
      merger: resolved('p/big1', 1_000_000),
    };
    assert.equal(
      fusionLimitingRoute(fusionRouteCapacities(evaluatorSmall)).qualified_id,
      'p/small',
    );
  });

  void it('reserves each route configured maximum output instead of assuming the smaller Fusion response contract', () => {
    const routeModels: ResolvedFusionModels = {
      candidates: [
        resolved('openai-codex/gpt-5.6-sol', 272_000, 128_000),
        resolved('openai-codex/gpt-5.6-terra', 272_000, 128_000),
        resolved('openai-codex/gpt-5.5', 272_000, 128_000),
      ],
      evaluator: resolved('openai-codex/gpt-5.6-sol', 272_000, 128_000),
      merger: resolved('openai-codex/gpt-5.6-sol', 272_000, 128_000),
    };
    for (const route of fusionRouteCapacities(routeModels)) {
      assert.equal(route.reserved_output_tokens, 128_000);
      assert.equal(route.allowed_input_tokens, 139_904);
    }
  });

  void it('selects the byte-capacity limiting route when token ordering flips', () => {
    const mixed: ResolvedFusionModels = {
      candidates: [
        resolved('anthropic/claude-a', 400_000),
        resolved('openai-codex/gpt-5.6-sol', 272_000),
        resolved('openai-codex/gpt-5.6-terra', 272_000),
      ],
      evaluator: resolved('openai-codex/gpt-5.6-sol', 272_000),
      merger: resolved('openai-codex/gpt-5.6-sol', 272_000),
    };
    const routes = fusionRouteCapacities(mixed);
    const anthropic = routes[0];
    const codex = routes[1];
    assert.ok(anthropic);
    assert.ok(codex);
    assert.ok(anthropic.allowed_input_tokens > codex.allowed_input_tokens);
    assert.ok(anthropic.byte_capacity_utf8_bytes < codex.byte_capacity_utf8_bytes);
    assert.equal(fusionLimitingRoute(routes).qualified_id, 'anthropic/claude-a');
  });

  void it('rejects routes whose capacity is unknown or too small to hold input', () => {
    for (const contextWindow of [0, -1, Number.NaN, 1_000, 40_000]) {
      const bad: ResolvedFusionModels = {
        candidates: [
          resolved('p/a', 200_000),
          resolved('p/b', 200_000),
          resolved('p/c', contextWindow),
        ],
        evaluator: resolved('p/a', 200_000),
        merger: resolved('p/a', 200_000),
      };
      assert.throws(
        () => new FusionBudget(bad, FUSION_COMMAND_CONTEXT_POLICY_ID),
        (error: unknown) =>
          error instanceof FusionError &&
          error.code === 'model_capacity_unknown' &&
          error.childCreated === false,
        `context window ${String(contextWindow)} must be rejected`,
      );
    }
  });

  void it('forecasts each concrete stage against its assigned route', () => {
    const budget = new FusionBudget(models(), FUSION_COMMAND_CONTEXT_POLICY_ID);
    const input = canonicalInput('small');
    const plan = budget.plan(input);
    assert.equal(plan.schema_version, 'pi-background-tasks.fusion-budget-plan.v4');
    assert.equal(plan.policy.id, 'fusion-budget-policy-v4');
    assert.equal(plan.policy.route_output_reserve_strategy, 'max_fusion_contract_or_model_max');
    assert.equal(plan.stages.length, 6);
    assert.equal(planEntry(plan.stages, 'candidate', 1).route.role, 'candidate-1');
    assert.equal(planEntry(plan.stages, 'candidate', 2).route.role, 'candidate-2');
    assert.equal(planEntry(plan.stages, 'candidate', 3).route.role, 'candidate-3');
    assert.equal(planEntry(plan.stages, 'evaluation').route.role, 'evaluator');
    assert.equal(planEntry(plan.stages, 'evaluation_repair').conditional, true);
    assert.equal(planEntry(plan.stages, 'merge').route.role, 'merger');
    for (const entry of plan.stages) {
      assert.equal(entry.input_only_input_tokens_upper_bound, entry.input_only_estimate.tokens);
      assert.equal(entry.forecast_input_tokens_upper_bound, entry.reservation_estimate.tokens);
      assert.equal(entry.input_only_signed_headroom_tokens, entry.allowed_input_tokens - entry.input_only_input_tokens_upper_bound);
      assert.equal(entry.signed_headroom_tokens, entry.allowed_input_tokens - entry.forecast_input_tokens_upper_bound);
    }
  });

  void it('accepts a safe prompt at the affine boundary and rejects one byte past it', () => {
    const budget = new FusionBudget(models(), FUSION_COMMAND_CONTEXT_POLICY_ID);
    const allowedBytes = maxKnownTextBytesForTokens({
      family: 'openai-codex',
      allowedInputTokens: budget.allowedInputTokens,
      scope: 'fusion',
    });
    assert.doesNotThrow(() => {
      budget.assertStagePrompt('candidate', '', 'x'.repeat(allowedBytes), 3);
    });
    assert.throws(
      () => {
        budget.assertStagePrompt('candidate', '', 'x'.repeat(allowedBytes + 1), 3);
      },
      (error: unknown) => error instanceof FusionError && error.code === 'prompt_budget_exceeded_measured',
    );
  });

  void it('counts the child system prompt as input, not free space', () => {
    const budget = new FusionBudget(models(), FUSION_COMMAND_CONTEXT_POLICY_ID);
    const allowedBytes = maxKnownTextBytesForTokens({
      family: 'openai-codex',
      allowedInputTokens: budget.allowedInputTokens,
      scope: 'fusion',
    });
    assert.throws(
      () => {
        budget.assertStagePrompt('candidate', 'ab', 'x'.repeat(allowedBytes - 1), 3);
      },
      (error: unknown) => error instanceof FusionError && error.code === 'prompt_budget_exceeded_measured',
    );
  });

  void it('uses conservative multibyte fatal accounting while persisting the provable advisory ceiling', () => {
    const cjkEstimate = estimateInputTokens({
      family: 'openai-codex',
      allowedInputTokens: 231_040,
      scope: 'fusion',
      segments: [
        {
          kind: 'known_text',
          bytes: 100_000,
          multibyteBytes: 100_000,
          denseBytes: 0,
          asciiWhitespaceBytes: 0,
        },
      ],
    });
    assert.equal(cjkEstimate.tokens, 50_512);
    assert.equal(cjkEstimate.advisory.input_tokens_if_multibyte_used_provable_ceiling, 100_512);
    assert.equal(cjkEstimate.rateSource.dominant_byte_class, 'multibyte');

    const budget = new FusionBudget(models(), FUSION_COMMAND_CONTEXT_POLICY_ID);
    const variableAllowance = budget.allowedInputTokens - TOKEN_BUDGET_AFFINE_F_TOKENS;
    const chars = Math.floor((variableAllowance * 2) / 3) + 1;
    const dense = '漢'.repeat(chars);
    const breakdown = utf8ByteClassBreakdown(dense);
    assert.equal(breakdown.multibyteBytes, breakdown.bytes);
    assert.throws(
      () => {
        budget.assertStagePrompt('candidate', '', dense, 3);
      },
      (error: unknown) => {
        assert.ok(error instanceof FusionError);
        assert.equal(error.code, 'prompt_budget_exceeded_measured');
        assert.equal(error.budget?.dominant_byte_class, 'multibyte');
        assert.match(error.message, /multibyte UTF-8/);
        return true;
      },
    );
  });

  void it('rejects an oversized candidate stage before spawning a child', async () => {
    const oversized = canonicalInput('u'.repeat(600_000));
    const outcome = await runExpectingFailure(oversized, async (options) =>
      childResult(options, 'unreachable'),
    );
    try {
      assertBudgetError(outcome.error, 'candidate');
      assert.equal(outcome.calls.length, 0, 'no child may be launched when preflight rejects');
    } finally {
      await rm(outcome.root, { recursive: true, force: true });
    }
  });

  void it('allows the reported input-only incident while warning on reservation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-budget-incident-'));
    const calls: RunPiChildOptions[] = [];
    try {
      const runner: FusionChildRunner = async (options) => {
        calls.push(options);
        if (options.stage === 'candidate') return childResult(options, 'candidate answer');
        if (options.stage === 'evaluation') return childResult(options, JSON.stringify(evaluation()));
        return childResult(options, 'merged');
      };
      const input = canonicalInputWithPromptBytes(290_099);
      const resolvedModels = models({ small: 267_904, large: 267_904 });
      const result = await new FusionOrchestrator({ childRunner: runner }).run({
        source: 'command',
        cwd: root,
        canonicalInput: input,
        canonicalInputSerialized: JSON.stringify(input),
        contextLedger: ledger,
        config: defaultFusionModelConfig(),
        models: resolvedModels,
      });
      assert.equal(result.mergedText, 'merged');
      assert.equal(calls.length, 5);
      const planText = await readFile(join(root, result.details.artifact_dir, 'budget-plan.json'), 'utf8');
      const plan = parseJsonText(planText);
      assert.ok(typeof plan === 'object' && plan !== null);
      assert.equal(Reflect.get(plan, 'primary_blocker'), undefined);
      const stages = Reflect.get(plan, 'stages');
      assert.ok(Array.isArray(stages));
      assert.equal(
        stages.some((stage) =>
          Reflect.get(stage, 'warning_kind') === 'worst_case_reservation' ||
          Reflect.get(stage, 'reservation_fits') === false,
        ),
        true,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('bounds each child response so downstream stages cannot be overrun', async () => {
    // Defence in depth layer 1: a response larger than its stage contract is
    // rejected loudly, never sliced and never forwarded to a later stage.
    const budget = new FusionBudget(models(), FUSION_COMMAND_CONTEXT_POLICY_ID);
    const oversized = 'c'.repeat(FUSION_CANDIDATE_MAX_OUTPUT_BYTES + 1);
    const outcome = await runExpectingFailure(canonicalInput('small'), async (options) => {
      if (options.stage === 'candidate') return childResult(options, oversized);
      return childResult(options, 'unreachable');
    });
    try {
      assert.equal(outcome.error.code, 'child_output_cap');
      assert.match(outcome.error.message, /exceeding the \d+-byte output contract/);
      assert.match(outcome.error.message, /not forwarded or truncated/);
      assert.equal(
        outcome.calls.filter((call) => call.stage !== 'candidate').length,
        0,
        'no downstream child may run once a candidate breaks its contract',
      );
      // The oversized response is preserved as evidence.
      const preserved = await readFile(
        join(outcome.root, outcome.artifactDir, 'candidate-1.attempt-1.response.md'),
        'utf8',
      );
      assert.equal(preserved.length, oversized.length);
    } finally {
      await rm(outcome.root, { recursive: true, force: true });
    }
    assert.equal(budget.allowedInputTokens > 0, true);
  });

  void it('rejects evaluator, repair, and merger expansion before those children spawn', () => {
    // Defence in depth layer 2: even if a response somehow reached a later stage,
    // the exact rendered prompt is re-measured before that child is created.
    const budget = new FusionBudget(models({ small: 200_000, large: 200_000 }), FUSION_COMMAND_CONTEXT_POLICY_ID);
    const allowedBytes = maxKnownTextBytesForTokens({
      family: 'openai-codex',
      allowedInputTokens: budget.allowedInputTokens,
      scope: 'fusion',
    });
    const oversizedPrompt = 'p'.repeat(allowedBytes + 1);
    for (const stage of ['evaluation', 'evaluation_repair', 'merge'] as const) {
      let thrown: unknown;
      try {
        budget.assertStagePrompt(stage, '', oversizedPrompt);
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown instanceof FusionError, `${stage} must reject`);
      assertBudgetError(thrown, stage);
      assert.equal(thrown.budget?.measurement_kind, 'rendered_prompt');
    }
  });

  void it('states the minimum viable route capacity instead of accepting a route that must fail', () => {
    // The policy's uniform conservatism has a real consequence: routes below the
    // documented minimum cannot host the workflow. That is surfaced as an
    // actionable configuration error, not discovered later at the provider.
    assert.equal(
      FUSION_MIN_CONTEXT_WINDOW_TOKENS,
      FUSION_MIN_CANONICAL_INPUT_TOKENS +
        FUSION_RESERVED_OUTPUT_TOKENS +
        FUSION_FRAMING_RESERVE_TOKENS +
        FUSION_SAFETY_RESERVE_TOKENS,
    );
    const tooSmall: ResolvedFusionModels = {
      candidates: [
        resolved('p/ok', 272_000),
        resolved('p/ok', 272_000),
        resolved('p/small', FUSION_MIN_CONTEXT_WINDOW_TOKENS - 1),
      ],
      evaluator: resolved('p/ok', 272_000),
      merger: resolved('p/ok', 272_000),
    };
    assert.throws(
      () => new FusionBudget(tooSmall, FUSION_COMMAND_CONTEXT_POLICY_ID),
      (error: unknown) => {
        assert.ok(error instanceof FusionError);
        assert.equal(error.code, 'model_capacity_unknown');
        assert.equal(error.childCreated, false);
        // The error must name the requirement and the remedy.
        assert.match(error.message, new RegExp(String(FUSION_MIN_CONTEXT_WINDOW_TOKENS)));
        assert.match(error.message, /\/fusion-models/);
        return true;
      },
    );
    // Exactly at the minimum is accepted.
    const atMinimum: ResolvedFusionModels = {
      candidates: [
        resolved('p/ok', 272_000),
        resolved('p/ok', 272_000),
        resolved('p/edge', FUSION_MIN_CONTEXT_WINDOW_TOKENS),
      ],
      evaluator: resolved('p/ok', 272_000),
      merger: resolved('p/ok', 272_000),
    };
    assert.doesNotThrow(() => new FusionBudget(atMinimum, FUSION_COMMAND_CONTEXT_POLICY_ID));
  });

  void it('bounds output contracts in JSON-rendered bytes so escaping cannot bypass them', () => {
    // A raw-byte contract would be bypassed by escape-heavy content: control
    // characters render as \u00XX (6x) and quotes/backslashes/newlines as 2x.
    const rawLimit = FUSION_CANDIDATE_MAX_OUTPUT_BYTES;
    for (const [label, unit] of [
      ['control chars', '\u0001'],
      ['quotes', '"'],
      ['backslashes', '\\'],
      ['newlines', '\n'],
    ] as const) {
      // Half the raw limit: trivially inside a raw-byte bound...
      const text = unit.repeat(Math.floor(rawLimit / 2));
      assert.ok(
        Buffer.byteLength(text, 'utf8') < rawLimit,
        `${label} fixture must be under the raw limit`,
      );
      // ...but over the contract once rendered, which is what the reserve covers.
      assert.ok(
        Buffer.byteLength(JSON.stringify(text), 'utf8') > rawLimit,
        `${label} must expand past the raw limit when rendered`,
      );
      assert.throws(
        () => {
          assertChildOutputWithinContract('candidate', text);
        },
        (error: unknown) =>
          error instanceof FusionError &&
          error.code === 'child_output_cap' &&
          /JSON-rendered bytes/.test(error.message),
        `${label} must be rejected by the rendered-byte contract`,
      );
    }
    // Ordinary prose of the same raw size is accepted.
    assert.doesNotThrow(() => {
      assertChildOutputWithinContract('candidate', 'a'.repeat(Math.floor(rawLimit / 2)));
    });
  });

  void it('adds upstream output contracts to real empty-slot renderings', () => {
    const budget = new FusionBudget(models({ small: 272_000, large: 272_000 }), FUSION_COMMAND_CONTEXT_POLICY_ID);
    const input = canonicalInputWithPromptBytes(291_748);
    const plan = budget.plan(input);
    const candidate = planEntry(plan.stages, 'candidate', 1);
    const evaluationStage = planEntry(plan.stages, 'evaluation');
    const repair = planEntry(plan.stages, 'evaluation_repair');
    const merge = planEntry(plan.stages, 'merge');
    assert.equal(candidate.fits, true);
    assert.equal(evaluationStage.fits, true);
    assert.equal(merge.fits, true);
    assert.equal(repair.fits, true);
    assert.equal(merge.reservation_fits, false);
    assert.equal(repair.reservation_fits, false);
    assert.equal(plan.blockers.length, 0);
    assert.equal(plan.warnings.some((entry) => entry.warning_kind === 'worst_case_reservation'), true);
    assert.ok(
      repair.forecast_utf8_bytes >
        evaluationStage.forecast_utf8_bytes + FUSION_EVALUATION_MAX_OUTPUT_BYTES,
    );
    assert.ok(repair.forecast_utf8_bytes > merge.forecast_utf8_bytes);
    assert.ok(
      repair.forecast_utf8_bytes - merge.forecast_utf8_bytes >= FUSION_DIAGNOSTICS_MAX_BYTES,
    );
  });

  void it('forecasts tool-enabled candidate stages with capability-specific system prompt bytes', () => {
    const input = canonicalInput('specific repository fact and public URL requested');
    const reasonBudget = new FusionBudget(models(), FUSION_COMMAND_CONTEXT_POLICY_ID, 'reason');
    const inspectBudget = new FusionBudget(models(), FUSION_COMMAND_CONTEXT_POLICY_ID, 'inspect');
    const researchBudget = new FusionBudget(models(), FUSION_COMMAND_CONTEXT_POLICY_ID, 'research');
    const reasonCandidate = planEntry(reasonBudget.plan(input).stages, 'candidate', 1);
    const inspectCandidate = planEntry(inspectBudget.plan(input).stages, 'candidate', 1);
    const researchCandidate = planEntry(researchBudget.plan(input).stages, 'candidate', 1);
    const expectedInspectDelta =
      Buffer.byteLength(FUSION_CANDIDATE_INSPECT_SYSTEM_PROMPT, 'utf8') -
      Buffer.byteLength(FUSION_CANDIDATE_SYSTEM_PROMPT, 'utf8');
    const expectedResearchDelta =
      Buffer.byteLength(FUSION_CANDIDATE_RESEARCH_SYSTEM_PROMPT, 'utf8') -
      Buffer.byteLength(FUSION_CANDIDATE_SYSTEM_PROMPT, 'utf8');
    assert.notEqual(FUSION_CANDIDATE_INSPECT_SYSTEM_PROMPT, FUSION_CANDIDATE_SYSTEM_PROMPT);
    assert.notEqual(FUSION_CANDIDATE_RESEARCH_SYSTEM_PROMPT, FUSION_CANDIDATE_SYSTEM_PROMPT);
    assert.match(FUSION_CANDIDATE_INSPECT_SYSTEM_PROMPT, /read-only tools: read, grep, find, ls/);
    assert.match(FUSION_CANDIDATE_RESEARCH_SYSTEM_PROMPT, /fusion_web_fetch/);
    assert.equal(inspectCandidate.input_utf8_bytes - reasonCandidate.input_utf8_bytes, expectedInspectDelta);
    assert.equal(researchCandidate.input_utf8_bytes - reasonCandidate.input_utf8_bytes, expectedResearchDelta);
    assert.notEqual(inspectCandidate.input_utf8_bytes, reasonCandidate.input_utf8_bytes);
    assert.notEqual(researchCandidate.input_utf8_bytes, reasonCandidate.input_utf8_bytes);
  });

  void it('gives each clean workflow distinct request-budget remediation', () => {
    const request = 'scope '.repeat(180_000);
    const profiles = [
      { workflow: 'investigate', profile: FUSION_INVESTIGATE_WORKFLOW },
      { workflow: 'research', profile: FUSION_RESEARCH_WORKFLOW },
      { workflow: 'validate', profile: FUSION_VALIDATE_WORKFLOW },
    ] as const;
    const remediation = profiles.map(({ workflow, profile }) => {
      const built = buildFusionCleanTaskCanonicalInput({
        cwd: '/repo',
        source: 'tool',
        request,
        workflow,
        ...(workflow === 'research'
          ? { declaredSources: [{ url: 'https://example.com/', purpose: 'primary source' }] }
          : {}),
      });
      const budget = new FusionBudget(
        models({ small: 200_000, large: 200_000 }),
        built.input.context.policy_id,
        profile.candidateCapability,
        profile,
      );
      const plan = budget.plan(built.input);
      assert.ok(plan.primary_blocker, `${profile.id} fixture must exceed its request budget`);
      let captured: FusionError | undefined;
      try {
        budget.assertPlanFits(plan, 'unit-test');
      } catch (error) {
        assert.ok(error instanceof FusionError);
        captured = error;
      }
      assert.ok(captured?.budget);
      assert.equal(captured.budget.counterfactuals.empty_request.still_fails_with_empty_request, false);
      assert.doesNotMatch(captured.budget.remediation.join('\n'), /fresh (?:Pi )?conversation/i);
      return captured.budget.remediation.join('\n');
    });
    const [investigate, research, validate] = remediation;
    assert.ok(investigate && research && validate);
    assert.match(investigate, /fusion_investigate/);
    assert.match(research, /fusion_research/);
    assert.match(validate, /fusion_validate/);
    assert.equal(new Set(remediation).size, 3);
    assert.doesNotMatch(investigate, /source sets/i);
    assert.doesNotMatch(validate, /source sets/i);
  });

  void it('reproduces the compact incident plan as fitting with utilization warnings', () => {
    const budget = new FusionBudget(models({ small: 272_000, large: 272_000 }), FUSION_COMMAND_CONTEXT_POLICY_ID);
    const input = canonicalInputWithPromptBytes(214_068);
    const plan = budget.plan(input);
    assert.equal(plan.blockers.length, 0);
    assert.equal(planEntry(plan.stages, 'candidate', 1).fits, true);
    assert.equal(planEntry(plan.stages, 'evaluation').fits, true);
    assert.equal(planEntry(plan.stages, 'merge').fits, true);
    assert.equal(planEntry(plan.stages, 'evaluation_repair').fits, true);
    assert.ok(planEntry(plan.stages, 'merge').input_only_signed_headroom_tokens > 0);
    assert.ok(planEntry(plan.stages, 'evaluation_repair').input_only_signed_headroom_tokens > 0);
    assert.ok(plan.warnings.length >= 2);
    assert.equal(
      plan.warnings.some((entry) => entry.budget_stage === 'merge'),
      true,
    );
    assert.equal(
      plan.warnings.some((entry) => entry.budget_stage === 'evaluation_repair'),
      true,
    );
    for (const warning of plan.warnings) {
      assert.ok(
        warning.utilization_basis_points >= FUSION_UTILIZATION_WARNING_THRESHOLD_BASIS_POINTS ||
          warning.reservation_fits === false,
      );
    }
  });

  void it('emits one advisory utilization progress event on a tight fitting plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-budget-warning-'));
    try {
      const events: string[] = [];
      const runner: FusionChildRunner = async (options) => {
        if (options.stage === 'candidate') return childResult(options, 'candidate answer');
        if (options.stage === 'evaluation') return childResult(options, JSON.stringify(evaluation()));
        return childResult(options, 'merged');
      };
      await new FusionOrchestrator({ childRunner: runner }).run({
        source: 'command',
        cwd: root,
        canonicalInput: canonicalInputWithPromptBytes(214_068),
        canonicalInputSerialized: JSON.stringify(canonicalInputWithPromptBytes(214_068)),
        contextLedger: ledger,
        config: defaultFusionModelConfig(),
        models: models({ small: 272_000, large: 272_000 }),
        onProgress: (event) => {
          if (event.type === 'budget_warning') events.push(String(event.warnings.length));
        },
      });
      assert.equal(events.length, 1);
      assert.ok(Number(events[0]) >= 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('lets safe prompts proceed through all five calls and persists the budget plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-budget-ok-'));
    try {
      const calls: RunPiChildOptions[] = [];
      const runner: FusionChildRunner = async (options) => {
        calls.push(options);
        if (options.stage === 'candidate') return childResult(options, 'candidate answer');
        if (options.stage === 'evaluation')
          return childResult(options, JSON.stringify(evaluation()));
        return childResult(options, 'merged');
      };
      const input = canonicalInput('a reasonable amount of conversation text');
      const result = await new FusionOrchestrator({ childRunner: runner }).run({
        source: 'command',
        cwd: root,
        canonicalInput: input,
        canonicalInputSerialized: JSON.stringify(input),
        contextLedger: ledger,
        config: defaultFusionModelConfig(),
        models: models(),
      });
      assert.equal(result.mergedText, 'merged');
      assert.equal(calls.length, 5);
      assert.equal(result.details.budget.policy_id, 'fusion-budget-policy-v4');
      assert.equal(result.details.budget.calibration_warnings.length, 0);

      const planText = await readFile(
        join(root, result.details.artifact_dir, 'budget-plan.json'),
        'utf8',
      );
      const plan = parseJsonText(planText);
      assert.ok(typeof plan === 'object' && plan !== null);
      const routes = Reflect.get(plan, 'routes');
      assert.ok(Array.isArray(routes));
      assert.equal(routes.length, 5, 'every configured route must be snapshotted');
      assert.equal(
        routes.some((route) => Reflect.get(route, 'qualified_id') === 'openai-codex/gpt-5.4-mini'),
        true,
      );
      assert.equal(Reflect.get(plan, 'schema_version'), 'pi-background-tasks.fusion-budget-plan.v4');
      const stages = Reflect.get(plan, 'stages');
      assert.ok(Array.isArray(stages));
      assert.equal(stages.length, 6);
      assert.equal(Array.isArray(Reflect.get(plan, 'warnings')), true);

      const ledgerText = await readFile(
        join(root, result.details.artifact_dir, 'context-omission-ledger.json'),
        'utf8',
      );
      assert.match(ledgerText, /visible-conversation-ledger-v2/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('does not let an unrecognised model inherit a known provider calibration', () => {
    const resolvedFamily = resolveTokenBudgetFamily({ provider: 'openai-codex', model: 'future-tokenizer' });
    assert.equal(resolvedFamily.family, 'openai-codex');
    assert.equal(resolvedFamily.backed, false);
    assert.equal(resolvedFamily.resolution, 'known_provider_unbacked_model');
    const unrecognised: ResolvedFusionModels = {
      candidates: [
        resolved('openai-codex/future-tokenizer', 400_000),
        resolved('openai-codex/future-tokenizer', 400_000),
        resolved('openai-codex/future-tokenizer', 400_000),
      ],
      evaluator: resolved('openai-codex/future-tokenizer', 400_000),
      merger: resolved('openai-codex/future-tokenizer', 400_000),
    };
    const budget = new FusionBudget(unrecognised, FUSION_COMMAND_CONTEXT_POLICY_ID);
    assert.equal(budget.routes.every((route) => route.rate_source.source === 'unbacked_model_floor'), true);
    assert.equal(budget.routes.every((route) => route.rate_source.backed === false), true);
    assert.equal(
      budget.routes.every((route) => route.rate_source.effective_rate_bytes_per_token_x100 === TOKEN_BUDGET_PROVABLE_RATE_X100),
      true,
    );
  });

  void it('surfaces unknown provider calibration in completed result details', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-budget-unknown-'));
    try {
      const runner: FusionChildRunner = async (options) => {
        if (options.stage === 'candidate') return childResult(options, 'candidate answer');
        if (options.stage === 'evaluation') return childResult(options, JSON.stringify(evaluation()));
        return childResult(options, 'merged');
      };
      const unknownModels: ResolvedFusionModels = {
        candidates: [
          resolved('mystery/a', 400_000),
          resolved('mystery/b', 400_000),
          resolved('mystery/c', 400_000),
        ],
        evaluator: resolved('mystery/e', 400_000),
        merger: resolved('mystery/m', 400_000),
      };
      const input = canonicalInput('small');
      const result = await new FusionOrchestrator({ childRunner: runner }).run({
        source: 'command',
        cwd: root,
        canonicalInput: input,
        canonicalInputSerialized: JSON.stringify(input),
        contextLedger: ledger,
        config: defaultFusionModelConfig(),
        models: unknownModels,
      });
      assert.equal(result.details.budget.unknown_provider_warnings.length, 5);
      assert.equal(result.details.budget.rate_sources.every((source) => source.family === 'unknown'), true);
      assert.match(result.details.budget.unknown_provider_warnings.join('\n'), /unknown provider/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('writes and surfaces a calibration violation without aborting success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-budget-breach-'));
    try {
      const events: string[] = [];
      const runner: FusionChildRunner = async (options) => {
        const result =
          options.stage === 'evaluation'
            ? childResult(options, JSON.stringify(evaluation()))
            : options.stage === 'merge'
              ? childResult(options, 'merged')
              : childResult(options, 'candidate answer');
        if (options.stage === 'candidate' && options.slot === 1) {
          result.usage.input = 1_000_000;
          result.usage.totalTokens = 1_000_001;
          result.firstRequestUsage = { ...result.usage, cost: { ...result.usage.cost } };
          result.providerRequestCount = 1;
        }
        return result;
      };
      const input = canonicalInput('small');
      const result = await new FusionOrchestrator({ childRunner: runner }).run({
        source: 'command',
        cwd: root,
        canonicalInput: input,
        canonicalInputSerialized: JSON.stringify(input),
        contextLedger: ledger,
        config: defaultFusionModelConfig(),
        models: models(),
        onProgress: (event) => {
          if (event.type === 'calibration_warning') events.push(event.artifact);
        },
      });
      assert.equal(result.mergedText, 'merged');
      assert.equal(result.details.budget.calibration_warnings.length, 1);
      assert.equal(events.length, 1);
      const artifact = await readFile(
        join(root, result.details.artifact_dir, 'candidate-1.attempt-1.calibration-violation.json'),
        'utf8',
      );
      const parsed = parseJsonText(artifact);
      assert.ok(typeof parsed === 'object' && parsed !== null);
      assert.equal(Reflect.get(parsed, 'schema_version'), 'pi-background-tasks.fusion-calibration-violation.v2');
      assert.equal(Reflect.get(parsed, 'observation_scope'), 'first_provider_request');
      assert.equal(Reflect.get(parsed, 'provider_request_count'), 1);
      assert.equal(Reflect.get(parsed, 'billed_input_tokens'), 1_000_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('does not compare a one-request forecast with cumulative agent-loop cache usage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-budget-loop-scope-'));
    try {
      const runner: FusionChildRunner = (options) => {
        const result = childResult(
          options,
          options.stage === 'evaluation'
            ? JSON.stringify(evaluation())
            : options.stage === 'merge'
              ? 'merged'
              : 'candidate answer',
        );
        result.firstRequestUsage = {
          input: 2,
          output: 10,
          cacheRead: 0,
          cacheWrite: 100,
          totalTokens: 112,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        result.providerRequestCount = 49;
        result.usage = {
          input: 100,
          output: 100_000,
          cacheRead: 4_500_000,
          cacheWrite: 200_000,
          totalTokens: 4_800_100,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        return Promise.resolve(result);
      };
      const input = canonicalInput('small');
      const result = await new FusionOrchestrator({ childRunner: runner }).run({
        source: 'command',
        cwd: root,
        canonicalInput: input,
        canonicalInputSerialized: JSON.stringify(input),
        contextLedger: ledger,
        config: defaultFusionModelConfig(),
        models: models(),
      });
      assert.equal(result.details.budget.calibration_warnings.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('writes the budget plan before rejecting so the decision stays auditable', async () => {
    const oversized = canonicalInput('u'.repeat(600_000));
    const outcome = await runExpectingFailure(oversized, async (options) =>
      childResult(options, 'unreachable'),
    );
    try {
      const planText = await readFile(
        join(outcome.root, outcome.artifactDir, 'budget-plan.json'),
        'utf8',
      );
      const plan = parseJsonText(planText);
      assert.ok(typeof plan === 'object' && plan !== null);
      const primary = Reflect.get(plan, 'primary_blocker');
      assert.ok(typeof primary === 'object' && primary !== null);
      assert.equal(Reflect.get(primary, 'fits'), false);
      const composition = Reflect.get(plan, 'primary_blocker_composition');
      assert.ok(typeof composition === 'object' && composition !== null);
    } finally {
      await rm(outcome.root, { recursive: true, force: true });
    }
  });

  void it('keeps a real 1 MB tool-heavy session within the smallest configured budget', () => {
    const session = sessionWith([
      userMessage('genuine user question about the failing build'),
      {
        role: 'assistant',
        api: 'openai-codex-responses',
        provider: 'openai-codex',
        model: 'gpt-5.5',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'toolUse',
        content: [
          { type: 'thinking', thinking: 'x'.repeat(10_303) },
          { type: 'text', text: 'assistant analysis kept verbatim' },
          {
            type: 'toolCall',
            id: 'c1',
            name: 'read',
            arguments: { blob: 'a'.repeat(251_508) },
          },
        ],
        timestamp: 2,
      },
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'read',
        content: [{ type: 'text', text: 'r'.repeat(696_929) }],
        details: { ok: true },
        isError: false,
        timestamp: 3,
      },
    ]);
    const built = buildFusionCanonicalInput(
      { cwd: '/tmp/project', sessionManager: session, getSystemPrompt: () => 'sys' },
      { source: 'tool', request: 'reproduce the original failure shape' },
    );
    // The pre-fix transcript for this shape was ~1,034,667 bytes.
    assert.ok(
      built.serialized.length < 10_000,
      `projected canonical input must be small, saw ${String(built.serialized.length)}`,
    );
    const budget = new FusionBudget(models(), built.input.conversation_projection.policy.id);
    const plan = budget.plan(built.input);
    assert.equal(plan.blockers.length, 0);
    assert.doesNotThrow(() => {
      budget.assertPlanFits(plan, 'unit-test');
    });
  });
});
