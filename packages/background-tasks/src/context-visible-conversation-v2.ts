import { createHash } from 'node:crypto';
import type { Message } from '@earendil-works/pi-ai';
import { canonicalJson } from './attested-pi-run.js';

/**
 * Frozen `visible-conversation-ledger-v2` transform.
 *
 * This is the single shared implementation of the package's conversation
 * projection: visible user/assistant text verbatim, assistant thinking and all
 * tool traffic replaced with deterministic hash-accounted omission receipts,
 * images marker-only, unknown block types a loud error.
 *
 * The transform has **no behavioural knobs**. Every consumer receives exactly
 * the same disposition for exactly the same input. Consumer identity — schema
 * versions, policy ids, request authority, branch-filter provenance — lives
 * entirely outside this module, so a consumer can never claim behaviour that did
 * not occur. A semantic change requires a new transform id and a new
 * implementation, never a flag added here.
 *
 * Fusion's persisted artifact bytes are frozen against this implementation and
 * are proven bit-identical by `tests/unit/fusion-golden-bytes.test.ts`.
 */
export const VISIBLE_CONVERSATION_TRANSFORM_ID = 'visible-conversation-ledger-v2';

export const CONVERSATION_IMAGE_OMISSION_PREFIX =
  '[Image omitted from fusion text transcript: ';

export const OMITTED_EVENT_KINDS = [
  'assistant_thinking',
  'tool_call',
  'tool_result_text',
  'tool_result_image',
] as const;
export type OmittedEventKind = (typeof OMITTED_EVENT_KINDS)[number];

export interface OmittedEventRecord {
  index: number;
  source_ordinal: number;
  block_ordinal: number;
  kind: OmittedEventKind;
  payload_bytes: number;
  payload_sha256: string;
  tool_name?: string;
  tool_call_id?: string;
  mime_type?: string;
}

export interface OmittedActivityProjectionMapEntry {
  canonical_entry_index: number;
  entry_kind: 'omitted_activity';
  ledger_index_first: number;
  ledger_index_last: number;
}

export interface LedgerOnlyImageProjectionMapEntry {
  entry_kind: 'ledger_only_tool_result_image';
  ledger_index_first: number;
  ledger_index_last: number;
}

export type ContextProjectionMapEntry =
  | OmittedActivityProjectionMapEntry
  | LedgerOnlyImageProjectionMapEntry;

export interface ProjectionTextEntry {
  kind: 'text';
  source_ordinal: number;
  block_ordinal: number;
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Per-kind counts for one omitted run. Zero-valued kinds are omitted from the
 * serialized receipt by a fixed policy rule so receipt size does not scale with
 * the number of tracked kinds; absent means exactly zero.
 */
export interface OmittedRunCounts {
  assistant_thinking?: number;
  tool_calls?: number;
  tool_result_texts?: number;
}

export interface ProjectionOmissionEntry {
  kind: 'omitted_activity';
  at: readonly [number, number];
  bytes: number;
  counts: OmittedRunCounts;
}

export type ProjectionEntry = ProjectionTextEntry | ProjectionOmissionEntry;

export interface ToolCallNameCount {
  name: string;
  calls: number;
}

export interface ProjectionAccounting {
  message_count: number;
  included_text_entry_count: number;
  included_user_text_bytes: number;
  included_assistant_text_bytes: number;
  included_image_marker_count: number;
  empty_text_block_count: number;
  omitted_run_count: number;
  omitted_event_count: number;
  omitted_thinking_bytes: number;
  omitted_tool_call_count: number;
  omitted_tool_call_argument_bytes: number;
  omitted_tool_result_text_count: number;
  omitted_tool_result_text_bytes: number;
  omitted_tool_result_image_count: number;
  omitted_tool_result_image_bytes: number;
  tool_call_names: readonly ToolCallNameCount[];
  ledger_entry_count: number;
  ledger_root_sha256: string;
  omission_receipt_utf8_bytes: number;
}

/**
 * Ledger body produced by the transform, carrying no consumer envelope.
 *
 * The ledger root commits only to the ledger rows, never to schema version,
 * policy id, or transform id, so this body can be sealed by different consumers
 * without changing the root. That property is pinned by a dedicated test.
 */
export interface LedgerBodyV2 {
  entries: readonly OmittedEventRecord[];
  projection_map: readonly ContextProjectionMapEntry[];
  root_sha256: string;
}

export interface ProjectedConversationV2 {
  entries: readonly ProjectionEntry[];
  accounting: ProjectionAccounting;
  ledger: LedgerBodyV2;
}

/** Raised when the transform meets a conversation block it refuses to silently drop. */
export class UnsupportedConversationBlockError extends Error {
  readonly label: string;

  constructor(label: string) {
    super(
      `fusion context projection encountered an unsupported conversation block: ${label}`,
    );
    this.name = 'UnsupportedConversationBlockError';
    this.label = label;
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function uint64be(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(value));
  return out;
}

/** Length-prefixed framing so concatenated fields cannot collide across boundaries. */
function lengthPrefixed(bytes: Buffer): Buffer {
  return Buffer.concat([uint64be(bytes.length), bytes]);
}

function ledgerLeafHash(index: number, record: OmittedEventRecord): Buffer {
  return createHash('sha256')
    .update(Buffer.from('pi-fusion-ledger-leaf-v1\0', 'utf8'))
    .update(uint64be(index))
    .update(lengthPrefixed(Buffer.from(canonicalJson(record), 'utf8')))
    .digest();
}

function ledgerRootHash(leaves: readonly Buffer[]): string {
  const hash = createHash('sha256')
    .update(Buffer.from('pi-fusion-ledger-root-v1\0', 'utf8'))
    .update(uint64be(leaves.length));
  for (const leaf of leaves) hash.update(leaf);
  return hash.digest('hex');
}

function unsupportedBlock(label: string): UnsupportedConversationBlockError {
  return new UnsupportedConversationBlockError(label);
}

/**
 * Fixed policy rule: a zero-valued kind is absent from the receipt rather than
 * serialized as `0`. This keeps receipts compact without losing information —
 * absent is defined by the policy version to mean exactly zero — and it is
 * applied unconditionally, never adaptively because an input happens to be large.
 */
function compactCounts(counts: Required<OmittedRunCounts>): OmittedRunCounts {
  const out: OmittedRunCounts = {};
  if (counts.assistant_thinking > 0) out.assistant_thinking = counts.assistant_thinking;
  if (counts.tool_calls > 0) out.tool_calls = counts.tool_calls;
  if (counts.tool_result_texts > 0) out.tool_result_texts = counts.tool_result_texts;
  return out;
}

function imageMarker(mimeType: string): string {
  return `${CONVERSATION_IMAGE_OMISSION_PREFIX}${mimeType}]`;
}

/**
 * Accumulates omitted-event ledger rows and turns maximal contiguous non-image
 * omission runs into compact, source-ordered receipts inside the projection.
 */
class ProjectionBuilder {
  private readonly entries: ProjectionEntry[] = [];
  private readonly ledger: OmittedEventRecord[] = [];
  private readonly leaves: Buffer[] = [];
  private readonly projectionMap: ContextProjectionMapEntry[] = [];
  private readonly toolCallNames = new Map<string, number>();
  private pendingCounts: Required<OmittedRunCounts> | undefined;
  private pendingBytes = 0;
  private pendingLedgerFirst = 0;
  private pendingLedgerLast = 0;
  private pendingSourceFirst = 0;
  private pendingSourceLast = 0;

  includedUserTextBytes = 0;
  includedAssistantTextBytes = 0;
  includedImageMarkers = 0;
  emptyTextBlocks = 0;

  addText(entry: ProjectionTextEntry): void {
    this.flush();
    this.entries.push(entry);
    if (entry.role === 'user') this.includedUserTextBytes += utf8Bytes(entry.text);
    else this.includedAssistantTextBytes += utf8Bytes(entry.text);
  }

  addOmission(
    sourceOrdinal: number,
    blockOrdinal: number,
    kind: OmittedEventKind,
    payload: Buffer,
    extra: { toolName?: string; toolCallId?: string; mimeType?: string } = {},
  ): void {
    const index = this.ledger.length;
    const record: OmittedEventRecord = {
      index,
      source_ordinal: sourceOrdinal,
      block_ordinal: blockOrdinal,
      kind,
      payload_bytes: payload.length,
      payload_sha256: sha256Hex(payload),
    };
    if (extra.toolName !== undefined) record.tool_name = extra.toolName;
    if (extra.toolCallId !== undefined) record.tool_call_id = extra.toolCallId;
    if (extra.mimeType !== undefined) record.mime_type = extra.mimeType;
    this.ledger.push(record);
    this.leaves.push(ledgerLeafHash(index, record));

    if (extra.toolName !== undefined && kind === 'tool_call') {
      this.toolCallNames.set(extra.toolName, (this.toolCallNames.get(extra.toolName) ?? 0) + 1);
    }

    if (kind === 'tool_result_image') {
      this.flush();
      this.addLedgerOnlyImageMap(index);
      return;
    }

    if (this.pendingCounts === undefined) {
      this.pendingCounts = {
        assistant_thinking: 0,
        tool_calls: 0,
        tool_result_texts: 0,
      };
      this.pendingBytes = 0;
      this.pendingLedgerFirst = index;
      this.pendingSourceFirst = sourceOrdinal;
    }
    this.pendingLedgerLast = index;
    this.pendingSourceLast = sourceOrdinal;
    this.pendingBytes += payload.length;
    if (kind === 'assistant_thinking') this.pendingCounts.assistant_thinking += 1;
    else if (kind === 'tool_call') this.pendingCounts.tool_calls += 1;
    else this.pendingCounts.tool_result_texts += 1;
  }

  private addLedgerOnlyImageMap(index: number): void {
    const previous = this.projectionMap[this.projectionMap.length - 1];
    if (
      previous !== undefined &&
      previous.entry_kind === 'ledger_only_tool_result_image' &&
      previous.ledger_index_last + 1 === index
    ) {
      previous.ledger_index_last = index;
      return;
    }
    this.projectionMap.push({
      entry_kind: 'ledger_only_tool_result_image',
      ledger_index_first: index,
      ledger_index_last: index,
    });
  }

  private flush(): void {
    const counts = this.pendingCounts;
    if (counts === undefined) return;
    const canonicalEntryIndex = this.entries.length;
    const entry: ProjectionOmissionEntry = {
      at: [this.pendingSourceFirst, this.pendingSourceLast],
      bytes: this.pendingBytes,
      counts: compactCounts(counts),
      kind: 'omitted_activity',
    };
    this.entries.push(entry);
    this.projectionMap.push({
      canonical_entry_index: canonicalEntryIndex,
      entry_kind: 'omitted_activity',
      ledger_index_first: this.pendingLedgerFirst,
      ledger_index_last: this.pendingLedgerLast,
    });
    this.pendingCounts = undefined;
    this.pendingBytes = 0;
  }

  finish(messageCount: number): ProjectedConversationV2 {
    this.flush();
    const rootSha256 = ledgerRootHash(this.leaves);
    let omittedRunCount = 0;
    let includedTextEntries = 0;
    let receiptBytes = 0;
    for (const entry of this.entries) {
      if (entry.kind === 'text') includedTextEntries += 1;
      else {
        omittedRunCount += 1;
        receiptBytes += utf8Bytes(canonicalJson(entry));
      }
    }
    let thinkingBytes = 0;
    let toolCallCount = 0;
    let toolArgumentBytes = 0;
    let toolResultTextCount = 0;
    let toolResultTextBytes = 0;
    let toolResultImageCount = 0;
    let toolResultImageBytes = 0;
    for (const row of this.ledger) {
      if (row.kind === 'assistant_thinking') thinkingBytes += row.payload_bytes;
      else if (row.kind === 'tool_call') {
        toolCallCount += 1;
        toolArgumentBytes += row.payload_bytes;
      } else if (row.kind === 'tool_result_text') {
        toolResultTextCount += 1;
        toolResultTextBytes += row.payload_bytes;
      } else {
        toolResultImageCount += 1;
        toolResultImageBytes += row.payload_bytes;
      }
    }
    const toolCallNames: ToolCallNameCount[] = [...this.toolCallNames.entries()]
      .map(([name, calls]) => ({ name, calls }))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    const accounting: ProjectionAccounting = {
      message_count: messageCount,
      included_text_entry_count: includedTextEntries,
      included_user_text_bytes: this.includedUserTextBytes,
      included_assistant_text_bytes: this.includedAssistantTextBytes,
      included_image_marker_count: this.includedImageMarkers,
      empty_text_block_count: this.emptyTextBlocks,
      omitted_run_count: omittedRunCount,
      omitted_event_count: this.ledger.length,
      omitted_thinking_bytes: thinkingBytes,
      omitted_tool_call_count: toolCallCount,
      omitted_tool_call_argument_bytes: toolArgumentBytes,
      omitted_tool_result_text_count: toolResultTextCount,
      omitted_tool_result_text_bytes: toolResultTextBytes,
      omitted_tool_result_image_count: toolResultImageCount,
      omitted_tool_result_image_bytes: toolResultImageBytes,
      tool_call_names: toolCallNames,
      ledger_entry_count: this.ledger.length,
      ledger_root_sha256: rootSha256,
      omission_receipt_utf8_bytes: receiptBytes,
    };
    return {
      entries: this.entries,
      accounting,
      ledger: {
        entries: this.ledger,
        projection_map: this.projectionMap,
        root_sha256: rootSha256,
      },
    };
  }
}

/**
 * Projects one user-role message. User text is retained verbatim; images stay
 * marker-only so the child never receives raw bytes.
 */
function projectUserMessage(
  builder: ProjectionBuilder,
  content: Message['content'],
  sourceOrdinal: number,
): void {
  if (typeof content === 'string') {
    if (content.length === 0) {
      builder.emptyTextBlocks += 1;
      return;
    }
    builder.addText({
      kind: 'text',
      source_ordinal: sourceOrdinal,
      block_ordinal: 0,
      role: 'user',
      text: content,
    });
    return;
  }
  for (const [blockOrdinal, block] of content.entries()) {
    if (block.type === 'text') {
      if (block.text.length === 0) {
        builder.emptyTextBlocks += 1;
        continue;
      }
      builder.addText({
        kind: 'text',
        source_ordinal: sourceOrdinal,
        block_ordinal: blockOrdinal,
        role: 'user',
        text: block.text,
      });
      continue;
    }
    if (block.type === 'image') {
      builder.includedImageMarkers += 1;
      builder.addText({
        kind: 'text',
        source_ordinal: sourceOrdinal,
        block_ordinal: blockOrdinal,
        role: 'user',
        text: imageMarker(block.mimeType),
      });
      continue;
    }
    throw unsupportedBlock(`user block ${String(Reflect.get(block, 'type'))}`);
  }
}

function projectAssistantMessage(
  builder: ProjectionBuilder,
  content: Extract<Message, { role: 'assistant' }>['content'],
  sourceOrdinal: number,
): void {
  for (const [blockOrdinal, block] of content.entries()) {
    if (block.type === 'text') {
      if (block.text.length === 0) {
        builder.emptyTextBlocks += 1;
        continue;
      }
      builder.addText({
        kind: 'text',
        source_ordinal: sourceOrdinal,
        block_ordinal: blockOrdinal,
        role: 'assistant',
        text: block.text,
      });
      continue;
    }
    if (block.type === 'thinking') {
      builder.addOmission(
        sourceOrdinal,
        blockOrdinal,
        'assistant_thinking',
        Buffer.from(block.thinking, 'utf8'),
      );
      continue;
    }
    if (block.type === 'toolCall') {
      builder.addOmission(
        sourceOrdinal,
        blockOrdinal,
        'tool_call',
        Buffer.from(canonicalJson(block.arguments), 'utf8'),
        { toolName: block.name, toolCallId: block.id },
      );
      continue;
    }
    throw unsupportedBlock(`assistant block ${String(Reflect.get(block, 'type'))}`);
  }
}

function projectToolResultMessage(
  builder: ProjectionBuilder,
  message: Extract<Message, { role: 'toolResult' }>,
  sourceOrdinal: number,
): void {
  const content = message.content;
  if (typeof content === 'string') {
    builder.addOmission(sourceOrdinal, 0, 'tool_result_text', Buffer.from(content, 'utf8'), {
      toolName: message.toolName,
      toolCallId: message.toolCallId,
    });
    return;
  }
  for (const [blockOrdinal, block] of content.entries()) {
    if (block.type === 'text') {
      builder.addOmission(
        sourceOrdinal,
        blockOrdinal,
        'tool_result_text',
        Buffer.from(block.text, 'utf8'),
        { toolName: message.toolName, toolCallId: message.toolCallId },
      );
      continue;
    }
    if (block.type === 'image') {
      builder.addOmission(
        sourceOrdinal,
        blockOrdinal,
        'tool_result_image',
        Buffer.from(block.data, 'utf8'),
        {
          toolName: message.toolName,
          toolCallId: message.toolCallId,
          mimeType: block.mimeType,
        },
      );
      continue;
    }
    throw unsupportedBlock(`tool result block ${String(Reflect.get(block, 'type'))}`);
  }
}

/**
 * Deterministic conversation projection. Every retained source block receives
 * exactly one disposition: included verbatim, or represented as an omission
 * ledger row. Unknown block types fail loudly instead of disappearing.
 */
export function projectVisibleConversationV2(
  messages: readonly Message[],
): ProjectedConversationV2 {
  const builder = new ProjectionBuilder();
  for (const [sourceOrdinal, message] of messages.entries()) {
    if (message.role === 'user') projectUserMessage(builder, message.content, sourceOrdinal);
    else if (message.role === 'assistant')
      projectAssistantMessage(builder, message.content, sourceOrdinal);
    else if (message.role === 'toolResult')
      projectToolResultMessage(builder, message, sourceOrdinal);
    else throw unsupportedBlock(`message role ${String(Reflect.get(message, 'role'))}`);
  }
  return builder.finish(messages.length);
}
