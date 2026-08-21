import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import { isJsonObject, parseJsonText, type JsonObject } from '../types.js';
import { replaceFileDurable } from '../durable-fs.js';
import { CLAUDE_CODE_200K_SUBSCRIPTION_CONTEXT_WINDOW } from '../anthropic-attribution.js';
import {
  FUSION_MODEL_CONFIG_SCHEMA_VERSION,
  FusionError,
  type FusionModelConfigRevision,
  type FusionModelConfigV1,
  type FusionModelSelection,
  type FusionThinkingLevel,
  type LoadedFusionModelConfig,
  type ResolvedFusionModel,
  type ResolvedFusionModels,
} from './types.js';

export const FUSION_MODEL_CONFIG_FILE = 'fusion-models.json';
export const CURRENT_MODEL_SELECTION = '$current';

export interface FusionModelRegistry {
  getAll(): Model<Api>[];
  getAvailable(): Model<Api>[];
  find?(provider: string, modelId: string): Model<Api> | undefined;
  isUsingOAuth?(model: Model<Api>): boolean;
}

export interface ResolveFusionModelsInput {
  config: FusionModelConfigV1;
  modelRegistry: FusionModelRegistry;
  currentModel: Model<Api> | undefined;
  thinkingLevel: FusionThinkingLevel;
}

export function defaultFusionModelConfig(): FusionModelConfigV1 {
  return {
    schema_version: FUSION_MODEL_CONFIG_SCHEMA_VERSION,
    candidates: [CURRENT_MODEL_SELECTION, CURRENT_MODEL_SELECTION, CURRENT_MODEL_SELECTION],
    evaluator: CURRENT_MODEL_SELECTION,
    merger: CURRENT_MODEL_SELECTION,
  };
}

export function fusionModelConfigPath(agentDir = getAgentDir()): string {
  return join(agentDir, FUSION_MODEL_CONFIG_FILE);
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function revisionForPath(path: string): Promise<FusionModelConfigRevision> {
  try {
    const bytes = await readFile(path);
    return { path, exists: true, sha256: sha256Hex(bytes) };
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) return { path, exists: false, sha256: null };
    throw error;
  }
}

function errorHasCode(error: unknown, code: string): boolean {
  return isJsonObject(error) && error['code'] === code;
}

function keysOf(value: object): string[] {
  return Object.keys(value).sort();
}

function assertClosed(record: JsonObject, expected: readonly string[], label: string): void {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(record)) {
    if (!expectedSet.has(key)) throw configError(`${label} contains unknown key ${key}`);
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw configError(`${label} is missing key ${key}`);
    }
  }
}

function configError(message: string): FusionError {
  return new FusionError(message, { code: 'config_invalid', childCreated: false });
}

function requireSelection(value: unknown, label: string): FusionModelSelection {
  if (typeof value !== 'string') throw configError(`${label} must be a string`);
  if (value === CURRENT_MODEL_SELECTION) return value;
  const trimmed = value.trim();
  if (trimmed.length === 0) throw configError(`${label} must not be blank`);
  if (trimmed !== value) throw configError(`${label} must not have surrounding whitespace`);
  if (!trimmed.includes('/')) throw configError(`${label} must be a qualified provider/model key`);
  return trimmed;
}

function requireCandidateSelections(
  value: unknown,
): [FusionModelSelection, FusionModelSelection, FusionModelSelection] {
  if (!Array.isArray(value)) throw configError('candidates must be an array');
  if (value.length !== 3) throw configError('candidates must contain exactly three entries');
  const first = requireSelection(value[0], 'candidates[0]');
  const second = requireSelection(value[1], 'candidates[1]');
  const third = requireSelection(value[2], 'candidates[2]');
  return [first, second, third];
}

export function parseFusionModelConfig(value: unknown): FusionModelConfigV1 {
  if (!isJsonObject(value) || Array.isArray(value))
    throw configError('fusion model config must be an object');
  const record: JsonObject = value;
  assertClosed(
    record,
    ['schema_version', 'candidates', 'evaluator', 'merger'],
    'fusion model config',
  );
  if (record['schema_version'] !== FUSION_MODEL_CONFIG_SCHEMA_VERSION) {
    throw configError('fusion model config schema_version mismatch');
  }
  return {
    schema_version: FUSION_MODEL_CONFIG_SCHEMA_VERSION,
    candidates: requireCandidateSelections(record['candidates']),
    evaluator: requireSelection(record['evaluator'], 'evaluator'),
    merger: requireSelection(record['merger'], 'merger'),
  };
}

export async function loadFusionModelConfig(
  path = fusionModelConfigPath(),
): Promise<LoadedFusionModelConfig> {
  const revision = await revisionForPath(path);
  if (!revision.exists) return { config: defaultFusionModelConfig(), revision };
  let parsed: unknown;
  try {
    parsed = parseJsonText(await readFile(path, 'utf8'));
  } catch (error) {
    throw configError(
      `fusion model config is not valid JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const config = parseFusionModelConfig(parsed);
  return { config, revision };
}

function qualifiedModelKey(model: Pick<Model<Api>, 'provider' | 'id'>): string {
  return `${model.provider}/${model.id}`;
}

function requireContextWindow(model: Model<Api>, label: string): number {
  const value = model.contextWindow;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new FusionError(`${label} has no positive context window`, {
      code: 'model_unavailable',
      childCreated: false,
    });
  }
  return Math.floor(value);
}

function transportContextWindow(model: Model<Api>, label: string): number {
  const advertised = requireContextWindow(model, label);
  return model.provider === 'anthropic'
    ? Math.min(advertised, CLAUDE_CODE_200K_SUBSCRIPTION_CONTEXT_WINDOW)
    : advertised;
}

function requireMaxOutputTokens(model: Model<Api>, label: string): number {
  const value = model.maxTokens;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new FusionError(`${label} has no positive maximum output token capacity`, {
      code: 'model_unavailable',
      childCreated: false,
    });
  }
  return Math.floor(value);
}

function modelIndex(models: readonly Model<Api>[]): Map<string, Model<Api>> {
  const out = new Map<string, Model<Api>>();
  for (const model of models) out.set(qualifiedModelKey(model), model);
  return out;
}

const FRONTIER_MODEL_PATTERN =
  /(?:^|[-_/])(?:gpt|codex|claude|opus|sonnet|o[134](?:-[a-z0-9.]+)*)(?:[-_/]|$)/iu;
const TRUSTED_SUBSCRIPTION_ENDPOINTS = Object.freeze({
  anthropic: 'https://api.anthropic.com',
  'openai-codex': 'https://chatgpt.com/backend-api',
} as const);
const AUTH_HEADER_NAMES = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'api-key']);

function isKnownFrontierEndpoint(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined || baseUrl.trim().length === 0) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase().replace(/\.+$/u, '');
    return (
      hostname === 'api.openai.com' ||
      hostname === 'api.anthropic.com' ||
      hostname === 'openrouter.ai' ||
      hostname === 'chatgpt.com' ||
      hostname.endsWith('.openai.azure.com') ||
      hostname.endsWith('.cognitiveservices.azure.com') ||
      hostname.endsWith('.ai.azure.com')
    );
  } catch {
    return false;
  }
}

function assertTrustedSubscriptionEndpoint(
  model: Model<Api>,
  slotLabel: string,
  provider: keyof typeof TRUSTED_SUBSCRIPTION_ENDPOINTS,
): void {
  const expectedText = TRUSTED_SUBSCRIPTION_ENDPOINTS[provider];
  const effectiveText = model.baseUrl?.trim() || expectedText;
  let effective: URL;
  try {
    effective = new URL(effectiveText);
  } catch {
    throw new FusionError(
      `${slotLabel} route ${model.provider}/${model.id} has a malformed subscription endpoint`,
      { code: 'model_unavailable', childCreated: false },
    );
  }
  const expected = new URL(expectedText);
  const effectivePath = effective.href.slice(effective.origin.length).replace(/\/+$/u, '');
  const expectedPath = expected.href.slice(expected.origin.length).replace(/\/+$/u, '');
  if (
    effective.protocol !== 'https:' ||
    effective.username !== '' ||
    effective.password !== '' ||
    effective.search !== '' ||
    effective.hash !== '' ||
    effective.origin !== expected.origin ||
    effectivePath !== expectedPath
  ) {
    throw new FusionError(
      `${slotLabel} route ${model.provider}/${model.id} does not use the trusted Pi subscription endpoint ${expectedText}`,
      { code: 'model_unavailable', childCreated: false },
    );
  }
  const unsafeHeader = Object.keys(model.headers ?? {}).find((name) =>
    AUTH_HEADER_NAMES.has(name.toLowerCase()),
  );
  if (unsafeHeader !== undefined) {
    throw new FusionError(
      `${slotLabel} route ${model.provider}/${model.id} overrides subscription authentication header ${unsafeHeader}`,
      { code: 'model_unavailable', childCreated: false },
    );
  }
}

function assertSubscriptionRoute(
  model: Model<Api>,
  slotLabel: string,
  registry: FusionModelRegistry,
): void {
  const provider = model.provider.toLowerCase();
  const frontier =
    provider === 'openai' ||
    provider === 'openrouter' ||
    provider === 'anthropic' ||
    provider === 'openai-codex' ||
    provider.includes('azure') ||
    FRONTIER_MODEL_PATTERN.test(`${provider}/${model.id}`) ||
    isKnownFrontierEndpoint(model.baseUrl);
  if (!frontier) return;
  if (provider !== 'anthropic' && provider !== 'openai-codex') {
    throw new FusionError(
      `${slotLabel} route ${model.provider}/${model.id} is a frontier-model API channel; Fusion requires the Pi Anthropic or Codex subscription route`,
      { code: 'model_unavailable', childCreated: false },
    );
  }
  assertTrustedSubscriptionEndpoint(model, slotLabel, provider);
  if (registry.isUsingOAuth === undefined) {
    throw new FusionError(
      `${slotLabel} route ${model.provider}/${model.id} cannot be admitted because ModelRegistry OAuth observation is unavailable`,
      { code: 'model_unavailable', childCreated: false },
    );
  }
  if (!registry.isUsingOAuth(model)) {
    throw new FusionError(
      `${slotLabel} route ${model.provider}/${model.id} is not using subscription OAuth; metered API credentials are forbidden for Fusion`,
      { code: 'model_unavailable', childCreated: false },
    );
  }
}

function resolveSelection(
  selection: FusionModelSelection,
  slotLabel: string,
  availableByKey: Map<string, Model<Api>>,
  currentModel: Model<Api> | undefined,
  thinkingLevel: FusionThinkingLevel,
  registry: FusionModelRegistry,
): ResolvedFusionModel {
  if (selection === CURRENT_MODEL_SELECTION) {
    if (currentModel === undefined) {
      throw new FusionError(`${slotLabel} uses $current but Pi has no current model`, {
        code: 'model_unavailable',
        childCreated: false,
      });
    }
    const qualifiedId = qualifiedModelKey(currentModel);
    const available = availableByKey.get(qualifiedId);
    if (available === undefined) {
      throw new FusionError(
        `${slotLabel} current model is not available to child Pi: ${qualifiedId}`,
        {
          code: 'model_unavailable',
          childCreated: false,
        },
      );
    }
    assertSubscriptionRoute(available, slotLabel, registry);
    return {
      selection,
      source: 'current',
      provider: available.provider,
      model: available.id,
      qualifiedId,
      thinkingLevel,
      contextWindow: transportContextWindow(available, slotLabel),
      maxOutputTokens: requireMaxOutputTokens(available, slotLabel),
    };
  }
  const model = availableByKey.get(selection);
  if (model === undefined) {
    throw new FusionError(`${slotLabel} configured model is unavailable: ${selection}`, {
      code: 'model_unavailable',
      childCreated: false,
    });
  }
  assertSubscriptionRoute(model, slotLabel, registry);
  return {
    selection,
    source: 'configured',
    provider: model.provider,
    model: model.id,
    qualifiedId: selection,
    thinkingLevel,
    contextWindow: transportContextWindow(model, slotLabel),
    maxOutputTokens: requireMaxOutputTokens(model, slotLabel),
  };
}

export function resolveFusionModels(input: ResolveFusionModelsInput): ResolvedFusionModels {
  const availableByKey = modelIndex(input.modelRegistry.getAvailable());
  const [first, second, third] = input.config.candidates;
  const resolve = (selection: FusionModelSelection, slot: string): ResolvedFusionModel =>
    resolveSelection(
      selection,
      slot,
      availableByKey,
      input.currentModel,
      input.thinkingLevel,
      input.modelRegistry,
    );
  return {
    candidates: [
      resolve(first, 'candidate 1'),
      resolve(second, 'candidate 2'),
      resolve(third, 'candidate 3'),
    ],
    evaluator: resolve(input.config.evaluator, 'evaluator'),
    merger: resolve(input.config.merger, 'merger'),
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withConfigLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const dir = dirname(path);
  const lockPath = join(dir, `.${basename(path)}.lock`);
  const started = Date.now();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (handle === undefined) {
    try {
      handle = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (!errorHasCode(error, 'EEXIST')) throw error;
      if (Date.now() - started > 10_000) {
        throw new FusionError(`timed out waiting for fusion model config lock: ${path}`, {
          code: 'config_conflict',
          childCreated: false,
        });
      }
      await delay(25);
    }
  }
  try {
    await handle.writeFile(`${String(process.pid)}\n`);
    await handle.sync();
    return await fn();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

function prettyConfig(config: FusionModelConfigV1): string {
  const sorted = {
    schema_version: config.schema_version,
    candidates: [...config.candidates],
    evaluator: config.evaluator,
    merger: config.merger,
  };
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

function revisionsMatch(
  expected: FusionModelConfigRevision,
  current: FusionModelConfigRevision,
): boolean {
  if (expected.path !== current.path) return false;
  if (expected.exists !== current.exists) return false;
  return expected.sha256 === current.sha256;
}

export async function saveFusionModelConfig(
  path: string,
  config: FusionModelConfigV1,
  expectedRevision: FusionModelConfigRevision,
): Promise<FusionModelConfigRevision> {
  parseFusionModelConfig(config);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return withConfigLock(path, async () => {
    const current = await revisionForPath(path);
    if (!revisionsMatch(expectedRevision, current)) {
      throw new FusionError(`fusion model config changed on disk: ${path}`, {
        code: 'config_conflict',
        childCreated: false,
      });
    }
    await replaceFileDurable(path, prettyConfig(config));
    return revisionForPath(path);
  });
}

export function describeFusionModelConfig(config: FusionModelConfigV1): string {
  return keysOf(config).join(', ');
}
