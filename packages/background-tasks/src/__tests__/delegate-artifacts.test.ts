import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DelegateArtifactStore } from '../delegate/artifacts.js';
import { evaluateDelegateTerminal, decideDelegateDelivery, inlineTooLarge } from '../delegate/runner.js';
import {
  buildDelegateResultPackage,
  serializeDelegateResultPackage,
} from '../delegate/result-package.js';
import { DelegateError, type DelegateLimits, type DelegatePinnedRoute } from '../delegate/types.js';
import { DELEGATE_INLINE_ANSWER_BYTES } from '../delegate/budget.js';

const roots: string[] = [];

const ROUTE: DelegatePinnedRoute = {
  provider: 'anthropic',
  model: 'claude-test',
  qualified_id: 'anthropic/claude-test',
  context_window_tokens: 200_000,
  thinking_level: 'medium',
  origin: 'parent_current',
};

const LIMITS: DelegateLimits = {
  max_turns: 24,
  max_tool_calls: 120,
  timeout_seconds: 900,
  max_tool_result_bytes: 1024,
  max_total_tool_output_bytes: 8192,
  max_answer_bytes: 4_194_304,
  allowed_input_tokens: 171_712,
};

const TASK_ID = 'd0123456789abcdef0123456789abcdef';
const NONCE = 'ffeeddccbbaa99887766554433221100';
const SEED_SHA = 'a'.repeat(64);

async function makeStore(taskId = TASK_ID) {
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-delegate-artifacts-'));
  roots.push(root);
  const store = await DelegateArtifactStore.create({
    cwd: root,
    taskId,
    launchNonce: NONCE,
    sessionId: 'unit-session',
    childSessionId: 'delegate-child-session',
    childSessionDir: '',
    extensionMode: 'isolated',
    route: ROUTE,
    limits: LIMITS,
    seedSha256: SEED_SHA,
  });
  return { root, store };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

void describe('delegate artifact store', () => {
  void it('creates a private task-owned directory with a spill subdirectory', async () => {
    const { store } = await makeStore();
    assert.ok(existsSync(store.artifactDirAbs));
    assert.ok(existsSync(store.spillDirAbs));
    assert.equal(store.snapshot().extension_mode, 'isolated');
    if (process.platform !== 'win32') {
      const stats = await stat(store.artifactDirAbs);
      assert.equal(stats.mode & 0o777, 0o700, 'artifact directory must be private');
    }
  });

  void it('refuses to reuse an existing task directory', async () => {
    const { root } = await makeStore();
    await assert.rejects(
      DelegateArtifactStore.create({
        cwd: root,
        taskId: TASK_ID,
        launchNonce: NONCE,
        sessionId: 'unit-session',
        childSessionId: 'x',
        childSessionDir: '',
        extensionMode: 'isolated',
        route: ROUTE,
        limits: LIMITS,
        seedSha256: SEED_SHA,
      }),
      (error: unknown) => error instanceof DelegateError && error.code === 'artifact_error',
    );
  });

  void it('gives concurrent delegates non-colliding directories', async () => {
    const first = await makeStore('d11111111111111111111111111111111');
    const second = await DelegateArtifactStore.create({
      cwd: first.root,
      taskId: 'd22222222222222222222222222222222',
      launchNonce: NONCE,
      sessionId: 'unit-session',
      childSessionId: 'x',
      childSessionDir: '',
      extensionMode: 'ambient',
      route: ROUTE,
      limits: LIMITS,
      seedSha256: SEED_SHA,
    });
    assert.notEqual(first.store.artifactDirAbs, second.artifactDirAbs);
    assert.ok(existsSync(first.store.artifactDirAbs));
    assert.ok(existsSync(second.artifactDirAbs));
  });

  void it('persists the seed bytes exactly as given', async () => {
    const { store } = await makeStore();
    const seed = '{"schema_version":"pi-background-tasks.delegate-seed.v2","x":"\u2028\u2029👩"}';
    const ref = await store.writeSeed(seed);
    const onDisk = await readFile(join(store.artifactDirAbs, 'seed.json'), 'utf8');
    assert.equal(onDisk, seed, 'persisted seed bytes must equal the bytes handed to the child');
    assert.equal(ref.sha256, createHash('sha256').update(seed, 'utf8').digest('hex'));
  });

  void it('readCommittedResult advertises only control artifacts that exist', async () => {
    const { store } = await makeStore();
    await assert.rejects(
      store.readCommittedResult(),
      (error: unknown) => {
        assert.ok(error instanceof DelegateError);
        assert.equal(error.code, 'result_unavailable');
        assert.doesNotMatch(error.describe(), /child\.stdout|child\.stderr/);
        assert.ok(error.preserved.length > 0);
        assert.ok(
          error.preserved.every((path) => existsSync(join(store.artifactDirAbs, path))),
        );
        return true;
      },
    );
  });

  void it('spills an oversized payload and returns a receipt naming its coordinates', async () => {
    const { store } = await makeStore();
    const payload = Buffer.alloc(2 * 1024 * 1024, 0x41);
    const receipt = await store.spillToolPayload({
      toolName: 'read',
      toolCallId: 'call-abc',
      turnSequence: 3,
      sourceCallIndex: 1,
      payload,
      maxTotalBytes: 64 * 1024 * 1024,
    });
    assert.equal(receipt.byte_length, payload.length);
    assert.equal(receipt.sha256, createHash('sha256').update(payload).digest('hex'));
    assert.equal(receipt.turn_sequence, 3);
    assert.equal(receipt.source_call_index, 1);
    const onDisk = await readFile(join(store.artifactDirAbs, receipt.artifact));
    assert.equal(onDisk.length, payload.length, 'the complete payload must be preserved');
    assert.ok(onDisk.equals(payload), 'nothing may be truncated on the way to disk');
  });

  void it('associates parallel spills with the right call even when they interleave', async () => {
    const { store } = await makeStore();
    // Coordinates are assigned before execution, so completion order cannot
    // mis-associate a receipt with another call's bytes.
    const payloads = [
      { id: 'call-a', index: 0, byte: 0x61 },
      { id: 'call-b', index: 1, byte: 0x62 },
      { id: 'call-c', index: 2, byte: 0x63 },
    ];
    const receipts = await Promise.all(
      // Reverse order deliberately, to emulate out-of-order completion.
      [...payloads].reverse().map((entry) =>
        store.spillToolPayload({
          toolName: 'read',
          toolCallId: entry.id,
          turnSequence: 1,
          sourceCallIndex: entry.index,
          payload: Buffer.alloc(4096, entry.byte),
          maxTotalBytes: 64 * 1024 * 1024,
        }),
      ),
    );
    for (const receipt of receipts) {
      const source = payloads.find((entry) => entry.id === receipt.tool_call_id);
      assert.ok(source);
      assert.equal(receipt.source_call_index, source.index);
      const bytes = await readFile(join(store.artifactDirAbs, receipt.artifact));
      assert.ok(
        bytes.every((value) => value === source.byte),
        `${receipt.tool_call_id} receipt must point at its own bytes`,
      );
    }
    assert.equal(new Set(receipts.map((receipt) => receipt.artifact)).size, 3);
  });

  void it('refuses a spill that would exceed the aggregate cap, and emits no receipt', async () => {
    const { store } = await makeStore();
    await store.spillToolPayload({
      toolName: 'read',
      toolCallId: 'a',
      turnSequence: 1,
      sourceCallIndex: 0,
      payload: Buffer.alloc(4096, 1),
      maxTotalBytes: 8192,
    });
    const before = await readdir(store.spillDirAbs);
    await assert.rejects(
      store.spillToolPayload({
        toolName: 'read',
        toolCallId: 'b',
        turnSequence: 1,
        sourceCallIndex: 1,
        payload: Buffer.alloc(8192, 2),
        maxTotalBytes: 8192,
      }),
      (error: unknown) =>
        error instanceof DelegateError && error.code === 'aggregate_tool_output_cap',
    );
    assert.deepEqual(await readdir(store.spillDirAbs), before, 'a refused spill writes nothing');
  });

  void it('returns exactly the requested byte range', async () => {
    const { store } = await makeStore();
    const payload = Buffer.from('0123456789abcdefghij', 'utf8');
    const receipt = await store.spillToolPayload({
      toolName: 'read',
      toolCallId: 'range',
      turnSequence: 1,
      sourceCallIndex: 0,
      payload,
      maxTotalBytes: 65_536,
    });
    const read = await store.readSpillRange(receipt.artifact, 5, 6);
    assert.equal(read.bytes.toString('utf8'), '56789a');
    assert.equal(read.totalBytes, payload.length);
  });

  void it('refuses a range past end-of-file instead of silently shortening it', async () => {
    const { store } = await makeStore();
    const receipt = await store.spillToolPayload({
      toolName: 'read',
      toolCallId: 'short',
      turnSequence: 1,
      sourceCallIndex: 0,
      payload: Buffer.from('0123456789', 'utf8'),
      maxTotalBytes: 65_536,
    });
    await assert.rejects(
      store.readSpillRange(receipt.artifact, 5, 100),
      (error: unknown) =>
        error instanceof DelegateError &&
        error.code === 'artifact_read_failed' &&
        /refused rather than silently shortened/.test(error.message),
    );
  });

  void it('refuses a range read that escapes the artifact directory', async () => {
    const { store } = await makeStore();
    for (const path of ['../escape.txt', '../../etc/passwd', 'spill/../../outside']) {
      await assert.rejects(
        store.readSpillRange(path, 0, 1),
        (error: unknown) => error instanceof DelegateError && error.code === 'artifact_read_failed',
      );
    }
  });

  void it('refuses non-positive lengths and negative offsets', async () => {
    const { store } = await makeStore();
    for (const [offset, length] of [
      [-1, 1],
      [0, 0],
      [0, -5],
      [1.5, 1],
    ] as const) {
      await assert.rejects(
        store.readSpillRange('spill/whatever.bin', offset, length),
        (error: unknown) => error instanceof DelegateError && error.code === 'artifact_read_failed',
      );
    }
  });
});

void describe('delegate terminal evaluation', () => {
  void it('accepts a committed package and reports verified answer facts', async () => {
    const { store } = await makeStore();
    const pkg = buildDelegateResultPackage({
      taskId: TASK_ID,
      launchNonce: NONCE,
      seedSha256: SEED_SHA,
      directiveSha256: 'b'.repeat(64),
      route: { provider: ROUTE.provider, model: ROUTE.model },
      routeAttestations: [
        { provider: ROUTE.provider, model: ROUTE.model, stop_reason: 'stop' },
      ],
      stopReason: 'stop',
      turns: 4,
      toolCalls: 9,
      usage: { status: 'unavailable', reason: 'no usage reported' },
      answerBlocks: ['the verified answer'],
      spilledArtifacts: [],
    });
    await store.commitResult(pkg);
    const evaluation = await evaluateDelegateTerminal({
      artifactDirAbs: store.artifactDirAbs,
      taskId: TASK_ID,
      launchNonce: NONCE,
      seedSha256: SEED_SHA,
      route: { provider: ROUTE.provider, model: ROUTE.model },
      taskStatus: 'completed',
      taskError: undefined,
    });
    assert.equal(evaluation.outcome.status, 'committed');
    assert.equal(evaluation.result?.answer, 'the verified answer');
    assert.equal(evaluation.outcome.turns, 4);
    assert.equal(evaluation.outcome.toolCalls, 9);
  });

  void it('treats a zero-exit child with no committed package as a typed failure', async () => {
    const { store } = await makeStore();
    const evaluation = await evaluateDelegateTerminal({
      artifactDirAbs: store.artifactDirAbs,
      taskId: TASK_ID,
      launchNonce: NONCE,
      seedSha256: SEED_SHA,
      route: { provider: ROUTE.provider, model: ROUTE.model },
      taskStatus: 'completed',
      taskError: undefined,
    });
    assert.equal(evaluation.outcome.status, 'failed');
    assert.equal(evaluation.outcome.errorCode, 'child_exited_without_commit');
    assert.match(evaluation.error?.message ?? '', /no committed answer/);
    assert.match(evaluation.error?.describe() ?? '', /Preserved:/);
    assert.doesNotMatch(
      evaluation.error?.describe() ?? '',
      /child\.stderr\.txt|child\.stdout\.txt|Inspect child-terminal\.json/,
      'terminal reporting must never advertise evidence files that do not exist',
    );
  });

  void it('does not advertise a configured merged output path that does not exist', async () => {
    const { root, store } = await makeStore();
    const missingAbsPath = join(root, '.pi', 'tasks', 'missing.output');
    const evaluation = await evaluateDelegateTerminal({
      artifactDirAbs: store.artifactDirAbs,
      taskId: TASK_ID,
      launchNonce: NONCE,
      seedSha256: SEED_SHA,
      route: { provider: ROUTE.provider, model: ROUTE.model },
      taskStatus: 'failed',
      taskError: 'spawn failed before output creation',
      taskOutputPath: '.pi/tasks/missing.output',
      taskOutputAbsPath: missingAbsPath,
    });
    assert.doesNotMatch(evaluation.error?.describe() ?? '', /missing\.output/);
    assert.doesNotMatch(evaluation.error?.describe() ?? '', /Inspect child-terminal\.json/);
  });

  void it('reports only a real merged task output path as preserved diagnostics', async () => {
    const { root, store } = await makeStore();
    const outputAbsPath = join(root, '.pi', 'tasks', 'delegate.output');
    await mkdir(join(root, '.pi', 'tasks'), { recursive: true });
    await writeFile(outputAbsPath, 'merged stdout and stderr', 'utf8');
    const evaluation = await evaluateDelegateTerminal({
      artifactDirAbs: store.artifactDirAbs,
      taskId: TASK_ID,
      launchNonce: NONCE,
      seedSha256: SEED_SHA,
      route: { provider: ROUTE.provider, model: ROUTE.model },
      taskStatus: 'failed',
      taskError: 'Exited with code 1',
      taskOutputPath: '.pi/tasks/delegate.output',
      taskOutputAbsPath: outputAbsPath,
    });
    assert.match(evaluation.error?.describe() ?? '', /\.pi\/tasks\/delegate\.output/);
    assert.doesNotMatch(evaluation.error?.describe() ?? '', /child\.stderr\.txt/);
  });

  void it('reports the child-recorded terminal reason when one exists', async () => {
    const { store } = await makeStore();
    await writeFile(
      join(store.artifactDirAbs, 'child-terminal.json'),
      JSON.stringify({
        schema_version: 'pi-background-tasks.delegate-child-terminal.v1',
        code: 'provider_context_budget_exhausted',
        message: 'context exceeded the pinned route window',
      }),
      'utf8',
    );
    const evaluation = await evaluateDelegateTerminal({
      artifactDirAbs: store.artifactDirAbs,
      taskId: TASK_ID,
      launchNonce: NONCE,
      seedSha256: SEED_SHA,
      route: { provider: ROUTE.provider, model: ROUTE.model },
      taskStatus: 'failed',
      taskError: 'Exited with code 1',
    });
    assert.equal(evaluation.outcome.errorCode, 'provider_context_budget_exhausted');
    assert.match(evaluation.error?.message ?? '', /context exceeded the pinned route window/);
  });

  void it('records the parent adjudication separately from the child package', async () => {
    const { store } = await makeStore();
    const pkg = buildDelegateResultPackage({
      taskId: TASK_ID,
      launchNonce: NONCE,
      seedSha256: SEED_SHA,
      directiveSha256: 'b'.repeat(64),
      route: { provider: ROUTE.provider, model: ROUTE.model },
      routeAttestations: [{ provider: ROUTE.provider, model: ROUTE.model, stop_reason: 'stop' }],
      stopReason: 'stop',
      turns: 1,
      toolCalls: 0,
      usage: { status: 'unavailable', reason: 'none' },
      answerBlocks: ['answer'],
      spilledArtifacts: [],
    });
    await store.commitResult(pkg);
    await evaluateDelegateTerminal({
      artifactDirAbs: store.artifactDirAbs,
      taskId: TASK_ID,
      launchNonce: NONCE,
      seedSha256: SEED_SHA,
      route: { provider: ROUTE.provider, model: ROUTE.model },
      taskStatus: 'completed',
      taskError: undefined,
    });
    // The child writes result.json; the parent writes outcome.json. Keeping the
    // two writers on separate artifacts means neither can claim a state it did
    // not observe, and a stale manifest field can never imply success.
    const outcome = JSON.parse(
      await readFile(join(store.artifactDirAbs, 'outcome.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(outcome['schema_version'], 'pi-background-tasks.delegate-outcome.v1');
    assert.equal(outcome['task_id'], TASK_ID);
    assert.equal(outcome['observed_task_status'], 'completed');
    assert.equal(outcome['error_code'], null);
    const recorded = outcome['outcome'];
    assert.ok(typeof recorded === 'object' && recorded !== null);
    assert.equal(Reflect.get(recorded, 'status'), 'committed');
  });

  void it('records a typed adjudication for a child that never committed', async () => {
    const { store } = await makeStore();
    await evaluateDelegateTerminal({
      artifactDirAbs: store.artifactDirAbs,
      taskId: TASK_ID,
      launchNonce: NONCE,
      seedSha256: SEED_SHA,
      route: { provider: ROUTE.provider, model: ROUTE.model },
      taskStatus: 'completed',
      taskError: undefined,
    });
    const outcome = JSON.parse(
      await readFile(join(store.artifactDirAbs, 'outcome.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(outcome['error_code'], 'child_exited_without_commit');
  });

  void it('classifies a killed task as cancelled', async () => {
    const { store } = await makeStore();
    const evaluation = await evaluateDelegateTerminal({
      artifactDirAbs: store.artifactDirAbs,
      taskId: TASK_ID,
      launchNonce: NONCE,
      seedSha256: SEED_SHA,
      route: { provider: ROUTE.provider, model: ROUTE.model },
      taskStatus: 'killed',
      taskError: 'killed by user',
    });
    assert.equal(evaluation.outcome.status, 'cancelled');
    assert.equal(evaluation.outcome.errorCode, 'child_cancelled');
  });

  void it('detects a corrupted committed package rather than returning its bytes', async () => {
    const { store } = await makeStore();
    const pkg = buildDelegateResultPackage({
      taskId: TASK_ID,
      launchNonce: NONCE,
      seedSha256: SEED_SHA,
      directiveSha256: 'b'.repeat(64),
      route: { provider: ROUTE.provider, model: ROUTE.model },
      routeAttestations: [{ provider: ROUTE.provider, model: ROUTE.model, stop_reason: 'stop' }],
      stopReason: 'stop',
      turns: 1,
      toolCalls: 0,
      usage: { status: 'unavailable', reason: 'none' },
      answerBlocks: ['original answer'],
      spilledArtifacts: [],
    });
    const serialized = serializeDelegateResultPackage(pkg);
    const corrupted = serialized.replace(
      pkg.answer.blocks[0]?.data_base64 ?? '',
      Buffer.from('substituted', 'utf8').toString('base64'),
    );
    await writeFile(join(store.artifactDirAbs, 'result.json'), corrupted, 'utf8');
    const evaluation = await evaluateDelegateTerminal({
      artifactDirAbs: store.artifactDirAbs,
      taskId: TASK_ID,
      launchNonce: NONCE,
      seedSha256: SEED_SHA,
      route: { provider: ROUTE.provider, model: ROUTE.model },
      taskStatus: 'completed',
      taskError: undefined,
    });
    assert.equal(evaluation.outcome.status, 'failed');
    assert.equal(evaluation.outcome.errorCode, 'answer_hash_mismatch');
    assert.equal(evaluation.result, undefined, 'a corrupted answer is never returned');
  });
});

void describe('delegate delivery decisions', () => {
  void it('inlines at exactly the cap and degrades one byte past it', () => {
    assert.equal(decideDelegateDelivery(DELEGATE_INLINE_ANSWER_BYTES, undefined).mode, 'inline');
    assert.equal(decideDelegateDelivery(DELEGATE_INLINE_ANSWER_BYTES + 1, undefined).mode, 'artifact');
  });

  void it('honours an explicit artifact request for a small answer', () => {
    assert.equal(decideDelegateDelivery(10, 'artifact').mode, 'artifact');
  });

  void it('never truncates: an explicit oversized inline request is a typed failure', () => {
    const error = inlineTooLarge('dtask', '.pi/delegate/x', DELEGATE_INLINE_ANSWER_BYTES + 1);
    assert.equal(error.code, 'result_too_large_for_inline');
    assert.match(error.message, /not truncated to fit/);
    assert.ok(error.remediation.length > 0);
    assert.ok(error.preserved.length > 0);
  });
});
