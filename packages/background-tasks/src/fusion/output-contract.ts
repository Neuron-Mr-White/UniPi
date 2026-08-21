import { FusionError, type FusionStage } from './types.js';

/** Hard output contracts are measured over the JSON rendering embedded downstream. */
export const FUSION_CANDIDATE_MAX_OUTPUT_BYTES = 48 * 1024;
export const FUSION_EVALUATION_MAX_OUTPUT_BYTES = 64 * 1024;
export const FUSION_MERGE_MAX_OUTPUT_BYTES = 64 * 1024;
export const FUSION_DIAGNOSTICS_MAX_BYTES = 8 * 1024;

const FUSION_CANDIDATE_MAX_OUTPUT_BYTES_DISPLAY =
  FUSION_CANDIDATE_MAX_OUTPUT_BYTES.toLocaleString('en-US');

export const FUSION_CANDIDATE_OUTPUT_CONTRACT_INSTRUCTION = `Your complete response must be at most ${FUSION_CANDIDATE_MAX_OUTPUT_BYTES_DISPLAY} JSON-rendered UTF-8 bytes. If the requested scope cannot fit, prioritize the most important findings and explicitly state limitations.`;

export const FUSION_CANDIDATE_OUTPUT_COMPRESSION_PROMPT = `Compress and restructure only your immediately previous answer so the complete replacement is at most ${FUSION_CANDIDATE_MAX_OUTPUT_BYTES_DISPLAY} JSON-rendered UTF-8 bytes. Do not investigate again, do not use tools, and do not add new evidence. Preserve the most important findings and evidence already present, state material limitations, obey the original output format, and output only the replacement answer.`;

export function fusionJsonRenderedTextBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), 'utf8');
}

export function fusionOutputContractBytes(stage: FusionStage): number {
  if (stage === 'candidate') return FUSION_CANDIDATE_MAX_OUTPUT_BYTES;
  if (stage === 'evaluation') return FUSION_EVALUATION_MAX_OUTPUT_BYTES;
  return FUSION_MERGE_MAX_OUTPUT_BYTES;
}

export function assertChildOutputWithinContract(stage: FusionStage, text: string): void {
  const bytes = fusionJsonRenderedTextBytes(text);
  const allowed = fusionOutputContractBytes(stage);
  if (bytes <= allowed) return;
  throw new FusionError(
    `fusion ${stage} response is ${String(bytes)} JSON-rendered bytes, exceeding the ${String(allowed)}-byte output contract for that stage; the response is preserved in the run artifacts and is not forwarded or truncated`,
    { code: 'child_output_cap', stage, childCreated: true },
  );
}
