import { createHash } from 'node:crypto';
import { canonicalJson } from '../attested-pi-run.js';
import { normalizeFusionDeclaredSources, type DeclaredFusionSourceInput } from './source-policy.js';
import {
  FUSION_INPUT_SCHEMA_VERSION,
  FusionError,
  type FusionCanonicalRequestV3,
  type FusionCleanTaskCanonicalInputV5,
  type FusionDeclaredSourceV1,
  type FusionSource,
  type FusionWorkflowId,
} from './types.js';

export interface BuildFusionCleanTaskInputOptions {
  cwd: string;
  source: FusionSource;
  request: string;
  workflow: Exclude<FusionWorkflowId, 'reason'>;
  declaredSources?: readonly DeclaredFusionSourceInput[] | undefined;
}

/**
 * Public v1 clean builder. It is deliberately pure: callers provide cwd and
 * normalized request text explicitly, and this module has no dependency on Pi
 * session, snapshot, parent-context, or visible-conversation APIs.
 */
export const buildCleanFusionCanonicalInput = buildFusionCleanTaskCanonicalInput;

export interface BuiltFusionCleanTaskCanonicalInput {
  input: FusionCleanTaskCanonicalInputV5;
  serialized: string;
  declaredSources: readonly FusionDeclaredSourceV1[];
  transcriptLeafId: null;
}

function sha256Text(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

export function buildFusionCleanTaskCanonicalInput(
  options: BuildFusionCleanTaskInputOptions,
): BuiltFusionCleanTaskCanonicalInput {
  if (options.request.trim().length === 0) {
    throw new FusionError('fusion request must not be blank', {
      code: 'context_capture_failed',
      childCreated: false,
    });
  }
  if (!['investigate', 'research', 'validate'].includes(options.workflow)) {
    throw new FusionError('clean-task fusion input is available only to investigate, research, and validate workflows', {
      code: 'context_capture_failed',
      childCreated: false,
    });
  }
  const declaredSources = normalizeFusionDeclaredSources(options.declaredSources ?? []);
  if (options.workflow === 'research' && declaredSources.length === 0) {
    throw new FusionError('fusion research requires at least one declared source URL and purpose', {
      code: 'context_capture_failed',
      childCreated: false,
    });
  }
  if (options.workflow !== 'research' && declaredSources.length > 0) {
    throw new FusionError('declared sources are accepted only by the research workflow', {
      code: 'context_capture_failed',
      childCreated: false,
    });
  }
  const request: FusionCanonicalRequestV3 = {
    source: options.source,
    authority: 'explicit_text',
    text: options.request,
    sha256: sha256Text(options.request),
  };
  const input: FusionCleanTaskCanonicalInputV5 = {
    schema_version: FUSION_INPUT_SCHEMA_VERSION,
    workflow: options.workflow,
    cwd: options.cwd,
    request,
    context: {
      kind: 'clean_task',
      policy_id: 'fusion-clean-task-v1',
      declared_sources: declaredSources,
    },
  };
  return {
    input,
    serialized: canonicalJson(input),
    declaredSources,
    transcriptLeafId: null,
  };
}
