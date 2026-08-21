import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  assertWellFormedUtf8,
  buildDelegateResultPackage,
  serializeDelegateResultPackage,
  verifyDelegateResultPackage,
} from '../delegate/result-package.js';
import { DelegateError, type DelegateUsageReport } from '../delegate/types.js';

const EXPECTED = {
  taskId: 'd0123456789abcdef0123456789abcdef',
  launchNonce: 'ffeeddccbbaa99887766554433221100',
  seedSha256: 'a'.repeat(64),
  route: { provider: 'anthropic', model: 'claude-test' },
};

const OBSERVED_USAGE: DelegateUsageReport = {
  status: 'observed',
  usage: {
    input: 100,
    output: 50,
    cacheRead: 10,
    cacheWrite: 5,
    totalTokens: 165,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
  },
};

function pkg(answerBlocks: readonly string[], overrides: Record<string, unknown> = {}) {
  const built = buildDelegateResultPackage({
    taskId: EXPECTED.taskId,
    launchNonce: EXPECTED.launchNonce,
    seedSha256: EXPECTED.seedSha256,
    directiveSha256: 'b'.repeat(64),
    route: EXPECTED.route,
    routeAttestations: [
      { provider: 'anthropic', model: 'claude-test', stop_reason: 'stop' },
    ],
    stopReason: 'stop',
    turns: 3,
    toolCalls: 7,
    usage: OBSERVED_USAGE,
    answerBlocks,
    spilledArtifacts: [],
  });
  return { ...built, ...overrides };
}

function roundTrip(answerBlocks: readonly string[]) {
  return verifyDelegateResultPackage(
    serializeDelegateResultPackage(pkg(answerBlocks)),
    EXPECTED,
  );
}

function tamper(mutate: (record: Record<string, unknown>) => void, blocks = ['answer text']) {
  const record = JSON.parse(serializeDelegateResultPackage(pkg(blocks))) as Record<string, unknown>;
  mutate(record);
  return JSON.stringify(record);
}

void describe('delegate result package', () => {
  void it('round-trips a single-block answer with verified hashes', () => {
    const verified = roundTrip(['the delegate answer']);
    assert.equal(verified.answer, 'the delegate answer');
    assert.equal(verified.package.turns, 3);
    assert.equal(verified.package.tool_calls, 7);
    assert.equal(verified.package.usage.status, 'observed');
  });

  void it('round-trips a multi-block answer preserving exact concatenation', () => {
    const verified = roundTrip(['first part ', 'second part ', 'third part']);
    assert.equal(verified.answer, 'first part second part third part');
    assert.equal(verified.package.answer.blocks.length, 3);
  });

  void it('preserves U+2028, U+2029, emoji, and unnormalized sequences exactly', () => {
    const tricky = 'line\u2028sep\u2029para 👩‍👩‍👧‍👦 e\u0301 combining \u200D zwj';
    const verified = roundTrip([tricky]);
    assert.equal(verified.answer, tricky);
    assert.equal(verified.answerBytes.length, Buffer.byteLength(tricky, 'utf8'));
  });

  void it('rejects a lone surrogate rather than substituting U+FFFD', () => {
    assert.throws(
      () => assertWellFormedUtf8('broken \uD800 surrogate', 'answer'),
      (error: unknown) =>
        error instanceof DelegateError && error.code === 'child_result_encoding_invalid',
    );
    assert.throws(
      () => buildDelegateResultPackage({
        taskId: EXPECTED.taskId,
        launchNonce: EXPECTED.launchNonce,
        seedSha256: EXPECTED.seedSha256,
        directiveSha256: 'b'.repeat(64),
        route: EXPECTED.route,
        routeAttestations: [{ provider: 'anthropic', model: 'claude-test', stop_reason: 'stop' }],
        stopReason: 'stop',
        turns: 1,
        toolCalls: 0,
        usage: OBSERVED_USAGE,
        answerBlocks: ['\uD800'],
        spilledArtifacts: [],
      }),
      (error: unknown) =>
        error instanceof DelegateError && error.code === 'child_result_encoding_invalid',
    );
  });

  void it('detects a corrupted answer block and never returns a prefix', () => {
    const corrupted = tamper((record) => {
      const answer = record['answer'];
      assert.ok(typeof answer === 'object' && answer !== null);
      const blocks = Reflect.get(answer, 'blocks');
      assert.ok(Array.isArray(blocks));
      const first = blocks[0];
      assert.ok(typeof first === 'object' && first !== null);
      Reflect.set(first, 'data_base64', Buffer.from('tampered text', 'utf8').toString('base64'));
    });
    assert.throws(
      () => verifyDelegateResultPackage(corrupted, EXPECTED),
      (error: unknown) => error instanceof DelegateError && error.code === 'answer_hash_mismatch',
    );
  });

  void it('detects an aggregate hash mismatch even when every block hash is valid', () => {
    const corrupted = tamper((record) => {
      const answer = record['answer'];
      assert.ok(typeof answer === 'object' && answer !== null);
      Reflect.set(answer, 'sha256', 'c'.repeat(64));
    });
    assert.throws(
      () => verifyDelegateResultPackage(corrupted, EXPECTED),
      (error: unknown) => error instanceof DelegateError && error.code === 'answer_hash_mismatch',
    );
  });

  void it('detects a declared length that disagrees with the carried bytes', () => {
    const corrupted = tamper((record) => {
      const answer = record['answer'];
      assert.ok(typeof answer === 'object' && answer !== null);
      Reflect.set(answer, 'byte_length', 999_999);
    });
    assert.throws(
      () => verifyDelegateResultPackage(corrupted, EXPECTED),
      (error: unknown) => error instanceof DelegateError && error.code === 'answer_hash_mismatch',
    );
  });

  void it('rejects non-strict base64 rather than absorbing it', () => {
    const corrupted = tamper((record) => {
      const answer = record['answer'];
      assert.ok(typeof answer === 'object' && answer !== null);
      const blocks = Reflect.get(answer, 'blocks');
      assert.ok(Array.isArray(blocks));
      const first = blocks[0];
      assert.ok(typeof first === 'object' && first !== null);
      const encoded: unknown = Reflect.get(first, 'data_base64');
      assert.ok(typeof encoded === 'string');
      Reflect.set(first, 'data_base64', `${encoded}===extra`);
    });
    assert.throws(
      () => verifyDelegateResultPackage(corrupted, EXPECTED),
      (error: unknown) => error instanceof DelegateError && error.code === 'child_result_invalid',
    );
  });

  void it('rejects a package produced from a different seed', () => {
    assert.throws(
      () =>
        verifyDelegateResultPackage(serializeDelegateResultPackage(pkg(['x'])), {
          ...EXPECTED,
          seedSha256: 'd'.repeat(64),
        }),
      (error: unknown) => error instanceof DelegateError && error.code === 'seed_hash_mismatch',
    );
  });

  void it('rejects a package carrying a foreign task identity or launch nonce', () => {
    const serialized = serializeDelegateResultPackage(pkg(['x']));
    assert.throws(
      () => verifyDelegateResultPackage(serialized, { ...EXPECTED, taskId: 'dfff' }),
      (error: unknown) => error instanceof DelegateError && error.code === 'child_result_invalid',
    );
    assert.throws(
      () => verifyDelegateResultPackage(serialized, { ...EXPECTED, launchNonce: 'other' }),
      (error: unknown) => error instanceof DelegateError && error.code === 'child_result_invalid',
    );
  });

  void it('rejects a route that does not match the pinned route', () => {
    const corrupted = tamper((record) => {
      Reflect.set(record, 'route', { provider: 'openai', model: 'gpt-test' });
    });
    assert.throws(
      () => verifyDelegateResultPackage(corrupted, EXPECTED),
      (error: unknown) => error instanceof DelegateError && error.code === 'route_mismatch',
    );
  });

  void it('rejects an attestation from a substituted route', () => {
    const corrupted = tamper((record) => {
      Reflect.set(record, 'route_attestations', [
        { provider: 'anthropic', model: 'claude-test', stop_reason: 'stop' },
        { provider: 'openai', model: 'gpt-test', stop_reason: 'stop' },
      ]);
    });
    assert.throws(
      () => verifyDelegateResultPackage(corrupted, EXPECTED),
      (error: unknown) => error instanceof DelegateError && error.code === 'route_mismatch',
    );
  });

  void it('refuses a package with no route attestation at all', () => {
    const corrupted = tamper((record) => {
      Reflect.set(record, 'route_attestations', []);
    });
    assert.throws(
      () => verifyDelegateResultPackage(corrupted, EXPECTED),
      (error: unknown) =>
        error instanceof DelegateError && error.code === 'route_attestation_missing',
    );
  });

  void it('reports unavailable usage explicitly rather than as zero', () => {
    const built = buildDelegateResultPackage({
      taskId: EXPECTED.taskId,
      launchNonce: EXPECTED.launchNonce,
      seedSha256: EXPECTED.seedSha256,
      directiveSha256: 'b'.repeat(64),
      route: EXPECTED.route,
      routeAttestations: [{ provider: 'anthropic', model: 'claude-test', stop_reason: 'stop' }],
      stopReason: 'stop',
      turns: 1,
      toolCalls: 0,
      usage: { status: 'unavailable', reason: 'the provider reported no usage' },
      answerBlocks: ['answer'],
      spilledArtifacts: [],
    });
    const verified = verifyDelegateResultPackage(
      serializeDelegateResultPackage(built),
      EXPECTED,
    );
    assert.equal(verified.package.usage.status, 'unavailable');
    const serialized = serializeDelegateResultPackage(built);
    assert.ok(!/"totalTokens":0/.test(serialized), 'must not synthesize zero usage');
  });

  void it('rejects a usage record missing cost components', () => {
    const corrupted = tamper((record) => {
      Reflect.set(record, 'usage', {
        status: 'observed',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      });
    });
    assert.throws(
      () => verifyDelegateResultPackage(corrupted, EXPECTED),
      (error: unknown) => error instanceof DelegateError && error.code === 'child_result_invalid',
    );
  });

  void it('rejects malformed JSON and a wrong schema version', () => {
    assert.throws(
      () => verifyDelegateResultPackage('{not json', EXPECTED),
      (error: unknown) => error instanceof DelegateError && error.code === 'child_result_invalid',
    );
    const corrupted = tamper((record) => {
      Reflect.set(record, 'schema_version', 'pi-background-tasks.delegate-result.v99');
    });
    assert.throws(
      () => verifyDelegateResultPackage(corrupted, EXPECTED),
      (error: unknown) => error instanceof DelegateError && error.code === 'child_result_invalid',
    );
  });

  void it('accepts a historical v1 spill receipt without content_format', () => {
    const built = buildDelegateResultPackage({
      taskId: EXPECTED.taskId,
      launchNonce: EXPECTED.launchNonce,
      seedSha256: EXPECTED.seedSha256,
      directiveSha256: 'b'.repeat(64),
      route: EXPECTED.route,
      routeAttestations: [{ provider: 'anthropic', model: 'claude-test', stop_reason: 'stop' }],
      stopReason: 'stop',
      turns: 1,
      toolCalls: 1,
      usage: OBSERVED_USAGE,
      answerBlocks: ['answer'],
      spilledArtifacts: [
        {
          schema_version: 'pi-background-tasks.delegate-receipt.v1',
          artifact: 'spill/historical.bin',
          tool_name: 'read',
          tool_call_id: 'historical',
          turn_sequence: 1,
          source_call_index: 0,
          byte_length: 7,
          sha256: createHash('sha256').update('payload').digest('hex'),
        },
      ],
    });
    const verified = verifyDelegateResultPackage(
      serializeDelegateResultPackage(built),
      EXPECTED,
    );
    assert.equal(verified.package.spilled_artifacts[0]?.content_format, undefined);
  });

  void it('preserves spill receipts with their call coordinates', () => {
    const built = buildDelegateResultPackage({
      taskId: EXPECTED.taskId,
      launchNonce: EXPECTED.launchNonce,
      seedSha256: EXPECTED.seedSha256,
      directiveSha256: 'b'.repeat(64),
      route: EXPECTED.route,
      routeAttestations: [{ provider: 'anthropic', model: 'claude-test', stop_reason: 'stop' }],
      stopReason: 'stop',
      turns: 2,
      toolCalls: 2,
      usage: OBSERVED_USAGE,
      answerBlocks: ['answer'],
      spilledArtifacts: [
        {
          schema_version: 'pi-background-tasks.delegate-receipt.v1',
          artifact: 'spill/t0001-c0000-abc.bin',
          tool_name: 'read',
          tool_call_id: 'abc',
          turn_sequence: 1,
          source_call_index: 0,
          byte_length: 2_097_152,
          sha256: createHash('sha256').update('payload').digest('hex'),
          content_format: 'single_text_utf8',
        },
      ],
    });
    const verified = verifyDelegateResultPackage(
      serializeDelegateResultPackage(built),
      EXPECTED,
    );
    assert.equal(verified.package.spilled_artifacts.length, 1);
    const receipt = verified.package.spilled_artifacts[0];
    assert.ok(receipt);
    assert.equal(receipt.turn_sequence, 1);
    assert.equal(receipt.source_call_index, 0);
    assert.equal(receipt.byte_length, 2_097_152);
    assert.equal(receipt.content_format, 'single_text_utf8');
  });
});
