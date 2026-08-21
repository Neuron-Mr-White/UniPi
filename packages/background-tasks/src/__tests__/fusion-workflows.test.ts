import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FUSION_INVESTIGATE,
  FUSION_INVESTIGATE_WORKFLOW,
  FUSION_REASON,
  FUSION_REASON_WORKFLOW,
  FUSION_RESEARCH,
  FUSION_RESEARCH_WORKFLOW,
  FUSION_VALIDATE,
  FUSION_VALIDATE_WORKFLOW,
  FUSION_WORKFLOW_PROFILES,
  assertWorkflowCapability,
  fusionWorkflowProfile,
} from '../fusion/workflows.js';
import { FUSION_WORKFLOW_IDS } from '../fusion/types.js';

void describe('fusion fixed v1 workflows', () => {
  void it('exports exactly four public workflow profiles with fixed policies', () => {
    assert.deepEqual([...FUSION_WORKFLOW_IDS], ['reason', 'investigate', 'research', 'validate']);
    assert.deepEqual(FUSION_WORKFLOW_PROFILES.map((profile) => profile.publicName), ['fusion_reason', 'fusion_investigate', 'fusion_research', 'fusion_validate']);
    assert.equal(FUSION_REASON, FUSION_REASON_WORKFLOW);
    assert.equal(FUSION_INVESTIGATE, FUSION_INVESTIGATE_WORKFLOW);
    assert.equal(FUSION_RESEARCH, FUSION_RESEARCH_WORKFLOW);
    assert.equal(FUSION_VALIDATE, FUSION_VALIDATE_WORKFLOW);
  });

  void it('pins context and tool policies by workflow', () => {
    assert.equal(FUSION_REASON_WORKFLOW.contextKind, 'session_projection');
    assert.equal(FUSION_REASON_WORKFLOW.candidateCapability, 'reason');
    assert.deepEqual(FUSION_REASON_WORKFLOW.candidateTools, []);
    assert.equal(FUSION_INVESTIGATE_WORKFLOW.contextKind, 'clean_task');
    assert.equal(FUSION_INVESTIGATE_WORKFLOW.candidateCapability, 'inspect');
    assert.deepEqual(FUSION_INVESTIGATE_WORKFLOW.candidateTools, ['read', 'grep', 'find', 'ls']);
    assert.equal(FUSION_RESEARCH_WORKFLOW.contextKind, 'clean_task');
    assert.equal(FUSION_RESEARCH_WORKFLOW.candidateCapability, 'research');
    assert.ok(FUSION_RESEARCH_WORKFLOW.candidateTools.includes('fusion_web_fetch'));
    assert.equal(FUSION_VALIDATE_WORKFLOW.contextKind, 'clean_task');
    assert.equal(FUSION_VALIDATE_WORKFLOW.candidateCapability, 'inspect');
    for (const profile of FUSION_WORKFLOW_PROFILES) {
      assert.equal(profile.evaluatorCapability, 'reason');
      assert.equal(profile.mergeCapability, 'reason');
      assert.deepEqual(profile.evaluatorTools, []);
      assert.deepEqual(profile.mergeTools, []);
    }
  });

  void it('rejects mismatched caller capabilities instead of substituting', () => {
    assert.equal(assertWorkflowCapability(FUSION_REASON_WORKFLOW, undefined), 'reason');
    assert.equal(assertWorkflowCapability(FUSION_VALIDATE_WORKFLOW, 'inspect'), 'inspect');
    assert.throws(() => assertWorkflowCapability(FUSION_VALIDATE_WORKFLOW, 'reason'), /always runs candidates with the inspect capability/);
    assert.throws(() => assertWorkflowCapability(FUSION_RESEARCH_WORKFLOW, 'inspect'), /always runs candidates with the research capability/);
  });

  void it('resolves every declared workflow id and fails closed on unknown ids', () => {
    for (const id of FUSION_WORKFLOW_IDS) assert.equal(fusionWorkflowProfile(id).id, id);
    assert.throws(() => fusionWorkflowProfile('brainstorm' as never), /unknown fusion workflow/);
  });
});
