import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../attested-pi-run.js';
import { FusionBudget } from '../fusion/budget.js';
import {
  FUSION_COMMAND_CONTEXT_POLICY_ID,
  type ResolvedFusionModel,
  type ResolvedFusionModels,
} from '../fusion/types.js';
import {
  buildFrom,
  omissionEntries,
  projectedText,
  type ExpandedFusionOmissionEntry,
} from './helpers/fusion-canonical.js';
import { buildHighCardinalitySession } from './helpers/fusion-high-cardinality.js';

/**
 * Regression coverage for the production incident in which omission receipts
 * grew to 43% of a 290 KB projected prompt (340 runs over 1,465 omitted
 * events). Existing fixtures used a few very large tool results and therefore
 * could not reproduce it: the cost came from receipt cardinality, not payload
 * size.
 */
function resolved(qualifiedId: string, contextWindow: number): ResolvedFusionModel {
  const slash = qualifiedId.indexOf('/');
  return {
    selection: '$current',
    source: 'current',
    provider: qualifiedId.slice(0, slash),
    model: qualifiedId.slice(slash + 1),
    qualifiedId,
    thinkingLevel: 'high',
    contextWindow,
    maxOutputTokens: 32_768,
  };
}

function codexModels(): ResolvedFusionModels {
  return {
    candidates: [
      resolved('openai-codex/gpt-5.6-sol', 272_000),
      resolved('openai-codex/gpt-5.6-terra', 272_000),
      resolved('openai-codex/gpt-5.5', 272_000),
    ],
    evaluator: resolved('openai-codex/gpt-5.6-sol', 272_000),
    merger: resolved('openai-codex/gpt-5.6-sol', 272_000),
  };
}

void describe('fusion high-cardinality tool activity', () => {
  void it('keeps receipt metadata small when omitted events are numerous and short', () => {
    const session = buildHighCardinalitySession();
    const built = buildFrom(session.messages, { source: 'tool', request: 'summarize' });
    const projection = built.input.conversation_projection;
    const receipts = omissionEntries(built.input);

    // One receipt per retained-text separated run, and every event ledgered.
    assert.equal(receipts.length, session.expectedRuns);
    assert.equal(built.ledger.entries.length, session.expectedLedgerEvents);
    assert.equal(projection.accounting.omitted_run_count, session.expectedRuns);
    assert.equal(projection.accounting.omitted_event_count, session.expectedLedgerEvents);

    // Per-receipt cost is the quantity that regressed: the incident averaged
    // 356 bytes per receipt because each carried a run hash, ledger indices,
    // and a per-kind byte map. Pin the compact cost directly, since the ratio
    // to total payload depends on how much visible text a fixture happens to
    // contain and is therefore not a stable signal.
    const receiptBytes = projection.accounting.omission_receipt_utf8_bytes;
    const perReceipt = receiptBytes / receipts.length;
    assert.ok(
      perReceipt < 140,
      `each receipt must stay compact, saw ${perReceipt.toFixed(1)} bytes`,
    );

    // Receipt metadata must never exceed the conversational text it annotates.
    const visibleBytes =
      projection.accounting.included_user_text_bytes +
      projection.accounting.included_assistant_text_bytes;
    assert.ok(
      receiptBytes < visibleBytes,
      `receipts (${String(receiptBytes)} B) must not outweigh visible text (${String(visibleBytes)} B)`,
    );
  });

  void it('emits only the compact model-facing receipt tuple', () => {
    const session = buildHighCardinalitySession({ runs: 8 });
    const built = buildFrom(session.messages, { source: 'tool', request: 'r' });
    const compactReceipts = built.input.conversation_projection.entries.filter(
      (entry) => entry[0] === 'o',
    );
    assert.equal(compactReceipts.length, session.expectedRuns);
    for (const receipt of compactReceipts) {
      assert.equal(receipt.length, 4);
      assert.equal(receipt[0], 'o');
      const span = receipt[1];
      assert.equal(span.length, 2);
      assert.ok(span[0] <= span[1]);
      assert.ok(Number.isSafeInteger(receipt[2]) && receipt[2] >= 0);
      const counts = receipt[3];
      assert.equal(counts.length, 3);
      for (const value of counts) {
        assert.ok(Number.isSafeInteger(value) && value >= 0, 'tuple counts must be non-negative');
      }
    }
    for (const receipt of omissionEntries(built.input)) {
      assert.deepEqual(Object.keys(receipt).sort(), ['at', 'bytes', 'counts', 'kind']);
    }
    // Retired coordinates and hashes must not reappear in the prompt bytes.
    for (const banned of [
      'ledger_run_sha256',
      'ledger_index_first',
      'ledger_index_last',
      'source_ordinal_first',
      'payload_bytes',
    ]) {
      assert.doesNotMatch(built.serialized, new RegExp(banned), banned);
    }
  });

  void it('reconciles every receipt against the ledger it summarizes', () => {
    const session = buildHighCardinalitySession({ runs: 12 });
    const built = buildFrom(session.messages, { source: 'tool', request: 'r' });
    const map = built.ledger.projection_map;

    // Every ledger row is represented exactly once.
    const covered = new Set<number>();
    for (const entry of map) {
      for (let i = entry.ledger_index_first; i <= entry.ledger_index_last; i++) {
        assert.equal(covered.has(i), false, `ledger row ${String(i)} mapped twice`);
        covered.add(i);
      }
    }
    assert.equal(covered.size, built.ledger.entries.length);

    // Receipt byte totals recompute exactly from the mapped ledger rows.
    const receipts = omissionEntries(built.input);
    const receiptMaps = map.filter((entry) => entry.entry_kind === 'omitted_activity');
    assert.equal(receiptMaps.length, receipts.length);
    for (const [index, entry] of receiptMaps.entries()) {
      const rows = built.ledger.entries.slice(
        entry.ledger_index_first,
        entry.ledger_index_last + 1,
      );
      const expected = rows
        .filter((row) => row.kind !== 'tool_result_image')
        .reduce((total, row) => total + row.payload_bytes, 0);
      const receipt = receipts[index];
      assert.ok(receipt);
      assert.equal(receipt.bytes, expected, `receipt ${String(index)} byte total mismatch`);
    }
  });

  void it('preserves all conversational text and forwards no tool payload', () => {
    const session = buildHighCardinalitySession({ runs: 20 });
    const built = buildFrom(session.messages, { source: 'tool', request: 'r' });
    const text = projectedText(built.input);
    for (let run = 0; run < 20; run++) {
      assert.match(text, new RegExp(`USER-TURN-${String(run)} `));
      assert.match(text, new RegExp(`ASSISTANT-TURN-${String(run)} `));
    }
    // Payload and thinking sentinels never reach the prompt.
    assert.doesNotMatch(built.serialized, /g{50}/);
    assert.doesNotMatch(built.serialized, /z{50}/);
    assert.doesNotMatch(built.serialized, /k{50}/);
  });

  void it('keeps input-only workflow preflight inside a real route budget', () => {
    const session = buildHighCardinalitySession();
    const built = buildFrom(session.messages, { source: 'tool', request: 'summarize' });
    const budget = new FusionBudget(codexModels(), FUSION_COMMAND_CONTEXT_POLICY_ID);
    const plan = budget.plan(built.input);
    assert.equal(plan.blockers.length, 0);
    for (const stage of plan.stages) {
      assert.ok(
        stage.input_only_input_tokens_upper_bound <= stage.allowed_input_tokens,
        `${stage.budget_stage} input must fit the limiting route, saw ${String(stage.input_only_input_tokens_upper_bound)} of ${String(stage.allowed_input_tokens)}`,
      );
    }
    assert.equal(plan.warnings.some((entry) => entry.warning_kind === 'worst_case_reservation'), true);
  });

  void it('produces byte-identical output for repeated construction', () => {
    const session = buildHighCardinalitySession({ runs: 30 });
    const first = buildFrom(session.messages, { source: 'tool', request: 'same' });
    const second = buildFrom(session.messages, { source: 'tool', request: 'same' });
    assert.equal(first.serialized, second.serialized);
    assert.equal(canonicalJson(first.ledger), canonicalJson(second.ledger));
    const receipts: readonly ExpandedFusionOmissionEntry[] = omissionEntries(first.input);
    assert.equal(receipts.length, session.expectedRuns);
  });
});
