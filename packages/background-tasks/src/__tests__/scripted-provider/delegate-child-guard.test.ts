import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ModelRuntime,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { isolatedTestEnv } from '../helpers/normalize.js';
import { buildDelegateSeed } from '../../delegate/seed.js';
import { verifyDelegateResultPackage } from '../../delegate/result-package.js';
import { DelegateError, type DelegateLimits, type DelegatePinnedRoute } from '../../delegate/types.js';
import { sessionWith, userMessage } from '../helpers/fusion-canonical.js';

/**
 * Delegate child-guard behaviour proven inside a real Pi agent loop.
 *
 * The guard extension is loaded into a real `AgentSession` driven by a
 * deterministic provider, so spill, budget refusal, route assertion, and the
 * atomic result commit are exercised through the actual hook dispatch path
 * rather than by calling handlers directly.
 */
const guardExtensionPath = resolve('extensions/delegate-child.ts');
const providerPath = resolve('tests/scripted-provider/delegate-guard-provider.ts');

const roots: string[] = [];

const ROUTE: DelegatePinnedRoute = {
  provider: 'pi-bg-delegate',
  model: 'delegate-model',
  qualified_id: 'pi-bg-delegate/delegate-model',
  context_window_tokens: 200_000,
  thinking_level: 'medium',
  origin: 'parent_current',
};

function limits(overrides: Partial<DelegateLimits> = {}): DelegateLimits {
  return {
    max_turns: 8,
    max_tool_calls: 20,
    timeout_seconds: 60,
    max_tool_result_bytes: 1024,
    max_total_tool_output_bytes: 8 * 1024 * 1024,
    max_answer_bytes: 4_194_304,
    allowed_input_tokens: 171_712,
    ...overrides,
  };
}

interface Harness {
  session: Awaited<ReturnType<typeof createAgentSession>>['session'];
  artifactDir: string;
  seedSha256: string;
  taskId: string;
  launchNonce: string;
  restore: () => void;
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

interface HarnessOptions {
  scenario: string;
  limits?: DelegateLimits | undefined;
  route?: DelegatePinnedRoute | undefined;
  directive?: string | undefined;
}

async function harness(options: HarnessOptions): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-delegate-guard-'));
  roots.push(root);
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  const artifactDir = join(root, 'artifacts');
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(artifactDir, 'spill'), { recursive: true });

  const taskId = 'd0123456789abcdef0123456789abcdef';
  const launchNonce = 'ffeeddccbbaa99887766554433221100';
  const route = options.route ?? ROUTE;
  const built = buildDelegateSeed(
    {
      cwd,
      sessionManager: sessionWith([userMessage('parent history line')]),
      getSystemPrompt: () => 'parent system prompt',
    },
    {
      taskId,
      launchNonce,
      toolCallId: 'delegate-call-1',
      directive: options.directive ?? 'investigate the thing',
      capability: 'inspect',
      extensionMode: 'isolated',
      route,
      limits: options.limits ?? limits(),
    },
  );
  const seedPath = join(artifactDir, 'seed.json');
  await writeFile(seedPath, built.serialized, 'utf8');

  const previous = {
    scenario: process.env['UNIPI_BG_DELEGATE_SCENARIO'],
    dir: process.env['UNIPI_BG_DELEGATE_ARTIFACT_DIR'],
    seed: process.env['UNIPI_BG_DELEGATE_SEED_PATH'],
    sha: process.env['UNIPI_BG_DELEGATE_SEED_SHA256'],
    task: process.env['UNIPI_BG_DELEGATE_TASK_ID'],
    nonce: process.env['UNIPI_BG_DELEGATE_LAUNCH_NONCE'],
    apiKey: process.env['UNIPI_BG_DELEGATE_API_KEY'],
  };
  Object.assign(process.env, isolatedTestEnv, {
    UNIPI_BG_DELEGATE_SCENARIO: options.scenario,
    UNIPI_BG_DELEGATE_ARTIFACT_DIR: artifactDir,
    UNIPI_BG_DELEGATE_SEED_PATH: seedPath,
    UNIPI_BG_DELEGATE_SEED_SHA256: built.sha256,
    UNIPI_BG_DELEGATE_TASK_ID: taskId,
    UNIPI_BG_DELEGATE_LAUNCH_NONCE: launchNonce,
    UNIPI_BG_DELEGATE_API_KEY: 'delegate-api-key',
  });

  const settingsManager = SettingsManager.inMemory({
    defaultProvider: 'pi-bg-delegate',
    defaultModel: 'delegate-model',
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [providerPath, guardExtensionPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    noThemes: true,
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
  });
  const modelRegistry = new ModelRegistry(modelRuntime);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    modelRuntime,
    noTools: 'builtin',
  });
  const model = modelRegistry.find('pi-bg-delegate', 'delegate-model');
  assert.ok(model, 'delegate guard provider model must be registered');
  await session.setModel(model);

  return {
    session,
    artifactDir,
    seedSha256: built.sha256,
    taskId,
    launchNonce,
    restore: () => {
      restoreEnvValue('UNIPI_BG_DELEGATE_SCENARIO', previous.scenario);
      restoreEnvValue('UNIPI_BG_DELEGATE_ARTIFACT_DIR', previous.dir);
      restoreEnvValue('UNIPI_BG_DELEGATE_SEED_PATH', previous.seed);
      restoreEnvValue('UNIPI_BG_DELEGATE_SEED_SHA256', previous.sha);
      restoreEnvValue('UNIPI_BG_DELEGATE_TASK_ID', previous.task);
      restoreEnvValue('UNIPI_BG_DELEGATE_LAUNCH_NONCE', previous.nonce);
      restoreEnvValue('UNIPI_BG_DELEGATE_API_KEY', previous.apiKey);
    },
  };
}

async function dispose(h: Harness): Promise<void> {
  try {
    await h.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  } finally {
    h.session.dispose();
    h.restore();
  }
}

async function readResult(h: Harness) {
  const raw = await readFile(join(h.artifactDir, 'result.json'), 'utf8');
  return verifyDelegateResultPackage(raw, {
    taskId: h.taskId,
    launchNonce: h.launchNonce,
    seedSha256: h.seedSha256,
    route: { provider: ROUTE.provider, model: ROUTE.model },
  });
}

async function readTerminal(h: Harness): Promise<Record<string, unknown>> {
  const raw = await readFile(join(h.artifactDir, 'child-terminal.json'), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  assert.ok(typeof parsed === 'object' && parsed !== null);
  return parsed as Record<string, unknown>;
}

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

void describe('delegate child guard in a real agent loop', { concurrency: false }, () => {
  void it('commits exactly one verified result package for a clean run', { timeout: 20_000 }, async () => {
    const h = await harness({ scenario: 'plain-answer' });
    try {
      await h.session.prompt('do the work');
      await h.session.agent.waitForIdle();
      const verified = await readResult(h);
      assert.equal(verified.answer, 'DELEGATE_FINAL_ANSWER');
      assert.equal(verified.package.task_id, h.taskId);
      assert.equal(verified.package.seed_sha256, h.seedSha256);
      assert.equal(verified.package.route.provider, ROUTE.provider);
      assert.ok(verified.package.route_attestations.length > 0);
      assert.ok(!existsSync(join(h.artifactDir, 'child-terminal.json')));
    } finally {
      await dispose(h);
    }
  });

  void it(
    'spills a 2 MB tool result to a hashed artifact and keeps the payload out of the transcript',
    { timeout: 30_000 },
    async () => {
      const h = await harness({ scenario: 'huge-tool-result' });
      try {
        await h.session.prompt('read the big thing');
        await h.session.agent.waitForIdle();

        const spills = await readdir(join(h.artifactDir, 'spill'));
        assert.equal(spills.length, 1, 'exactly one spill artifact must exist');
        const spillName = spills[0];
        assert.ok(spillName);
        const spilled = await readFile(join(h.artifactDir, 'spill', spillName));
        assert.equal(spilled.length, 2 * 1024 * 1024, 'the complete payload must be preserved');

        const verified = await readResult(h);
        assert.equal(verified.package.spilled_artifacts.length, 1);
        const receipt = verified.package.spilled_artifacts[0];
        assert.ok(receipt);
        assert.equal(receipt.byte_length, 2 * 1024 * 1024);
        assert.equal(receipt.tool_name, 'guard_probe');

        // The raw payload must never have entered the transcript.
        const entries: readonly unknown[] = h.session.sessionManager.getEntries();
        const serialized = JSON.stringify(entries);
        // Distinguish precisely: the marker legitimately appears in the
        // assistant's own tool-call arguments (the model wrote it). What must
        // never appear is the oversized payload inside a toolResult message.
        const toolResultText = entries
          .flatMap((entry) => {
            if (typeof entry !== 'object' || entry === null) return [];
            if (Reflect.get(entry, 'type') !== 'message') return [];
            const message = Reflect.get(entry, 'message');
            if (typeof message !== 'object' || message === null) return [];
            if (Reflect.get(message, 'role') !== 'toolResult') return [];
            const content = Reflect.get(message, 'content');
            if (!Array.isArray(content)) return [];
            return content.flatMap((part) =>
              typeof part === 'object' && part !== null && typeof Reflect.get(part, 'text') === 'string'
                ? [String(Reflect.get(part, 'text'))]
                : [],
            );
          })
          .join('\n');
        assert.ok(
          !toolResultText.includes('HUGEPAYLOAD'),
          'the raw oversized payload must never reach the transcript as a tool result',
        );
        assert.ok(
          toolResultText.length < 4096,
          `the replaced tool result must be a compact receipt, not the payload (was ${String(toolResultText.length)} bytes)`,
        );
        assert.ok(
          serialized.includes('[delegate spill receipt]'),
          'the transcript must carry an explicit receipt instead',
        );
        assert.ok(serialized.includes(receipt.sha256), 'the receipt must name the payload hash');
        assert.ok(
          serialized.includes('Nothing was truncated'),
          'the receipt must state that nothing was truncated',
        );
      } finally {
        await dispose(h);
      }
    },
  );

  void it(
    'preserves image-bearing tool results in a hashed structured spill',
    { timeout: 30_000 },
    async () => {
      const h = await harness({ scenario: 'image-tool-result' });
      try {
        await h.session.prompt('inspect the image result and answer');
        await h.session.agent.waitForIdle();
        const verified = await readResult(h);
        assert.equal(verified.answer, 'DELEGATE_FINAL_ANSWER');
        assert.equal(verified.package.spilled_artifacts.length, 1);
        const receipt = verified.package.spilled_artifacts[0];
        assert.ok(receipt);
        assert.equal(receipt.content_format, 'tool_result_content_json_v1');
        const raw = await readFile(join(h.artifactDir, receipt.artifact), 'utf8');
        const envelope = JSON.parse(raw) as Record<string, unknown>;
        assert.equal(
          envelope['schema_version'],
          'pi-background-tasks.delegate-tool-result-content.v1',
        );
        const content = envelope['content'];
        assert.ok(Array.isArray(content));
        assert.equal(content.length, 2);
        const image = content[1];
        assert.ok(typeof image === 'object' && image !== null);
        assert.equal(Reflect.get(image, 'type'), 'image');
        assert.equal(Reflect.get(image, 'mimeType'), 'image/png');
        const data = Reflect.get(image, 'data');
        assert.equal(typeof data, 'string');
        assert.equal(
          Buffer.from(data, 'base64').toString('utf8'),
          'IMAGE_SENTINEL_BYTES'.repeat(256),
        );
      } finally {
        await dispose(h);
      }
    },
  );

  void it(
    'rejects malformed Unicode tool text instead of hashing substituted bytes',
    { timeout: 20_000 },
    async () => {
      const h = await harness({ scenario: 'invalid-unicode-tool-result' });
      try {
        await h.session.prompt('exercise malformed Unicode handling');
        await h.session.agent.waitForIdle();
        assert.ok(!existsSync(join(h.artifactDir, 'result.json')));
        const terminal = await readTerminal(h);
        assert.equal(terminal['code'], 'artifact_spill_failed');
        assert.match(String(terminal['message']), /without substitution/);
      } finally {
        await dispose(h);
      }
    },
  );

  void it(
    'commits only final clean-stop text and excludes intermediate tool-use narration',
    { timeout: 20_000 },
    async () => {
      const h = await harness({ scenario: 'intermediate-narration' });
      try {
        await h.session.prompt('investigate before answering');
        await h.session.agent.waitForIdle();
        const verified = await readResult(h);
        assert.equal(verified.answer, 'DELEGATE_FINAL_ANSWER');
        assert.equal(verified.package.usage.status, 'observed');
        if (verified.package.usage.status === 'observed') {
          assert.equal(verified.package.usage.usage.input, 24);
          assert.equal(verified.package.usage.usage.output, 12);
          assert.equal(verified.package.usage.usage.totalTokens, 36);
          assert.equal(verified.package.usage.usage.cost.total, 0.006);
        }
        assert.ok(
          JSON.stringify(h.session.sessionManager.getEntries()).includes(
            'INTERMEDIATE_NARRATION_MUST_NOT_BE_COMMITTED',
          ),
          'intermediate narration should remain available in the transcript',
        );
      } finally {
        await dispose(h);
      }
    },
  );

  void it(
    'does not repeat Fusion BUG-185 by aborting a live request from an advisory token estimate',
    { timeout: 20_000 },
    async () => {
      // A one-token advisory allowance guarantees the estimate is over. The
      // package must request graceful finalization and let Pi/provider capacity
      // handling proceed rather than self-reporting provider exhaustion.
      const h = await harness({
        scenario: 'plain-answer',
        limits: limits({ allowed_input_tokens: 1 }),
      });
      try {
        await h.session.prompt('this estimate is deliberately over its advisory allowance');
        await h.session.agent.waitForIdle();
        const verified = await readResult(h);
        assert.equal(verified.answer, 'DELEGATE_FINAL_ANSWER');
        assert.ok(!existsSync(join(h.artifactDir, 'child-terminal.json')));
        const runtime = JSON.parse(
          await readFile(join(h.artifactDir, 'runtime-budget.json'), 'utf8'),
        ) as Record<string, unknown>;
        assert.equal(runtime['finalization_requested'], true);
      } finally {
        await dispose(h);
      }
    },
  );

  void it(
    'spills repeated sub-64-KiB results against route runway and still completes',
    { timeout: 30_000 },
    async () => {
      const h = await harness({
        scenario: 'subthreshold-growth',
        limits: limits({
          allowed_input_tokens: 120_000,
          max_turns: 12,
          max_tool_result_bytes: 64 * 1024,
        }),
      });
      try {
        await h.session.prompt('perform the repeated reads and then answer');
        await h.session.agent.waitForIdle();
        const verified = await readResult(h);
        assert.equal(verified.answer, 'DELEGATE_FINAL_ANSWER');
        assert.equal(verified.package.tool_calls, 8);
        assert.ok(
          verified.package.spilled_artifacts.length > 0,
          'route pressure must spill results that are individually below 64 KiB',
        );
        assert.ok(
          verified.package.spilled_artifacts.every((receipt) => receipt.byte_length === 32 * 1024),
        );
        const runtime = JSON.parse(
          await readFile(join(h.artifactDir, 'runtime-budget.json'), 'utf8'),
        ) as Record<string, unknown>;
        assert.ok(Number(runtime['context_pressure_spill_bytes']) > 0);
        assert.ok(Number(runtime['retained_tool_result_bytes']) < 8 * 32 * 1024);
      } finally {
        await dispose(h);
      }
    },
  );

  void it(
    'returns exactly the requested artifact range and refuses a short read',
    { timeout: 30_000 },
    async () => {
      const h = await harness({ scenario: 'spill-then-read' });
      try {
        await h.session.prompt('read a range from the spill');
        await h.session.agent.waitForIdle();
        const entries: readonly unknown[] = h.session.sessionManager.getEntries();
        const serialized = JSON.stringify(entries);
        assert.ok(
          serialized.includes('UkFOR0VNQVJLRVI='),
          'the exact requested range must be returned as lossless base64',
        );
        assert.ok(
          serialized.includes('refused rather than silently shortened'),
          'an over-long range read must fail loudly rather than return a short read',
        );
      } finally {
        await dispose(h);
      }
    },
  );

  void it(
    'preserves a byte range that splits a multibyte UTF-8 sequence',
    { timeout: 30_000 },
    async () => {
      const h = await harness({
        scenario: 'split-utf8-range',
        limits: limits({ max_tool_result_bytes: 512 }),
      });
      try {
        await h.session.prompt('read exactly the second byte of the first UTF-8 sequence');
        await h.session.agent.waitForIdle();
        const serialized = JSON.stringify(h.session.sessionManager.getEntries());
        assert.ok(
          serialized.includes('qQ=='),
          'the isolated 0xA9 continuation byte must survive as exact base64',
        );
        assert.ok(!serialized.includes('�'), 'the exact byte must never become U+FFFD');
        const verified = await readResult(h);
        assert.equal(verified.answer, 'DELEGATE_FINAL_ANSWER');
      } finally {
        await dispose(h);
      }
    },
  );

  void it(
    'refuses to commit a success package when the observed route does not match the pin',
    { timeout: 20_000 },
    async () => {
      const h = await harness({ scenario: 'route-drift' });
      try {
        await h.session.prompt('answer from a drifted route');
        await h.session.agent.waitForIdle();
        assert.ok(
          !existsSync(join(h.artifactDir, 'result.json')),
          'a route mismatch must never produce a committed answer',
        );
        const terminal = await readTerminal(h);
        assert.equal(terminal['code'], 'route_mismatch');
      } finally {
        await dispose(h);
      }
    },
  );

  void it('enforces the turn limit with a typed terminal record', { timeout: 30_000 }, async () => {
    const h = await harness({ scenario: 'many-turns', limits: limits({ max_turns: 2 }) });
    try {
      await h.session.prompt('loop a few times');
      await h.session.agent.waitForIdle();
      assert.ok(!existsSync(join(h.artifactDir, 'result.json')));
      const terminal = await readTerminal(h);
      assert.equal(terminal['code'], 'child_turn_limit');
    } finally {
      await dispose(h);
    }
  });

  void it(
    'never commits an answer truncated by the output-token limit',
    { timeout: 20_000 },
    async () => {
      const h = await harness({ scenario: 'truncated-answer' });
      try {
        await h.session.prompt('produce a truncated answer');
        await h.session.agent.waitForIdle();
        // The bytes are intact and would hash correctly. They are still an
        // incomplete answer, so they must not be committed as a result.
        assert.ok(
          !existsSync(join(h.artifactDir, 'result.json')),
          'a length-truncated response must never be committed as a complete answer',
        );
        const terminal = await readTerminal(h);
        assert.equal(terminal['code'], 'child_model_output_limit');
        assert.match(String(terminal['message']), /incomplete/);
      } finally {
        await dispose(h);
      }
    },
  );

  void it('enforces the declared answer capture contract without committing a prefix', { timeout: 20_000 }, async () => {
    const h = await harness({
      scenario: 'plain-answer',
      limits: limits({ max_answer_bytes: 8 }),
    });
    try {
      await h.session.prompt('produce an answer larger than the test capture contract');
      await h.session.agent.waitForIdle();
      assert.ok(!existsSync(join(h.artifactDir, 'result.json')));
      const terminal = await readTerminal(h);
      assert.equal(terminal['code'], 'child_capture_limit');
      assert.match(String(terminal['message']), /no prefix is committed/);
    } finally {
      await dispose(h);
    }
  });

  void it('never commits a whitespace-only answer', { timeout: 20_000 }, async () => {
    const h = await harness({ scenario: 'whitespace-answer' });
    try {
      await h.session.prompt('produce nothing useful');
      await h.session.agent.waitForIdle();
      assert.ok(!existsSync(join(h.artifactDir, 'result.json')));
      const terminal = await readTerminal(h);
      assert.equal(terminal['code'], 'child_result_invalid');
    } finally {
      await dispose(h);
    }
  });

  void it(
    'turns zero advisory runway into a no-tool finalization rather than a false context failure',
    { timeout: 20_000 },
    async () => {
      const h = await harness({
        scenario: 'guard-throw',
        limits: limits({ allowed_input_tokens: 0 }),
      });
      try {
        await h.session.prompt('finalize without treating an estimate as provider truth');
        await h.session.agent.waitForIdle();
        const verified = await readResult(h);
        assert.equal(verified.answer, 'GUARD_THROW_SENTINEL_ANSWER');
        assert.ok(!existsSync(join(h.artifactDir, 'child-terminal.json')));
      } finally {
        await dispose(h);
      }
    },
  );

  void it(
    'refuses a tampered seed at guard load rather than running on it',
    { timeout: 20_000 },
    async () => {
      const h = await harness({ scenario: 'plain-answer' });
      try {
        const seedPath = process.env['UNIPI_BG_DELEGATE_SEED_PATH'];
        assert.ok(seedPath);
        const original = await readFile(seedPath, 'utf8');
        const tampered = original.replace('parent history line', 'tampered history!!');
        assert.notEqual(tampered, original, 'the tamper must actually change the bytes');
        await writeFile(seedPath, tampered, 'utf8');
        const { verifyDelegateSeedBytes } = await import('../../src/core/delegate/seed.js');
        const onDisk = await readFile(seedPath, 'utf8');
        assert.throws(
          () =>
            verifyDelegateSeedBytes(onDisk, {
              sha256: h.seedSha256,
              taskId: h.taskId,
              launchNonce: h.launchNonce,
            }),
          (error: unknown) => error instanceof DelegateError && error.code === 'seed_hash_mismatch',
        );
      } finally {
        await dispose(h);
      }
    },
  );
});
