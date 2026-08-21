import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFusionCleanTaskCanonicalInput } from '../fusion/clean-context.js';
import { buildFusionCanonicalInput } from '../fusion/context.js';
import { canonicalJson } from '../attested-pi-run.js';
import { sessionWith, userMessage } from './helpers/fusion-canonical.js';

void describe('fusion v5 context boundaries', () => {
  void it('keeps reason as the only workflow that projects parent conversation', () => {
    const sessionManager = sessionWith([userMessage('visible parent text')]);
    const built = buildFusionCanonicalInput({ cwd: '/repo', sessionManager, getSystemPrompt: () => 'parent system' }, { source: 'tool', request: 'reason about this', toolName: 'fusion_reason' });
    assert.equal(built.input.workflow, 'reason');
    assert.equal(built.input.context?.kind, 'session_projection');
    assert.match(built.serialized, /visible parent text/);
    assert.match(built.serialized, /parent system/);
  });

  void it('clean canonical input is byte-identical across unrelated parent sessions with same request and cwd', () => {
    const parentSentinel = 'PARENT-SESSION-SENTINEL-never-forward';
    const unrelatedLeft = sessionWith([userMessage(`left ${parentSentinel}`)]);
    const unrelatedRight = sessionWith([userMessage(`right ${parentSentinel}`)]);
    assert.notDeepEqual(unrelatedLeft.getEntries(), unrelatedRight.getEntries());

    const requests = {
      investigate: canonicalJson({ objective: 'inspect', background: [], deliverable: 'answer', scope: [], constraints: [] }),
      research: canonicalJson({ objective: 'research', background: [], deliverable: 'answer', scope: [], constraints: [], sources: [{ url: 'https://example.com/a', purpose: 'unit' }] }),
      validate: canonicalJson({ objective: 'validate', background: [], changeSummary: 'changed', scope: ['src'], acceptanceCriteria: ['works'], verification: { status: 'not_run', evidence: [], reason: 'unit' }, knownLimitations: [], exclusions: [] }),
    } as const;

    for (const [workflow, request] of Object.entries(requests) as Array<[keyof typeof requests, string]>) {
      const declaredSources = workflow === 'research'
        ? [{ url: 'https://example.com/a', purpose: 'unit' }]
        : [];
      const left = buildFusionCleanTaskCanonicalInput({ cwd: '/repo', source: 'tool', workflow, request, declaredSources });
      const right = buildFusionCleanTaskCanonicalInput({ cwd: '/repo', source: 'tool', workflow, request, declaredSources });
      assert.equal(left.serialized, right.serialized, workflow);
      assert.equal(left.input.context.kind, 'clean_task');
      assert.equal('system_prompt' in left.input, false);
      assert.equal('conversation_projection' in left.input, false);
      assert.equal('ledger' in left, false);
      assert.doesNotMatch(left.serialized, new RegExp(parentSentinel));
    }
  });

  void it('refuses old parent-session projection fallback before touching throwing clean accessors', () => {
    const throwingParent = {
      get cwd(): never { throw new Error('clean workflow touched parent cwd'); },
      get sessionManager(): never { throw new Error('clean workflow touched parent session'); },
      getSystemPrompt(): never { throw new Error('clean workflow touched parent system prompt'); },
    };
    for (const workflow of ['investigate', 'research', 'validate'] as const) {
      assert.throws(
        () => buildFusionCanonicalInput(throwingParent as never, { source: 'tool', request: 'clean', workflow }),
        /parent session projection is available only to the reason workflow/,
      );
    }
  });
});
