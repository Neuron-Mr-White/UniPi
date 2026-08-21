import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Buffer } from '../attested-pi-run.js';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalJson } from '../attested-pi-run.js';
import { parseJsonText } from '../types.js';
import {
  FUSION_FAILURE_SUMMARY_ATTEMPT_CAP,
  FUSION_FAILURE_SUMMARY_EVIDENCE_CAP,
  FusionArtifactStore,
  buildFusionFailureSummary,
  buildFusionRunProgress,
} from '../fusion/artifacts.js';
import { defaultFusionModelConfig } from '../fusion/config.js';
import { readFusionCommittedResult, readFusionFailureResult } from '../fusion/result-package.js';
import {
  FUSION_FAILURE_SUMMARY_SCHEMA_VERSION,
  FUSION_RESULT_SCHEMA_VERSION,
  FUSION_TOOL_CALL_LOG_SCHEMA_VERSION,
  FusionError,
  addFusionUsage,
  cloneFusionUsage,
  createEmptyFusionUsage,
  type FusionChildRunResult,
  type FusionResultDetails,
  type ResolvedFusionModel,
  type ResolvedFusionModels,
} from '../fusion/types.js';

function resolved(qualifiedId: string): ResolvedFusionModel {
  const slash = qualifiedId.indexOf('/');
  const provider = qualifiedId.slice(0, slash);
  const model = qualifiedId.slice(slash + 1);
  return {
    selection: '$current',
    source: 'current',
    provider,
    model,
    qualifiedId,
    thinkingLevel: 'medium',
    contextWindow: 1000,
    maxOutputTokens: 128,
  };
}

function models(): ResolvedFusionModels {
  return {
    candidates: [resolved('p/a'), resolved('p/b'), resolved('p/c')],
    evaluator: resolved('p/e'),
    merger: resolved('p/m'),
  };
}

function childResult(
  stage: 'candidate' | 'evaluation' | 'merge',
  text: string,
): FusionChildRunResult {
  const result: FusionChildRunResult = {
    stage,
    attempt: 1,
    provider: 'p',
    model: 'a',
    qualifiedId: 'p/a',
    text,
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    },
    events: Buffer.from('{"schema_version":"pi-background-tasks.fusion-child-result.v4"}\n'),
    stderr: Buffer.from('stderr'),
    exitCode: 0,
    signal: null,
  };
  if (stage === 'candidate') result.slot = 1;
  return result;
}

function parseManifest(text: string): object {
  const parsed = parseJsonText(text);
  assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed));
  return parsed;
}

function field(record: object, key: string): unknown {
  return Reflect.get(record, key);
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), label);
  return value as Record<string, unknown>;
}

async function createVerifiedFailureStore(
  root: string,
  terminalState: 'failed' | 'cancelled' = 'failed',
): Promise<{ store: FusionArtifactStore; summary: ReturnType<typeof buildFusionFailureSummary> }> {
  const store = await FusionArtifactStore.create({
    cwd: root,
    runId: `reason-${terminalState === 'failed' ? '4' : '5'}`.padEnd(39, terminalState === 'failed' ? '4' : '5'),
    source: 'tool',
    config: defaultFusionModelConfig(),
    models: models(),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
  await store.transition('candidates_running');
  await store.recordFailedAttempt({
    stage: 'candidate',
    slot: 1,
    attempt: 1,
    systemPrompt: 'system',
    prompt: 'prompt',
    events: Buffer.from('STAGE_OUTPUT_BODY_MUST_NOT_BE_READ'),
    partialResponse: Buffer.from('PARTIAL_STAGE_OUTPUT_MUST_NOT_BE_READ'),
    stderr: Buffer.from('stderr'),
    error: 'candidate failed',
    status: terminalState,
    childCreated: true,
    responseKind: 'md',
  });
  const message = `${terminalState} terminal error`;
  await store.writeError(terminalState, message);
  const manifest = store.snapshot();
  const summary = buildFusionFailureSummary({
    manifest,
    terminalError: new FusionError(message, {
      code: terminalState === 'cancelled' ? 'child_cancelled' : 'child_exit_failed',
      stage: 'candidate',
      slot: 1,
      attempt: 1,
      childCreated: true,
    }),
    progress: buildFusionRunProgress(manifest),
    terminalState,
    createdAt: manifest.updated_at,
  });
  await store.writeFailureSummary(summary);
  return { store, summary };
}

async function rewriteBoundFailureSummary(
  store: FusionArtifactStore,
  value: Buffer | unknown,
): Promise<void> {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  await writeFile(join(store.artifactDirAbs, 'failure-summary.json'), bytes);
  const manifest = record(
    parseManifest(await readFile(join(store.artifactDirAbs, 'manifest.json'), 'utf8')),
    'manifest',
  );
  const artifacts = record(manifest['artifacts'], 'artifacts');
  artifacts['failure-summary.json'] = {
    path: 'failure-summary.json',
    byte_length: bytes.length,
    sha256: sha256Buffer(bytes),
  };
  await writeFile(
    join(store.artifactDirAbs, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

void describe('fusion artifacts', () => {
  void it('preserves and aggregates one-hour cache writes and reasoning subsets', () => {
    const usage = {
      input: 10,
      output: 8,
      cacheRead: 6,
      cacheWrite: 4,
      cacheWrite1h: 3,
      reasoning: 5,
      totalTokens: 28,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
    };
    assert.deepEqual(cloneFusionUsage(usage), usage);

    const total = createEmptyFusionUsage();
    addFusionUsage(total, usage);
    addFusionUsage(total, {
      input: 2,
      output: 3,
      cacheRead: 5,
      cacheWrite: 7,
      cacheWrite1h: 6,
      reasoning: 2,
      totalTokens: 17,
      cost: { input: 0.02, output: 0.03, cacheRead: 0.05, cacheWrite: 0.07, total: 0.17 },
    });
    assert.equal(total.cacheWrite1h, 9);
    assert.equal(total.reasoning, 7);
    assert.equal(total.cacheWrite, 11);
    assert.equal(total.output, 11);
  });

  void it('creates private run files and records child attempt artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-artifacts-'));
    try {
      const store = await FusionArtifactStore.create({
        cwd: root,
        sessionId: 'session/id',
        runId: 'reason-00000000000000000000000000000000',
        source: 'command',
        config: defaultFusionModelConfig(),
        models: models(),
        capabilities: { candidate: 'inspect', evaluation: 'reason', merge: 'reason' },
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      });
      // Normalize separators: the artifact dir uses native path separators, so
      // it is backslash-delimited on Windows.
      assert.match(store.artifactDir.replaceAll('\\', '/'), /^\.pi\/fusion\/session-id-/);
      const dirMode = (await stat(store.artifactDirAbs)).mode & 0o777;
      // Windows has no POSIX permission bits; NTFS ACLs are not modelled here.
      if (process.platform !== 'win32') assert.equal(dirMode, 0o700);
      await store.writeCanonicalInput('{"request":"x"}');
      await store.transition('candidates_running');
      await store.recordChildAttempt({
        result: childResult('candidate', 'answer'),
        systemPrompt: 'system prompt',
        prompt: 'prompt',
        responseKind: 'md',
      });
      const responsePath = join(store.artifactDirAbs, 'candidate-1.attempt-1.response.md');
      assert.equal(await readFile(responsePath, 'utf8'), 'answer');
      if (process.platform !== 'win32')
        assert.equal((await stat(responsePath)).mode & 0o777, 0o600);
      const manifest = parseManifest(
        await readFile(join(store.artifactDirAbs, 'manifest.json'), 'utf8'),
      );
      assert.equal(field(manifest, 'state'), 'candidates_running');
      assert.deepEqual(field(manifest, 'capabilities'), {
        candidate: 'inspect',
        evaluation: 'reason',
        merge: 'reason',
      });
      const attempts = field(manifest, 'attempts');
      assert.ok(Array.isArray(attempts));
      assert.equal(attempts.length, 1);
      const firstAttempt = attempts[0];
      assert.ok(typeof firstAttempt === 'object' && firstAttempt !== null);
      assert.equal(field(firstAttempt, 'response_path'), 'candidate-1.attempt-1.response.md');
      assert.equal(field(firstAttempt, 'tool_calls_path'), undefined);
      assert.equal(field(firstAttempt, 'tool_calls'), undefined);
      assert.equal(field(firstAttempt, 'provider'), 'p');
      assert.equal(field(firstAttempt, 'qualifiedId'), 'p/a');
      const usageRecord = field(firstAttempt, 'usage');
      assert.ok(typeof usageRecord === 'object' && usageRecord !== null);
      assert.equal(field(usageRecord, 'totalTokens'), 3);
      assert.deepEqual(field(usageRecord, 'cost'), {
        input: 0.01,
        output: 0.02,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.03,
      });
      assert.deepEqual(
        (await readdir(store.artifactDirAbs)).filter((entry) => entry.endsWith('.tmp')),
        [],
      );
      const artifacts = field(manifest, 'artifacts');
      assert.ok(typeof artifacts === 'object' && artifacts !== null);
      assert.ok(Reflect.has(artifacts, 'canonical-input.json'));
      assert.equal(Reflect.has(artifacts, 'candidate-1.attempt-1.tool-calls.jsonl'), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('records same-session output recovery without putting original text in the manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-artifacts-output-recovery-'));
    try {
      const store = await FusionArtifactStore.create({
        cwd: root,
        runId: 'reason-00000000000000000000000000000002',
        source: 'command',
        config: defaultFusionModelConfig(),
        models: models(),
      });
      const result = childResult('candidate', 'compressed answer');
      const original = 'o'.repeat(50_000);
      result.outputRecovery = {
        kind: 'same_session_compression',
        limit_bytes: 49_152,
        original_record_index: 0,
        replacement_record_index: 1,
        original_json_rendered_bytes: 50_002,
        replacement_json_rendered_bytes: 19,
        original_text_sha256: createHash('sha256').update(original).digest('hex'),
        original_text: original,
        status: 'completed',
      };
      await store.recordChildAttempt({
        result,
        systemPrompt: 'system prompt',
        prompt: 'prompt',
        responseKind: 'md',
      });
      assert.equal(
        await readFile(
          join(store.artifactDirAbs, 'candidate-1.attempt-1.response.oversized.md'),
          'utf8',
        ),
        original,
      );
      const manifest = parseManifest(
        await readFile(join(store.artifactDirAbs, 'manifest.json'), 'utf8'),
      );
      const attempts = field(manifest, 'attempts');
      assert.ok(Array.isArray(attempts));
      const attempt: unknown = attempts[0];
      assert.ok(typeof attempt === 'object' && attempt !== null);
      assert.equal(field(attempt, 'child_created'), true);
      assert.deepEqual(field(attempt, 'output_recovery'), {
        kind: 'same_session_compression',
        status: 'completed',
        limit_bytes: 49_152,
        original_response_path: 'candidate-1.attempt-1.response.oversized.md',
        original_record_index: 0,
        replacement_record_index: 1,
        original_json_rendered_bytes: 50_002,
        replacement_json_rendered_bytes: 19,
        original_text_sha256: createHash('sha256').update(original).digest('hex'),
      });
      assert.equal(JSON.stringify(manifest).includes(original), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('records completed child tool-call logs and summaries on attempts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-artifacts-tools-'));
    try {
      const store = await FusionArtifactStore.create({
        cwd: root,
        runId: 'reason-00000000000000000000000000000001',
        source: 'command',
        config: defaultFusionModelConfig(),
        models: models(),
        capabilities: { candidate: 'inspect', evaluation: 'reason', merge: 'reason' },
      });
      const result = childResult('candidate', 'answer');
      const logText =
        `${JSON.stringify({
          schema_version: FUSION_TOOL_CALL_LOG_SCHEMA_VERSION,
          ordinal: 0,
          tool_name: 'read',
          arguments_sha256: 'a'.repeat(64),
          arguments_bytes: 17,
          result_bytes: 23,
          result_sha256: 'b'.repeat(64),
          status: 'ok',
          duration_ms: 4,
        })}\n` +
        `${JSON.stringify({
          schema_version: FUSION_TOOL_CALL_LOG_SCHEMA_VERSION,
          ordinal: 1,
          tool_name: 'grep',
          arguments_sha256: 'c'.repeat(64),
          arguments_bytes: 19,
          result_bytes: 29,
          result_sha256: 'd'.repeat(64),
          status: 'error',
          duration_ms: 8,
        })}\n`;
      result.toolCallTrace = {
        bytes: Buffer.from(logText, 'utf8'),
        records: [],
        summary: { count: 2, total_result_bytes: 52, trace_complete: true },
      };
      await store.recordChildAttempt({
        result,
        systemPrompt: 'system prompt',
        prompt: 'prompt',
        responseKind: 'md',
      });
      assert.equal(
        await readFile(
          join(store.artifactDirAbs, 'candidate-1.attempt-1.tool-calls.jsonl'),
          'utf8',
        ),
        logText,
      );
      const manifest = parseManifest(
        await readFile(join(store.artifactDirAbs, 'manifest.json'), 'utf8'),
      );
      const attempts = field(manifest, 'attempts');
      assert.ok(Array.isArray(attempts));
      const firstAttempt = attempts[0];
      assert.ok(typeof firstAttempt === 'object' && firstAttempt !== null);
      assert.equal(
        field(firstAttempt, 'tool_calls_path'),
        'candidate-1.attempt-1.tool-calls.jsonl',
      );
      assert.deepEqual(field(firstAttempt, 'tool_calls'), {
        count: 2,
        total_result_bytes: 52,
        trace_complete: true,
      });
      const artifacts = field(manifest, 'artifacts');
      assert.ok(typeof artifacts === 'object' && artifacts !== null);
      assert.ok(Reflect.has(artifacts, 'candidate-1.attempt-1.tool-calls.jsonl'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('enforces lifecycle ordering and durable merge before completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-state-'));
    try {
      const store = await FusionArtifactStore.create({
        cwd: root,
        runId: 'reason-11111111111111111111111111111111',
        source: 'tool',
        config: defaultFusionModelConfig(),
        models: models(),
      });
      await assert.rejects(store.transition('evaluating'), /illegal fusion state transition/);
      await store.transition('candidates_running');
      await store.transition('candidates_complete');
      await store.transition('evaluating');
      await store.transition('evaluation_complete');
      await store.transition('merging');
      await assert.rejects(store.transition('completed'), /merged\.md/);
      const merged = await store.writeMerged('final');
      await assert.rejects(store.transition('completed'), /result\.json/);
      const details: FusionResultDetails = {
        schema_version: FUSION_RESULT_SCHEMA_VERSION,
        run_id: store.runId,
        workflow: 'reason',
        source: 'tool',
        status: 'completed',
        context: { kind: 'session_projection', policy_id: 'test-policy' },
        tool_policy: { candidate_tools: [], evaluation_tools: [], merge_tools: [] },
        artifact_dir: store.artifactDir,
        models: store.snapshot().models,
        evaluator_attempts: 1,
        usage: {
          input: 2,
          output: 13,
          cacheRead: 3,
          cacheWrite: 11,
          cacheWrite1h: 7,
          reasoning: 5,
          totalTokens: 29,
          cost: { input: 0.02, output: 0.13, cacheRead: 0.003, cacheWrite: 0.066, total: 0.219 },
        },
        budget: {
          policy_id: 'test-policy',
          calibration_version: 'test',
          route_table: [],
          rate_sources: [],
          unknown_provider_warnings: [],
          calibration_warnings: [],
        },
      };
      await store.writeCommittedResult(merged, details);
      await store.transition('completed');
      const manifest = parseManifest(
        await readFile(join(store.artifactDirAbs, 'manifest.json'), 'utf8'),
      );
      assert.equal(field(manifest, 'state'), 'completed');
      assert.equal(await readFile(join(store.artifactDirAbs, 'merged.md'), 'utf8'), 'final');
      const verified = await readFusionCommittedResult({
        artifactDirAbs: store.artifactDirAbs,
        artifactDir: store.artifactDir,
        runId: store.runId,
        workflow: 'reason',
      });
      assert.equal(verified.mergedText, 'final');
      assert.equal(verified.details.usage.cacheWrite1h, 7);
      assert.equal(verified.details.usage.reasoning, 5);
      await writeFile(join(store.artifactDirAbs, 'merged.md'), 'tampered', 'utf8');
      await assert.rejects(
        readFusionCommittedResult({
          artifactDirAbs: store.artifactDirAbs,
          artifactDir: store.artifactDir,
          runId: store.runId,
          workflow: 'reason',
        }),
        /does not match its committed hash and length/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('writes a canonical manifest-bound failure summary without stage-output bodies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-failure-summary-'));
    try {
      const store = await FusionArtifactStore.create({
        cwd: root,
        runId: 'reason-33333333333333333333333333333333',
        source: 'tool',
        config: defaultFusionModelConfig(),
        models: models(),
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      });
      await store.transition('candidates_running');
      await store.recordChildAttempt({
        result: childResult('candidate', 'COMPLETE_RESPONSE_SENTINEL'),
        systemPrompt: 'system', prompt: 'prompt', responseKind: 'md',
      });
      const oversized = `OVERSIZED_RESPONSE_SENTINEL${'o'.repeat(50_000)}`;
      await store.recordFailedAttempt({
        stage: 'candidate', slot: 2, attempt: 1, systemPrompt: 'system', prompt: 'prompt',
        events: Buffer.from('TOOL_OUTPUT_SENTINEL'), stderr: Buffer.from('stderr'),
        partialResponse: Buffer.from('PARTIAL_RESPONSE_SENTINEL'),
        error: 'candidate failure', status: 'failed', childCreated: true, responseKind: 'md',
        outputRecovery: {
          kind: 'same_session_compression', limit_bytes: 49_152, original_record_index: 0,
          replacement_record_index: null,
          original_json_rendered_bytes: Buffer.byteLength(JSON.stringify(oversized), 'utf8'),
          replacement_json_rendered_bytes: null,
          original_text_sha256: createHash('sha256').update(oversized).digest('hex'),
          original_text: oversized, status: 'failed',
        },
      });
      await store.writeError('failed', 'terminal error');
      const manifest = store.snapshot();
      const summary = buildFusionFailureSummary({
        manifest,
        terminalError: new FusionError('terminal error', {
          code: 'child_output_cap', stage: 'candidate', slot: 2, attempt: 1, childCreated: true,
        }),
        progress: {
          manifest_state: 'failed',
          candidates: { status: 'incomplete', attempts_recorded: 2, children_created: 2, children_completed: 1, children_failed: 1, children_cancelled: 0, not_started_slots: 1 },
          evaluation: { status: 'not_started', attempts_recorded: 0, children_created: 0, children_completed: 0, children_failed: 0, children_cancelled: 0 },
          merge: { status: 'not_started', attempts_recorded: 0, children_created: 0, children_completed: 0, children_failed: 0, children_cancelled: 0 },
          usage_so_far: manifest.usage,
        },
        terminalState: 'failed', createdAt: manifest.updated_at,
      });
      const summaryRef = await store.writeFailureSummary(summary);
      const summaryBytes = await readFile(join(store.artifactDirAbs, 'failure-summary.json'));
      assert.equal(sha256Buffer(summaryBytes), summaryRef.sha256);
      assert.equal(summaryBytes.length, summaryRef.byte_length);
      assert.doesNotMatch(summaryBytes.toString('utf8'), /COMPLETE_RESPONSE_SENTINEL|PARTIAL_RESPONSE_SENTINEL|OVERSIZED_RESPONSE_SENTINEL|TOOL_OUTPUT_SENTINEL/);
      const finalManifest = parseManifest(await readFile(join(store.artifactDirAbs, 'manifest.json'), 'utf8'));
      const artifacts = field(finalManifest, 'artifacts');
      assert.ok(typeof artifacts === 'object' && artifacts !== null);
      assert.deepEqual(Reflect.get(artifacts, 'failure-summary.json'), summaryRef);
      const verified = await readFusionFailureResult({
        artifactDirAbs: store.artifactDirAbs, artifactDir: store.artifactDir, runId: store.runId, workflow: 'reason',
      });
      assert.equal(verified.schema_version, FUSION_FAILURE_SUMMARY_SCHEMA_VERSION);
      assert.equal(verified.summary_status, 'verified');
      assert.equal(verified.failure_summary_ref?.sha256, summaryRef.sha256);
      const classes = new Map(verified.evidence_artifacts?.listed.map((entry) => [entry.name, entry.classification]));
      assert.equal(classes.get('candidate-1.attempt-1.response.md'), 'complete_stage_output');
      assert.equal(classes.get('candidate-2.attempt-1.response.partial.md'), 'partial_stage_output');
      assert.equal(classes.get('candidate-2.attempt-1.response.oversized.md'), 'oversized_original');
      assert.equal(classes.get('candidate-2.attempt-1.response.md'), 'empty_rejected_output');
      assert.equal(classes.get('candidate-2.attempt-1.events.jsonl'), 'evidence_only');
      await writeFile(join(store.artifactDirAbs, 'failure-summary.json'), '{"corrupt":true}\n', 'utf8');
      const corrupt = await readFusionFailureResult({
        artifactDirAbs: store.artifactDirAbs, artifactDir: store.artifactDir, runId: store.runId, workflow: 'reason',
      });
      assert.equal(corrupt.summary_status, 'integrity_failed');
      assert.equal(corrupt.evidence_artifacts, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('rejects invalid summary lifecycle, identity, no-answer, and duplicate-write inputs at runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-summary-guards-'));
    try {
      const unstarted = await FusionArtifactStore.create({
        cwd: root,
        runId: 'reason-66666666666666666666666666666666',
        source: 'tool',
        config: defaultFusionModelConfig(),
        models: models(),
      });
      await assert.rejects(
        unstarted.writeFailureSummary({} as never),
        /failed\/cancelled terminal manifest/,
      );

      const terminalRoot = await mkdtemp(join(root, 'terminal-'));
      const { store, summary } = await createVerifiedFailureStore(terminalRoot);
      await assert.rejects(
        store.writeFailureSummary({ ...summary, answer: { present: true } } as never),
        /no answer was committed/,
      );
      await assert.rejects(
        store.writeFailureSummary({ ...summary, run_id: 'reason-foreign' }),
        /identity does not match/,
      );
      await assert.rejects(
        store.writeFailureSummary({ ...summary, terminal_state: 'cancelled' }),
        /terminal state does not match/,
      );
      await assert.rejects(store.writeFailureSummary(summary), /already bound/);
      await assert.rejects(
        Promise.resolve().then(() =>
          buildFusionFailureSummary({
            manifest: store.snapshot(),
            terminalError: new FusionError('different terminal error', {
              code: 'child_exit_failed',
              childCreated: true,
            }),
            progress: buildFusionRunProgress(store.snapshot()),
            terminalState: 'failed',
            createdAt: store.snapshot().updated_at,
          }),
        ),
        /terminal error does not match/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('keeps failure summaries deterministic and records exact source caps', () => {
    const manifest = {
      state: 'failed',
      run_id: 'reason-77777777777777777777777777777777',
      workflow: 'reason',
      source: 'tool',
      error: 'terminal error',
      usage: createEmptyFusionUsage(),
      attempts: Array.from({ length: FUSION_FAILURE_SUMMARY_ATTEMPT_CAP + 1 }, (_, index) => ({
        stage: 'candidate' as const,
        slot: ((index % 3) + 1) as 1 | 2 | 3,
        attempt: index + 1,
        status: 'failed' as const,
        child_created: true,
      })),
      artifacts: Object.fromEntries(
        Array.from({ length: FUSION_FAILURE_SUMMARY_EVIDENCE_CAP + 1 }, (_, index) => [
          `evidence-${String(index).padStart(2, '0')}.json`,
          {
            path: `evidence-${String(index).padStart(2, '0')}.json`,
            byte_length: index,
            sha256: `sha256:${String(index).padStart(64, '0')}`,
          },
        ]),
      ),
    } as never;
    const terminalError = new FusionError('terminal error', {
      code: 'child_exit_failed',
      childCreated: true,
    });
    const input = {
      manifest,
      terminalError,
      progress: buildFusionRunProgress(manifest),
      terminalState: 'failed' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const first = buildFusionFailureSummary(input);
    const second = buildFusionFailureSummary(input);
    assert.equal(canonicalJson(first), canonicalJson(second));
    assert.equal(first.attempts.listed.length, FUSION_FAILURE_SUMMARY_ATTEMPT_CAP);
    assert.equal(first.attempts.omitted_count, 1);
    assert.equal(first.evidence_artifacts.listed.length, FUSION_FAILURE_SUMMARY_EVIDENCE_CAP);
    assert.equal(first.evidence_artifacts.omitted_count, 1);
  });

  void it('returns verified failed/cancelled evidence without reading stage-output bodies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-summary-terminal-views-'));
    try {
      for (const terminalState of ['failed', 'cancelled'] as const) {
        const runRoot = await mkdtemp(join(root, `${terminalState}-`));
        const { store } = await createVerifiedFailureStore(runRoot, terminalState);
        await writeFile(
          join(store.artifactDirAbs, 'candidate-1.attempt-1.response.md'),
          Buffer.from([0xff]),
        );
        const view = await readFusionFailureResult({
          artifactDirAbs: store.artifactDirAbs,
          artifactDir: store.artifactDir,
          runId: store.runId,
          workflow: 'reason',
        });
        assert.equal(view.summary_status, 'verified');
        assert.equal(view.terminal_state, terminalState);
        assert.deepEqual(view.answer, { present: false, reason: 'run_did_not_commit' });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('fails closed for summary corruption, divergence, unsafe refs, and legacy manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-summary-integrity-'));
    try {
      const cases: Array<{
        name: string;
        mutate: (store: FusionArtifactStore) => Promise<void>;
        expected: 'integrity_failed' | 'unavailable' | 'legacy_manifest_only';
      }> = [
        {
          name: 'missing historical summary',
          async mutate(store) {
            const manifest = record(
              parseManifest(await readFile(join(store.artifactDirAbs, 'manifest.json'), 'utf8')),
              'manifest',
            );
            manifest['schema_version'] = 'pi-background-tasks.fusion-manifest.v3';
            delete record(manifest['artifacts'], 'artifacts')['failure-summary.json'];
            await writeFile(
              join(store.artifactDirAbs, 'manifest.json'),
              `${JSON.stringify(manifest, null, 2)}\n`,
              'utf8',
            );
          },
          expected: 'legacy_manifest_only',
        },
        {
          name: 'missing current summary file',
          async mutate(store) {
            await rm(join(store.artifactDirAbs, 'failure-summary.json'));
          },
          expected: 'integrity_failed',
        },
        {
          name: 'invalid UTF-8',
          mutate: (store) => rewriteBoundFailureSummary(store, Buffer.from([0xff])),
          expected: 'integrity_failed',
        },
        {
          name: 'invalid JSON',
          mutate: (store) => rewriteBoundFailureSummary(store, Buffer.from('{', 'utf8')),
          expected: 'integrity_failed',
        },
        {
          name: 'manifest summary hash mismatch',
          async mutate(store) {
            const manifest = record(
              parseManifest(await readFile(join(store.artifactDirAbs, 'manifest.json'), 'utf8')),
              'manifest',
            );
            record(manifest['artifacts'], 'artifacts')['failure-summary.json'] = {
              path: 'failure-summary.json',
              byte_length: 1,
              sha256: `sha256:${'0'.repeat(64)}`,
            };
            await writeFile(
              join(store.artifactDirAbs, 'manifest.json'),
              `${JSON.stringify(manifest, null, 2)}\n`,
              'utf8',
            );
          },
          expected: 'integrity_failed',
        },
        {
          name: 'manifest summary length mismatch',
          async mutate(store) {
            const manifest = record(
              parseManifest(await readFile(join(store.artifactDirAbs, 'manifest.json'), 'utf8')),
              'manifest',
            );
            const ref = record(
              record(manifest['artifacts'], 'artifacts')['failure-summary.json'],
              'summary ref',
            );
            ref['byte_length'] = Number(ref['byte_length']) + 1;
            await writeFile(
              join(store.artifactDirAbs, 'manifest.json'),
              `${JSON.stringify(manifest, null, 2)}\n`,
              'utf8',
            );
          },
          expected: 'integrity_failed',
        },
        {
          name: 'summary no-answer assertion mismatch',
          async mutate(store) {
            const value = parseJsonText(
              await readFile(join(store.artifactDirAbs, 'failure-summary.json'), 'utf8'),
            );
            record(value, 'summary')['answer'] = { present: true, reason: 'run_did_not_commit' };
            await rewriteBoundFailureSummary(store, value);
          },
          expected: 'integrity_failed',
        },
        {
          name: 'summary identity mismatch',
          async mutate(store) {
            const value = parseJsonText(
              await readFile(join(store.artifactDirAbs, 'failure-summary.json'), 'utf8'),
            );
            record(value, 'summary')['run_id'] = 'reason-foreign';
            await rewriteBoundFailureSummary(store, value);
          },
          expected: 'integrity_failed',
        },
        {
          name: 'summary state mismatch',
          async mutate(store) {
            const value = parseJsonText(
              await readFile(join(store.artifactDirAbs, 'failure-summary.json'), 'utf8'),
            );
            record(value, 'summary')['terminal_state'] = 'cancelled';
            await rewriteBoundFailureSummary(store, value);
          },
          expected: 'integrity_failed',
        },
        {
          name: 'evidence ref divergence',
          async mutate(store) {
            const value = record(
              parseJsonText(await readFile(join(store.artifactDirAbs, 'failure-summary.json'), 'utf8')),
              'summary',
            );
            const listed = record(value['evidence_artifacts'], 'evidence')['listed'];
            assert.ok(Array.isArray(listed));
            const first = record(listed[0], 'evidence row');
            record(first['ref'], 'evidence ref')['byte_length'] = 999;
            await rewriteBoundFailureSummary(store, value);
          },
          expected: 'integrity_failed',
        },
        {
          name: 'unsafe summary ref never escapes the run directory',
          async mutate(store) {
            const outside = join(store.artifactDirAbs, '..', 'crafted-summary.json');
            await writeFile(outside, '{"outside":true}\n', 'utf8');
            const manifest = record(
              parseManifest(await readFile(join(store.artifactDirAbs, 'manifest.json'), 'utf8')),
              'manifest',
            );
            record(manifest['artifacts'], 'artifacts')['failure-summary.json'] = {
              path: '../crafted-summary.json',
              byte_length: 17,
              sha256: `sha256:${'0'.repeat(64)}`,
            };
            await writeFile(
              join(store.artifactDirAbs, 'manifest.json'),
              `${JSON.stringify(manifest, null, 2)}\n`,
              'utf8',
            );
          },
          expected: 'unavailable',
        },
      ];
      for (const item of cases) {
        const runRoot = await mkdtemp(join(root, `${item.name.replaceAll(' ', '-')}-`));
        const { store } = await createVerifiedFailureStore(runRoot);
        await item.mutate(store);
        const view = await readFusionFailureResult({
          artifactDirAbs: store.artifactDirAbs,
          artifactDir: store.artifactDir,
          runId: store.runId,
          workflow: 'reason',
        });
        assert.equal(view.summary_status, item.expected, item.name);
        if (item.expected !== 'legacy_manifest_only') {
          assert.equal(view.failure, undefined, item.name);
          assert.equal(view.evidence_artifacts, undefined, item.name);
          assert.equal(view.failure_summary_ref, undefined, item.name);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('bounds the actual failure view with whole-row omission receipts for multibyte diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-summary-bound-'));
    try {
      const store = await FusionArtifactStore.create({
        cwd: root,
        runId: 'reason-88888888888888888888888888888888',
        source: 'tool',
        config: defaultFusionModelConfig(),
        models: models(),
      });
      await store.transition('candidates_running');
      for (let index = 0; index < FUSION_FAILURE_SUMMARY_ATTEMPT_CAP + 1; index += 1) {
        await store.recordFailedAttempt({
          stage: 'candidate',
          slot: ((index % 3) + 1) as 1 | 2 | 3,
          attempt: index + 1,
          systemPrompt: 'system',
          prompt: 'prompt',
          events: Buffer.alloc(0),
          partialResponse: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          error: 'failed',
          status: 'failed',
          childCreated: true,
          responseKind: 'md',
        });
      }
      const terminalMessage = '💥'.repeat(256);
      await store.writeError('failed', terminalMessage);
      const manifest = store.snapshot();
      const summary = buildFusionFailureSummary({
        manifest,
        terminalError: new FusionError(terminalMessage, {
          code: 'child_exit_failed',
          childCreated: true,
        }),
        progress: buildFusionRunProgress(manifest),
        terminalState: 'failed',
        createdAt: manifest.updated_at,
      });
      await store.writeFailureSummary(summary);
      const view = await readFusionFailureResult({
        artifactDirAbs: store.artifactDirAbs,
        artifactDir: store.artifactDir,
        runId: store.runId,
        workflow: 'reason',
      });
      assert.ok(Buffer.byteLength(canonicalJson(view), 'utf8') <= 6 * 1024);
      assert.equal(view.attempts?.omitted_count, summary.attempts.omitted_count);
      assert.ok((view.evidence_artifacts?.omitted_count ?? 0) > summary.evidence_artifacts.omitted_count);
      assert.equal(
        (view.evidence_artifacts?.listed.length ?? 0) +
          (view.evidence_artifacts?.omitted_count ?? 0),
        summary.evidence_artifacts.listed.length + summary.evidence_artifacts.omitted_count,
      );
      assert.equal(view.failure?.message.inline_message, undefined);
      assert.equal(view.failure?.message.omission_reason, 'result_view_byte_budget');
      const modelVisibleResult = {
        content: [
          {
            type: 'text',
            text: 'Fusion task-0123456789abcdef0123456789abcdef failed; no answer was committed. Terminal evidence status: verified. Delivery is none; use only the manifest-bound artifact references in details.',
          },
        ],
        details: {
          schema_version: 'pi-background-tasks.fusion-result-view.v1',
          task_id: 'task-0123456789abcdef0123456789abcdef',
          state: 'failed',
          delivery: 'none',
          workflow: 'reason',
          artifact_dir: store.artifactDir,
          answer: view.answer,
          summary_status: view.summary_status,
          failure_summary_ref: view.failure_summary_ref,
          failure: view.failure,
          progress: view.progress,
          usage_so_far: view.usage_so_far,
          attempts: view.attempts,
          evidence_artifacts: view.evidence_artifacts,
          remediation_ids: view.remediation_ids,
        },
      };
      assert.ok(Buffer.byteLength(JSON.stringify(modelVisibleResult), 'utf8') <= 8 * 1024);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('writes terminal failure evidence loudly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-failed-'));
    try {
      const store = await FusionArtifactStore.create({
        cwd: root,
        runId: 'reason-22222222222222222222222222222222',
        source: 'command',
        config: defaultFusionModelConfig(),
        models: models(),
      });
      await store.transition('candidates_running');
      await store.recordFailedAttempt({
        stage: 'candidate',
        slot: 2,
        attempt: 1,
        systemPrompt: 'system prompt',
        prompt: 'prompt',
        events: Buffer.from('compact-event'),
        partialResponse: Buffer.from('partial response'),
        stderr: Buffer.from('err'),
        error: 'boom',
        status: 'failed',
        childCreated: true,
        responseKind: 'md',
        provider: 'p',
        model: 'b',
        qualifiedId: 'p/b',
        usage: {
          input: 2,
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 5,
          cost: { input: 0.02, output: 0.03, cacheRead: 0, cacheWrite: 0, total: 0.05 },
        },
      });
      await store.writeError('failed', 'boom');
      assert.ok(existsSync(join(store.artifactDirAbs, 'error.json')));
      const manifest = parseManifest(
        await readFile(join(store.artifactDirAbs, 'manifest.json'), 'utf8'),
      );
      assert.equal(field(manifest, 'state'), 'failed');
      assert.equal(field(manifest, 'error'), 'boom');
      const attempts = field(manifest, 'attempts');
      assert.ok(Array.isArray(attempts));
      const firstAttempt: unknown = attempts[0];
      assert.ok(typeof firstAttempt === 'object' && firstAttempt !== null);
      assert.equal(field(firstAttempt, 'status'), 'failed');
      assert.equal(field(firstAttempt, 'child_created'), true);
      assert.equal(field(firstAttempt, 'response_path'), 'candidate-2.attempt-1.response.md');
      assert.equal(
        field(firstAttempt, 'partial_response_path'),
        'candidate-2.attempt-1.response.partial.md',
      );
      assert.equal(
        await readFile(join(store.artifactDirAbs, 'candidate-2.attempt-1.response.md'), 'utf8'),
        '',
      );
      assert.equal(
        await readFile(
          join(store.artifactDirAbs, 'candidate-2.attempt-1.response.partial.md'),
          'utf8',
        ),
        'partial response',
      );
      assert.equal(field(firstAttempt, 'qualifiedId'), 'p/b');
      const failedUsage = field(firstAttempt, 'usage');
      assert.ok(typeof failedUsage === 'object' && failedUsage !== null);
      assert.equal(field(failedUsage, 'totalTokens'), 5);
      assert.deepEqual(field(failedUsage, 'cost'), {
        input: 0.02,
        output: 0.03,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.05,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
