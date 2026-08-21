import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import { buildFusionCanonicalInput } from '../../fusion/context.js';
import { FusionBudget } from '../../fusion/budget.js';
import { canonicalJson } from '../../attested-pi-run.js';
import {
  FUSION_NO_TOOLS_CAPABILITY,
  FUSION_VALIDATE_CAPABILITY,
  type FusionCapability,
  type FusionSource,
  type ResolvedFusionModel,
  type ResolvedFusionModels,
} from '../../fusion/types.js';
import {
  FUSION_REASON_WORKFLOW,
  FUSION_VALIDATE_WORKFLOW,
  type FusionWorkflowProfile,
} from '../../fusion/workflows.js';
import { assistantMessage, sessionWith, toolResultMessage, userMessage } from './fusion-canonical.js';

/**
 * Frozen differential corpus for Fusion's conversation projection and budget
 * planner.
 *
 * Every case here is rendered to raw bytes and compared against committed golden
 * files. The corpus is deliberately exhaustive across the branches that could
 * silently move during a refactor: run-boundary flushing, image coalescing in
 * `projection_map`, tool-name ordering, `compactCounts` combinations, UTF-8 and
 * lone-surrogate handling, empty-block accounting, and every budget stage.
 */

type ConversationMessage = UserMessage | AssistantMessage | ToolResultMessage;

export interface FusionGoldenCase {
  readonly id: string;
  readonly messages: readonly ConversationMessage[];
  readonly source: FusionSource;
  readonly request: string;
  readonly systemPrompt: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
}

function thinking(text: string) {
  return { type: 'thinking' as const, thinking: text, thinkingSignature: '' };
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { type: 'toolCall' as const, id, name, arguments: args };
}

function textBlock(text: string) {
  return { type: 'text' as const, text };
}

function image(mimeType: string, data = 'AAAA') {
  return { type: 'image' as const, mimeType, data };
}

const UNICODE_SAMPLE = [
  'crlf\r\nline',
  'quote " backslash \\ slash /',
  'emoji 👩‍👩‍👧‍👦 family',
  'combining e\u0301 accent',
  'rtl \u05D0\u05D1\u05D2 hebrew',
  'sep \u2028 para \u2029 end',
  'zwj \u200D joiner',
  'tab\tvertical\u000Bform\u000C',
  'lone surrogate \uD800 end',
  'nul \u0000 byte',
].join(' | ');

export const FUSION_GOLDEN_CASES: readonly FusionGoldenCase[] = [
  { id: 'empty-conversation', messages: [], source: 'tool', request: 'r', systemPrompt: 'sys' },
  {
    id: 'user-text-only',
    messages: [userMessage('hello world')],
    source: 'tool',
    request: 'r',
    systemPrompt: 'sys',
  },
  {
    id: 'empty-string-user-content',
    messages: [userMessage(''), userMessage([textBlock('')]), userMessage('after')],
    source: 'tool',
    request: 'r',
    systemPrompt: 'sys',
  },
  {
    id: 'omission-only',
    messages: [assistantMessage([thinking('secret reasoning')])],
    source: 'tool',
    request: 'r',
    systemPrompt: 'sys',
  },
  {
    id: 'omission-at-start',
    messages: [assistantMessage([thinking('lead')]), userMessage('visible tail')],
    source: 'tool',
    request: 'r',
    systemPrompt: 'sys',
  },
  {
    id: 'omission-at-end',
    messages: [userMessage('visible head'), assistantMessage([thinking('trail')])],
    source: 'tool',
    request: 'r',
    systemPrompt: 'sys',
  },
  {
    id: 'singleton-run-between-text',
    messages: [
      userMessage('before'),
      assistantMessage([thinking('mid')]),
      userMessage('after'),
    ],
    source: 'tool',
    request: 'r',
    systemPrompt: 'sys',
  },
  {
    id: 'multiple-separated-runs',
    messages: [
      userMessage('a'),
      assistantMessage([thinking('t1'), toolCall('c1', 'read', { path: '/x' })]),
      toolResultMessage('c1', 'read', [textBlock('payload one')]),
      assistantMessage([textBlock('visible answer')]),
      assistantMessage([thinking('t2'), toolCall('c2', 'grep', { pattern: 'p' })]),
      toolResultMessage('c2', 'grep', [textBlock('payload two')]),
      userMessage('z'),
    ],
    source: 'tool',
    request: 'r',
    systemPrompt: 'sys',
  },
  {
    id: 'cross-message-contiguous-run',
    messages: [
      assistantMessage([toolCall('c1', 'read', { path: '/a' })]),
      toolResultMessage('c1', 'read', [textBlock('one')]),
      assistantMessage([toolCall('c2', 'read', { path: '/b' })]),
      toolResultMessage('c2', 'read', [textBlock('two')]),
    ],
    source: 'tool',
    request: 'r',
    systemPrompt: 'sys',
  },
  {
    id: 'all-count-kinds-in-one-run',
    messages: [
      assistantMessage([thinking('why'), toolCall('c1', 'ls', { path: '.' })]),
      toolResultMessage('c1', 'ls', [textBlock('entries')]),
    ],
    source: 'tool',
    request: 'r',
    systemPrompt: 'sys',
  },
  {
    id: 'thinking-only-counts',
    messages: [assistantMessage([thinking('a'), thinking('b')])],
    source: 'tool',
    request: 'r',
    systemPrompt: 'sys',
  },
  {
    id: 'tool-call-only-counts',
    messages: [assistantMessage([toolCall('c1', 'find', {}), toolCall('c2', 'find', {})])],
    source: 'tool',
    request: 'r',
    systemPrompt: 'sys',
  },
  {
    id: 'tool-result-only-counts',
    messages: [toolResultMessage('c1', 'read', [textBlock('only result')])],
    source: 'tool',
    request: 'r',
    systemPrompt: 'sys',
  },
  {
    id: 'single-user-image',
    messages: [userMessage([image('image/png')])],
    source: 'tool',
    request: 'r',
    systemPrompt: 'sys',
  },
  {
    id: 'adjacent-user-images',
    messages: [userMessage([image('image/png'), image('image/jpeg'), image('image/webp')])],
    source: 'tool',
    request: 'r',
    systemPrompt: 'sys',
  },
  {
    id: 'text-image-text',
    messages: [userMessage([textBlock('left'), image('image/gif'), textBlock('right')])],
    source: 'tool',
    request: 'r',
    systemPrompt: 'sys',
  },
  {
    id: 'adjacent-tool-result-images-coalesce',
    messages: [
      toolResultMessage('c1', 'read', [image('image/png', 'IMG1'), image('image/png', 'IMG2')]),
      toolResultMessage('c2', 'read', [image('image/png', 'IMG3')]),
    ],
    source: 'tool',
    request: 'r',
    systemPrompt: 'sys',
  },
  {
    id: 'image-splits-omission-run',
    messages: [
      assistantMessage([thinking('before image')]),
      toolResultMessage('c1', 'read', [image('image/png', 'MID')]),
      assistantMessage([thinking('after image')]),
    ],
    source: 'tool',
    request: 'r',
    systemPrompt: 'sys',
  },
  {
    id: 'non-adjacent-tool-result-images',
    messages: [
      toolResultMessage('c1', 'read', [image('image/png', 'A')]),
      toolResultMessage('c2', 'read', [textBlock('text between')]),
      toolResultMessage('c3', 'read', [image('image/png', 'B')]),
    ],
    source: 'tool',
    request: 'r',
    systemPrompt: 'sys',
  },
  {
    id: 'mixed-tool-result-text-and-image',
    messages: [
      toolResultMessage('c1', 'read', [
        { type: 'text', text: 'head' },
        image('image/png', 'MIX'),
        { type: 'text', text: 'tail' },
      ]),
    ],
    source: 'tool',
    request: 'r',
    systemPrompt: 'sys',
  },
  {
    id: 'repeated-and-unsorted-tool-names',
    messages: [
      assistantMessage([
        toolCall('c1', 'zeta', {}),
        toolCall('c2', 'Alpha', {}),
        toolCall('c3', 'alpha', {}),
        toolCall('c4', 'zeta', {}),
        toolCall('c5', '10_numeric', {}),
        toolCall('c6', '2_numeric', {}),
        toolCall('c7', 'Ünicode', {}),
        toolCall('c8', 'a-dash', {}),
        toolCall('c9', 'a_underscore', {}),
      ]),
    ],
    source: 'tool',
    request: 'r',
    systemPrompt: 'sys',
  },
  {
    id: 'unicode-heavy-visible-text',
    messages: [userMessage(UNICODE_SAMPLE), assistantMessage([textBlock(UNICODE_SAMPLE)])],
    source: 'tool',
    request: UNICODE_SAMPLE,
    systemPrompt: UNICODE_SAMPLE,
  },
  {
    id: 'unicode-heavy-omitted-payload',
    messages: [
      assistantMessage([thinking(UNICODE_SAMPLE), toolCall('c1', 'read', { q: UNICODE_SAMPLE })]),
      toolResultMessage('c1', 'read', [textBlock(UNICODE_SAMPLE)]),
    ],
    source: 'tool',
    request: 'r',
    systemPrompt: 'sys',
  },
  {
    id: 'command-source-authority',
    messages: [userMessage('shared history'), assistantMessage([textBlock('shared reply')])],
    source: 'command',
    request: 'command request text',
    systemPrompt: 'sys',
  },
  {
    id: 'tool-source-with-tool-call-id',
    messages: [userMessage('shared history'), assistantMessage([textBlock('shared reply')])],
    source: 'tool',
    request: 'tool request text',
    systemPrompt: 'sys',
    toolCallId: 'explicit-call-id',
  },
  {
    id: 'tool-source-custom-tool-name',
    messages: [userMessage('shared history')],
    source: 'tool',
    request: 'r',
    systemPrompt: 'sys',
    toolName: 'some_other_tool',
  },
  {
    id: 'active-tool-call-leaf-excluded',
    messages: [
      userMessage('keep this'),
      assistantMessage([textBlock('keep this too')]),
      assistantMessage([
        toolCall('active-call', 'fusion_reason', { prompt: 'p' }),
        toolCall('sibling-call', 'read', { path: '/sibling' }),
      ]),
    ],
    source: 'tool',
    request: 'r',
    systemPrompt: 'sys',
    toolCallId: 'active-call',
  },
  {
    id: 'many-runs-high-cardinality',
    messages: Array.from({ length: 24 }, (_, index) =>
      index % 3 === 0
        ? userMessage(`visible ${String(index)}`)
        : index % 3 === 1
          ? assistantMessage([
              thinking(`t${String(index)}`),
              toolCall(`c${String(index)}`, `tool_${String(index % 5)}`, { i: index }),
            ])
          : toolResultMessage(`c${String(index - 1)}`, `tool_${String((index - 1) % 5)}`, [textBlock(`payload ${String(index)}`)]),
    ),
    source: 'tool',
    request: 'r',
    systemPrompt: 'sys',
  },
];

function model(
  provider: string,
  id: string,
  contextWindow: number,
  source: 'current' | 'configured' = 'configured',
): ResolvedFusionModel {
  return {
    selection: `${provider}/${id}`,
    source,
    provider,
    model: id,
    qualifiedId: `${provider}/${id}`,
    thinkingLevel: 'medium',
    contextWindow,
    maxOutputTokens: 32_768,
  };
}

export interface FusionGoldenModelSet {
  readonly id: string;
  readonly models: ResolvedFusionModels;
}

/** Route sets spanning equal, asymmetric, boundary, and just-above-minimum capacities. */
export const FUSION_GOLDEN_MODEL_SETS: readonly FusionGoldenModelSet[] = [
  {
    id: 'uniform-large',
    models: {
      candidates: [
        model('anthropic', 'claude-a', 200_000),
        model('anthropic', 'claude-b', 200_000),
        model('anthropic', 'claude-c', 200_000),
      ],
      evaluator: model('anthropic', 'claude-eval', 200_000),
      merger: model('anthropic', 'claude-merge', 200_000),
    },
  },
  {
    id: 'asymmetric-small-candidate',
    models: {
      candidates: [
        model('openai-codex', 'gpt-small', 60_000),
        model('anthropic', 'claude-b', 400_000),
        model('anthropic', 'claude-c', 400_000),
      ],
      evaluator: model('anthropic', 'claude-eval', 400_000),
      merger: model('anthropic', 'claude-merge', 400_000),
    },
  },
  {
    id: 'minimum-viable-window',
    models: {
      candidates: [
        model('local', 'tiny-1', 53_248),
        model('local', 'tiny-2', 53_248),
        model('local', 'tiny-3', 53_248),
      ],
      evaluator: model('local', 'tiny-eval', 53_248),
      merger: model('local', 'tiny-merge', 53_248),
    },
  },
];

export interface FusionGoldenRecord {
  readonly case_id: string;
  readonly canonical_input: string;
  readonly context_ledger: string;
  readonly transcript_leaf_present: boolean;
  readonly budget_plans: Readonly<Record<string, string>>;
}

/** Recompute one golden record from the live implementation. */
export function computeFusionGoldenRecord(
  testCase: FusionGoldenCase,
  profile: FusionWorkflowProfile = FUSION_REASON_WORKFLOW,
  candidateCapability: FusionCapability = FUSION_NO_TOOLS_CAPABILITY,
): FusionGoldenRecord {
  const session = sessionWith(testCase.messages);
  const options: Parameters<typeof buildFusionCanonicalInput>[1] = {
    source: testCase.source,
    request: testCase.request,
  };
  if (testCase.toolCallId !== undefined) options.toolCallId = testCase.toolCallId;
  if (testCase.toolName !== undefined) options.toolName = testCase.toolName;
  const built = buildFusionCanonicalInput(
    {
      cwd: '/tmp/project',
      sessionManager: session,
      getSystemPrompt: () => testCase.systemPrompt,
    },
    options,
  );
  const plans: Record<string, string> = {};
  for (const set of FUSION_GOLDEN_MODEL_SETS) {
    const budget = new FusionBudget(
      set.models,
      built.input.conversation_projection.policy.id,
      candidateCapability,
      profile,
    );
    plans[set.id] = canonicalJson(budget.plan(built.input));
  }
  return {
    case_id: testCase.id,
    canonical_input: built.serialized,
    context_ledger: canonicalJson(built.ledger),
    transcript_leaf_present: built.transcriptLeafId !== null,
    budget_plans: plans,
  };
}

export function computeFusionGoldenCorpus(): readonly FusionGoldenRecord[] {
  return FUSION_GOLDEN_CASES.map((testCase) => computeFusionGoldenRecord(testCase));
}

/**
 * Validate-workflow record.
 *
 * A workflow selects stage framing only, so the canonical input and the omission
 * ledger are provably identical to the reason/session-projection run for the same case.
 * Pinning copies of those 7 MB of bytes would not add coverage; instead the equality is
 * asserted directly by the gate, and this fixture pins only the budget plans,
 * which are the bytes a workflow can legitimately move.
 */
export interface FusionValidateGoldenRecord {
  readonly case_id: string;
  /** Historical fixture field name; proven equal to the reason record rather than duplicated. */
  readonly canonical_input_matches_brainstorm: boolean;
  readonly context_ledger_matches_brainstorm: boolean;
  readonly budget_plans: Readonly<Record<string, string>>;
}

export function computeFusionValidateGoldenRecord(
  testCase: FusionGoldenCase,
): FusionValidateGoldenRecord {
  const reason = computeFusionGoldenRecord(testCase);
  const validate = computeFusionGoldenRecord(
    testCase,
    FUSION_VALIDATE_WORKFLOW,
    FUSION_VALIDATE_CAPABILITY,
  );
  return {
    case_id: testCase.id,
    canonical_input_matches_brainstorm:
      reason.canonical_input === validate.canonical_input,
    context_ledger_matches_brainstorm: reason.context_ledger === validate.context_ledger,
    budget_plans: validate.budget_plans,
  };
}

export function computeFusionValidateGoldenCorpus(): readonly FusionValidateGoldenRecord[] {
  return FUSION_GOLDEN_CASES.map(computeFusionValidateGoldenRecord);
}

export function serializeFusionValidateGoldenCorpus(): string {
  return `${JSON.stringify(computeFusionValidateGoldenCorpus(), null, 2)}\n`;
}

/**
 * Stable serialization of the whole corpus. Compared byte-for-byte against the
 * committed golden file; a single differing byte fails the gate.
 */
export function serializeFusionGoldenCorpus(): string {
  return `${JSON.stringify(computeFusionGoldenCorpus(), null, 2)}\n`;
}
