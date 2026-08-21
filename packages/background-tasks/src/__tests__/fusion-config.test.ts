import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Api, Model } from '@earendil-works/pi-ai';
import {
  CURRENT_MODEL_SELECTION,
  defaultFusionModelConfig,
  loadFusionModelConfig,
  parseFusionModelConfig,
  resolveFusionModels,
  saveFusionModelConfig,
  type FusionModelRegistry,
} from '../fusion/config.js';
import { parseJsonText } from '../types.js';
import { FUSION_MODEL_CONFIG_SCHEMA_VERSION, FusionError } from '../fusion/types.js';

function model(
  provider: string,
  id: string,
  contextWindow = 1000,
  baseUrl = provider === 'anthropic'
    ? 'https://api.anthropic.com'
    : provider === 'openai-codex'
      ? 'https://chatgpt.com/backend-api'
      : 'https://example.invalid',
): Model<Api> {
  return {
    id,
    name: id,
    api: 'openai-codex-responses',
    provider,
    baseUrl,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 100,
  };
}

function registry(models: readonly Model<Api>[], oauth = true): FusionModelRegistry {
  return {
    getAll: () => [...models],
    getAvailable: () => [...models],
    find: (provider, modelId) =>
      models.find((entry) => entry.provider === provider && entry.id === modelId),
    isUsingOAuth: () => oauth,
  };
}

void describe('fusion model config', () => {
  void it('defaults only when the config file is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-fusion-config-'));
    try {
      const path = join(dir, 'fusion-models.json');
      const loaded = await loadFusionModelConfig(path);
      assert.deepEqual(loaded.config, defaultFusionModelConfig());
      assert.equal(loaded.revision.exists, false);
      await writeFile(path, '{ broken', 'utf8');
      await assert.rejects(loadFusionModelConfig(path), /not valid JSON/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  void it('parses the closed five-slot schema and rejects invalid shapes', () => {
    const valid = {
      schema_version: FUSION_MODEL_CONFIG_SCHEMA_VERSION,
      candidates: [CURRENT_MODEL_SELECTION, 'openai-codex/gpt-5.5', 'anthropic/claude/opus'],
      evaluator: CURRENT_MODEL_SELECTION,
      merger: 'openai-codex/gpt-5.5',
    };
    assert.deepEqual(parseFusionModelConfig(valid), valid);
    assert.throws(() => parseFusionModelConfig({ ...valid, extra: true }), /unknown key extra/);
    assert.throws(
      () => parseFusionModelConfig({ ...valid, candidates: [CURRENT_MODEL_SELECTION] }),
      /exactly three/,
    );
    assert.throws(
      () => parseFusionModelConfig({ ...valid, evaluator: 'gpt-5.5' }),
      /qualified provider\/model/,
    );
    assert.throws(
      () => parseFusionModelConfig({ ...valid, schema_version: 'v0' }),
      /schema_version mismatch/,
    );
  });

  void it('resolves current, duplicate, and slash-containing model keys exactly', () => {
    const current = model('openai-codex', 'gpt-5.5');
    const slash = model('anthropic', 'claude/opus');
    const config = parseFusionModelConfig({
      schema_version: FUSION_MODEL_CONFIG_SCHEMA_VERSION,
      candidates: [CURRENT_MODEL_SELECTION, 'anthropic/claude/opus', 'anthropic/claude/opus'],
      evaluator: CURRENT_MODEL_SELECTION,
      merger: 'anthropic/claude/opus',
    });
    const resolved = resolveFusionModels({
      config,
      modelRegistry: registry([current, slash]),
      currentModel: current,
      thinkingLevel: 'high',
    });
    assert.deepEqual(
      resolved.candidates.map((entry) => entry.qualifiedId),
      ['openai-codex/gpt-5.5', 'anthropic/claude/opus', 'anthropic/claude/opus'],
    );
    assert.equal(resolved.evaluator.source, 'current');
    assert.equal(resolved.merger.model, 'claude/opus');
    assert.equal(resolved.merger.thinkingLevel, 'high');
  });

  void it('caps Anthropic route capacity to the attributed 200K subscription transport', () => {
    const claude = model('anthropic', 'claude-sonnet-4-6', 1_000_000);
    const config = parseFusionModelConfig({
      schema_version: FUSION_MODEL_CONFIG_SCHEMA_VERSION,
      candidates: [
        'anthropic/claude-sonnet-4-6',
        'anthropic/claude-sonnet-4-6',
        'anthropic/claude-sonnet-4-6',
      ],
      evaluator: 'anthropic/claude-sonnet-4-6',
      merger: 'anthropic/claude-sonnet-4-6',
    });
    const resolved = resolveFusionModels({
      config,
      modelRegistry: registry([claude]),
      currentModel: claude,
      thinkingLevel: 'high',
    });
    assert.equal(resolved.candidates[0].contextWindow, 200_000);
    assert.equal(resolved.evaluator.contextWindow, 200_000);
    assert.equal(resolved.merger.contextWindow, 200_000);
  });

  void it('rejects frontier models unless they use a supported subscription OAuth route', () => {
    const codex = model('openai-codex', 'gpt-5.5');
    assert.throws(
      () =>
        resolveFusionModels({
          config: defaultFusionModelConfig(),
          modelRegistry: registry([codex], false),
          currentModel: codex,
          thinkingLevel: 'medium',
        }),
      /not using subscription OAuth/,
    );
    const metered = model('openrouter', 'openai/gpt-5.5');
    assert.throws(
      () =>
        resolveFusionModels({
          config: defaultFusionModelConfig(),
          modelRegistry: registry([metered], true),
          currentModel: metered,
          thinkingLevel: 'medium',
        }),
      /frontier-model API channel/,
    );
    for (const azureModel of ['o1', 'o3', 'o4-mini']) {
      const azure = model('azure-openai-responses', azureModel);
      assert.throws(
        () =>
          resolveFusionModels({
            config: defaultFusionModelConfig(),
            modelRegistry: registry([azure], true),
            currentModel: azure,
            thinkingLevel: 'medium',
          }),
        /frontier-model API channel/,
      );
    }
    const aliasedOModel = model('custom-metered', 'o3-mini');
    assert.throws(
      () =>
        resolveFusionModels({
          config: defaultFusionModelConfig(),
          modelRegistry: registry([aliasedOModel], true),
          currentModel: aliasedOModel,
          thinkingLevel: 'medium',
        }),
      /frontier-model API channel/,
    );
    for (const endpoint of [
      'https://api.openai.com/v1',
      'https://api.anthropic.com',
      'https://openrouter.ai/api/v1',
      'https://chatgpt.com/backend-api',
      'https://tenant.openai.azure.com/openai/v1',
      'https://tenant.cognitiveservices.azure.com/openai/v1',
      'https://tenant.ai.azure.com/openai/v1',
    ]) {
      const endpointAlias = model('custom', 'prod', 1000, endpoint);
      assert.throws(
        () =>
          resolveFusionModels({
            config: defaultFusionModelConfig(),
            modelRegistry: registry([endpointAlias], true),
            currentModel: endpointAlias,
            thinkingLevel: 'medium',
          }),
        /frontier-model API channel/,
      );
    }
  });

  void it('binds subscription OAuth routes to trusted endpoints and provider authentication', () => {
    const redirected = model('openai-codex', 'gpt-5.5', 1000, 'https://example.invalid');
    assert.throws(
      () =>
        resolveFusionModels({
          config: defaultFusionModelConfig(),
          modelRegistry: registry([redirected]),
          currentModel: redirected,
          thinkingLevel: 'medium',
        }),
      /trusted Pi subscription endpoint/,
    );
    const overridden = {
      ...model('anthropic', 'claude-opus-5'),
      headers: { Authorization: 'Bearer direct-credential' },
    };
    assert.throws(
      () =>
        resolveFusionModels({
          config: defaultFusionModelConfig(),
          modelRegistry: registry([overridden]),
          currentModel: overridden,
          thinkingLevel: 'medium',
        }),
      /overrides subscription authentication header/,
    );
    const codex = model('openai-codex', 'gpt-5.5', 1000, 'https://chatgpt.com/backend-api/');
    assert.doesNotThrow(() =>
      resolveFusionModels({
        config: defaultFusionModelConfig(),
        modelRegistry: registry([codex]),
        currentModel: codex,
        thinkingLevel: 'medium',
      }),
    );
  });

  void it('fails loudly for missing current or unavailable configured models', () => {
    const current = model('openai-codex', 'gpt-5.5');
    assert.throws(
      () =>
        resolveFusionModels({
          config: defaultFusionModelConfig(),
          modelRegistry: registry([current]),
          currentModel: undefined,
          thinkingLevel: 'medium',
        }),
      /no current model/,
    );
    const config = parseFusionModelConfig({
      schema_version: FUSION_MODEL_CONFIG_SCHEMA_VERSION,
      candidates: [CURRENT_MODEL_SELECTION, CURRENT_MODEL_SELECTION, CURRENT_MODEL_SELECTION],
      evaluator: CURRENT_MODEL_SELECTION,
      merger: 'anthropic/missing',
    });
    assert.throws(
      () =>
        resolveFusionModels({
          config,
          modelRegistry: registry([current]),
          currentModel: current,
          thinkingLevel: 'medium',
        }),
      /unavailable/,
    );
  });

  void it('saves atomically with a revision guard and private file mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-fusion-config-save-'));
    try {
      const path = join(dir, 'fusion-models.json');
      const loaded = await loadFusionModelConfig(path);
      const next = defaultFusionModelConfig();
      const revision = await saveFusionModelConfig(path, next, loaded.revision);
      assert.equal(revision.exists, true);
      assert.match(await readFile(path, 'utf8'), /fusion-models\.v1/);
      const mode = (await stat(path)).mode & 0o777;
      // Windows has no POSIX permission bits; NTFS ACLs are not modelled here.
      if (process.platform !== 'win32') assert.equal(mode, 0o600);
      await writeFile(path, JSON.stringify(next), 'utf8');
      const conflict = saveFusionModelConfig(path, next, revision);
      await assert.rejects(conflict, (error: unknown) => {
        assert.ok(error instanceof FusionError);
        assert.equal(error.code, 'config_conflict');
        return true;
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  void it('serializes concurrent saves so one stale writer fails instead of replacing the other', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-fusion-config-race-'));
    try {
      const path = join(dir, 'fusion-models.json');
      const loaded = await loadFusionModelConfig(path);
      const first = parseFusionModelConfig({
        ...defaultFusionModelConfig(),
        candidates: ['openai-codex/one', CURRENT_MODEL_SELECTION, CURRENT_MODEL_SELECTION],
      });
      const second = parseFusionModelConfig({
        ...defaultFusionModelConfig(),
        candidates: ['openai-codex/two', CURRENT_MODEL_SELECTION, CURRENT_MODEL_SELECTION],
      });
      const results = await Promise.allSettled([
        saveFusionModelConfig(path, first, loaded.revision),
        saveFusionModelConfig(path, second, loaded.revision),
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      const rejected = results.find((result) => result.status === 'rejected');
      assert.ok(rejected);
      if (rejected.status === 'rejected') {
        assert.ok(rejected.reason instanceof FusionError);
        assert.equal(rejected.reason.code, 'config_conflict');
      }
      const saved = parseFusionModelConfig(parseJsonText(await readFile(path, 'utf8')));
      assert.ok(
        saved.candidates[0] === 'openai-codex/one' || saved.candidates[0] === 'openai-codex/two',
      );
      assert.deepEqual(
        (await readdir(dir)).filter((entry) => entry.endsWith('.lock')),
        [],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
