import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalJson } from '../attested-pi-run.js';
import { FusionOrchestrator } from '../fusion/orchestrator.js';
import { defaultFusionModelConfig } from '../fusion/config.js';
import { buildFusionCleanTaskCanonicalInput } from '../fusion/clean-context.js';
import {
  FUSION_VALIDATE_CANDIDATE_SYSTEM_PROMPT,
  FUSION_VALIDATE_EVALUATOR_SYSTEM_PROMPT,
  FUSION_VALIDATE_MERGER_SYSTEM_PROMPT,
} from '../fusion/prompts.js';
import { FUSION_VALIDATE_WORKFLOW } from '../fusion/workflows.js';
import {
  FUSION_EVALUATION_SCHEMA_VERSION,
  FUSION_RESULT_SCHEMA_VERSION,
  FUSION_VALIDATE_CANDIDATE_SCHEMA_VERSION,
  FUSION_VALIDATE_CAPABILITY,
  FusionError,
  type FusionChildRunResult,
  type ResolvedFusionModel,
  type ResolvedFusionModels,
} from '../fusion/types.js';
import type { RunPiChildOptions } from '../fusion/pi-child.js';

function resolved(qualifiedId: string): ResolvedFusionModel {
  const slash = qualifiedId.indexOf('/');
  return { selection: '$current', source: 'current', provider: qualifiedId.slice(0, slash), model: qualifiedId.slice(slash + 1), qualifiedId, thinkingLevel: 'high', contextWindow: 200_000, maxOutputTokens: 32_768 };
}

function models(): ResolvedFusionModels {
  return { candidates: [resolved('p/c1'), resolved('p/c2'), resolved('p/c3')], evaluator: resolved('p/eval'), merger: resolved('p/merge') };
}

function childResult(options: RunPiChildOptions, text: string): FusionChildRunResult {
  const result: FusionChildRunResult = {
    stage: options.stage,
    attempt: options.attempt,
    provider: options.model.provider,
    model: options.model.model,
    qualifiedId: options.model.qualifiedId,
    text,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } },
    events: Buffer.from('{"schema_version":"pi-background-tasks.fusion-child-result.v4"}\n'),
    stderr: Buffer.alloc(0),
    exitCode: 0,
    signal: null,
  };
  if (options.slot !== undefined) result.slot = options.slot;
  return result;
}

function candidateReport(slot: number): string {
  return JSON.stringify({
    schema_version: FUSION_VALIDATE_CANDIDATE_SCHEMA_VERSION,
    findings: [{ severity: slot === 1 ? 'critical' : 'minor', location: `src/file-${String(slot)}.ts:1`, evidence: `evidence ${String(slot)}`, impact: `impact ${String(slot)}`, summary: `finding ${String(slot)}` }],
    verified: [`verified ${String(slot)}`],
    limitations: ['none'],
  });
}

function evaluatorText(stdin: string): string {
  const blind = JSON.parse(stdin) as { candidates: Array<{ candidate_id: 'A' | 'B' | 'C'; response: string }> };
  const findings = blind.candidates.flatMap((candidate) => {
    const report = JSON.parse(candidate.response) as {
      findings: Array<{
        severity: 'critical' | 'high' | 'minor';
        location: string;
        evidence: string;
        impact: string;
        summary: string;
      }>;
    };
    return report.findings.map((finding, index) => ({ id: `${candidate.candidate_id}-F${String(index + 1).padStart(3, '0')}`, candidate_id: candidate.candidate_id, ...finding }));
  });
  return JSON.stringify({
    schema_version: FUSION_EVALUATION_SCHEMA_VERSION,
    candidate_assessments: ['A', 'B', 'C'].map((candidate_id) => ({ candidate_id, summary: 's', strengths: ['s'], limitations: ['l'], useful_contributions: ['u'], risks: ['r'] })),
    agreements: ['agree'],
    conflicts: [],
    synthesis_plan: { must_include: [{ candidate_id: 'A', contribution: 'preserve findings' }], must_resolve: [], must_avoid: [] },
    validation_accounting: {
      findings,
      decisions: findings.map((finding, index) => ({ source_id: finding.id, disposition: 'include', rationale: 'supported', group_id: `G${String(index + 1)}` })),
      groups: findings.map((finding, index) => ({
        group_id: `G${String(index + 1)}`,
        source_ids: [finding.id],
        severity: finding.severity,
        location: finding.location,
        evidence: finding.evidence,
        impact: finding.impact,
        summary: finding.summary,
        rationale: 'supported by source evidence',
      })),
    },
  });
}

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pi-fusion-validate-'));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

void describe('fusion validate orchestration', () => {
  void it('uses clean input, inspect candidates, no-tool adjudicators, and deterministic validated rendering', async () => {
    await withRoot(async (root) => {
      const calls: RunPiChildOptions[] = [];
      const oversizedOriginal = 'o'.repeat(50_000);
      const built = buildFusionCleanTaskCanonicalInput({ cwd: root, source: 'tool', workflow: 'validate', request: canonicalJson({ objective: 'validate', background: [], changeSummary: 'changed', scope: ['src'], acceptanceCriteria: ['works'], verification: { status: 'not_run', evidence: [], reason: 'unit' }, knownLimitations: [], exclusions: [] }) });
      const orchestrator = new FusionOrchestrator({
        childRunner: (options) => {
          calls.push(options);
          if (options.stage === 'candidate') {
            const candidate = childResult(options, candidateReport(options.slot ?? 0));
            if (options.slot === 1) {
              candidate.outputRecovery = {
                kind: 'same_session_compression',
                limit_bytes: 49_152,
                original_record_index: 0,
                replacement_record_index: 1,
                original_json_rendered_bytes: 50_002,
                replacement_json_rendered_bytes: Buffer.byteLength(
                  JSON.stringify(candidate.text),
                  'utf8',
                ),
                original_text_sha256: createHash('sha256').update(oversizedOriginal).digest('hex'),
                original_text: oversizedOriginal,
                status: 'completed',
              };
            }
            return Promise.resolve(candidate);
          }
          if (options.stage === 'evaluation')
            return Promise.resolve(childResult(options, evaluatorText(options.userPrompt)));
          return Promise.resolve(childResult(options, 'ignored free-form merger prose'));
        },
      });
      const result = await orchestrator.run({ source: 'tool', cwd: root, canonicalInput: built.input, canonicalInputSerialized: built.serialized, config: defaultFusionModelConfig(), models: models(), profile: FUSION_VALIDATE_WORKFLOW });

      assert.equal(calls.length, 5);
      assert.deepEqual(calls.filter((call) => call.stage === 'candidate').map((call) => call.capability), [FUSION_VALIDATE_CAPABILITY, FUSION_VALIDATE_CAPABILITY, FUSION_VALIDATE_CAPABILITY]);
      assert.deepEqual(calls.filter((call) => call.stage !== 'candidate').map((call) => call.capability), ['reason', 'reason']);
      assert.equal(calls[0]?.systemPrompt, FUSION_VALIDATE_CANDIDATE_SYSTEM_PROMPT);
      assert.equal(calls.find((call) => call.stage === 'evaluation')?.systemPrompt, FUSION_VALIDATE_EVALUATOR_SYSTEM_PROMPT);
      assert.equal(calls.find((call) => call.stage === 'merge')?.systemPrompt, FUSION_VALIDATE_MERGER_SYSTEM_PROMPT);
      assert.match(result.mergedText, /^# Validation report/);
      assert.match(result.mergedText, /Location: src\/file-/);
      assert.doesNotMatch(result.mergedText, /ignored free-form/);
      assert.equal(result.details.workflow, 'validate');
      assert.equal(result.details.schema_version, FUSION_RESULT_SCHEMA_VERSION);
      assert.equal(result.details.context.kind, 'clean_task');
      assert.equal(
        await readFile(
          join(root, result.details.artifact_dir, 'candidate-1.attempt-1.response.oversized.txt'),
          'utf8',
        ),
        oversizedOriginal,
      );
    });
  });

  void it('audits and recovers the narrowly supported fenced-JSON violation', async () => {
    await withRoot(async (root) => {
      const built = buildFusionCleanTaskCanonicalInput({ cwd: root, source: 'tool', workflow: 'validate', request: 'validate' });
      const orchestrator = new FusionOrchestrator({ childRunner: (options) => {
        if (options.stage === 'candidate') {
          const report = candidateReport(options.slot ?? 0);
          if (options.slot === 1) return Promise.resolve(childResult(options, `\`\`\`json\n${report}\n\`\`\``));
          if (options.slot === 2) return Promise.resolve(childResult(options, `Validation complete.\n\`\`\`json\n${report}\n\`\`\``));
          return Promise.resolve(childResult(options, report));
        }
        if (options.stage === 'evaluation') return Promise.resolve(childResult(options, evaluatorText(options.userPrompt)));
        return Promise.resolve(childResult(options, 'ignored'));
      }});
      const result = await orchestrator.run({ source: 'tool', cwd: root, canonicalInput: built.input, canonicalInputSerialized: built.serialized, config: defaultFusionModelConfig(), models: models(), profile: FUSION_VALIDATE_WORKFLOW });
      assert.match(result.mergedText, /required audited removal of a Markdown JSON wrapper/);
      const artifactDir = join(root, result.details.artifact_dir);
      const names = await readdir(artifactDir);
      const normalizationArtifacts = names.filter((name) => name.includes('output-contract-normalized'));
      assert.equal(normalizationArtifacts.length, 2);
      const firstNormalization = normalizationArtifacts[0];
      assert.ok(firstNormalization);
      const normalizationEvent = JSON.parse(await readFile(join(artifactDir, firstNormalization), 'utf8')) as { schema_version?: string; status?: string };
      assert.equal(normalizationEvent.schema_version, 'pi-background-tasks.fusion-validation-candidate-contract-event.v1');
      assert.equal(normalizationEvent.status, 'normalized');
      assert.equal(names.includes('candidate-1.attempt-1.response.txt'), true);
      assert.equal(
        await readFile(join(artifactDir, 'candidate-1.attempt-1.system-prompt.txt'), 'utf8'),
        FUSION_VALIDATE_CANDIDATE_SYSTEM_PROMPT,
      );
    });
  });

  void it('continues with an explicit limitation when one report is irrecoverable', async () => {
    await withRoot(async (root) => {
      const built = buildFusionCleanTaskCanonicalInput({ cwd: root, source: 'tool', workflow: 'validate', request: 'validate' });
      const orchestrator = new FusionOrchestrator({ childRunner: (options) => {
        if (options.stage === 'candidate') return Promise.resolve(childResult(options, options.slot === 1 ? 'not JSON' : candidateReport(options.slot ?? 0)));
        if (options.stage === 'evaluation') return Promise.resolve(childResult(options, evaluatorText(options.userPrompt)));
        return Promise.resolve(childResult(options, 'ignored'));
      }});
      const result = await orchestrator.run({ source: 'tool', cwd: root, canonicalInput: built.input, canonicalInputSerialized: built.serialized, config: defaultFusionModelConfig(), models: models(), profile: FUSION_VALIDATE_WORKFLOW });
      assert.match(result.mergedText, /could not be parsed after strict contract checks/);
      const names = await readdir(join(root, result.details.artifact_dir));
      assert.equal(names.filter((name) => name.includes('output-contract-dropped')).length, 1);
    });
  });

  void it('fails loudly for two invalid reports while preserving the anonymous map', async () => {
    await withRoot(async (root) => {
      const built = buildFusionCleanTaskCanonicalInput({ cwd: root, source: 'tool', workflow: 'validate', request: 'validate' });
      const orchestrator = new FusionOrchestrator({ childRunner: (options) =>
        Promise.resolve(childResult(options, options.stage === 'candidate' && options.slot !== 3 ? 'not JSON' : candidateReport(options.slot ?? 3)))
      });
      let failure: FusionError | undefined;
      try {
        await orchestrator.run({ source: 'tool', cwd: root, canonicalInput: built.input, canonicalInputSerialized: built.serialized, config: defaultFusionModelConfig(), models: models(), profile: FUSION_VALIDATE_WORKFLOW });
      } catch (error) {
        if (error instanceof FusionError) failure = error;
        else throw error;
      }
      assert.ok(failure);
      assert.match(failure.message, /2 of 3 candidate reports/);
      assert.ok(failure.artifactDir);
      const manifest = JSON.parse(await readFile(join(root, failure.artifactDir, 'manifest.json'), 'utf8')) as { anonymous_map?: unknown };
      assert.ok(manifest.anonymous_map);
    });
  });

  void it('rejects validate runs that attempt to carry a parent ledger', async () => {
    await withRoot(async (root) => {
      const built = buildFusionCleanTaskCanonicalInput({ cwd: root, source: 'tool', workflow: 'validate', request: 'validate' });
      const orchestrator = new FusionOrchestrator({ childRunner: async (options) => childResult(options, '{}') });
      await assert.rejects(() => orchestrator.run({ source: 'tool', cwd: root, canonicalInput: built.input, canonicalInputSerialized: built.serialized, contextLedger: { schema_version: 'pi-background-tasks.fusion-context-ledger.v2', policy_id: 'x', transform: 'visible-conversation-ledger-v2', entries: [], projection_map: [], root_sha256: 'a'.repeat(64) }, config: defaultFusionModelConfig(), models: models(), profile: FUSION_VALIDATE_WORKFLOW }), /clean-task fusion input must not carry/);
    });
  });
});
