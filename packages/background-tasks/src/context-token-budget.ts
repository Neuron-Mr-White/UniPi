/**
 * Shared, dependency-free size arithmetic for prompt budgeting.
 *
 * Fusion and delegate both use the same pure estimator, but they pass distinct
 * scope profiles. Fusion may use a calibrated family rate only for measured
 * large prompts that remain in the calibration domain. Delegate uses a stricter
 * byte-ceiling profile because its 8,192-token floor is too small for relaxed
 * rates.
 *
 * Calibration basis: 882 real large Fusion prompts. The observed floors are
 * 2.047 B/tok for Anthropic and 3.400 B/tok for Codex. The shipped rates apply
 * a 15% haircut and add a provisional 512-token affine intercept. The
 * low-whitespace gate below is a corpus-derived heuristic proxy for dense ASCII
 * token density; it is not a tokenizer bound or guarantee.
 */

export const TOKEN_BUDGET_CALIBRATION_VERSION =
  'pi-background-tasks.input-token-calibration.v1' as const;
export const TOKEN_BUDGET_RATE_SCALE = 100;
export const TOKEN_BUDGET_PROVENANCE_SCALE = 1000;
export const TOKEN_BUDGET_HAIRCUT_BASIS_POINTS = 1500;
export const TOKEN_BUDGET_LARGE_PROMPT_MIN_BYTES = 50 * 1024;
export const TOKEN_BUDGET_CONSERVATIVE_RATE_X100 = 200;
export const TOKEN_BUDGET_PROVABLE_RATE_X100 = 100;
export const TOKEN_BUDGET_DELEGATE_CONSERVATIVE_RATE_X100 = TOKEN_BUDGET_PROVABLE_RATE_X100;
export const TOKEN_BUDGET_MULTIBYTE_FATAL_RATE_X100 = TOKEN_BUDGET_CONSERVATIVE_RATE_X100;
export const TOKEN_BUDGET_AFFINE_F_TOKENS = 512;
export const TOKEN_BUDGET_WHITESPACE_FRACTION_SCALE = 10_000;
/**
 * Floor of the observed large-prompt calibration corpus, scaled by
 * TOKEN_BUDGET_WHITESPACE_FRACTION_SCALE and rounded down. The gate threshold is
 * deliberately below this value; it catches near-zero-whitespace OOD payloads
 * without claiming to bound tokenizer density.
 */
export const TOKEN_BUDGET_CALIBRATION_CORPUS_MIN_WHITESPACE_FRACTION_X10000 = 18;
export const TOKEN_BUDGET_DENSE_ASCII_WHITESPACE_THRESHOLD_X10000 = 10;

export const TOKEN_BUDGET_FAMILIES = ['anthropic', 'openai-codex', 'unknown'] as const;
export type TokenBudgetFamily = (typeof TOKEN_BUDGET_FAMILIES)[number];

export const TOKEN_BUDGET_SEGMENT_KINDS = [
  'known_text',
  'known_json',
  'unknown_output_contract',
] as const;
export type TokenBudgetSegmentKind = (typeof TOKEN_BUDGET_SEGMENT_KINDS)[number];

export type TokenBudgetEstimatorScope =
  | 'fusion'
  | 'delegate_launch'
  | 'delegate'
  | 'conservative';
export type TokenBudgetDominantByteClass =
  | 'normal'
  | 'dense_ascii'
  | 'multibyte'
  | 'unknown_output_contract';

export interface TokenBudgetCalibrationProvenance {
  n: number;
  observed_min_bpt_x1000: number | null;
  median_bpt_x1000: number | null;
  max_bpt_x1000: number | null;
  corpus_sha256: string | null;
  corpus_date: string;
  haircut_basis_points: number;
  backed: boolean;
  byte_level_bpe: boolean;
}

export interface TokenBudgetFamilyCalibration {
  family: TokenBudgetFamily;
  rate_bytes_per_token_x100: number;
  affine_f_tokens: number;
  provenance: TokenBudgetCalibrationProvenance;
}

const ANTHROPIC_PROVENANCE: TokenBudgetCalibrationProvenance = Object.freeze({
  n: 85,
  observed_min_bpt_x1000: 2047,
  median_bpt_x1000: 2217,
  max_bpt_x1000: 2481,
  corpus_sha256: 'sha256:large-fusion-prompts-2026-08-02',
  corpus_date: '2026-08-02',
  haircut_basis_points: TOKEN_BUDGET_HAIRCUT_BASIS_POINTS,
  backed: true,
  byte_level_bpe: true,
});

const OPENAI_CODEX_PROVENANCE: TokenBudgetCalibrationProvenance = Object.freeze({
  n: 797,
  observed_min_bpt_x1000: 3400,
  median_bpt_x1000: 3721,
  max_bpt_x1000: 4526,
  corpus_sha256: 'sha256:large-fusion-prompts-2026-08-02',
  corpus_date: '2026-08-02',
  haircut_basis_points: TOKEN_BUDGET_HAIRCUT_BASIS_POINTS,
  backed: true,
  byte_level_bpe: true,
});

const UNKNOWN_PROVENANCE: TokenBudgetCalibrationProvenance = Object.freeze({
  n: 0,
  observed_min_bpt_x1000: null,
  median_bpt_x1000: null,
  max_bpt_x1000: null,
  corpus_sha256: null,
  corpus_date: 'unbacked',
  haircut_basis_points: TOKEN_BUDGET_HAIRCUT_BASIS_POINTS,
  backed: false,
  byte_level_bpe: true,
});

export const TOKEN_BUDGET_FAMILY_CALIBRATIONS: Readonly<
  Record<TokenBudgetFamily, TokenBudgetFamilyCalibration>
> = Object.freeze({
  anthropic: Object.freeze({
    family: 'anthropic',
    rate_bytes_per_token_x100: 173,
    affine_f_tokens: TOKEN_BUDGET_AFFINE_F_TOKENS,
    provenance: ANTHROPIC_PROVENANCE,
  }),
  'openai-codex': Object.freeze({
    family: 'openai-codex',
    rate_bytes_per_token_x100: 289,
    affine_f_tokens: TOKEN_BUDGET_AFFINE_F_TOKENS,
    provenance: OPENAI_CODEX_PROVENANCE,
  }),
  unknown: Object.freeze({
    family: 'unknown',
    rate_bytes_per_token_x100: 100,
    affine_f_tokens: TOKEN_BUDGET_AFFINE_F_TOKENS,
    provenance: UNKNOWN_PROVENANCE,
  }),
});

const MODEL_OVERRIDES: Readonly<Record<string, TokenBudgetFamily>> = Object.freeze({
  'anthropic/claude-opus-5': 'anthropic',
  'anthropic/claude-fable-5': 'anthropic',
  'openai-codex/gpt-5.6-sol': 'openai-codex',
  'openai-codex/gpt-5.6-terra': 'openai-codex',
  'openai-codex/gpt-5.5': 'openai-codex',
  'openai-codex/gpt-5.4-mini': 'openai-codex',
});
const PROVIDER_DEFAULTS: Readonly<Record<string, TokenBudgetFamily>> = Object.freeze({
  anthropic: 'anthropic',
  'openai-codex': 'openai-codex',
});

export interface TokenBudgetRouteLike {
  provider: string;
  model: string;
}

export interface ResolvedTokenBudgetFamily {
  family: TokenBudgetFamily;
  provider: string;
  model: string;
  qualified_id: string;
  backed: boolean;
  resolution: 'model_override' | 'known_provider_unbacked_model' | 'unknown_provider_floor';
}

export function resolveTokenBudgetFamily(route: TokenBudgetRouteLike): ResolvedTokenBudgetFamily {
  const qualified = `${route.provider}/${route.model}`;
  const overridden = MODEL_OVERRIDES[qualified];
  if (overridden !== undefined) {
    return {
      family: overridden,
      provider: route.provider,
      model: route.model,
      qualified_id: qualified,
      backed: true,
      resolution: 'model_override',
    };
  }
  const providerDefault = PROVIDER_DEFAULTS[route.provider];
  if (providerDefault !== undefined) {
    return {
      family: providerDefault,
      provider: route.provider,
      model: route.model,
      qualified_id: qualified,
      backed: false,
      resolution: 'known_provider_unbacked_model',
    };
  }
  return {
    family: 'unknown',
    provider: route.provider,
    model: route.model,
    qualified_id: qualified,
    backed: false,
    resolution: 'unknown_provider_floor',
  };
}

export interface TokenBudgetSegment {
  kind: TokenBudgetSegmentKind;
  bytes: number;
  multibyteBytes?: number | undefined;
  denseBytes?: number | undefined;
  asciiWhitespaceBytes?: number | undefined;
}

export interface TokenBudgetByteClassBreakdown {
  total_bytes: number;
  normal_bytes: number;
  multibyte_bytes: number;
  dense_bytes: number;
  unknown_output_contract_bytes: number;
}

export interface TokenBudgetPromptProfile extends TokenBudgetByteClassBreakdown {
  concrete_known_bytes: number;
  ascii_whitespace_bytes: number;
  whitespace_fraction_x10000: number | null;
  whitespace_fraction_scale: typeof TOKEN_BUDGET_WHITESPACE_FRACTION_SCALE;
  whitespace_fraction_available: boolean;
  dominant_byte_class: TokenBudgetDominantByteClass;
}

export interface TokenBudgetDenseAsciiGate {
  heuristic: 'low_whitespace_fraction_proxy_not_tokenizer_bound';
  corpus_min_whitespace_fraction_x10000: number;
  threshold_whitespace_fraction_x10000: number;
  measured_whitespace_fraction_x10000: number | null;
  evaluated: boolean;
  out_of_distribution: boolean;
  decision: 'not_evaluated' | 'calibrated_allowed' | 'conservative_fallback';
  reason: 'prompt_below_large_prompt_floor' | 'multibyte_or_non_ascii_dominant' | 'whitespace_fraction_unavailable' | 'below_threshold' | 'at_or_above_threshold' | null;
}

export interface TokenBudgetRateBucketEstimate {
  rate_bytes_per_token_x100: number;
  bytes: number;
  tokens: number;
  byte_classes: readonly TokenBudgetDominantByteClass[];
}

export interface TokenBudgetAdvisoryEstimate {
  multibyte_provable_rate_bytes_per_token_x100: typeof TOKEN_BUDGET_PROVABLE_RATE_X100;
  multibyte_provable_tokens: number;
  input_tokens_if_multibyte_used_provable_ceiling: number;
  rate_buckets: readonly TokenBudgetRateBucketEstimate[];
}

export interface TokenBudgetPerSegmentEstimate extends TokenBudgetByteClassBreakdown {
  kind: TokenBudgetSegmentKind;
  ascii_whitespace_bytes: number;
  normal_rate_bytes_per_token_x100: number;
  normal_tokens: number;
  multibyte_rate_bytes_per_token_x100: typeof TOKEN_BUDGET_MULTIBYTE_FATAL_RATE_X100;
  multibyte_tokens: number;
  multibyte_provable_tokens: number;
  dense_tokens: number;
  unknown_output_contract_tokens: number;
  tokens: number;
}

export interface TokenBudgetRateSource {
  calibration_version: typeof TOKEN_BUDGET_CALIBRATION_VERSION;
  family: TokenBudgetFamily;
  configured_rate_bytes_per_token_x100: number;
  effective_rate_bytes_per_token_x100: number;
  conservative_rate_bytes_per_token_x100: number;
  delegate_conservative_rate_bytes_per_token_x100: typeof TOKEN_BUDGET_DELEGATE_CONSERVATIVE_RATE_X100;
  affine_f_tokens: number;
  scope: TokenBudgetEstimatorScope;
  source:
    | 'calibrated_large_window'
    | 'conservative_small_prompt'
    | 'conservative_capacity_guard'
    | 'conservative_dense_ascii_whitespace_gate'
    | 'delegate_conservative'
    | 'explicit_conservative'
    | 'unknown_provider_floor'
    | 'unbacked_model_floor';
  backed: boolean;
  provenance: TokenBudgetCalibrationProvenance;
  model_resolution: ResolvedTokenBudgetFamily['resolution'] | 'family_direct';
  scope_guard_min_bytes: typeof TOKEN_BUDGET_LARGE_PROMPT_MIN_BYTES;
  calibration_applied: boolean;
  prompt_profile: TokenBudgetPromptProfile;
  dense_ascii_gate: TokenBudgetDenseAsciiGate;
  dominant_byte_class: TokenBudgetDominantByteClass;
  warning: string | null;
}

export interface EstimateInputTokensInput {
  family: TokenBudgetFamily;
  segments: readonly TokenBudgetSegment[];
  allowedInputTokens?: number | undefined;
  scope?: TokenBudgetEstimatorScope | undefined;
  calibrationBacked?: boolean | undefined;
  familyResolution?: ResolvedTokenBudgetFamily['resolution'] | 'family_direct' | undefined;
}

export interface EstimateInputTokensResult {
  tokens: number;
  fixed_tokens: number;
  perSegment: readonly TokenBudgetPerSegmentEstimate[];
  byte_class_breakdown: TokenBudgetByteClassBreakdown;
  rate_buckets: readonly TokenBudgetRateBucketEstimate[];
  advisory: TokenBudgetAdvisoryEstimate;
  rateSource: TokenBudgetRateSource;
}

function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function calibrationFor(family: TokenBudgetFamily): TokenBudgetFamilyCalibration {
  return TOKEN_BUDGET_FAMILY_CALIBRATIONS[family];
}

function ceilDiv(numerator: number, denominator: number): number {
  assertSafeNonNegativeInteger(numerator, 'division numerator');
  assertPositiveInteger(denominator, 'division denominator');
  if (numerator === 0) return 0;
  return Math.floor((numerator - 1) / denominator) + 1;
}

function tokensAtRate(bytes: number, rateBytesPerTokenX100: number): number {
  assertSafeNonNegativeInteger(bytes, 'bytes');
  assertPositiveInteger(rateBytesPerTokenX100, 'rateBytesPerTokenX100');
  return ceilDiv(bytes * TOKEN_BUDGET_RATE_SCALE, rateBytesPerTokenX100);
}

function conservativeFusionRate(configured: number): number {
  return Math.min(configured, TOKEN_BUDGET_CONSERVATIVE_RATE_X100);
}

interface NormalizedTokenBudgetSegment {
  kind: TokenBudgetSegmentKind;
  bytes: number;
  multibyteBytes: number;
  denseBytes: number;
  asciiWhitespaceBytes: number;
  whitespaceKnown: boolean;
}

function normalizeSegment(
  segment: TokenBudgetSegment,
  index: number,
): NormalizedTokenBudgetSegment {
  assertSafeNonNegativeInteger(segment.bytes, `segments[${String(index)}].bytes`);
  const denseBytes = segment.denseBytes ?? 0;
  assertSafeNonNegativeInteger(denseBytes, `segments[${String(index)}].denseBytes`);
  if (segment.kind === 'unknown_output_contract') {
    if (segment.multibyteBytes !== undefined) {
      throw new TypeError(
        `segments[${String(index)}].multibyteBytes must not be set for unknown_output_contract`,
      );
    }
    if (segment.asciiWhitespaceBytes !== undefined) {
      throw new TypeError(
        `segments[${String(index)}].asciiWhitespaceBytes must not be set for unknown_output_contract`,
      );
    }
    if (denseBytes !== 0) {
      throw new TypeError(
        `segments[${String(index)}].denseBytes must be zero for unknown_output_contract`,
      );
    }
    return {
      kind: segment.kind,
      bytes: segment.bytes,
      multibyteBytes: 0,
      denseBytes,
      asciiWhitespaceBytes: 0,
      whitespaceKnown: true,
    };
  }
  if (segment.kind !== 'known_text' && segment.kind !== 'known_json') {
    throw new TypeError(`segments[${String(index)}].kind is not supported`);
  }
  if (segment.multibyteBytes === undefined) {
    throw new TypeError(`segments[${String(index)}].multibyteBytes is required`);
  }
  assertSafeNonNegativeInteger(segment.multibyteBytes, `segments[${String(index)}].multibyteBytes`);
  if (segment.multibyteBytes + denseBytes > segment.bytes) {
    throw new TypeError(
      `segments[${String(index)}] byte classes exceed segment byte length`,
    );
  }
  const whitespaceKnown = segment.asciiWhitespaceBytes !== undefined;
  const asciiWhitespaceBytes = segment.asciiWhitespaceBytes ?? 0;
  assertSafeNonNegativeInteger(
    asciiWhitespaceBytes,
    `segments[${String(index)}].asciiWhitespaceBytes`,
  );
  if (asciiWhitespaceBytes > segment.bytes - segment.multibyteBytes) {
    throw new TypeError(
      `segments[${String(index)}].asciiWhitespaceBytes exceeds ASCII byte length`,
    );
  }
  return {
    kind: segment.kind,
    bytes: segment.bytes,
    multibyteBytes: segment.multibyteBytes,
    denseBytes,
    asciiWhitespaceBytes,
    whitespaceKnown,
  };
}

function addBreakdown(
  target: TokenBudgetByteClassBreakdown,
  delta: TokenBudgetByteClassBreakdown,
): void {
  target.total_bytes += delta.total_bytes;
  target.normal_bytes += delta.normal_bytes;
  target.multibyte_bytes += delta.multibyte_bytes;
  target.dense_bytes += delta.dense_bytes;
  target.unknown_output_contract_bytes += delta.unknown_output_contract_bytes;
}

function dominantByteClass(breakdown: TokenBudgetByteClassBreakdown): TokenBudgetDominantByteClass {
  const entries: Array<{ byteClass: TokenBudgetDominantByteClass; bytes: number; order: number }> = [
    { byteClass: 'dense_ascii', bytes: breakdown.dense_bytes, order: 0 },
    { byteClass: 'multibyte', bytes: breakdown.multibyte_bytes, order: 1 },
    { byteClass: 'unknown_output_contract', bytes: breakdown.unknown_output_contract_bytes, order: 2 },
    { byteClass: 'normal', bytes: breakdown.normal_bytes, order: 3 },
  ];
  entries.sort((left, right) => right.bytes - left.bytes || left.order - right.order);
  return entries[0]?.byteClass ?? 'normal';
}

function profileForSegments(
  segments: readonly NormalizedTokenBudgetSegment[],
  breakdown: TokenBudgetByteClassBreakdown,
): TokenBudgetPromptProfile {
  let asciiWhitespaceBytes = 0;
  let whitespaceKnown = true;
  for (const segment of segments) {
    if (segment.kind === 'unknown_output_contract') continue;
    asciiWhitespaceBytes += segment.asciiWhitespaceBytes;
    if (!segment.whitespaceKnown) whitespaceKnown = false;
  }
  const concreteKnownBytes = breakdown.total_bytes - breakdown.unknown_output_contract_bytes;
  const whitespaceFraction =
    whitespaceKnown && concreteKnownBytes > 0
      ? Math.floor((asciiWhitespaceBytes * TOKEN_BUDGET_WHITESPACE_FRACTION_SCALE) / concreteKnownBytes)
      : null;
  return {
    ...breakdown,
    concrete_known_bytes: concreteKnownBytes,
    ascii_whitespace_bytes: asciiWhitespaceBytes,
    whitespace_fraction_x10000: whitespaceFraction,
    whitespace_fraction_scale: TOKEN_BUDGET_WHITESPACE_FRACTION_SCALE,
    whitespace_fraction_available: whitespaceKnown,
    dominant_byte_class: dominantByteClass(breakdown),
  };
}

function denseAsciiGate(profile: TokenBudgetPromptProfile): TokenBudgetDenseAsciiGate {
  const base = {
    heuristic: 'low_whitespace_fraction_proxy_not_tokenizer_bound' as const,
    corpus_min_whitespace_fraction_x10000:
      TOKEN_BUDGET_CALIBRATION_CORPUS_MIN_WHITESPACE_FRACTION_X10000,
    threshold_whitespace_fraction_x10000:
      TOKEN_BUDGET_DENSE_ASCII_WHITESPACE_THRESHOLD_X10000,
    measured_whitespace_fraction_x10000: profile.whitespace_fraction_x10000,
  };
  if (profile.concrete_known_bytes < TOKEN_BUDGET_LARGE_PROMPT_MIN_BYTES) {
    return {
      ...base,
      evaluated: false,
      out_of_distribution: false,
      decision: 'not_evaluated',
      reason: 'prompt_below_large_prompt_floor',
    };
  }
  if (profile.normal_bytes === 0 || profile.multibyte_bytes > profile.normal_bytes) {
    return {
      ...base,
      evaluated: false,
      out_of_distribution: false,
      decision: 'not_evaluated',
      reason: 'multibyte_or_non_ascii_dominant',
    };
  }
  if (!profile.whitespace_fraction_available || profile.whitespace_fraction_x10000 === null) {
    return {
      ...base,
      evaluated: true,
      out_of_distribution: true,
      decision: 'conservative_fallback',
      reason: 'whitespace_fraction_unavailable',
    };
  }
  if (profile.whitespace_fraction_x10000 < TOKEN_BUDGET_DENSE_ASCII_WHITESPACE_THRESHOLD_X10000) {
    return {
      ...base,
      evaluated: true,
      out_of_distribution: true,
      decision: 'conservative_fallback',
      reason: 'below_threshold',
    };
  }
  return {
    ...base,
    evaluated: true,
    out_of_distribution: false,
    decision: 'calibrated_allowed',
    reason: 'at_or_above_threshold',
  };
}

function rateSourceWarning(input: {
  source: TokenBudgetRateSource['source'];
  family: TokenBudgetFamily;
  profile: TokenBudgetPromptProfile;
  gate: TokenBudgetDenseAsciiGate;
  scope: TokenBudgetEstimatorScope;
}): string | null {
  if (input.source === 'unknown_provider_floor') {
    return `unknown provider family uses the provable 1.00 B/tok floor; no calibration backs ${input.family}`;
  }
  if (input.source === 'unbacked_model_floor') {
    return `model is not in the exact calibration backing set for family ${input.family}; using the provable 1.00 B/tok floor`;
  }
  if (input.source === 'delegate_conservative') {
    return 'delegate launch/runtime uses the provable 1.00 B/tok profile when the prompt or route is below the backed large-prompt calibration domain';
  }
  if (input.source === 'explicit_conservative') {
    return 'explicit conservative scope uses the provable 1.00 B/tok profile';
  }
  if (input.source === 'conservative_small_prompt') {
    return `calibrated rate withheld because measured prompt bytes ${String(input.profile.concrete_known_bytes)} are below the ${String(TOKEN_BUDGET_LARGE_PROMPT_MIN_BYTES)}-byte calibration floor; using conservative profile`;
  }
  if (input.source === 'conservative_capacity_guard') {
    return `calibrated rate withheld because route capacity evaluated at the conservative rate cannot hold the ${String(TOKEN_BUDGET_LARGE_PROMPT_MIN_BYTES)}-byte calibration floor`;
  }
  if (input.source === 'conservative_dense_ascii_whitespace_gate') {
    if (input.gate.reason === 'whitespace_fraction_unavailable') {
      return 'calibrated rate withheld because known-text whitespace bytes were not supplied; provide asciiWhitespaceBytes from a one-pass UTF-8 measurement to use calibrated rates';
    }
    return `calibrated rate withheld because whitespace fraction ${String(input.gate.measured_whitespace_fraction_x10000 ?? 0)}/${String(TOKEN_BUDGET_WHITESPACE_FRACTION_SCALE)} is below the dense-ASCII gate ${String(TOKEN_BUDGET_DENSE_ASCII_WHITESPACE_THRESHOLD_X10000)}/${String(TOKEN_BUDGET_WHITESPACE_FRACTION_SCALE)}; this is a heuristic token-density proxy, not a bound`;
  }
  return null;
}

function effectiveRateSource(input: {
  family: TokenBudgetFamily;
  allowedInputTokens: number | undefined;
  scope: TokenBudgetEstimatorScope;
  profile: TokenBudgetPromptProfile;
  calibrationBacked: boolean;
  familyResolution: ResolvedTokenBudgetFamily['resolution'] | 'family_direct';
}): TokenBudgetRateSource {
  const calibration = calibrationFor(input.family);
  const configured = calibration.rate_bytes_per_token_x100;
  const familyBacked = calibration.provenance.backed;
  const backed = familyBacked && input.calibrationBacked;
  const conservativeRate = conservativeFusionRate(configured);
  const gate = denseAsciiGate(input.profile);
  let source: TokenBudgetRateSource['source'];
  let effective: number;
  let calibrationApplied = false;

  if (!backed) {
    source = input.familyResolution === 'known_provider_unbacked_model'
      ? 'unbacked_model_floor'
      : 'unknown_provider_floor';
    effective = TOKEN_BUDGET_PROVABLE_RATE_X100;
  } else if (
    input.scope === 'delegate' ||
    (input.scope === 'delegate_launch' &&
      (input.profile.concrete_known_bytes < TOKEN_BUDGET_LARGE_PROMPT_MIN_BYTES ||
        (input.allowedInputTokens !== undefined &&
          Math.floor(
            (input.allowedInputTokens * TOKEN_BUDGET_DELEGATE_CONSERVATIVE_RATE_X100) /
              TOKEN_BUDGET_RATE_SCALE,
          ) < TOKEN_BUDGET_LARGE_PROMPT_MIN_BYTES)))
  ) {
    source = 'delegate_conservative';
    effective = Math.min(configured, TOKEN_BUDGET_DELEGATE_CONSERVATIVE_RATE_X100);
  } else if (input.scope === 'conservative') {
    source = 'explicit_conservative';
    effective = Math.min(configured, TOKEN_BUDGET_PROVABLE_RATE_X100);
  } else if (input.profile.concrete_known_bytes < TOKEN_BUDGET_LARGE_PROMPT_MIN_BYTES) {
    source = 'conservative_small_prompt';
    effective = conservativeRate;
  } else if (
    input.allowedInputTokens !== undefined &&
    Math.floor((input.allowedInputTokens * conservativeRate) / TOKEN_BUDGET_RATE_SCALE) <
      TOKEN_BUDGET_LARGE_PROMPT_MIN_BYTES
  ) {
    assertSafeNonNegativeInteger(input.allowedInputTokens, 'allowedInputTokens');
    source = 'conservative_capacity_guard';
    effective = conservativeRate;
  } else if (gate.out_of_distribution) {
    source = 'conservative_dense_ascii_whitespace_gate';
    effective = conservativeRate;
  } else {
    source = 'calibrated_large_window';
    effective = configured;
    calibrationApplied = true;
  }

  const dominant = gate.out_of_distribution && input.profile.normal_bytes >= input.profile.multibyte_bytes
    ? 'dense_ascii'
    : input.profile.dominant_byte_class;
  const rateSourceInput = {
    source,
    family: input.family,
    profile: input.profile,
    gate,
    scope: input.scope,
  };
  return {
    calibration_version: TOKEN_BUDGET_CALIBRATION_VERSION,
    family: input.family,
    configured_rate_bytes_per_token_x100: configured,
    effective_rate_bytes_per_token_x100: effective,
    conservative_rate_bytes_per_token_x100: conservativeRate,
    delegate_conservative_rate_bytes_per_token_x100: TOKEN_BUDGET_DELEGATE_CONSERVATIVE_RATE_X100,
    affine_f_tokens: calibration.affine_f_tokens,
    scope: input.scope,
    source,
    backed,
    provenance: calibration.provenance,
    model_resolution: input.familyResolution,
    scope_guard_min_bytes: TOKEN_BUDGET_LARGE_PROMPT_MIN_BYTES,
    calibration_applied: calibrationApplied,
    prompt_profile: { ...input.profile, dominant_byte_class: dominant },
    dense_ascii_gate: gate,
    dominant_byte_class: dominant,
    warning: rateSourceWarning(rateSourceInput),
  };
}

interface MutableRateBucket {
  rate: number;
  bytes: number;
  classes: TokenBudgetDominantByteClass[];
}

function addBucket(
  buckets: Map<number, MutableRateBucket>,
  rate: number,
  bytes: number,
  byteClass: TokenBudgetDominantByteClass,
): void {
  if (bytes === 0) return;
  const existing = buckets.get(rate);
  if (existing === undefined) {
    buckets.set(rate, { rate, bytes, classes: [byteClass] });
    return;
  }
  existing.bytes += bytes;
  if (!existing.classes.includes(byteClass)) existing.classes.push(byteClass);
}

function finalizeBuckets(buckets: Map<number, MutableRateBucket>): TokenBudgetRateBucketEstimate[] {
  return [...buckets.values()]
    .sort((left, right) => left.rate - right.rate)
    .map((bucket) => ({
      rate_bytes_per_token_x100: bucket.rate,
      bytes: bucket.bytes,
      tokens: tokensAtRate(bucket.bytes, bucket.rate),
      byte_classes: [...bucket.classes].sort(),
    }));
}

function bucketTokenTotal(buckets: readonly TokenBudgetRateBucketEstimate[]): number {
  return buckets.reduce((sum, bucket) => sum + bucket.tokens, 0);
}

export function estimateInputTokens(input: EstimateInputTokensInput): EstimateInputTokensResult {
  const scope = input.scope ?? 'fusion';
  const normalized: NormalizedTokenBudgetSegment[] = [];
  const total: TokenBudgetByteClassBreakdown = {
    total_bytes: 0,
    normal_bytes: 0,
    multibyte_bytes: 0,
    dense_bytes: 0,
    unknown_output_contract_bytes: 0,
  };
  for (const [index, rawSegment] of input.segments.entries()) {
    const segment = normalizeSegment(rawSegment, index);
    const unknownBytes = segment.kind === 'unknown_output_contract' ? segment.bytes : 0;
    const normalBytes =
      segment.kind === 'unknown_output_contract'
        ? 0
        : segment.bytes - segment.multibyteBytes - segment.denseBytes;
    const breakdown: TokenBudgetByteClassBreakdown = {
      total_bytes: segment.bytes,
      normal_bytes: normalBytes,
      multibyte_bytes: segment.multibyteBytes,
      dense_bytes: segment.denseBytes,
      unknown_output_contract_bytes: unknownBytes,
    };
    addBreakdown(total, breakdown);
    normalized.push(segment);
  }
  if (input.allowedInputTokens !== undefined) {
    assertSafeNonNegativeInteger(input.allowedInputTokens, 'allowedInputTokens');
  }
  const profile = profileForSegments(normalized, total);
  const rateSource = effectiveRateSource({
    family: input.family,
    allowedInputTokens: input.allowedInputTokens,
    scope,
    profile,
    calibrationBacked: input.calibrationBacked ?? true,
    familyResolution: input.familyResolution ?? 'family_direct',
  });

  const perSegment: TokenBudgetPerSegmentEstimate[] = [];
  const fatalBuckets = new Map<number, MutableRateBucket>();
  const advisoryBuckets = new Map<number, MutableRateBucket>();
  let multibyteAdvisoryTotal = 0;

  for (const segment of normalized) {
    const unknownBytes = segment.kind === 'unknown_output_contract' ? segment.bytes : 0;
    const normalBytes =
      segment.kind === 'unknown_output_contract'
        ? 0
        : segment.bytes - segment.multibyteBytes - segment.denseBytes;
    const normalRate =
      segment.kind === 'unknown_output_contract'
        ? TOKEN_BUDGET_PROVABLE_RATE_X100
        : rateSource.effective_rate_bytes_per_token_x100;
    const normalTokens = tokensAtRate(normalBytes, normalRate);
    const unknownTokens = tokensAtRate(unknownBytes, TOKEN_BUDGET_PROVABLE_RATE_X100);
    const multibyteTokens = tokensAtRate(segment.multibyteBytes, TOKEN_BUDGET_MULTIBYTE_FATAL_RATE_X100);
    const multibyteProvableTokens = tokensAtRate(segment.multibyteBytes, TOKEN_BUDGET_PROVABLE_RATE_X100);
    const denseTokens = tokensAtRate(segment.denseBytes, TOKEN_BUDGET_PROVABLE_RATE_X100);
    const tokens = normalTokens + unknownTokens + multibyteTokens + denseTokens;
    const breakdown: TokenBudgetByteClassBreakdown = {
      total_bytes: segment.bytes,
      normal_bytes: normalBytes,
      multibyte_bytes: segment.multibyteBytes,
      dense_bytes: segment.denseBytes,
      unknown_output_contract_bytes: unknownBytes,
    };
    addBucket(fatalBuckets, normalRate, normalBytes, 'normal');
    addBucket(fatalBuckets, TOKEN_BUDGET_MULTIBYTE_FATAL_RATE_X100, segment.multibyteBytes, 'multibyte');
    addBucket(fatalBuckets, TOKEN_BUDGET_PROVABLE_RATE_X100, segment.denseBytes, 'dense_ascii');
    addBucket(fatalBuckets, TOKEN_BUDGET_PROVABLE_RATE_X100, unknownBytes, 'unknown_output_contract');
    addBucket(advisoryBuckets, normalRate, normalBytes, 'normal');
    addBucket(advisoryBuckets, TOKEN_BUDGET_PROVABLE_RATE_X100, segment.multibyteBytes, 'multibyte');
    addBucket(advisoryBuckets, TOKEN_BUDGET_PROVABLE_RATE_X100, segment.denseBytes, 'dense_ascii');
    addBucket(advisoryBuckets, TOKEN_BUDGET_PROVABLE_RATE_X100, unknownBytes, 'unknown_output_contract');
    multibyteAdvisoryTotal += multibyteProvableTokens;
    perSegment.push({
      kind: segment.kind,
      ...breakdown,
      ascii_whitespace_bytes: segment.asciiWhitespaceBytes,
      normal_rate_bytes_per_token_x100: normalRate,
      normal_tokens: normalTokens,
      multibyte_rate_bytes_per_token_x100: TOKEN_BUDGET_MULTIBYTE_FATAL_RATE_X100,
      multibyte_tokens: multibyteTokens,
      multibyte_provable_tokens: multibyteProvableTokens,
      dense_tokens: denseTokens,
      unknown_output_contract_tokens: unknownTokens,
      tokens,
    });
  }
  const rateBuckets = finalizeBuckets(fatalBuckets);
  const advisoryRateBuckets = finalizeBuckets(advisoryBuckets);
  const variableTokenTotal = bucketTokenTotal(rateBuckets);
  return {
    tokens: variableTokenTotal + rateSource.affine_f_tokens,
    fixed_tokens: rateSource.affine_f_tokens,
    perSegment,
    byte_class_breakdown: total,
    rate_buckets: rateBuckets,
    advisory: {
      multibyte_provable_rate_bytes_per_token_x100: TOKEN_BUDGET_PROVABLE_RATE_X100,
      multibyte_provable_tokens: multibyteAdvisoryTotal,
      input_tokens_if_multibyte_used_provable_ceiling:
        bucketTokenTotal(advisoryRateBuckets) + rateSource.affine_f_tokens,
      rate_buckets: advisoryRateBuckets,
    },
    rateSource,
  };
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);
}

export function utf8ByteClassBreakdown(value: string): {
  bytes: number;
  multibyteBytes: number;
  denseBytes: 0;
  asciiWhitespaceBytes: number;
} {
  const bytes = Buffer.from(value, 'utf8');
  let multibyteBytes = 0;
  let asciiWhitespaceBytes = 0;
  for (const byte of bytes) {
    if (byte >= 0x80) multibyteBytes += 1;
    else if (isAsciiWhitespace(byte)) asciiWhitespaceBytes += 1;
  }
  return { bytes: bytes.length, multibyteBytes, denseBytes: 0, asciiWhitespaceBytes };
}

export function knownTextSegment(value: string): TokenBudgetSegment {
  const breakdown = utf8ByteClassBreakdown(value);
  return {
    kind: 'known_text',
    bytes: breakdown.bytes,
    multibyteBytes: breakdown.multibyteBytes,
    denseBytes: breakdown.denseBytes,
    asciiWhitespaceBytes: breakdown.asciiWhitespaceBytes,
  };
}

export function knownJsonSegment(value: string): TokenBudgetSegment {
  const breakdown = utf8ByteClassBreakdown(value);
  return {
    kind: 'known_json',
    bytes: breakdown.bytes,
    multibyteBytes: breakdown.multibyteBytes,
    denseBytes: breakdown.denseBytes,
    asciiWhitespaceBytes: breakdown.asciiWhitespaceBytes,
  };
}

export function unknownOutputContractSegment(bytes: number): TokenBudgetSegment {
  assertSafeNonNegativeInteger(bytes, 'unknown output contract bytes');
  return { kind: 'unknown_output_contract', bytes, denseBytes: 0 };
}

export function tokenUpperBound(utf8Bytes: number): number {
  return estimateInputTokens({
    family: 'unknown',
    scope: 'conservative',
    calibrationBacked: false,
    segments: [{ kind: 'known_text', bytes: utf8Bytes, multibyteBytes: 0, denseBytes: 0 }],
  }).tokens;
}

export function maxKnownTextBytesForTokens(input: {
  family: TokenBudgetFamily;
  allowedInputTokens: number;
  scope?: TokenBudgetEstimatorScope | undefined;
  calibrationBacked?: boolean | undefined;
  familyResolution?: ResolvedTokenBudgetFamily['resolution'] | 'family_direct' | undefined;
}): number {
  assertSafeNonNegativeInteger(input.allowedInputTokens, 'allowedInputTokens');
  const rate = effectiveRateSource({
    family: input.family,
    allowedInputTokens: input.allowedInputTokens,
    scope: input.scope ?? 'fusion',
    profile: profileForSegments([], {
      total_bytes: 0,
      normal_bytes: 0,
      multibyte_bytes: 0,
      dense_bytes: 0,
      unknown_output_contract_bytes: 0,
    }),
    calibrationBacked: input.calibrationBacked ?? true,
    familyResolution: input.familyResolution ?? 'family_direct',
  });
  const variableTokens = input.allowedInputTokens - rate.affine_f_tokens;
  if (variableTokens <= 0) return 0;
  return Math.floor((variableTokens * rate.effective_rate_bytes_per_token_x100) / TOKEN_BUDGET_RATE_SCALE);
}

export interface RouteReserves {
  reservedOutputTokens: number;
  framingReserveTokens: number;
  safetyReserveTokens: number;
}

/**
 * Usable input tokens for one route.
 *
 * Returns a signed value. A caller that requires a minimum must check it and
 * fail loudly; this helper never clamps, never substitutes a default window, and
 * never silently returns zero for an unusable route.
 */
export function allowedInputTokens(contextWindowTokens: number, reserves: RouteReserves): number {
  return (
    contextWindowTokens -
    reserves.reservedOutputTokens -
    reserves.framingReserveTokens -
    reserves.safetyReserveTokens
  );
}

/** True only for a positive, finite, integral context window. */
export function isUsableContextWindow(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value > 0;
}
