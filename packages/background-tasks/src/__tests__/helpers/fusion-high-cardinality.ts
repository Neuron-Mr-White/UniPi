import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';

/**
 * High-cardinality interleaved tool activity.
 *
 * The production incident that motivated compact omission receipts was NOT a
 * few enormous tool results: it was many small, interleaved tool events. That
 * shape produces one receipt per contiguous omitted run, so receipt metadata —
 * not tool payload — dominated the projected prompt.
 *
 * Fixtures built from a handful of huge tool results cannot reproduce it, so
 * this builder deliberately generates many short runs separated by retained
 * conversation text.
 */
export interface HighCardinalityOptions {
  /** Number of retained-text separated omitted runs. */
  runs?: number;
  /** Tool calls (and matching results) per run. */
  callsPerRun?: number;
  /**
   * Assistant thinking blocks per cycle. Retained assistant text separates
   * thinking from the tool calls, so a non-zero value yields two receipts per
   * cycle instead of one.
   */
  thinkingPerRun?: number;
  /** UTF-8 bytes per tool-call argument payload. */
  argumentBytes?: number;
  /** UTF-8 bytes per tool-result text payload. */
  resultBytes?: number;
  /**
   * UTF-8 bytes of retained conversational text per visible entry. The default
   * reproduces the production incident's total visible volume: that session
   * carried 120,621 bytes of visible text, and this builder emits two visible
   * entries per cycle, so 177 bytes per entry over 340 cycles matches it.
   */
  visibleTextBytes?: number;
}

export interface HighCardinalitySession {
  messages: (UserMessage | AssistantMessage | ToolResultMessage)[];
  /**
   * Receipts produced per cycle. Retained assistant text sits between the
   * thinking block and the tool calls, so each cycle yields two maximal
   * contiguous omitted runs when thinking is present: one for thinking and one
   * for the tool call/result group.
   */
  expectedRuns: number;
  expectedLedgerEvents: number;
  expectedToolCalls: number;
  expectedToolResults: number;
  expectedThinking: number;
}

function usage() {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Builds a session whose omitted events are numerous and short. Every run is
 * separated by retained user/assistant text so runs cannot merge, which pins
 * the receipt count exactly.
 */
export function buildHighCardinalitySession(
  options: HighCardinalityOptions = {},
): HighCardinalitySession {
  const runs = options.runs ?? 340;
  const callsPerRun = options.callsPerRun ?? 2;
  const thinkingPerRun = options.thinkingPerRun ?? 0;
  const argumentBytes = options.argumentBytes ?? 512;
  const resultBytes = options.resultBytes ?? 1024;
  const visibleTextBytes = options.visibleTextBytes ?? 177;

  const messages: (UserMessage | AssistantMessage | ToolResultMessage)[] = [];
  let timestamp = 1;

  for (let run = 0; run < runs; run++) {
    // Retained text separates runs so contiguous omissions cannot merge.
    messages.push({
      role: 'user',
      content: `USER-TURN-${String(run)} ${'q'.repeat(visibleTextBytes)}`,
      timestamp: timestamp++,
    });

    const content: AssistantMessage['content'] = [];
    for (let t = 0; t < thinkingPerRun; t++) {
      content.push({ type: 'thinking', thinking: 'k'.repeat(64) });
    }
    content.push({
      type: 'text',
      text: `ASSISTANT-TURN-${String(run)} ${'w'.repeat(visibleTextBytes)}`,
    });
    for (let call = 0; call < callsPerRun; call++) {
      content.push({
        type: 'toolCall',
        id: `call-${String(run)}-${String(call)}`,
        name: call % 2 === 0 ? 'read' : 'bash',
        arguments: { payload: 'g'.repeat(argumentBytes) },
      });
    }
    messages.push({
      role: 'assistant',
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      model: 'gpt-5.5',
      usage: usage(),
      stopReason: 'toolUse',
      content,
      timestamp: timestamp++,
    });

    for (let call = 0; call < callsPerRun; call++) {
      messages.push({
        role: 'toolResult',
        toolCallId: `call-${String(run)}-${String(call)}`,
        toolName: call % 2 === 0 ? 'read' : 'bash',
        content: [{ type: 'text', text: 'z'.repeat(resultBytes) }],
        details: { ok: true },
        isError: false,
        timestamp: timestamp++,
      });
    }
  }

  const receiptsPerCycle = thinkingPerRun > 0 ? 2 : 1;
  return {
    messages,
    expectedRuns: runs * receiptsPerCycle,
    expectedLedgerEvents: runs * (thinkingPerRun + callsPerRun * 2),
    expectedToolCalls: runs * callsPerRun,
    expectedToolResults: runs * callsPerRun,
    expectedThinking: runs * thinkingPerRun,
  };
}
