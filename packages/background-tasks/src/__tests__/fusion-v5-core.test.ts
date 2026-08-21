import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../attested-pi-run.js';
import {
  buildFusionCanonicalInput,
} from '../fusion/context.js';
import { buildFusionCleanTaskCanonicalInput } from '../fusion/clean-context.js';
import {
  FUSION_INVESTIGATE_WORKFLOW,
  FUSION_REASON_WORKFLOW,
  FUSION_RESEARCH_WORKFLOW,
  FUSION_VALIDATE_WORKFLOW,
  FUSION_WORKFLOW_PROFILES,
  assertWorkflowCapability,
} from '../fusion/workflows.js';
import {
  FUSION_FORBIDDEN_TOOLS,
  FUSION_INPUT_SCHEMA_VERSION,
  FUSION_PUBLIC_WORKFLOW_NAMES,
  FUSION_RESEARCH_TOOLS,
  FUSION_WORKFLOW_IDS,
} from '../fusion/types.js';
import {
  buildFusionSourcePolicy,
  canonicalizeFusionPublicUrl,
  normalizeFusionDeclaredSources,
  parseFusionSourcePolicy,
  sourcePolicyCanonicalBytes,
} from '../fusion/source-policy.js';
import {
  assertMergerFindingCoverage,
  stableFusionFindingId,
  validateFusionFindingAccounting,
} from '../fusion/evaluation.js';
import { buildFusionPiChildArgv } from '../fusion/pi-child.js';
import { FusionArtifactStore } from '../fusion/artifacts.js';
import { userMessage, buildFrom } from './helpers/fusion-canonical.js';

function model(id: string): ResolvedFusionModel {
  return {
    selection: id,
    source: 'configured',
    provider: 'openai-codex',
    model: id,
    qualifiedId: `openai-codex/${id}`,
    thinkingLevel: 'high',
    contextWindow: 200000,
    maxOutputTokens: 32_768,
  };
}

function models(): ResolvedFusionModels {
  return { candidates: [model('a'), model('b'), model('c')], evaluator: model('e'), merger: model('m') };
}

const config: FusionModelConfigV1 = {
  schema_version: 'pi-background-tasks.fusion-models.v1',
  candidates: ['openai-codex/a', 'openai-codex/b', 'openai-codex/c'],
  evaluator: 'openai-codex/e',
  merger: 'openai-codex/m',
};

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedFusionModel, ResolvedFusionModels, FusionModelConfigV1 } from '../fusion/types.js';

void describe('fusion v5 core workflow contracts', () => {
  void it('exports four fixed immutable workflow profiles and public names', () => {
    assert.deepEqual([...FUSION_WORKFLOW_IDS], ['reason', 'investigate', 'research', 'validate']);
    assert.deepEqual([...FUSION_PUBLIC_WORKFLOW_NAMES], [
      'fusion_reason',
      'fusion_investigate',
      'fusion_research',
      'fusion_validate',
    ]);
    assert.equal(FUSION_REASON_WORKFLOW.contextKind, 'session_projection');
    assert.equal(FUSION_REASON_WORKFLOW.candidateCapability, 'reason');
    assert.deepEqual(FUSION_REASON_WORKFLOW.candidateTools, []);
    assert.equal(FUSION_INVESTIGATE_WORKFLOW.contextKind, 'clean_task');
    assert.equal(FUSION_INVESTIGATE_WORKFLOW.candidateCapability, 'inspect');
    assert.deepEqual(FUSION_RESEARCH_WORKFLOW.candidateTools, FUSION_RESEARCH_TOOLS);
    assert.equal(FUSION_VALIDATE_WORKFLOW.contextKind, 'clean_task');
    for (const profile of FUSION_WORKFLOW_PROFILES) {
      assert.ok(profile.runIdPrefix.startsWith(`${profile.id}-`));
      assert.throws(() => ((profile.candidateTools as string[]).push('bash')), TypeError);
      assert.equal(assertWorkflowCapability(profile, undefined), profile.candidateCapability);
      assert.throws(() => assertWorkflowCapability(profile, profile.candidateCapability === 'reason' ? 'inspect' : 'reason'));
    }
  });

  void it('retains legacy and current fusion workflow names only in the child recursion denylist', () => {
    for (const name of ['fusion_brainstorm', 'fusion_reason', 'fusion_investigate', 'fusion_research', 'fusion_validate']) {
      assert.ok(FUSION_FORBIDDEN_TOOLS.includes(name as never), `${name} denied`);
    }
  });

  void it('builds session projection only for reason and clean bytes independent of parent accessors', () => {
    const reason = buildFrom([userMessage('hello')], { source: 'command', request: 'answer', workflow: 'reason' }, 'system');
    assert.equal(reason.input.schema_version, FUSION_INPUT_SCHEMA_VERSION);
    assert.equal(reason.input.workflow, 'reason');
    assert.equal(reason.input.context?.kind, 'session_projection');
    assert.ok(reason.ledger.entries.length === 0);

    const throwingParent = {
      get cwd(): string { throw new Error('clean builder touched cwd accessor'); },
      get sessionManager(): never { throw new Error('clean builder touched session'); },
      getSystemPrompt(): never { throw new Error('clean builder touched system prompt'); },
    };
    assert.throws(
      () => buildFusionCanonicalInput(throwingParent as never, { source: 'command', request: 'x', workflow: 'investigate' }),
      /parent session projection is available only to the reason workflow/,
    );

    const first = buildFusionCleanTaskCanonicalInput({
      cwd: '/repo',
      source: 'tool',
      request: 'Inspect src',
      workflow: 'investigate',
    });
    const second = buildFusionCleanTaskCanonicalInput({
      cwd: '/repo',
      source: 'tool',
      request: 'Inspect src',
      workflow: 'investigate',
    });
    assert.equal(first.serialized, second.serialized);
    assert.equal(canonicalJson(first.input), first.serialized);
    assert.equal(first.input.context?.kind, 'clean_task');
    assert.equal('conversation_projection' in first.input, false);
    assert.equal('system_prompt' in first.input, false);
    assert.equal('ledger' in first, false);
  });

  void it('normalizes and hashes research declared-source policies', () => {
    const sources = normalizeFusionDeclaredSources([
      { url: 'HTTPS://Example.COM:443/a?q=1#frag', purpose: 'primary source' },
    ]);
    assert.equal(sources[0]?.canonical_url, 'https://example.com/a?q=1');
    assert.throws(() => canonicalizeFusionPublicUrl('https://user:secret@example.com/'), /credentials/);
    assert.throws(() => canonicalizeFusionPublicUrl('http://127.0.0.1/'), /public/);
    assert.throws(
      () => canonicalizeFusionPublicUrl('http://[64:ff9b::a00:1]/'),
      /private\/reserved/,
    );
    const policy = buildFusionSourcePolicy('/repo', sources);
    const bytes = sourcePolicyCanonicalBytes(policy);
    const parsed = parseFusionSourcePolicy(JSON.parse(bytes));
    assert.equal(parsed.root_sha256, policy.root_sha256);
    assert.equal(parsed.sources[0]?.sha256, sources[0]?.sha256);
    const tampered = JSON.parse(bytes) as { root_sha256: string };
    tampered.root_sha256 = '0'.repeat(64);
    assert.throws(() => parseFusionSourcePolicy(tampered), /root_sha256 mismatch/);
  });



  void it('builds exact v5 child argv and run-id manifest metadata', async () => {
    const argv = buildFusionPiChildArgv(model('child'), 'system', '/ext/fusion-child.js', 'research', () => '/ext/anthropic-attribution.js');
    assert.deepEqual(argv.slice(0, 8), ['--mode', 'text', '--no-session', '--no-builtin-tools', '--tools', 'read,grep,find,ls,fusion_web_fetch', '--exclude-tools', FUSION_FORBIDDEN_TOOLS.join(',')]);
    assert.ok(argv.includes('--no-extensions'));
    assert.ok(argv.includes('--system-prompt'));

    const root = await mkdtemp(join(tmpdir(), 'fusion-v5-'));
    try {
      const store = await FusionArtifactStore.create({
        cwd: root,
        profile: FUSION_RESEARCH_WORKFLOW,
        source: 'tool',
        config,
        models: models(),
        runId: 'research-' + '1'.repeat(32),
      });
      const manifest = store.snapshot();
      assert.equal(manifest.run_id, 'research-' + '1'.repeat(32));
      assert.equal(manifest.workflow, 'research');
      assert.equal(manifest.context.kind, 'clean_task');
      assert.deepEqual(manifest.tool_policy.candidate_tools, [...FUSION_RESEARCH_TOOLS]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('validates validation finding accounting and merger coverage mechanically', () => {
    assert.equal(stableFusionFindingId('A', 1), 'A-F001');
    const accounting = {
      findings: [
        {
          id: 'A-F001',
          candidate_id: 'A' as const,
          severity: 'high' as const,
          location: 'src/x.ts:1',
          evidence: 'read line 1',
          impact: 'breaks callers',
          summary: 'bug',
        },
      ],
      decisions: [
        { source_id: 'A-F001', disposition: 'include' as const, rationale: 'supported', group_id: 'G001' },
      ],
      groups: [
        {
          group_id: 'G001',
          source_ids: ['A-F001'],
          severity: 'high' as const,
          location: 'src/x.ts:1',
          evidence: 'read line 1',
          impact: 'breaks callers',
          summary: 'bug',
          rationale: 'supported',
        },
      ],
    };
    assert.deepEqual(validateFusionFindingAccounting(accounting), []);
    assert.doesNotThrow(() => assertMergerFindingCoverage(accounting, ['G001']));
    assert.throws(() => assertMergerFindingCoverage(accounting, []), /dropped included group/);
    assert.throws(() => assertMergerFindingCoverage(accounting, ['G001', 'G999']), /invented/);
  });
});
