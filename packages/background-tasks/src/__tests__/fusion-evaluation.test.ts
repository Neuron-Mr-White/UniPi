import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertMergerFindingCoverage,
  boundedEvaluationErrors,
  parseFusionEvaluation,
  parseFusionValidationCandidateReport,
  recoverFencedFusionValidationCandidateReport,
  renderValidatedFusionValidationReport,
  validateFusionEvaluation,
  validateFusionFindingAccounting,
} from '../fusion/evaluation.js';
import {
  FUSION_EVALUATION_SCHEMA_VERSION,
  FUSION_VALIDATE_CANDIDATE_SCHEMA_VERSION,
  FusionError,
  type FusionValidationFindingAccounting,
} from '../fusion/types.js';

function validEvaluation(): Record<string, unknown> {
  return {
    schema_version: FUSION_EVALUATION_SCHEMA_VERSION,
    candidate_assessments: [
      {
        candidate_id: 'A',
        summary: 'solid',
        strengths: ['clear'],
        limitations: ['brief'],
        useful_contributions: ['structure'],
        risks: ['misses edge case'],
      },
      {
        candidate_id: 'B',
        summary: 'detailed',
        strengths: ['coverage'],
        limitations: ['wordy'],
        useful_contributions: ['tests'],
        risks: ['overstates'],
      },
      {
        candidate_id: 'C',
        summary: 'balanced',
        strengths: ['tradeoffs'],
        limitations: ['few examples'],
        useful_contributions: ['risk list'],
        risks: ['needs cleanup'],
      },
    ],
    agreements: ['all address the request'],
    conflicts: [
      {
        topic: 'scope',
        positions: [
          { candidate_id: 'A', position: 'small' },
          { candidate_id: 'B', position: 'broad' },
        ],
        resolution: 'use the smallest complete scope',
      },
    ],
    synthesis_plan: {
      must_include: [{ candidate_id: 'C', contribution: 'risk list' }],
      must_resolve: ['scope'],
      must_avoid: ['unsupported claims'],
    },
  };
}

function singletonAccounting(): FusionValidationFindingAccounting {
  return {
    findings: [
      {
        id: 'A-F001',
        candidate_id: 'A',
        severity: 'high',
        location: 'src/fusion.ts:12',
        evidence: 'read line 12',
        impact: 'breaks workflow',
        summary: 'workflow bug',
      },
    ],
    decisions: [
      {
        source_id: 'A-F001',
        disposition: 'include',
        rationale: 'candidate A: A-F001 is supported by evidence',
        group_id: 'G001',
      },
    ],
    groups: [
      {
        group_id: 'G001',
        source_ids: ['A-F001'],
        severity: 'high',
        location: 'src/fusion.ts:12',
        evidence: 'read line 12',
        impact: 'breaks workflow',
        summary: 'workflow bug',
        rationale: 'the evidence supports inclusion',
      },
    ],
  };
}

void describe('fusion evaluation schema', () => {
  void it('accepts a closed valid evaluation object', () => {
    const parsed = parseFusionEvaluation(JSON.stringify(validEvaluation()));
    assert.equal(parsed.schema_version, FUSION_EVALUATION_SCHEMA_VERSION);
    assert.deepEqual(
      parsed.candidate_assessments.map((entry) => entry.candidate_id),
      ['A', 'B', 'C'],
    );
  });

  void it('rejects wrappers and invalid JSON without substring extraction', () => {
    assert.throws(() => parseFusionEvaluation('```json\n{}\n```'), /JSON only/);
    assert.throws(
      () => parseFusionEvaluation(`${JSON.stringify(validEvaluation())}\nprose`),
      /JSON only/,
    );
  });

  void it('rejects unknown fields, duplicate IDs, and blank strings', () => {
    const withExtra = validEvaluation();
    withExtra['winner'] = 'A';
    const extra = validateFusionEvaluation(withExtra);
    assert.equal(extra.ok, false);
    if (!extra.ok) assert.match(extra.errors.join('\n'), /unknown key winner/);

    const duplicate = validEvaluation();
    const assessments = duplicate['candidate_assessments'];
    assert.ok(Array.isArray(assessments));
    const first = assessments[0];
    assert.ok(typeof first === 'object' && first !== null && !Array.isArray(first));
    Reflect.set(first, 'candidate_id', 'B');
    const duplicateResult = validateFusionEvaluation(duplicate);
    assert.equal(duplicateResult.ok, false);
    if (!duplicateResult.ok) assert.match(duplicateResult.errors.join('\n'), /unique/);

    const blank = validEvaluation();
    blank['agreements'] = ['   '];
    const blankResult = validateFusionEvaluation(blank);
    assert.equal(blankResult.ok, false);
    if (!blankResult.ok) assert.match(blankResult.errors.join('\n'), /non-blank/);
  });

  void it('requires conflict positions from distinct candidates without duplicate IDs', () => {
    const invalid = validEvaluation();
    invalid['conflicts'] = [
      {
        topic: 'scope',
        positions: [
          { candidate_id: 'A', position: 'small' },
          { candidate_id: 'A', position: 'also small' },
        ],
        resolution: 'compare real disagreement',
      },
    ];
    const result = validateFusionEvaluation(invalid);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.join('\n'), /two distinct|unique/);

    const duplicateWithTwoIds = validEvaluation();
    duplicateWithTwoIds['conflicts'] = [
      {
        topic: 'scope',
        positions: [
          { candidate_id: 'A', position: 'small' },
          { candidate_id: 'A', position: 'duplicate small' },
          { candidate_id: 'B', position: 'broad' },
        ],
        resolution: 'compare real disagreement',
      },
    ];
    const duplicateResult = validateFusionEvaluation(duplicateWithTwoIds);
    assert.equal(duplicateResult.ok, false);
    if (!duplicateResult.ok) assert.match(duplicateResult.errors.join('\n'), /unique/);
  });

  void it('keeps validation parsing strict while narrowly recovering one audited JSON fence', () => {
    const report = JSON.stringify({
      schema_version: FUSION_VALIDATE_CANDIDATE_SCHEMA_VERSION,
      findings: [],
      verified: ['read src/file.ts'],
      limitations: [],
    });
    assert.throws(
      () => parseFusionValidationCandidateReport(`\`\`\`json\n${report}\n\`\`\``, 'A'),
      /structured JSON only/,
    );
    const recovered = recoverFencedFusionValidationCandidateReport(
      `Validation complete.\n\n\`\`\`json\n${report}\n\`\`\``,
      'A',
    );
    assert.ok(recovered);
    assert.equal(recovered.normalization, 'prose_then_markdown_json_fence');
    assert.equal(recovered.response, report);
    assert.deepEqual(recovered.report.verified, ['read src/file.ts']);
    assert.equal(
      recoverFencedFusionValidationCandidateReport(
        `\`\`\`json\n${report}\n\`\`\`\ntrailing prose`,
        'A',
      ),
      undefined,
    );
  });

  void it('validates validation finding singleton, duplicate, and exclusion contracts', () => {
    const singleton = singletonAccounting();
    assert.deepEqual(validateFusionFindingAccounting(singleton), []);
    const rendered = renderValidatedFusionValidationReport(singleton);
    assert.match(rendered, /# Validation report/);
    assert.match(rendered, /workflow bug/);
    assert.doesNotMatch(rendered, /A-F001|candidate A/i, 'rendered rationale must not expose source ids or candidate labels');

    const duplicateDecision: FusionValidationFindingAccounting = {
      ...singleton,
      decisions: [singleton.decisions[0]!, { ...singleton.decisions[0]!, rationale: 'duplicate' }],
    };
    assert.match(validateFusionFindingAccounting(duplicateDecision).join('\n'), /accounted more than once/);

    const includeWithoutGroup: FusionValidationFindingAccounting = {
      ...singleton,
      decisions: [{ source_id: 'A-F001', disposition: 'include', rationale: 'supported' }],
    };
    assert.match(validateFusionFindingAccounting(includeWithoutGroup).join('\n'), /group_id required/);

    const excludedWithGroup: FusionValidationFindingAccounting = {
      ...singleton,
      decisions: [
        { source_id: 'A-F001', disposition: 'exclude', rationale: 'duplicate of stronger finding', group_id: 'G001' },
      ],
    };
    assert.match(validateFusionFindingAccounting(excludedWithGroup).join('\n'), /group_id must be omitted/);

    const excluded: FusionValidationFindingAccounting = {
      ...singleton,
      decisions: [{ source_id: 'A-F001', disposition: 'exclude', rationale: 'candidate A: not supported' }],
      groups: [],
    };
    assert.deepEqual(validateFusionFindingAccounting(excluded), []);
    const excludedReport = renderValidatedFusionValidationReport(excluded);
    assert.match(excludedReport, /No included findings/);
    assert.match(excludedReport, /Excluded source findings/);
    assert.doesNotMatch(excludedReport, /candidate A|A-F001/i);
  });

  void it('merges distinct duplicate source findings into one resolved group', () => {
    const singleton = singletonAccounting();
    const duplicate: FusionValidationFindingAccounting = {
      findings: [
        ...singleton.findings,
        {
          ...singleton.findings[0]!,
          id: 'B-F001',
          candidate_id: 'B',
          severity: 'minor',
          evidence: 'independent read of line 12',
        },
      ],
      decisions: [
        { source_id: 'A-F001', disposition: 'include', rationale: 'supported', group_id: 'G001' },
        { source_id: 'B-F001', disposition: 'include', rationale: 'same defect', group_id: 'G001' },
      ],
      groups: [
        {
          ...singleton.groups[0]!,
          source_ids: ['A-F001', 'B-F001'],
          severity: 'high',
          evidence: 'both reviewers independently read line 12',
          rationale: 'same location and failure mechanism; high severity has stronger support',
        },
      ],
    };
    assert.deepEqual(validateFusionFindingAccounting(duplicate), []);
    const rendered = renderValidatedFusionValidationReport(duplicate);
    assert.equal((rendered.match(/### high: workflow bug/gu) ?? []).length, 1);
    assert.doesNotMatch(rendered, /### minor:/u);
  });

  void it('rejects validation merger dropped and invented group IDs', () => {
    const singleton = singletonAccounting();
    assert.doesNotThrow(() => assertMergerFindingCoverage(singleton, ['G001']));
    assert.throws(
      () => assertMergerFindingCoverage(singleton, []),
      /merger dropped included group G001/,
    );
    assert.throws(
      () => assertMergerFindingCoverage(singleton, ['G001', 'G999']),
      /invented or revived group G999/,
    );
  });

  void it('bounds validation errors for repair prompts and user-facing failures', () => {
    const errors = Array.from(
      { length: 200 },
      (_, index) => `error-${String(index)}-${'x'.repeat(800)}`,
    );
    const bounded = boundedEvaluationErrors(errors);
    assert.ok(bounded.length < errors.length);
    assert.ok(bounded.join('').length < 4300);
    assert.match(bounded.at(-1) ?? '', /omitted/);
  });

  void it('throws a typed error for invalid parsed content', () => {
    assert.throws(
      () =>
        parseFusionEvaluation(JSON.stringify({ schema_version: FUSION_EVALUATION_SCHEMA_VERSION })),
      (error: unknown) => {
        assert.ok(error instanceof FusionError);
        assert.equal(error.code, 'evaluation_invalid');
        return true;
      },
    );
  });
});
