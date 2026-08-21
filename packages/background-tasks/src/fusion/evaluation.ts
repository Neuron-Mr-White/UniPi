import { parseJsonText, type JsonObject } from '../types.js';
import {
  FUSION_CANDIDATE_IDS,
  FUSION_EVALUATION_SCHEMA_VERSION,
  FUSION_VALIDATE_CANDIDATE_SCHEMA_VERSION,
  FusionError,
  type CandidateAssessment,
  type FusionCandidateId,
  type FusionConflict,
  type FusionConflictPosition,
  type FusionEvaluationV1,
  type FusionSynthesisContribution,
  type FusionSynthesisPlan,
  type FusionValidationFindingAccounting,
  type FusionValidationFindingDecision,
  type FusionValidationFindingGroup,
  type FusionValidationFindingRecord,
  type FusionValidationSeverity,
} from './types.js';

const MAX_REPAIR_ERROR_CHARS = 500;
const MAX_REPAIR_ERROR_COUNT = 24;
const MAX_REPAIR_ERROR_TOTAL_CHARS = 4000;

export type FusionEvaluationValidationResult =
  | { ok: true; value: FusionEvaluationV1 }
  | { ok: false; errors: readonly string[] };

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function closed(
  record: JsonObject,
  keys: readonly string[],
  label: string,
  errors: string[],
): void {
  const expected = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!expected.has(key)) errors.push(`${label} contains unknown key ${key}`);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key))
      errors.push(`${label} is missing key ${key}`);
  }
}

function nonBlankString(value: unknown, label: string, errors: string[]): string | undefined {
  if (typeof value !== 'string') {
    errors.push(`${label} must be a string`);
    return undefined;
  }
  if (value.trim().length === 0) {
    errors.push(`${label} must be non-blank`);
    return undefined;
  }
  return value;
}

function stringList(
  value: unknown,
  label: string,
  errors: string[],
): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return undefined;
  }
  const out: string[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = nonBlankString(item, `${label}[${String(index)}]`, errors);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

function candidateId(
  value: unknown,
  label: string,
  errors: string[],
): FusionCandidateId | undefined {
  if (value === 'A' || value === 'B' || value === 'C') return value;
  errors.push(`${label} must be A, B, or C`);
  return undefined;
}

function tuple3<T>(
  items: readonly T[],
  label: string,
  errors: string[],
): readonly [T, T, T] | undefined {
  if (items.length !== 3) {
    errors.push(`${label} must contain exactly three entries`);
    return undefined;
  }
  const first = items[0];
  const second = items[1];
  const third = items[2];
  if (first === undefined || second === undefined || third === undefined) {
    errors.push(`${label} must not contain empty positions`);
    return undefined;
  }
  return [first, second, third];
}

function parseAssessment(
  value: unknown,
  label: string,
  errors: string[],
): CandidateAssessment | undefined {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return undefined;
  }
  closed(
    value,
    ['candidate_id', 'summary', 'strengths', 'limitations', 'useful_contributions', 'risks'],
    label,
    errors,
  );
  const id = candidateId(value['candidate_id'], `${label}.candidate_id`, errors);
  const summary = nonBlankString(value['summary'], `${label}.summary`, errors);
  const strengths = stringList(value['strengths'], `${label}.strengths`, errors);
  const limitations = stringList(value['limitations'], `${label}.limitations`, errors);
  const useful = stringList(value['useful_contributions'], `${label}.useful_contributions`, errors);
  const risks = stringList(value['risks'], `${label}.risks`, errors);
  if (
    id === undefined ||
    summary === undefined ||
    strengths === undefined ||
    limitations === undefined ||
    useful === undefined ||
    risks === undefined
  ) {
    return undefined;
  }
  return { candidate_id: id, summary, strengths, limitations, useful_contributions: useful, risks };
}

function parsePosition(
  value: unknown,
  label: string,
  errors: string[],
): FusionConflictPosition | undefined {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return undefined;
  }
  closed(value, ['candidate_id', 'position'], label, errors);
  const id = candidateId(value['candidate_id'], `${label}.candidate_id`, errors);
  const position = nonBlankString(value['position'], `${label}.position`, errors);
  if (id === undefined || position === undefined) return undefined;
  return { candidate_id: id, position };
}

function parseConflict(
  value: unknown,
  label: string,
  errors: string[],
): FusionConflict | undefined {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return undefined;
  }
  closed(value, ['topic', 'positions', 'resolution'], label, errors);
  const topic = nonBlankString(value['topic'], `${label}.topic`, errors);
  const positionsRaw = value['positions'];
  const positions: FusionConflictPosition[] = [];
  if (!Array.isArray(positionsRaw)) {
    errors.push(`${label}.positions must be an array`);
  } else {
    for (const [index, item] of positionsRaw.entries()) {
      const parsed = parsePosition(item, `${label}.positions[${String(index)}]`, errors);
      if (parsed !== undefined) positions.push(parsed);
    }
    const distinctIds = new Set(positions.map((position) => position.candidate_id));
    if (distinctIds.size < 2)
      errors.push(`${label}.positions must include at least two distinct candidates`);
    if (distinctIds.size !== positions.length)
      errors.push(`${label}.positions candidate_id values must be unique`);
  }
  const resolution = nonBlankString(value['resolution'], `${label}.resolution`, errors);
  if (topic === undefined || resolution === undefined || !Array.isArray(positionsRaw))
    return undefined;
  return { topic, positions, resolution };
}

function parseContribution(
  value: unknown,
  label: string,
  errors: string[],
): FusionSynthesisContribution | undefined {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return undefined;
  }
  closed(value, ['candidate_id', 'contribution'], label, errors);
  const id = candidateId(value['candidate_id'], `${label}.candidate_id`, errors);
  const contribution = nonBlankString(value['contribution'], `${label}.contribution`, errors);
  if (id === undefined || contribution === undefined) return undefined;
  return { candidate_id: id, contribution };
}

function parseContributionList(
  value: unknown,
  label: string,
  errors: string[],
): readonly FusionSynthesisContribution[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return undefined;
  }
  const out: FusionSynthesisContribution[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = parseContribution(item, `${label}[${String(index)}]`, errors);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

function parseSynthesisPlan(
  value: unknown,
  label: string,
  errors: string[],
): FusionSynthesisPlan | undefined {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return undefined;
  }
  closed(value, ['must_include', 'must_resolve', 'must_avoid'], label, errors);
  const include = parseContributionList(value['must_include'], `${label}.must_include`, errors);
  const resolve = stringList(value['must_resolve'], `${label}.must_resolve`, errors);
  const avoid = stringList(value['must_avoid'], `${label}.must_avoid`, errors);
  if (include === undefined || resolve === undefined || avoid === undefined) return undefined;
  return { must_include: include, must_resolve: resolve, must_avoid: avoid };
}

function parseAssessmentList(
  value: unknown,
  label: string,
  errors: string[],
): readonly [CandidateAssessment, CandidateAssessment, CandidateAssessment] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return undefined;
  }
  const parsed: CandidateAssessment[] = [];
  for (const [index, item] of value.entries()) {
    const assessment = parseAssessment(item, `${label}[${String(index)}]`, errors);
    if (assessment !== undefined) parsed.push(assessment);
  }
  const ids = new Set(parsed.map((assessment) => assessment.candidate_id));
  for (const id of FUSION_CANDIDATE_IDS) {
    if (!ids.has(id)) errors.push(`${label} must contain candidate ${id}`);
  }
  if (ids.size !== parsed.length) errors.push(`${label} candidate_id values must be unique`);
  return tuple3(parsed, label, errors);
}

function parseConflictList(
  value: unknown,
  label: string,
  errors: string[],
): readonly FusionConflict[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return undefined;
  }
  const out: FusionConflict[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = parseConflict(item, `${label}[${String(index)}]`, errors);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

function parseValidationGroups(
  value: unknown,
  label: string,
  errors: string[],
): readonly FusionValidationFindingGroup[] {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return [];
  }
  const groups: FusionValidationFindingGroup[] = [];
  for (const [index, item] of value.entries()) {
    const itemLabel = `${label}[${String(index)}]`;
    if (!isRecord(item)) {
      errors.push(`${itemLabel} must be an object`);
      continue;
    }
    closed(
      item,
      ['group_id', 'source_ids', 'severity', 'location', 'evidence', 'impact', 'summary', 'rationale'],
      itemLabel,
      errors,
    );
    const groupId = nonBlankString(item['group_id'], `${itemLabel}.group_id`, errors);
    const sourceIds = stringList(item['source_ids'], `${itemLabel}.source_ids`, errors);
    const severity = nonBlankString(item['severity'], `${itemLabel}.severity`, errors) as
      | FusionValidationSeverity
      | undefined;
    const location = nonBlankString(item['location'], `${itemLabel}.location`, errors);
    const evidence = nonBlankString(item['evidence'], `${itemLabel}.evidence`, errors);
    const impact = nonBlankString(item['impact'], `${itemLabel}.impact`, errors);
    const summary = nonBlankString(item['summary'], `${itemLabel}.summary`, errors);
    const rationale = nonBlankString(item['rationale'], `${itemLabel}.rationale`, errors);
    if (sourceIds !== undefined && sourceIds.length === 0) {
      errors.push(`${itemLabel}.source_ids must not be empty`);
    }
    if (severity !== undefined && !['critical', 'high', 'minor'].includes(severity)) {
      errors.push(`${itemLabel}.severity invalid`);
    }
    if (
      groupId !== undefined &&
      sourceIds !== undefined &&
      sourceIds.length > 0 &&
      severity !== undefined &&
      location !== undefined &&
      evidence !== undefined &&
      impact !== undefined &&
      summary !== undefined &&
      rationale !== undefined
    ) {
      groups.push({
        group_id: groupId,
        source_ids: sourceIds,
        severity,
        location,
        evidence,
        impact,
        summary,
        rationale,
      });
    }
  }
  return groups;
}

function parseValidationAccounting(value: unknown, label: string, errors: string[]): FusionValidationFindingAccounting | undefined {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return undefined;
  }
  closed(value, ['findings', 'decisions', 'groups'], label, errors);
  const findingsRaw = value['findings'];
  const decisionsRaw = value['decisions'];
  const groups = parseValidationGroups(value['groups'], `${label}.groups`, errors);
  const findings: FusionValidationFindingRecord[] = [];
  if (!Array.isArray(findingsRaw)) errors.push(`${label}.findings must be an array`);
  else {
    for (const [index, item] of findingsRaw.entries()) {
      const itemLabel = `${label}.findings[${String(index)}]`;
      if (!isRecord(item)) {
        errors.push(`${itemLabel} must be an object`);
        continue;
      }
      closed(item, ['id', 'candidate_id', 'severity', 'location', 'evidence', 'impact', 'summary'], itemLabel, errors);
      const id = nonBlankString(item['id'], `${itemLabel}.id`, errors);
      const candidate = candidateId(item['candidate_id'], `${itemLabel}.candidate_id`, errors);
      const severity = nonBlankString(item['severity'], `${itemLabel}.severity`, errors) as FusionValidationSeverity | undefined;
      const location = nonBlankString(item['location'], `${itemLabel}.location`, errors);
      const evidence = nonBlankString(item['evidence'], `${itemLabel}.evidence`, errors);
      const impact = nonBlankString(item['impact'], `${itemLabel}.impact`, errors);
      const summary = nonBlankString(item['summary'], `${itemLabel}.summary`, errors);
      if (severity !== undefined && !['critical', 'high', 'minor'].includes(severity)) errors.push(`${itemLabel}.severity invalid`);
      if (id !== undefined && candidate !== undefined && severity !== undefined && location !== undefined && evidence !== undefined && impact !== undefined && summary !== undefined) {
        findings.push({ id, candidate_id: candidate, severity, location, evidence, impact, summary });
      }
    }
  }
  const decisions: FusionValidationFindingDecision[] = [];
  if (!Array.isArray(decisionsRaw)) errors.push(`${label}.decisions must be an array`);
  else {
    for (const [index, item] of decisionsRaw.entries()) {
      const itemLabel = `${label}.decisions[${String(index)}]`;
      if (!isRecord(item)) {
        errors.push(`${itemLabel} must be an object`);
        continue;
      }
      const allowedDecisionKeys = new Set(['source_id', 'disposition', 'rationale', 'group_id']);
      for (const key of Object.keys(item)) {
        if (!allowedDecisionKeys.has(key)) errors.push(`${itemLabel} contains unknown key ${key}`);
      }
      for (const key of ['source_id', 'disposition', 'rationale'] as const) {
        if (!Object.prototype.hasOwnProperty.call(item, key)) errors.push(`${itemLabel} is missing key ${key}`);
      }
      const sourceId = nonBlankString(item['source_id'], `${itemLabel}.source_id`, errors);
      const disposition = nonBlankString(item['disposition'], `${itemLabel}.disposition`, errors);
      const rationale = nonBlankString(item['rationale'], `${itemLabel}.rationale`, errors);
      const group = item['group_id'] === undefined ? undefined : nonBlankString(item['group_id'], `${itemLabel}.group_id`, errors);
      if (disposition !== undefined && disposition !== 'include' && disposition !== 'exclude') errors.push(`${itemLabel}.disposition invalid`);
      if (sourceId !== undefined && (disposition === 'include' || disposition === 'exclude') && rationale !== undefined) {
        const decision: FusionValidationFindingDecision = { source_id: sourceId, disposition, rationale };
        if (group !== undefined) decision.group_id = group;
        decisions.push(decision);
      }
    }
  }
  const accounting: FusionValidationFindingAccounting = { findings, decisions, groups };
  errors.push(...validateFusionFindingAccounting(accounting));
  return accounting;
}

export function validateFusionEvaluation(value: unknown): FusionEvaluationValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['evaluation must be a JSON object'] };
  const evaluationAllowed = new Set(['schema_version', 'candidate_assessments', 'agreements', 'conflicts', 'synthesis_plan', 'validation_accounting']);
  for (const key of Object.keys(value)) {
    if (!evaluationAllowed.has(key)) errors.push(`evaluation contains unknown key ${key}`);
  }
  for (const key of ['schema_version', 'candidate_assessments', 'agreements', 'conflicts', 'synthesis_plan'] as const) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`evaluation is missing key ${key}`);
  }
  if (value['schema_version'] !== FUSION_EVALUATION_SCHEMA_VERSION) {
    errors.push('evaluation.schema_version mismatch');
  }
  const assessments = parseAssessmentList(
    value['candidate_assessments'],
    'evaluation.candidate_assessments',
    errors,
  );
  const agreements = stringList(value['agreements'], 'evaluation.agreements', errors);
  const conflicts = parseConflictList(value['conflicts'], 'evaluation.conflicts', errors);
  const plan = parseSynthesisPlan(value['synthesis_plan'], 'evaluation.synthesis_plan', errors);
  const validationAccounting = Object.prototype.hasOwnProperty.call(value, 'validation_accounting')
    ? parseValidationAccounting(value['validation_accounting'], 'evaluation.validation_accounting', errors)
    : undefined;
  if (
    errors.length > 0 ||
    assessments === undefined ||
    agreements === undefined ||
    conflicts === undefined ||
    plan === undefined
  ) {
    return { ok: false, errors };
  }
  const parsedValue: FusionEvaluationV1 = {
    schema_version: FUSION_EVALUATION_SCHEMA_VERSION,
    candidate_assessments: assessments,
    agreements,
    conflicts,
    synthesis_plan: plan,
  };
  if (validationAccounting !== undefined) parsedValue.validation_accounting = validationAccounting;
  return { ok: true, value: parsedValue };
}

export function parseFusionEvaluation(text: string): FusionEvaluationV1 {
  let parsed: unknown;
  try {
    parsed = parseJsonText(text);
  } catch (error) {
    throw new FusionError(
      `evaluation output must be JSON only: ${error instanceof Error ? error.message : String(error)}`,
      {
        code: 'evaluation_invalid',
        stage: 'evaluation',
      },
    );
  }
  const result = validateFusionEvaluation(parsed);
  if (!result.ok) {
    throw new FusionError(
      `evaluation output failed schema validation: ${formatEvaluationErrors(result.errors)}`,
      {
        code: 'evaluation_invalid',
        stage: 'evaluation',
      },
    );
  }
  return result.value;
}

export function boundedEvaluationErrors(errors: readonly string[]): readonly string[] {
  const bounded: string[] = [];
  let total = 0;
  for (const error of errors) {
    if (bounded.length >= MAX_REPAIR_ERROR_COUNT) break;
    const perError =
      error.length <= MAX_REPAIR_ERROR_CHARS
        ? error
        : `${error.slice(0, MAX_REPAIR_ERROR_CHARS - 1)}…`;
    const remaining = MAX_REPAIR_ERROR_TOTAL_CHARS - total;
    if (remaining <= 0) break;
    const next =
      perError.length <= remaining ? perError : `${perError.slice(0, Math.max(0, remaining - 1))}…`;
    bounded.push(next);
    total += next.length;
  }
  if (errors.length > bounded.length)
    bounded.push(`… ${String(errors.length - bounded.length)} more validation errors omitted`);
  return bounded;
}

export function formatEvaluationErrors(errors: readonly string[]): string {
  return boundedEvaluationErrors(errors).join('; ');
}

function parseValidationCandidateFinding(value: unknown, label: string, errors: string[]): Omit<FusionValidationFindingRecord, 'id' | 'candidate_id'> | undefined {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return undefined;
  }
  closed(value, ['severity', 'location', 'evidence', 'impact', 'summary'], label, errors);
  const severity = nonBlankString(value['severity'], `${label}.severity`, errors) as FusionValidationSeverity | undefined;
  const location = nonBlankString(value['location'], `${label}.location`, errors);
  const evidence = nonBlankString(value['evidence'], `${label}.evidence`, errors);
  const impact = nonBlankString(value['impact'], `${label}.impact`, errors);
  const summary = nonBlankString(value['summary'], `${label}.summary`, errors);
  if (severity !== undefined && !['critical', 'high', 'minor'].includes(severity)) errors.push(`${label}.severity invalid`);
  if (severity === undefined || location === undefined || evidence === undefined || impact === undefined || summary === undefined) return undefined;
  return { severity, location, evidence, impact, summary };
}

export interface ParsedFusionValidationCandidateReport {
  findings: readonly FusionValidationFindingRecord[];
  verified: readonly string[];
  limitations: readonly string[];
}

export type FusionValidationCandidateNormalization =
  | 'markdown_json_fence'
  | 'prose_then_markdown_json_fence';

export interface RecoveredFusionValidationCandidateReport {
  report: ParsedFusionValidationCandidateReport;
  /** Bare JSON forwarded to the evaluator after explicit, audited recovery. */
  response: string;
  normalization: FusionValidationCandidateNormalization;
}

/**
 * Recognize exactly one complete Markdown JSON fence, optionally preceded by a
 * short prose preamble. This is deliberately narrower than generic substring
 * extraction: trailing prose, nested fences, unlabelled fences, and oversized
 * preambles remain contract failures.
 */
function fencedValidationCandidateJson(text: string): {
  payload: string;
  normalization: FusionValidationCandidateNormalization;
} | undefined {
  const trimmed = text.trim();
  const openingPattern = /```json[ \t]*\r?\n/giu;
  const openings = [...trimmed.matchAll(openingPattern)];
  if (openings.length !== 1) return undefined;
  const opening = openings[0];
  if (opening === undefined) return undefined;
  const headerEnd = opening.index + opening[0].length;
  const closing = trimmed.indexOf('```', headerEnd);
  if (closing < 0 || trimmed.slice(closing + 3).includes('```')) return undefined;
  if (trimmed.slice(closing + 3).trim().length > 0) return undefined;
  const preamble = trimmed.slice(0, opening.index).trim();
  if (Buffer.byteLength(preamble, 'utf8') > 2_000 || preamble.includes('```')) return undefined;
  const payload = trimmed.slice(headerEnd, closing).trim();
  if (payload.length === 0 || payload.includes('```')) return undefined;
  return {
    payload,
    normalization: preamble.length === 0
      ? 'markdown_json_fence'
      : 'prose_then_markdown_json_fence',
  };
}

/**
 * Defensive recovery for the one observed contract violation shape. Callers
 * must persist/surface the returned normalization; this function intentionally
 * does not make the strict parser permissive.
 */
export function recoverFencedFusionValidationCandidateReport(
  text: string,
  candidateId: FusionCandidateId,
): RecoveredFusionValidationCandidateReport | undefined {
  const recovered = fencedValidationCandidateJson(text);
  if (recovered === undefined) return undefined;
  return {
    report: parseFusionValidationCandidateReport(recovered.payload, candidateId),
    response: recovered.payload,
    normalization: recovered.normalization,
  };
}

export function parseFusionValidationCandidateReport(text: string, candidateId: FusionCandidateId): ParsedFusionValidationCandidateReport {
  let parsed: unknown;
  try {
    parsed = parseJsonText(text);
  } catch (error) {
    throw new FusionError(
      `validation candidate ${candidateId} output must be structured JSON only: ${errorText(error)}`,
      { code: 'evaluation_invalid', stage: 'candidate' },
    );
  }
  const errors: string[] = [];
  if (!isRecord(parsed)) {
    errors.push('validation candidate report must be an object');
  } else {
    closed(parsed, ['schema_version', 'findings', 'verified', 'limitations'], 'validation candidate report', errors);
  }
  if (!isRecord(parsed)) {
    throw new FusionError(`validation candidate ${candidateId} output failed schema validation: ${formatEvaluationErrors(errors)}`, {
      code: 'evaluation_invalid',
      stage: 'candidate',
    });
  }
  if (parsed['schema_version'] !== FUSION_VALIDATE_CANDIDATE_SCHEMA_VERSION) errors.push('validation candidate report.schema_version mismatch');
  const rawFindings = parsed['findings'];
  const findings: Array<Omit<FusionValidationFindingRecord, 'id' | 'candidate_id'>> = [];
  if (!Array.isArray(rawFindings)) errors.push('validation candidate report.findings must be an array');
  else {
    for (const [index, item] of rawFindings.entries()) {
      const finding = parseValidationCandidateFinding(item, `validation candidate report.findings[${String(index)}]`, errors);
      if (finding !== undefined) findings.push(finding);
    }
  }
  const verified = stringList(parsed['verified'], 'validation candidate report.verified', errors);
  const limitations = stringList(parsed['limitations'], 'validation candidate report.limitations', errors);
  if (errors.length > 0) {
    throw new FusionError(`validation candidate ${candidateId} output failed schema validation: ${formatEvaluationErrors(errors)}`, {
      code: 'evaluation_invalid',
      stage: 'candidate',
    });
  }
  return {
    findings: findings.map((finding, index) => ({
      id: stableFusionFindingId(candidateId, index + 1),
      candidate_id: candidateId,
      ...finding,
    })),
    verified: verified ?? [],
    limitations: limitations ?? [],
  };
}

export function stableFusionFindingId(candidateId: FusionCandidateId, ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal <= 0) {
    throw new FusionError('validation finding ordinal must be a positive integer', {
      code: 'evaluation_invalid',
      stage: 'evaluation',
    });
  }
  return `${candidateId}-F${String(ordinal).padStart(3, '0')}`;
}

export function validateFusionFindingAccounting(
  accounting: FusionValidationFindingAccounting,
): readonly string[] {
  const errors: string[] = [];
  const sourceIds = new Set<string>();
  const perCandidateOrdinal: Record<FusionCandidateId, number> = { A: 0, B: 0, C: 0 };
  for (const [index, finding] of accounting.findings.entries()) {
    const label = `finding[${String(index)}]`;
    perCandidateOrdinal[finding.candidate_id] += 1;
    if (finding.id !== stableFusionFindingId(finding.candidate_id, perCandidateOrdinal[finding.candidate_id])) {
      errors.push(`${label}.id must be the stable host id for its candidate and ordinal`);
    }
    if (!['critical', 'high', 'minor'].includes(finding.severity)) errors.push(`${label}.severity invalid`);
    for (const key of ['location', 'evidence', 'impact', 'summary'] as const) {
      if (finding[key].trim().length === 0) errors.push(`${label}.${key} must be non-blank`);
    }
    if (sourceIds.has(finding.id)) errors.push(`${label}.id duplicate`);
    sourceIds.add(finding.id);
  }
  const accounted = new Set<string>();
  for (const [index, decision] of accounting.decisions.entries()) {
    const label = `decision[${String(index)}]`;
    if (!sourceIds.has(decision.source_id)) errors.push(`${label}.source_id does not name a candidate finding`);
    if (accounted.has(decision.source_id)) errors.push(`${label}.source_id accounted more than once`);
    accounted.add(decision.source_id);
    if (decision.disposition !== 'include' && decision.disposition !== 'exclude') errors.push(`${label}.disposition invalid`);
    if (decision.rationale.trim().length === 0) errors.push(`${label}.rationale must be non-blank`);
    if (decision.disposition === 'include' && (decision.group_id === undefined || decision.group_id.trim().length === 0)) {
      errors.push(`${label}.group_id required for included findings`);
    }
    if (decision.disposition === 'exclude' && decision.group_id !== undefined) {
      errors.push(`${label}.group_id must be omitted for excluded findings`);
    }
  }
  for (const id of sourceIds) {
    if (!accounted.has(id)) errors.push(`source finding ${id} was not accounted exactly once`);
  }

  const groupsById = new Map<string, FusionValidationFindingGroup>();
  for (const [index, group] of accounting.groups.entries()) {
    const label = `group[${String(index)}]`;
    if (groupsById.has(group.group_id)) errors.push(`${label}.group_id duplicate`);
    groupsById.set(group.group_id, group);
    if (!['critical', 'high', 'minor'].includes(group.severity)) errors.push(`${label}.severity invalid`);
    for (const key of ['location', 'evidence', 'impact', 'summary', 'rationale'] as const) {
      if (group[key].trim().length === 0) errors.push(`${label}.${key} must be non-blank`);
    }
    if (group.source_ids.length === 0) errors.push(`${label}.source_ids must not be empty`);
    const groupSourceIds = new Set<string>();
    for (const sourceId of group.source_ids) {
      if (!sourceIds.has(sourceId)) errors.push(`${label}.source_ids contains unknown finding ${sourceId}`);
      if (groupSourceIds.has(sourceId)) errors.push(`${label}.source_ids contains duplicate ${sourceId}`);
      groupSourceIds.add(sourceId);
    }
  }

  const includedByGroup = new Map<string, Set<string>>();
  for (const decision of accounting.decisions) {
    if (decision.disposition !== 'include' || decision.group_id === undefined) continue;
    const group = groupsById.get(decision.group_id);
    if (group === undefined) {
      errors.push(`included source finding ${decision.source_id} references unknown group ${decision.group_id}`);
      continue;
    }
    const members = includedByGroup.get(decision.group_id) ?? new Set<string>();
    members.add(decision.source_id);
    includedByGroup.set(decision.group_id, members);
  }
  for (const group of accounting.groups) {
    const expected = [...group.source_ids].sort();
    const actual = [...(includedByGroup.get(group.group_id) ?? new Set<string>())].sort();
    if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
      errors.push(`group ${group.group_id} source_ids must exactly match included decisions assigned to that group`);
    }
  }
  return errors;
}

function sanitizeValidationRationale(value: string): string {
  return value
    .replace(/\b[ABC]-F\d{3}\b/gu, 'source finding')
    .replace(/\bcandidate [ABC]\b/giu, 'one reviewer')
    .replace(/\b[ABC]:\s*/gu, '');
}

export function renderValidatedFusionValidationReport(
  accounting: FusionValidationFindingAccounting,
  coverage?: { verified: readonly string[]; limitations: readonly string[] } | undefined,
): string {
  const errors = validateFusionFindingAccounting(accounting);
  if (errors.length > 0) {
    throw new FusionError(`validation accounting invalid before render: ${formatEvaluationErrors(errors)}`, {
      code: 'evaluation_invalid',
      stage: 'merge',
    });
  }
  const severityOrder = { critical: 0, high: 1, minor: 2 } as const;
  const renderedFindings = [...accounting.groups].sort((left, right) =>
    severityOrder[left.severity] - severityOrder[right.severity] ||
    left.location.localeCompare(right.location) ||
    left.group_id.localeCompare(right.group_id),
  );
  const lines: string[] = ['# Validation report', ''];
  if (renderedFindings.length === 0) {
    lines.push('No included findings were identified by the validated accounting.', '');
  } else {
    lines.push('## Findings', '');
    for (const finding of renderedFindings) {
      lines.push(`### ${finding.severity}: ${finding.summary}`, '');
      lines.push(`- Location: ${finding.location}`);
      lines.push(`- Evidence: ${finding.evidence}`);
      lines.push(`- Impact: ${finding.impact}`);
      lines.push(`- Inclusion rationale: ${sanitizeValidationRationale(finding.rationale)}`, '');
    }
  }
  const exclusions = accounting.decisions
    .filter((decision) => decision.disposition === 'exclude')
    .sort((left, right) => left.source_id.localeCompare(right.source_id));
  if (exclusions.length > 0) {
    lines.push('## Excluded source findings', '');
    for (const decision of exclusions) lines.push(`- ${sanitizeValidationRationale(decision.rationale)}`);
    lines.push('');
  }
  if (coverage !== undefined) {
    lines.push('## Verified', '');
    if (coverage.verified.length === 0) lines.push('- No verification statements were provided.');
    else for (const item of coverage.verified) lines.push(`- ${item}`);
    lines.push('', '## Limitations', '');
    if (coverage.limitations.length === 0) lines.push('- No limitations were provided.');
    else for (const item of coverage.limitations) lines.push(`- ${item}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function assertMergerFindingCoverage(
  accounting: FusionValidationFindingAccounting,
  renderedGroupIds: readonly string[],
): void {
  const errors = [...validateFusionFindingAccounting(accounting)];
  const included = new Set(accounting.groups.map((group) => group.group_id));
  const rendered = new Set(renderedGroupIds);
  for (const id of included) if (!rendered.has(id)) errors.push(`merger dropped included group ${id}`);
  for (const id of rendered) if (!included.has(id)) errors.push(`merger invented or revived group ${id}`);
  if (errors.length > 0) {
    throw new FusionError(`validation finding preservation failed: ${formatEvaluationErrors(errors)}`, {
      code: 'evaluation_invalid',
      stage: 'merge',
    });
  }
}
