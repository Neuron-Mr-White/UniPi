import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdirSync, openSync, closeSync, fsyncSync, renameSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { Type, type Static } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Usage } from '@earendil-works/pi-ai';
import {
  DELEGATE_RECEIPT_SCHEMA_VERSION,
  DELEGATE_CAPABILITIES,
  type DelegateRouteAttestation,
  type DelegateSeedV1,
  type DelegateSpillReceipt,
  type DelegateUsageReport,
} from './delegate/types.js';
import { verifyDelegateSeedBytes } from './delegate/seed.js';
import {
  DELEGATE_FINALIZATION_INPUT_RESERVE_TOKENS,
  DELEGATE_FINALIZATION_TRIGGER_TOKENS,
  evaluateDelegateRuntimeBudget,
} from './delegate/budget.js';
import { utf8ByteClassBreakdown } from './context-token-budget.js';
import {
  assertWellFormedUtf8,
  buildDelegateResultPackage,
  serializeDelegateResultPackage,
} from './delegate/result-package.js';

/**
 * Package-owned delegate child extension.
 *
 * This runs inside every delegate child Pi process and is the package-owned
 * child guard. Anthropic routes load attribution first, and ambient mode may
 * also execute discovered extensions; this guard remains
 * responsible for every isolation guarantee that cannot be enforced from the
 * parent:
 *
 * - verifying the frozen seed bytes before the first model call;
 * - measuring the outgoing message set before every model call and requesting
 *   no-tool finalization when advisory runway becomes low;
 * - spilling oversized or runway-pressuring tool results to hashed artifacts
 *   and replacing them with explicit receipts before transcript entry;
 * - asserting every assistant message came from the pinned route;
 * - enforcing turn and tool-call limits;
 * - committing exactly one result package atomically.
 *
 * Measured behavior across the supported Pi lines (see
 * `tests/scripted-provider/pi-hook-contract.test.ts` and `scripts/test-compat.ts`):
 *
 * - Throwing from a `context` handler does NOT stop dispatch. Pi catches the
 *   exception and continues, so a throw is never used as a barrier here.
 * - `ctx.abort()` blocks transport in both supported modes: Pi 0.81.1-0.83.0
 *   invoke the provider with an already-aborted signal, while Pi 0.84.0 skips
 *   the provider entry point during signal-aware auth resolution.
 * - The guard ALSO replaces the offending content in the returned message set.
 *   Even a non-conforming provider could not transmit the content because the
 *   content is no longer there.
 */

const SPILL_DIRNAME = 'spill';

interface GuardState {
  seed: DelegateSeedV1;
  artifactDirAbs: string;
  turns: number;
  toolCalls: number;
  totalToolOutputBytes: number;
  spilled: DelegateSpillReceipt[];
  attestations: DelegateRouteAttestation[];
  usage: Usage | undefined;
  usageIncomplete: boolean;
  usageUnavailableReason: string | undefined;
  answerBlocks: string[];
  answerBytes: number;
  retainedGrowthTokens: number;
  retainedGrowthBudgetTokens: number | undefined;
  retainedToolResultBytes: number;
  contextPressureSpillBytes: number;
  finalizationRequested: boolean;
  finalizationReason: string | undefined;
  contextMeasurements: RuntimeContextMeasurement[];
  firstRequestObservedInputTokens: number | undefined;
  runtimeBudgetWritten: boolean;
  terminal: TerminalLatch | undefined;
  committed: boolean;
}

/**
 * A terminal condition latches.
 *
 * Once the guard has degraded or refused anything, no later assistant message
 * may be committed as a successful answer. Otherwise a run whose context was
 * silently mutilated could still produce a hash-valid package, which is exactly
 * the "hash-valid but wrong" failure this design must not have.
 */
interface TerminalLatch {
  code: string;
  message: string;
}

interface RuntimeContextMeasurement {
  request_ordinal: number;
  retained_utf8_bytes: number;
  estimated_input_tokens: number;
  allowed_input_tokens: number;
  signed_headroom_tokens: number;
  dominant_byte_class: string;
  finalization_requested: boolean;
}

/**
 * Stop reasons that may be committed as a complete answer.
 *
 * `length` means the provider truncated the response at the output-token limit,
 * `aborted` and `error` mean the run did not finish, and a pending tool call
 * means the agent had more to do. None of those is a whole answer, so none of
 * them may be committed as one.
 */
const ACCEPTED_STOP_REASONS: ReadonlySet<string> = new Set(['stop']);

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Replacement message set used when the guard suppresses a request.
 *
 * Keeps the shape valid without transmitting the content that triggered the
 * suppression. The head message is retained only when it is a user message, so
 * a suppressed request cannot carry assistant or tool content forward.
 */
function suppressedMessages<TMessage extends object>(
  messages: readonly TMessage[],
): TMessage[] {
  const head = messages[0];
  if (head === undefined) return [];
  return Reflect.get(head, 'role') === 'user' ? [head] : [];
}

function utf8(value: string): Buffer {
  return Buffer.from(value, 'utf8');
}

interface DelegateToolTextPart {
  readonly type: 'text';
  readonly text: string;
}

interface DelegateToolImagePart {
  readonly type: 'image';
  readonly data: string;
  readonly mimeType: string;
}

type DelegateToolResultPart = DelegateToolTextPart | DelegateToolImagePart;
type SpillContentFormat = DelegateSpillReceipt['content_format'];

function encodeToolResultContent(
  content: ReadonlyArray<DelegateToolResultPart>,
): { payload: Buffer; contentFormat: Exclude<SpillContentFormat, undefined> } {
  if (content.length === 1) {
    const only = content[0];
    if (only?.type === 'text') {
      return {
        payload: assertWellFormedUtf8(only.text, 'delegate single-text tool result'),
        contentFormat: 'single_text_utf8',
      };
    }
  }
  const normalized = content.map((part) => {
    if (part.type === 'text' && typeof part.text === 'string') {
      return { type: 'text' as const, text: part.text };
    }
    if (
      part.type === 'image' &&
      typeof part.data === 'string' &&
      typeof part.mimeType === 'string'
    ) {
      return {
        type: 'image' as const,
        data: part.data,
        mimeType: part.mimeType,
      };
    }
    throw new Error('delegate tool result contains an unsupported or malformed content block');
  });
  return {
    payload: utf8(
      JSON.stringify({
        schema_version: 'pi-background-tasks.delegate-tool-result-content.v1',
        content: normalized,
      }),
    ),
    contentFormat: 'tool_result_content_json_v1',
  };
}

function addUsage(current: Usage | undefined, delta: Usage): Usage {
  const prior = current ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return {
    input: prior.input + delta.input,
    output: prior.output + delta.output,
    cacheRead: prior.cacheRead + delta.cacheRead,
    cacheWrite: prior.cacheWrite + delta.cacheWrite,
    totalTokens: prior.totalTokens + delta.totalTokens,
    cost: {
      input: prior.cost.input + delta.cost.input,
      output: prior.cost.output + delta.cost.output,
      cacheRead: prior.cost.cacheRead + delta.cost.cacheRead,
      cacheWrite: prior.cost.cacheWrite + delta.cost.cacheWrite,
      total: prior.cost.total + delta.cost.total,
    },
  };
}

function finiteNonNegative(source: object, key: string): number | undefined {
  const value: unknown = Reflect.get(source, key);
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/**
 * Read a complete Pi `Usage` record, or report none.
 *
 * A partial usage record is treated as no usage at all. Filling missing fields
 * with zero would understate real spend, which is a silent misreport.
 */
function readUsage(value: unknown): Usage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const cost: unknown = Reflect.get(value, 'cost');
  if (typeof cost !== 'object' || cost === null) return undefined;
  const input = finiteNonNegative(value, 'input');
  const output = finiteNonNegative(value, 'output');
  const cacheRead = finiteNonNegative(value, 'cacheRead');
  const cacheWrite = finiteNonNegative(value, 'cacheWrite');
  const totalTokens = finiteNonNegative(value, 'totalTokens');
  const costInput = finiteNonNegative(cost, 'input');
  const costOutput = finiteNonNegative(cost, 'output');
  const costCacheRead = finiteNonNegative(cost, 'cacheRead');
  const costCacheWrite = finiteNonNegative(cost, 'cacheWrite');
  const costTotal = finiteNonNegative(cost, 'total');
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    totalTokens === undefined ||
    costInput === undefined ||
    costOutput === undefined ||
    costCacheRead === undefined ||
    costCacheWrite === undefined ||
    costTotal === undefined
  ) {
    return undefined;
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: {
      input: costInput,
      output: costOutput,
      cacheRead: costCacheRead,
      cacheWrite: costCacheWrite,
      total: costTotal,
    },
  };
}

function readEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.length === 0) {
    throw new Error(`delegate child requires ${key}`);
  }
  return value;
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'));
}

/** Synchronous durable commit: temp write, fsync, rename, directory fsync. */
function commitFileSync(absPath: string, data: Buffer): void {
  const dir = dirname(absPath);
  mkdirSync(dir, { recursive: true });
  const temporary = `${absPath}.${String(process.pid)}.${Date.now().toString(36)}.tmp`;
  const handle = openSync(temporary, 'wx', 0o600);
  try {
    let written = 0;
    while (written < data.length) {
      written += writeSync(handle, data, written, data.length - written, null);
    }
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, absPath);
  if (process.platform !== 'win32') {
    const dirHandle = openSync(dir, 'r');
    try {
      fsyncSync(dirHandle);
    } finally {
      closeSync(dirHandle);
    }
  }
}

interface ContentMeasurement {
  bytes: number;
  multibyteBytes: number;
  denseBytes: 0;
}

function emptyContentMeasurement(): ContentMeasurement {
  return { bytes: 0, multibyteBytes: 0, denseBytes: 0 };
}

function addContentMeasurement(target: ContentMeasurement, delta: ContentMeasurement): void {
  target.bytes += delta.bytes;
  target.multibyteBytes += delta.multibyteBytes;
}

function stringMeasurement(value: string): ContentMeasurement {
  return utf8ByteClassBreakdown(value);
}

function messageContentMeasurement(content: unknown): ContentMeasurement {
  if (typeof content === 'string') return stringMeasurement(content);
  const total = emptyContentMeasurement();
  if (!Array.isArray(content)) return total;
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue;
    const text: unknown = Reflect.get(part, 'text');
    if (typeof text === 'string') addContentMeasurement(total, stringMeasurement(text));
    const thinkingText: unknown = Reflect.get(part, 'thinking');
    if (typeof thinkingText === 'string') addContentMeasurement(total, stringMeasurement(thinkingText));
    const args: unknown = Reflect.get(part, 'arguments');
    if (args !== undefined) addContentMeasurement(total, stringMeasurement(JSON.stringify(args) ?? ''));
    const data: unknown = Reflect.get(part, 'data');
    if (typeof data === 'string') addContentMeasurement(total, stringMeasurement(data));
  }
  return total;
}

/** Complete retained input measured the same way the admission plan measured the seed. */
function retainedInputMeasurement(messages: readonly object[], systemPrompt: string): ContentMeasurement {
  const total = stringMeasurement(systemPrompt);
  for (const message of messages) addContentMeasurement(total, messageContentMeasurement(Reflect.get(message, 'content')));
  return total;
}

const ArtifactReadParams = Type.Object(
  {
    artifact: Type.String({
      description:
        'Relative artifact path exactly as named in a spill receipt, for example spill/t0001-c0000-abc.bin',
    }),
    offset: Type.Number({ description: 'Byte offset to start reading from. Zero-based.' }),
    length: Type.Number({ description: 'Exact number of bytes to read. Must be positive.' }),
  },
  { additionalProperties: false },
);

type ArtifactReadParamsValue = Static<typeof ArtifactReadParams>;

interface ArtifactReadDetails {
  artifact: string;
  offset: number;
  length: number;
  total_bytes: number;
}

export default function delegateChildExtension(pi: ExtensionAPI): void {
  const artifactDirAbs = readEnv('UNIPI_BG_DELEGATE_ARTIFACT_DIR');
  const seedPath = readEnv('UNIPI_BG_DELEGATE_SEED_PATH');
  const expectedSeedSha = readEnv('UNIPI_BG_DELEGATE_SEED_SHA256');
  const expectedTaskId = readEnv('UNIPI_BG_DELEGATE_TASK_ID');
  const expectedNonce = readEnv('UNIPI_BG_DELEGATE_LAUNCH_NONCE');

  // Seed verification happens at load, before the first model call. A seed
  // that does not match its declared hash and identity aborts the child rather
  // than running with content the parent did not author.
  const seedRaw = readFileSync(seedPath, 'utf8');
  const seed = verifyDelegateSeedBytes(seedRaw, {
    sha256: expectedSeedSha,
    taskId: expectedTaskId,
    launchNonce: expectedNonce,
  });

  if (!DELEGATE_CAPABILITIES.includes(seed.capability)) {
    throw new Error(`delegate child cannot enforce capability ${seed.capability}`);
  }

  const state: GuardState = {
    seed,
    artifactDirAbs,
    turns: 0,
    toolCalls: 0,
    totalToolOutputBytes: 0,
    spilled: [],
    attestations: [],
    usage: undefined,
    usageIncomplete: false,
    usageUnavailableReason: 'the child produced no assistant message carrying usage',
    answerBlocks: [],
    answerBytes: 0,
    retainedGrowthTokens: 0,
    retainedGrowthBudgetTokens: undefined,
    retainedToolResultBytes: 0,
    contextPressureSpillBytes: 0,
    finalizationRequested: false,
    finalizationReason: undefined,
    contextMeasurements: [],
    firstRequestObservedInputTokens: undefined,
    runtimeBudgetWritten: false,
    terminal: undefined,
    committed: false,
  };

  function latch(code: string, message: string): void {
    if (state.terminal === undefined) state.terminal = { code, message };
  }

  function usageReport(): DelegateUsageReport {
    if (!state.usageIncomplete && state.usage !== undefined) {
      return { status: 'observed', usage: state.usage };
    }
    return {
      status: 'unavailable',
      reason: state.usageUnavailableReason ?? 'usage was not reported by the provider',
    };
  }

  function remainingGrowthTokens(): number {
    if (state.retainedGrowthBudgetTokens === undefined) return 0;
    return Math.max(0, state.retainedGrowthBudgetTokens - state.retainedGrowthTokens);
  }

  function requestFinalization(reason: string): void {
    if (!state.finalizationRequested) {
      state.finalizationRequested = true;
      state.finalizationReason = reason;
    }
    pi.setActiveTools([]);
  }

  function accountRetainedGrowth(bytes: number, source: string): void {
    state.retainedGrowthTokens += bytes;
    if (
      state.retainedGrowthBudgetTokens !== undefined &&
      remainingGrowthTokens() <= DELEGATE_FINALIZATION_TRIGGER_TOKENS
    ) {
      requestFinalization(
        `${source} left ${String(remainingGrowthTokens())} protected retained-growth tokens`,
      );
    }
  }

  function writeRuntimeBudgetRecord(): void {
    if (state.runtimeBudgetWritten) return;
    const latest = state.contextMeasurements.at(-1);
    const firstEstimate = state.contextMeasurements[0]?.estimated_input_tokens;
    const calibrationViolation =
      firstEstimate !== undefined &&
      state.firstRequestObservedInputTokens !== undefined &&
      state.firstRequestObservedInputTokens > firstEstimate
        ? {
            forecast_input_tokens: firstEstimate,
            observed_input_tokens: state.firstRequestObservedInputTokens,
            tokens_under_forecast:
              state.firstRequestObservedInputTokens - firstEstimate,
          }
        : null;
    commitFileSync(
      join(artifactDirAbs, 'runtime-budget.json'),
      utf8(
        `${JSON.stringify(
          {
            schema_version: 'pi-background-tasks.delegate-runtime-budget.v1',
            task_id: seed.task_id,
            launch_nonce: seed.launch_nonce,
            policy: {
              live_provider_context_owner: 'pi_and_provider',
              retained_growth_estimator: 'provable_1_byte_per_token',
              finalization_input_reserve_tokens: DELEGATE_FINALIZATION_INPUT_RESERVE_TOKENS,
              finalization_trigger_tokens: DELEGATE_FINALIZATION_TRIGGER_TOKENS,
            },
            retained_growth_budget_tokens: state.retainedGrowthBudgetTokens ?? null,
            retained_growth_tokens: state.retainedGrowthTokens,
            retained_tool_result_bytes: state.retainedToolResultBytes,
            spilled_tool_result_bytes: state.spilled.reduce(
              (sum, receipt) => sum + receipt.byte_length,
              0,
            ),
            context_pressure_spill_bytes: state.contextPressureSpillBytes,
            finalization_requested: state.finalizationRequested,
            finalization_reason: state.finalizationReason ?? null,
            first_request_observed_input_tokens: state.firstRequestObservedInputTokens ?? null,
            calibration_violation: calibrationViolation,
            latest_context_estimate: latest ?? null,
            context_measurements: state.contextMeasurements,
          },
          null,
          2,
        )}\n`,
      ),
    );
    state.runtimeBudgetWritten = true;
  }

  /**
   * Commit exactly one result package.
   *
   * Refuses to commit when a terminal condition has latched, so a degraded run
   * can never be reported as a clean success. Refuses to commit twice.
   */
  function commitResult(stopReason: string): void {
    if (state.committed) return;
    if (state.terminal !== undefined) {
      writeTerminalRecord(state.terminal);
      return;
    }
    // A hash proves the bytes are intact; it cannot prove they are complete.
    // Only an approved terminal stop reason may be committed as success, so a
    // response cut short by the output-token limit, a content filter, an
    // aborted run, or a provider error can never be returned as a whole answer.
    if (!ACCEPTED_STOP_REASONS.has(stopReason)) {
      writeTerminalRecord({
        code: stopReason === 'length' ? 'child_model_output_limit' : 'child_result_invalid',
        message: `the delegate child stopped with reason "${stopReason}", so its answer is incomplete and is not committed as a result; the complete assistant message remains in the child transcript`,
      });
      return;
    }
    if (state.answerBlocks.length === 0) {
      writeTerminalRecord({
        code: 'child_exited_without_commit',
        message: 'the delegate child produced no final assistant answer text',
      });
      return;
    }
    if (state.answerBlocks.join('').trim().length === 0) {
      writeTerminalRecord({
        code: 'child_result_invalid',
        message: 'the delegate child produced only whitespace, which is not a usable answer',
      });
      return;
    }
    writeRuntimeBudgetRecord();
    const pkg = buildDelegateResultPackage({
      taskId: seed.task_id,
      launchNonce: seed.launch_nonce,
      seedSha256: expectedSeedSha,
      directiveSha256: seed.directive.sha256,
      route: { provider: seed.route.provider, model: seed.route.model },
      routeAttestations: state.attestations,
      stopReason,
      turns: state.turns,
      toolCalls: state.toolCalls,
      usage: usageReport(),
      answerBlocks: state.answerBlocks,
      spilledArtifacts: state.spilled,
    });
    commitFileSync(join(artifactDirAbs, 'result.json'), utf8(serializeDelegateResultPackage(pkg)));
    state.committed = true;
  }

  function writeTerminalRecord(terminal: TerminalLatch): void {
    writeRuntimeBudgetRecord();
    commitFileSync(
      join(artifactDirAbs, 'child-terminal.json'),
      utf8(
        `${JSON.stringify(
          {
            schema_version: 'pi-background-tasks.delegate-child-terminal.v1',
            task_id: seed.task_id,
            launch_nonce: seed.launch_nonce,
            code: terminal.code,
            message: terminal.message,
            turns: state.turns,
            tool_calls: state.toolCalls,
            spilled_artifacts: state.spilled,
          },
          null,
          2,
        )}\n`,
      ),
    );
  }

  pi.registerTool<typeof ArtifactReadParams, ArtifactReadDetails>({
    name: 'delegate_read_artifact',
    label: 'Delegate Artifact Read',
    description:
      'Read an exact byte range from a spilled tool-result artifact as lossless base64. Returns the complete requested range or fails; it never decodes arbitrary bytes as UTF-8, returns fewer bytes, or clamps the request.',
    promptSnippet: 'Read an exact artifact byte range as lossless base64',
    promptGuidelines: [
      'Use delegate_read_artifact when a tool result was replaced by a spill receipt and the omitted bytes are actually needed.',
      'The response body is base64 for the exact requested bytes. Decode it according to the receipt content_format.',
      'Request a bounded range. A request past the end of the artifact fails loudly rather than returning a short read.',
    ],
    parameters: ArtifactReadParams,
    prepareArguments(args): ArtifactReadParamsValue {
      if (typeof args !== 'object' || args === null)
        throw new Error('delegate_read_artifact arguments must be an object');
      const artifact: unknown = Reflect.get(args, 'artifact');
      const offset: unknown = Reflect.get(args, 'offset');
      const length: unknown = Reflect.get(args, 'length');
      if (typeof artifact !== 'string')
        throw new Error('delegate_read_artifact requires artifact string');
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0)
        throw new Error('delegate_read_artifact requires a non-negative integer offset');
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length <= 0)
        throw new Error('delegate_read_artifact requires a positive integer length');
      return { artifact, offset, length };
    },
    execute(_toolCallId, params) {
      const absPath = join(artifactDirAbs, params.artifact);
      if (!pathInside(artifactDirAbs, absPath)) {
        throw new Error(
          `delegate_read_artifact path ${params.artifact} escapes the delegate artifact directory`,
        );
      }
      const bytes = readFileSync(absPath);
      const end = params.offset + params.length;
      if (end > bytes.length) {
        throw new Error(
          `delegate_read_artifact requested bytes ${String(params.offset)}..${String(end)} but ${params.artifact} is ${String(bytes.length)} bytes; the read is refused rather than silently shortened`,
        );
      }
      const slice = bytes.subarray(params.offset, end);
      if (slice.length !== params.length) {
        throw new Error(
          `delegate_read_artifact returned ${String(slice.length)} of ${String(params.length)} requested bytes`,
        );
      }
      const encoded = slice.toString('base64');
      const responseText = [
        `[delegate artifact range] artifact=${params.artifact} offset=${String(params.offset)} length=${String(params.length)} encoding=base64`,
        encoded,
      ].join('\n');
      const responseBytes = utf8(responseText).length;
      const availableInlineBytes = Math.max(
        0,
        Math.min(
          seed.limits.max_tool_result_bytes,
          remainingGrowthTokens() - DELEGATE_FINALIZATION_TRIGGER_TOKENS,
        ),
      );
      if (responseBytes > availableInlineBytes) {
        if (availableInlineBytes === 0) {
          requestFinalization('no retained-growth runway remains for an artifact range read');
          throw new Error(
            `delegate_read_artifact cannot retain another artifact range because protected final-answer runway is active; stop reading and answer from gathered evidence`,
          );
        }
        throw new Error(
          `delegate_read_artifact requested ${String(params.length)} raw bytes whose lossless base64 response is ${String(responseBytes)} bytes, but current protected runway permits at most ${String(availableInlineBytes)} inline bytes; request a smaller exact range`,
        );
      }
      return Promise.resolve({
        content: [{ type: 'text' as const, text: responseText }],
        details: {
          artifact: params.artifact,
          offset: params.offset,
          length: params.length,
          total_bytes: bytes.length,
        },
      });
    },
  });

  pi.on('context', (event, ctx) => {
    // Measurement failures remain fail-closed. A successful estimate is
    // advisory: Fusion BUG-185 proved that subtracting hypothetical output from
    // a live provider payload can falsely refuse valid work. Package-owned
    // growth is bounded earlier by the tool-result spill governor instead.
    try {
      if (state.terminal !== undefined) {
        ctx.abort();
        return { messages: suppressedMessages(event.messages) };
      }
      const measurement = retainedInputMeasurement(event.messages, ctx.getSystemPrompt());
      const verdict = evaluateDelegateRuntimeBudget(
        {
          retainedInputBytes: measurement.bytes,
          retainedInputMultibyteBytes: measurement.multibyteBytes,
          retainedInputDenseBytes: measurement.denseBytes,
        },
        seed.limits.allowed_input_tokens,
        seed.route,
      );
      if (state.retainedGrowthBudgetTokens === undefined) {
        state.retainedGrowthBudgetTokens = Math.max(
          0,
          verdict.allowedTokens -
            verdict.measuredTokens -
            DELEGATE_FINALIZATION_INPUT_RESERVE_TOKENS,
        );
      }
      state.contextMeasurements.push({
        request_ordinal: state.contextMeasurements.length + 1,
        retained_utf8_bytes: measurement.bytes,
        estimated_input_tokens: verdict.measuredTokens,
        allowed_input_tokens: verdict.allowedTokens,
        signed_headroom_tokens: verdict.allowedTokens - verdict.measuredTokens,
        dominant_byte_class: verdict.dominantByteClass,
        finalization_requested: state.finalizationRequested,
      });
      if (
        verdict.measuredTokens >=
        verdict.allowedTokens - DELEGATE_FINALIZATION_INPUT_RESERVE_TOKENS
      ) {
        requestFinalization(
          `advisory retained-input estimate reached ${String(verdict.measuredTokens)} of ${String(verdict.allowedTokens)} allowed tokens`,
        );
      }
      if (!state.finalizationRequested) return undefined;
      const finalizationMessage = {
        role: 'user' as const,
        content: `[delegate finalization runway] Stop investigating and do not call tools. Produce the final self-contained answer now from evidence already gathered. Reason: ${state.finalizationReason ?? 'protected final-answer runway is active'}.`,
        timestamp: Date.now(),
      };
      return { messages: [...event.messages, finalizationMessage] };
    } catch (error) {
      latch(
        'child_result_invalid',
        `delegate context measurement failed and the run was stopped rather than dispatched unguarded: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        ctx.abort();
      } catch {
        // The terminal latch prevents success even if abort itself fails.
      }
      return { messages: suppressedMessages(event.messages) };
    }
  });

  pi.on('tool_call', (_event, ctx) => {
    if (state.finalizationRequested) {
      return {
        block: true,
        reason: 'delegate protected final-answer runway is active; answer now without tools',
      };
    }
    state.toolCalls += 1;
    if (state.toolCalls > seed.limits.max_tool_calls) {
      latch(
        'child_tool_call_limit',
        `delegate child exceeded its ${String(seed.limits.max_tool_calls)} tool-call limit`,
      );
      ctx.abort();
      return {
        block: true,
        reason: `delegate child exceeded its ${String(seed.limits.max_tool_calls)} tool-call limit`,
      };
    }
    return undefined;
  });

  pi.on('tool_result', (event) => {
    // Fail closed for the same reason as the context guard: a throw here would
    // let the ORIGINAL oversized payload flow into the transcript.
    try {
      return guardToolResult(event);
    } catch (error) {
      latch(
        'artifact_spill_failed',
        `delegate tool-result guard failed and the payload was withheld: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: '[delegate: tool result withheld because the result guard failed; the run is terminating]',
          },
        ],
        isError: true,
      };
    }
  });

  function guardToolResult(event: {
    toolName: string;
    toolCallId: string;
    content: ReadonlyArray<DelegateToolResultPart>;
  }): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } | undefined {
    // A single text block keeps its exact UTF-8 payload for convenient range
    // reads. Multi-block and image-bearing results use a closed JSON envelope
    // so block boundaries, MIME types, and complete base64 image data survive
    // a spill. Unknown blocks fail closed rather than disappearing from hashes.
    const encodedContent = encodeToolResultContent(event.content);
    const payload = encodedContent.payload;
    state.totalToolOutputBytes += payload.length;
    if (state.totalToolOutputBytes > seed.limits.max_total_tool_output_bytes) {
      latch(
        'aggregate_tool_output_cap',
        `delegate child accumulated ${String(state.totalToolOutputBytes)} bytes of tool output, exceeding its ${String(seed.limits.max_total_tool_output_bytes)}-byte cap`,
      );
      requestFinalization('the aggregate raw tool-output cap was reached');
      const withheld = '[delegate: tool result withheld because the aggregate raw-output cap was reached; answer from evidence already gathered]';
      accountRetainedGrowth(utf8(withheld).length, 'aggregate-cap receipt');
      return { content: [{ type: 'text', text: withheld }], isError: true };
    }
    const contextPressure =
      state.retainedGrowthBudgetTokens === undefined || payload.length > remainingGrowthTokens();
    if (!contextPressure && payload.length <= seed.limits.max_tool_result_bytes) {
      state.retainedToolResultBytes += payload.length;
      accountRetainedGrowth(payload.length, `${event.toolName} inline result`);
      return undefined;
    }

    // Per-result oversized or route-pressure output is spilled in full and
    // replaced by a receipt. Conservative false positives cause an explicit
    // spill, never task failure or silent byte loss.
    const turnSequence = state.turns;
    const sourceCallIndex = state.spilled.length;
    const safeCallId = event.toolCallId.replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 64);
    const name = `t${String(turnSequence).padStart(4, '0')}-c${String(sourceCallIndex).padStart(4, '0')}-${safeCallId}.bin`;
    const relPath = join(SPILL_DIRNAME, name);
    const absPath = join(artifactDirAbs, relPath);
    if (!pathInside(artifactDirAbs, absPath)) {
      latch('artifact_spill_failed', `delegate spill path escapes the artifact directory: ${name}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: '[delegate: tool result withheld because its spill path was rejected]',
          },
        ],
      };
    }
    try {
      commitFileSync(absPath, payload);
    } catch (error) {
      // A spill that cannot be committed is terminal. The original payload is
      // never returned as a fallback, and no receipt claims an uncommitted file.
      latch(
        'artifact_spill_failed',
        `delegate could not spill a ${String(payload.length)}-byte tool result: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: '[delegate: tool result withheld because it could not be durably spilled; the run is terminating]',
          },
        ],
        isError: true,
      };
    }
    const receipt: DelegateSpillReceipt = {
      schema_version: DELEGATE_RECEIPT_SCHEMA_VERSION,
      artifact: relPath,
      tool_name: event.toolName,
      tool_call_id: event.toolCallId,
      turn_sequence: turnSequence,
      source_call_index: sourceCallIndex,
      byte_length: payload.length,
      sha256: sha256(payload),
      content_format: encodedContent.contentFormat,
    };
    state.spilled.push(receipt);
    if (contextPressure) state.contextPressureSpillBytes += payload.length;
    const spillReason = contextPressure
      ? `retaining it would consume protected final-answer runway (${String(remainingGrowthTokens())} tokens remain)`
      : `it exceeded the ${String(seed.limits.max_tool_result_bytes)}-byte per-result transcript cap`;
    const receiptText = [
      `[delegate spill receipt] The ${event.toolName} result was ${String(payload.length)} bytes; ${spillReason}.`,
      `It was written in full to ${relPath} (sha256 ${receipt.sha256}, content_format ${encodedContent.contentFormat}).`,
      'Nothing was truncated: the complete encoded content is on disk.',
      `Read an exact range as base64 with delegate_read_artifact({artifact:"${relPath}", offset, length}).`,
    ].join('\n');
    accountRetainedGrowth(utf8(receiptText).length, `${event.toolName} spill receipt`);
    return {
      content: [{ type: 'text' as const, text: receiptText }],
    };
  }

  pi.on('turn_start', () => {
    state.turns += 1;
    if (state.turns > seed.limits.max_turns) {
      latch(
        'child_turn_limit',
        `delegate child exceeded its ${String(seed.limits.max_turns)} turn limit`,
      );
    }
  });

  pi.on('message_end', (event) => {
    if (event.message.role !== 'assistant') return;
    const provider: unknown = Reflect.get(event.message, 'provider');
    const model: unknown = Reflect.get(event.message, 'model');
    const stopReason: unknown = Reflect.get(event.message, 'stopReason');
    const attestation: DelegateRouteAttestation = {
      provider: typeof provider === 'string' ? provider : '',
      model: typeof model === 'string' ? model : '',
      stop_reason: typeof stopReason === 'string' ? stopReason : '',
    };
    state.attestations.push(attestation);
    if (
      attestation.provider !== seed.route.provider ||
      attestation.model !== seed.route.model
    ) {
      latch(
        'route_mismatch',
        `delegate child produced an assistant message on ${attestation.provider}/${attestation.model}, but the pinned route is ${seed.route.qualified_id}`,
      );
    }
    const observedUsage = readUsage(Reflect.get(event.message, 'usage'));
    if (observedUsage === undefined) {
      // Never synthesize zero usage. Once one turn is incomplete, later usage
      // cannot conceal it by replacing the missing record.
      state.usageIncomplete = true;
      state.usageUnavailableReason =
        'at least one provider turn did not report a complete token/cost usage record';
    } else {
      if (state.firstRequestObservedInputTokens === undefined) {
        state.firstRequestObservedInputTokens =
          observedUsage.input + observedUsage.cacheRead + observedUsage.cacheWrite;
      }
      state.usage = addUsage(state.usage, observedUsage);
      if (!state.usageIncomplete) state.usageUnavailableReason = undefined;
    }
    const content: unknown = Reflect.get(event.message, 'content');
    if (!Array.isArray(content)) return;
    if (attestation.stop_reason !== 'stop') {
      const retained = messageContentMeasurement(content);
      accountRetainedGrowth(retained.bytes, 'assistant intermediate message');
      // Tool-use narration is retained in the transcript for reasoning but is
      // not part of the delegate's committed answer. Only the final clean-stop
      // assistant message owns the answer data plane.
      return;
    }
    state.answerBlocks = [];
    state.answerBytes = 0;
    for (const part of content) {
      if (typeof part !== 'object' || part === null) continue;
      if (Reflect.get(part, 'type') !== 'text') continue;
      const text: unknown = Reflect.get(part, 'text');
      if (typeof text !== 'string' || text.length === 0) continue;
      const bytes = utf8(text).length;
      state.answerBytes += bytes;
      if (state.answerBytes > seed.limits.max_answer_bytes) {
        latch(
          'child_capture_limit',
          `delegate child answer text reached ${String(state.answerBytes)} bytes, exceeding its ${String(seed.limits.max_answer_bytes)}-byte capture contract; the transcript is preserved and no prefix is committed`,
        );
        continue;
      }
      state.answerBlocks.push(text);
    }
  });

  pi.on('agent_end', () => {
    const finalStop = state.attestations.at(-1)?.stop_reason ?? 'unknown';
    commitResult(finalStop);
  });

  pi.on('session_shutdown', () => {
    // A shutdown before agent_end means no answer was produced. Record it so the
    // parent sees a typed reason instead of an empty directory.
    if (state.committed) return;
    if (state.terminal === undefined) {
      latch('child_exited_without_commit', 'the delegate child shut down before committing a result');
    }
    if (state.terminal !== undefined) writeTerminalRecord(state.terminal);
  });
}
