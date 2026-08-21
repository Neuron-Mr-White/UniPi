import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildDelegateSeed, verifyDelegateSeedBytes } from '../delegate/seed.js';
import {
  DELEGATE_CONTEXT_POLICY_ID,
  DELEGATE_SEED_SCHEMA_VERSION,
  DelegateError,
  type DelegateLimits,
  type DelegatePinnedRoute,
} from '../delegate/types.js';
import {
  assistantMessage,
  sessionWith,
  toolResultMessage,
  userMessage,
} from './helpers/fusion-canonical.js';
import { buildDeterministicFixtureSeed } from './helpers/delegate-deterministic-seed.js';

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
  max_tool_result_bytes: 65_536,
  max_total_tool_output_bytes: 67_108_864,
  max_answer_bytes: 4_194_304,
  allowed_input_tokens: 171_712,
};

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function build(
  messages: Parameters<typeof sessionWith>[0],
  overrides: Partial<Parameters<typeof buildDelegateSeed>[1]> = {},
  systemPrompt = 'parent system prompt',
) {
  return buildFromSession(sessionWith(messages), overrides, systemPrompt);
}

function buildFromSession(
  session: ReturnType<typeof sessionWith>,
  overrides: Partial<Parameters<typeof buildDelegateSeed>[1]> = {},
  systemPrompt = 'parent system prompt',
) {
  return buildDelegateSeed(
    { cwd: '/tmp/project', sessionManager: session, getSystemPrompt: () => systemPrompt },
    {
      taskId: 'd0123456789abcdef0123456789abcdef',
      launchNonce: 'ffeeddccbbaa99887766554433221100',
      toolCallId: 'delegate-call-1',
      directive: 'investigate the failing gate',
      capability: 'inspect',
      extensionMode: 'isolated',
      route: ROUTE,
      limits: LIMITS,
      ...overrides,
    },
  );
}

const CONVERSATION = [
  userMessage('VISIBLE_USER_ONE about the failing test'),
  assistantMessage([
    { type: 'text', text: 'VISIBLE_ASSISTANT_ONE here is my reading' },
    { type: 'thinking', thinking: 'SECRET_THINKING_PAYLOAD', thinkingSignature: '' },
    { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: '/SECRET_TOOL_ARGUMENT' } },
  ]),
  toolResultMessage('c1', 'read', [{ type: 'text', text: 'SECRET_TOOL_RESULT_PAYLOAD' }]),
  userMessage('VISIBLE_USER_TWO follow-up'),
];

void describe('delegate seed construction', () => {
  void it('preserves visible user and assistant text verbatim', () => {
    const built = build(CONVERSATION);
    const texts = built.seed.conversation_projection.entries.flatMap((entry) =>
      entry.kind === 'text' ? [entry.text] : [],
    );
    assert.deepEqual(texts, [
      'VISIBLE_USER_ONE about the failing test',
      'VISIBLE_ASSISTANT_ONE here is my reading',
      'VISIBLE_USER_TWO follow-up',
    ]);
  });

  void it('excludes thinking and tool payloads from the seed entirely', () => {
    const built = build(CONVERSATION);
    for (const secret of [
      'SECRET_THINKING_PAYLOAD',
      'SECRET_TOOL_ARGUMENT',
      'SECRET_TOOL_RESULT_PAYLOAD',
    ]) {
      assert.ok(
        !built.serialized.includes(secret),
        `seed must not contain omitted payload ${secret}`,
      );
    }
    const omissions = built.seed.conversation_projection.entries.filter(
      (entry) => entry.kind === 'omitted_activity',
    );
    assert.equal(omissions.length, 1, 'contiguous omissions collapse into one receipt');
  });

  void it('accounts for every omitted payload with a hash rather than dropping it', () => {
    const built = build(CONVERSATION);
    assert.equal(built.ledger.entries.length, 3);
    for (const row of built.ledger.entries) {
      assert.match(row.payload_sha256, /^[0-9a-f]{64}$/);
      assert.ok(row.payload_bytes > 0);
    }
    assert.equal(
      built.seed.conversation_projection.accounting.ledger_root_sha256,
      built.ledger.root_sha256,
    );
  });

  void it('represents images as markers and never as raw bytes', () => {
    const built = build([
      userMessage([
        { type: 'text', text: 'look at this' },
        { type: 'image', mimeType: 'image/png', data: 'RAWIMAGEBYTES' },
      ]),
      toolResultMessage('c1', 'read', [
        { type: 'image', mimeType: 'image/jpeg', data: 'RAWTOOLIMAGE' },
      ]),
    ]);
    assert.ok(!built.serialized.includes('RAWIMAGEBYTES'));
    assert.ok(!built.serialized.includes('RAWTOOLIMAGE'));
    assert.ok(built.serialized.includes('[Image omitted from fusion text transcript: image/png]'));
    assert.equal(built.seed.conversation_projection.accounting.omitted_tool_result_image_count, 1);
  });

  void it('excludes the in-flight delegate call and every sibling call in that message', () => {
    const built = build([
      userMessage('KEEP_THIS_USER_TEXT'),
      assistantMessage([{ type: 'text', text: 'KEEP_THIS_ASSISTANT_TEXT' }]),
      assistantMessage([
        { type: 'toolCall', id: 'delegate-call-1', name: 'bg_delegate', arguments: { prompt: 'a' } },
        { type: 'toolCall', id: 'delegate-call-2', name: 'bg_delegate', arguments: { prompt: 'b' } },
        { type: 'toolCall', id: 'sibling-read', name: 'read', arguments: { path: '/SIBLING' } },
      ]),
    ]);
    assert.equal(built.seed.conversation_projection.branch_filter.active_tool_call_leaf_excluded, true);
    assert.ok(!built.serialized.includes('SIBLING'));
    assert.ok(!built.serialized.includes('delegate-call-2'));
    assert.equal(built.seed.conversation_projection.accounting.omitted_tool_call_count, 0);
    const texts = built.seed.conversation_projection.entries.flatMap((entry) =>
      entry.kind === 'text' ? [entry.text] : [],
    );
    assert.deepEqual(texts, ['KEEP_THIS_USER_TEXT', 'KEEP_THIS_ASSISTANT_TEXT']);
  });

  void it('gives sibling delegates in one message byte-identical projected history', () => {
    // One shared session, exactly as two sibling calls in one assistant message
    // would observe it.
    const session = sessionWith([
      userMessage('SHARED_HISTORY'),
      assistantMessage([
        { type: 'toolCall', id: 'delegate-call-1', name: 'bg_delegate', arguments: { prompt: 'a' } },
        { type: 'toolCall', id: 'delegate-call-2', name: 'bg_delegate', arguments: { prompt: 'b' } },
      ]),
    ]);
    const first = buildFromSession(session, {
      toolCallId: 'delegate-call-1',
      directive: 'first task',
    });
    const second = buildFromSession(session, {
      toolCallId: 'delegate-call-2',
      directive: 'second task',
    });
    assert.equal(
      first.seed.parent_leaf_id,
      second.seed.parent_leaf_id,
      'siblings must be projected from the same parent leaf',
    );
    assert.deepEqual(
      first.seed.conversation_projection.entries,
      second.seed.conversation_projection.entries,
      'both siblings must observe the same projected history',
    );
    assert.equal(
      first.seed.conversation_projection.accounting.ledger_root_sha256,
      second.seed.conversation_projection.accounting.ledger_root_sha256,
    );
    // Their directives differ, so the seeds themselves must differ.
    assert.notEqual(first.sha256, second.sha256);
  });

  void it('treats the prompt as authoritative and preserves it exactly', () => {
    const directive = 'exact directive with "quotes", \\backslash, \u2028 and emoji 👩‍👩‍👧‍👦';
    const built = build(CONVERSATION, { directive });
    assert.equal(built.seed.directive.text, directive);
    assert.equal(built.seed.directive.sha256, sha256(directive));
    assert.equal(built.seed.directive.authority, 'explicit_text');
  });

  void it('is byte-identical across repeated construction from one session', () => {
    const session = sessionWith(CONVERSATION);
    const first = buildFromSession(session);
    const second = buildFromSession(session);
    const third = buildFromSession(session);
    assert.equal(first.serialized, second.serialized);
    assert.equal(second.serialized, third.serialized);
    assert.equal(first.sha256, third.sha256);
  });

  void it('is byte-identical across separate processes', () => {
    // Pi assigns random ids to session entries, so `parent_leaf_id` is genuinely
    // session-specific provenance rather than a function of the conversation.
    // The determinism that must hold is of the projection itself: the same
    // messages and the same leaf must always produce the same bytes. The
    // subprocess therefore uses a fixed leaf id, and the in-process comparison
    // below uses the same fixture, so a real byte drift cannot hide behind an
    // id that was expected to differ.
    const script = fileURLToPath(new URL('./helpers/delegate-seed-subprocess.ts', import.meta.url));
    const run = (): string =>
      execFileSync(process.execPath, ['--import', 'tsx', script], {
        encoding: 'utf8',
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      }).trim();
    const first = run();
    const second = run();
    assert.equal(first, second, 'seed bytes must not vary across processes');
    assert.equal(
      first,
      buildDeterministicFixtureSeed().sha256,
      'the in-process build must produce the same bytes as a separate process',
    );
  });

  void it('binds the seed to the exact parent leaf it was projected from', () => {
    const session = sessionWith(CONVERSATION);
    const built = buildFromSession(session);
    assert.equal(built.seed.parent_leaf_id, session.getLeafId());
  });

  void it('uses the delegate policy id and never claims Fusion provenance', () => {
    const built = build(CONVERSATION);
    assert.equal(built.seed.schema_version, DELEGATE_SEED_SCHEMA_VERSION);
    assert.equal(built.seed.conversation_projection.policy.id, DELEGATE_CONTEXT_POLICY_ID);
    assert.ok(!built.serialized.includes('fusion-input.v4'));
    assert.ok(!built.serialized.includes('fusion-tool-explicit'));
  });

  void it('never emits a payload preview', () => {
    const built = build(CONVERSATION);
    assert.equal(built.seed.conversation_projection.policy.tool_payload_preview_bytes, 0);
  });

  void it('refuses a blank prompt loudly with zero side effects', () => {
    for (const directive of ['', '   ', '\n\t']) {
      assert.throws(
        () => build(CONVERSATION, { directive }),
        (error: unknown) =>
          error instanceof DelegateError &&
          error.code === 'invalid_arguments' &&
          error.childCreated === false,
      );
    }
  });
});

void describe('delegate seed receive-side verification', () => {
  void it('accepts the exact persisted bytes', () => {
    const built = build(CONVERSATION);
    const seed = verifyDelegateSeedBytes(built.serialized, {
      sha256: built.sha256,
      taskId: built.seed.task_id,
      launchNonce: built.seed.launch_nonce,
    });
    assert.equal(seed.directive.text, built.seed.directive.text);
    assert.equal(seed.extension_mode, 'isolated');
    assert.equal(seed.route.qualified_id, ROUTE.qualified_id);
    assert.equal(seed.limits.allowed_input_tokens, LIMITS.allowed_input_tokens);
  });

  void it('rejects a single mutated byte', () => {
    const built = build(CONVERSATION);
    const mutated = built.serialized.replace('VISIBLE_USER_ONE', 'VISIBLE_USER_0NE');
    assert.notEqual(mutated, built.serialized);
    assert.throws(
      () =>
        verifyDelegateSeedBytes(mutated, {
          sha256: built.sha256,
          taskId: built.seed.task_id,
          launchNonce: built.seed.launch_nonce,
        }),
      (error: unknown) => error instanceof DelegateError && error.code === 'seed_hash_mismatch',
    );
  });

  void it('rejects a seed carrying another task identity', () => {
    const built = build(CONVERSATION);
    assert.throws(
      () =>
        verifyDelegateSeedBytes(built.serialized, {
          sha256: built.sha256,
          taskId: 'dffffffffffffffffffffffffffffffff',
          launchNonce: built.seed.launch_nonce,
        }),
      (error: unknown) => error instanceof DelegateError && error.code === 'seed_hash_mismatch',
    );
  });

  void it('rejects a structurally malformed seed even when its hash matches', () => {
    const malformed = JSON.stringify({
      schema_version: DELEGATE_SEED_SCHEMA_VERSION,
      task_id: 'd0123456789abcdef0123456789abcdef',
      launch_nonce: 'ffeeddccbbaa99887766554433221100',
      capability: 'inspect',
      // route deliberately absent
    });
    assert.throws(
      () =>
        verifyDelegateSeedBytes(malformed, {
          sha256: sha256(malformed),
          taskId: 'd0123456789abcdef0123456789abcdef',
          launchNonce: 'ffeeddccbbaa99887766554433221100',
        }),
      (error: unknown) => error instanceof DelegateError && error.code === 'seed_hash_mismatch',
    );
  });

  void it('rejects a directive whose hash does not match its text', () => {
    const built = build(CONVERSATION);
    const tampered = JSON.parse(built.serialized) as Record<string, unknown>;
    const directive = tampered['directive'];
    assert.ok(typeof directive === 'object' && directive !== null);
    Reflect.set(directive, 'text', 'a different directive entirely');
    const serialized = JSON.stringify(tampered);
    assert.throws(
      () =>
        verifyDelegateSeedBytes(serialized, {
          sha256: sha256(serialized),
          taskId: built.seed.task_id,
          launchNonce: built.seed.launch_nonce,
        }),
      (error: unknown) => error instanceof DelegateError && error.code === 'seed_hash_mismatch',
    );
  });

  void it('binds the selected extension mode into the verified seed', () => {
    const built = build(CONVERSATION, { extensionMode: 'ambient' });
    assert.equal(built.seed.extension_mode, 'ambient');
    assert.match(built.serialized, /"extension_mode":"ambient"/);
  });

  void it('rejects an unknown extension mode even when its hash matches', () => {
    const built = build(CONVERSATION);
    const tampered = JSON.parse(built.serialized) as Record<string, unknown>;
    tampered['extension_mode'] = 'custom-path';
    const serialized = JSON.stringify(tampered);
    assert.throws(
      () =>
        verifyDelegateSeedBytes(serialized, {
          sha256: sha256(serialized),
          taskId: built.seed.task_id,
          launchNonce: built.seed.launch_nonce,
        }),
      (error: unknown) => error instanceof DelegateError && error.code === 'seed_hash_mismatch',
    );
  });

  void it('rejects a capability the child cannot enforce', () => {
    const built = build(CONVERSATION);
    const tampered = JSON.parse(built.serialized) as Record<string, unknown>;
    tampered['capability'] = 'write';
    const serialized = JSON.stringify(tampered);
    assert.throws(
      () =>
        verifyDelegateSeedBytes(serialized, {
          sha256: sha256(serialized),
          taskId: built.seed.task_id,
          launchNonce: built.seed.launch_nonce,
        }),
      (error: unknown) =>
        error instanceof DelegateError && error.code === 'delegate_isolation_unsupported',
    );
  });
});
