import { createHash } from 'node:crypto';
import { canonicalJson } from '../attested-pi-run.js';
import {
  DELEGATE_RECEIPT_SCHEMA_VERSION,
  DELEGATE_RESULT_PACKAGE_SCHEMA_VERSION,
  DelegateError,
  type DelegateAnswerBlock,
  type DelegateResultPackageV1,
  type DelegateRouteAttestation,
  type DelegateSpillReceipt,
  type DelegateUsageReport,
} from './types.js';

/**
 * The delegate answer data plane.
 *
 * A delegate child commits exactly one self-contained package: temp-write,
 * fsync, rename, directory fsync. The rename is the commit point. A package
 * present under its final name is complete; its absence means no answer was
 * accepted. There is no second channel to reconcile, so a child that dies after
 * emitting bytes but before committing can never be mistaken for a success.
 *
 * Every acceptance path verifies per-block and aggregate SHA-256 before it
 * returns a single byte, and it returns bytes from the same buffer it verified
 * rather than re-reading the file.
 */

export const DELEGATE_RESULT_PACKAGE_FILENAME = 'result.json';

function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string, code: DelegateError['code'], taskId?: string): never {
  const details: ConstructorParameters<typeof DelegateError>[1] = { code, childCreated: true };
  if (taskId !== undefined) details.taskId = taskId;
  throw new DelegateError(message, details);
}

/**
 * Reject text that cannot round-trip through UTF-8.
 *
 * A lone surrogate would be silently replaced with U+FFFD by a naive encode,
 * changing the answer bytes without anyone noticing. That is exactly the class
 * of silent corruption this package refuses, so it is a loud typed failure.
 * Well-formed U+2028/U+2029 and unnormalized sequences are preserved untouched.
 */
export function assertWellFormedUtf8(text: string, label: string): Buffer {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.toString('utf8') !== text) {
    fail(
      `${label} contains text that cannot be represented in UTF-8 without substitution (lone surrogate); the answer is not silently repaired`,
      'child_result_encoding_invalid',
    );
  }
  return encoded;
}

export interface BuildDelegateResultPackageInput {
  taskId: string;
  launchNonce: string;
  seedSha256: string;
  directiveSha256: string;
  route: { provider: string; model: string };
  routeAttestations: readonly DelegateRouteAttestation[];
  stopReason: string;
  turns: number;
  toolCalls: number;
  usage: DelegateUsageReport;
  answerBlocks: readonly string[];
  spilledArtifacts: readonly DelegateSpillReceipt[];
}

export function buildDelegateResultPackage(
  input: BuildDelegateResultPackageInput,
): DelegateResultPackageV1 {
  const blocks: DelegateAnswerBlock[] = input.answerBlocks.map((text, index) => {
    const bytes = assertWellFormedUtf8(text, `delegate answer block ${String(index)}`);
    return {
      kind: 'text',
      byte_length: bytes.length,
      sha256: sha256Bytes(bytes),
      data_base64: bytes.toString('base64'),
    };
  });
  const aggregate = Buffer.concat(
    blocks.map((block) => Buffer.from(block.data_base64, 'base64')),
  );
  return {
    schema_version: DELEGATE_RESULT_PACKAGE_SCHEMA_VERSION,
    task_id: input.taskId,
    launch_nonce: input.launchNonce,
    seed_sha256: input.seedSha256,
    directive_sha256: input.directiveSha256,
    route: { provider: input.route.provider, model: input.route.model },
    route_attestations: input.routeAttestations,
    stop_reason: input.stopReason,
    turns: input.turns,
    tool_calls: input.toolCalls,
    usage: input.usage,
    answer: {
      encoding: 'utf-8',
      byte_length: aggregate.length,
      sha256: sha256Bytes(aggregate),
      blocks,
    },
    spilled_artifacts: input.spilledArtifacts,
  };
}

export function serializeDelegateResultPackage(pkg: DelegateResultPackageV1): string {
  return `${canonicalJson(pkg)}\n`;
}

export interface VerifiedDelegateResult {
  package: DelegateResultPackageV1;
  /** Verified answer bytes, taken from the same buffer whose hashes were checked. */
  answer: string;
  answerBytes: Buffer;
}

export interface DelegateResultExpectation {
  taskId: string;
  launchNonce: string;
  seedSha256: string;
  route: { provider: string; model: string };
}

function requireString(record: Record<PropertyKey, unknown>, key: string, taskId: string): string {
  const value = record[key];
  if (typeof value !== 'string')
    fail(`delegate result package field ${key} must be a string`, 'child_result_invalid', taskId);
  return value;
}

function requireInteger(record: Record<PropertyKey, unknown>, key: string, taskId: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    fail(
      `delegate result package field ${key} must be a non-negative safe integer`,
      'child_result_invalid',
      taskId,
    );
  return value;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function requireSha256(record: Record<PropertyKey, unknown>, key: string, taskId: string): string {
  const value = requireString(record, key, taskId);
  if (!SHA256_PATTERN.test(value))
    fail(
      `delegate result package field ${key} must be a lowercase SHA-256 digest`,
      'child_result_invalid',
      taskId,
    );
  return value;
}

function parseUsage(value: unknown, taskId: string): DelegateUsageReport {
  if (!isRecord(value))
    fail('delegate result package usage must be an object', 'child_result_invalid', taskId);
  const status = value['status'];
  if (status === 'unavailable') {
    const reason = value['reason'];
    if (typeof reason !== 'string')
      fail(
        'delegate result package unavailable usage must state a reason',
        'child_result_invalid',
        taskId,
      );
    return { status: 'unavailable', reason };
  }
  if (status !== 'observed')
    fail(
      'delegate result package usage status must be observed or unavailable',
      'child_result_invalid',
      taskId,
    );
  const usage = value['usage'];
  if (!isRecord(usage))
    fail('delegate result package observed usage must be an object', 'child_result_invalid', taskId);
  const cost = usage['cost'];
  if (!isRecord(cost))
    fail(
      'delegate result package observed usage must carry a complete cost breakdown',
      'child_result_invalid',
      taskId,
    );
  const number = (record: Record<PropertyKey, unknown>, key: string): number => {
    const raw = record[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0)
      fail(
        `delegate result package usage.${key} must be a non-negative finite number`,
        'child_result_invalid',
        taskId,
      );
    return raw;
  };
  return {
    status: 'observed',
    usage: {
      input: number(usage, 'input'),
      output: number(usage, 'output'),
      cacheRead: number(usage, 'cacheRead'),
      cacheWrite: number(usage, 'cacheWrite'),
      totalTokens: number(usage, 'totalTokens'),
      cost: {
        input: number(cost, 'input'),
        output: number(cost, 'output'),
        cacheRead: number(cost, 'cacheRead'),
        cacheWrite: number(cost, 'cacheWrite'),
        total: number(cost, 'total'),
      },
    },
  };
}

function parseAttestations(
  value: unknown,
  taskId: string,
): readonly DelegateRouteAttestation[] {
  if (!Array.isArray(value))
    fail(
      'delegate result package route_attestations must be an array',
      'route_attestation_missing',
      taskId,
    );
  if (value.length === 0)
    fail(
      'delegate result package carries no route attestation, so the route the child actually used cannot be proven',
      'route_attestation_missing',
      taskId,
    );
  return value.map((entry) => {
    if (!isRecord(entry))
      fail('delegate route attestation must be an object', 'route_attestation_missing', taskId);
    return {
      provider: requireString(entry, 'provider', taskId),
      model: requireString(entry, 'model', taskId),
      stop_reason: requireString(entry, 'stop_reason', taskId),
    };
  });
}

function parseSpillContentFormat(
  value: unknown,
  taskId: string,
): DelegateSpillReceipt['content_format'] {
  if (value === undefined) return undefined;
  if (
    value !== 'single_text_utf8' &&
    value !== 'tool_result_content_json_v1' &&
    value !== 'opaque_bytes'
  ) {
    fail('delegate spill receipt content_format is invalid', 'child_result_invalid', taskId);
  }
  return value;
}

function parseSpillReceipts(value: unknown, taskId: string): readonly DelegateSpillReceipt[] {
  if (!Array.isArray(value))
    fail('delegate result package spilled_artifacts must be an array', 'child_result_invalid', taskId);
  return value.map((entry) => {
    if (!isRecord(entry))
      fail('delegate spill receipt must be an object', 'child_result_invalid', taskId);
    if (entry['schema_version'] !== DELEGATE_RECEIPT_SCHEMA_VERSION)
      fail('delegate spill receipt schema_version mismatch', 'child_result_invalid', taskId);
    return {
      schema_version: DELEGATE_RECEIPT_SCHEMA_VERSION,
      artifact: requireString(entry, 'artifact', taskId),
      tool_name: requireString(entry, 'tool_name', taskId),
      tool_call_id: requireString(entry, 'tool_call_id', taskId),
      turn_sequence: requireInteger(entry, 'turn_sequence', taskId),
      source_call_index: requireInteger(entry, 'source_call_index', taskId),
      byte_length: requireInteger(entry, 'byte_length', taskId),
      sha256: requireSha256(entry, 'sha256', taskId),
      content_format: parseSpillContentFormat(entry['content_format'], taskId),
    };
  });
}

/**
 * Parse and fully verify a committed result package.
 *
 * Verification order matters: identity, then route, then per-block hashes, then
 * the aggregate hash. Only after every check passes are answer bytes produced,
 * and they come from the buffer that was hashed.
 */
export function verifyDelegateResultPackage(
  raw: string,
  expected: DelegateResultExpectation,
): VerifiedDelegateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(
      `delegate result package is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      'child_result_invalid',
      expected.taskId,
    );
  }
  if (!isRecord(parsed))
    fail('delegate result package must be a JSON object', 'child_result_invalid', expected.taskId);
  if (parsed['schema_version'] !== DELEGATE_RESULT_PACKAGE_SCHEMA_VERSION)
    fail(
      `delegate result package schema_version must be ${DELEGATE_RESULT_PACKAGE_SCHEMA_VERSION}`,
      'child_result_invalid',
      expected.taskId,
    );

  const taskId = requireString(parsed, 'task_id', expected.taskId);
  const launchNonce = requireString(parsed, 'launch_nonce', expected.taskId);
  if (taskId !== expected.taskId || launchNonce !== expected.launchNonce)
    fail(
      'delegate result package identity does not match the launched task; a stale or foreign package is never accepted',
      'child_result_invalid',
      expected.taskId,
    );
  const seedSha256 = requireSha256(parsed, 'seed_sha256', expected.taskId);
  if (seedSha256 !== expected.seedSha256)
    fail(
      `delegate result package was produced from a different seed: expected ${expected.seedSha256}, package declares ${seedSha256}`,
      'seed_hash_mismatch',
      expected.taskId,
    );

  const routeRecord = parsed['route'];
  if (!isRecord(routeRecord))
    fail('delegate result package route must be an object', 'child_result_invalid', expected.taskId);
  const provider = requireString(routeRecord, 'provider', expected.taskId);
  const model = requireString(routeRecord, 'model', expected.taskId);
  if (provider !== expected.route.provider || model !== expected.route.model)
    fail(
      `delegate result package route ${provider}/${model} does not match the pinned route ${expected.route.provider}/${expected.route.model}`,
      'route_mismatch',
      expected.taskId,
    );
  const attestations = parseAttestations(parsed['route_attestations'], expected.taskId);
  for (const attestation of attestations) {
    if (attestation.provider !== expected.route.provider || attestation.model !== expected.route.model)
      fail(
        `delegate child produced an assistant message on ${attestation.provider}/${attestation.model}, but the pinned route is ${expected.route.provider}/${expected.route.model}`,
        'route_mismatch',
        expected.taskId,
      );
  }

  const answerRecord = parsed['answer'];
  if (!isRecord(answerRecord))
    fail('delegate result package answer must be an object', 'child_result_invalid', expected.taskId);
  if (answerRecord['encoding'] !== 'utf-8')
    fail(
      'delegate result package answer encoding must be utf-8',
      'child_result_encoding_invalid',
      expected.taskId,
    );
  const declaredLength = requireInteger(answerRecord, 'byte_length', expected.taskId);
  const declaredSha = requireSha256(answerRecord, 'sha256', expected.taskId);
  const blocksValue = answerRecord['blocks'];
  if (!Array.isArray(blocksValue))
    fail('delegate result package answer blocks must be an array', 'child_result_invalid', expected.taskId);

  const blocks: DelegateAnswerBlock[] = [];
  const buffers: Buffer[] = [];
  for (const [index, entry] of blocksValue.entries()) {
    if (!isRecord(entry))
      fail(
        `delegate answer block ${String(index)} must be an object`,
        'child_result_invalid',
        expected.taskId,
      );
    if (entry['kind'] !== 'text')
      fail(
        `delegate answer block ${String(index)} kind must be text`,
        'child_result_invalid',
        expected.taskId,
      );
    const byteLength = requireInteger(entry, 'byte_length', expected.taskId);
    const sha = requireSha256(entry, 'sha256', expected.taskId);
    const dataBase64 = requireString(entry, 'data_base64', expected.taskId);
    const bytes = Buffer.from(dataBase64, 'base64');
    // Strict base64: a re-encode round trip catches padding and alphabet abuse
    // that Buffer.from would otherwise absorb silently.
    if (bytes.toString('base64') !== dataBase64)
      fail(
        `delegate answer block ${String(index)} is not strict base64`,
        'child_result_invalid',
        expected.taskId,
      );
    if (bytes.length !== byteLength)
      fail(
        `delegate answer block ${String(index)} declares ${String(byteLength)} bytes but carries ${String(bytes.length)}`,
        'answer_hash_mismatch',
        expected.taskId,
      );
    const actual = sha256Bytes(bytes);
    if (actual !== sha)
      fail(
        `delegate answer block ${String(index)} hash mismatch: declared ${sha}, computed ${actual}`,
        'answer_hash_mismatch',
        expected.taskId,
      );
    blocks.push({ kind: 'text', byte_length: byteLength, sha256: sha, data_base64: dataBase64 });
    buffers.push(bytes);
  }

  const aggregate = Buffer.concat(buffers);
  if (aggregate.length !== declaredLength)
    fail(
      `delegate answer declares ${String(declaredLength)} bytes but its blocks total ${String(aggregate.length)}`,
      'answer_hash_mismatch',
      expected.taskId,
    );
  const aggregateSha = sha256Bytes(aggregate);
  if (aggregateSha !== declaredSha)
    fail(
      `delegate answer aggregate hash mismatch: declared ${declaredSha}, computed ${aggregateSha}`,
      'answer_hash_mismatch',
      expected.taskId,
    );
  const answer = aggregate.toString('utf8');
  if (!Buffer.from(answer, 'utf8').equals(aggregate))
    fail(
      'delegate answer bytes are not well-formed UTF-8; they are preserved on disk and never returned with substitution characters',
      'child_result_encoding_invalid',
      expected.taskId,
    );

  return {
    package: {
      schema_version: DELEGATE_RESULT_PACKAGE_SCHEMA_VERSION,
      task_id: taskId,
      launch_nonce: launchNonce,
      seed_sha256: seedSha256,
      directive_sha256: requireSha256(parsed, 'directive_sha256', expected.taskId),
      route: { provider, model },
      route_attestations: attestations,
      stop_reason: requireString(parsed, 'stop_reason', expected.taskId),
      turns: requireInteger(parsed, 'turns', expected.taskId),
      tool_calls: requireInteger(parsed, 'tool_calls', expected.taskId),
      usage: parseUsage(parsed['usage'], expected.taskId),
      answer: {
        encoding: 'utf-8',
        byte_length: declaredLength,
        sha256: declaredSha,
        blocks,
      },
      spilled_artifacts: parseSpillReceipts(parsed['spilled_artifacts'], expected.taskId),
    },
    answer,
    answerBytes: aggregate,
  };
}
