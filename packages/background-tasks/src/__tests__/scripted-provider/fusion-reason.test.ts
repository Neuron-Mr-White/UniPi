import { afterEach, describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ModelRuntime,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import { parseJsonText } from '../../types.js';
import { installFusionFakePi } from '../helpers/fusion-fake-pi.js';
import { isolatedTestEnv } from '../helpers/normalize.js';

const backgroundTasksExtensionPath = resolve('extensions/background-tasks.ts');
const scriptedProviderPath = resolve('tests/scripted-provider/scripted-provider-extension.ts');
const roots: string[] = [];
const savedEnv = new Map<string, string | undefined>();
const envKeys = [
  'PATH',
  'PI_CODING_AGENT_DIR',
  'UNIPI_BG_SCRIPTED_SCENARIO',
  'UNIPI_BG_SCRIPTED_EVENTS',
  'UNIPI_BG_SCRIPTED_API_KEY',
] as const;

type JsonRecord = Record<string, unknown>;

interface ProviderEvent extends JsonRecord {
  callCount?: number;
  summaries?: string[];
}

interface Harness {
  session: AgentSession;
  eventsPath: string;
  fakeLogPath: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rememberEnv(): void {
  if (savedEnv.size > 0) return;
  for (const key of envKeys) savedEnv.set(key, process.env[key]);
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

function restoreEnv(): void {
  for (const key of envKeys) restoreEnvValue(key, savedEnv.get(key));
  savedEnv.clear();
}

function stringArray(value: unknown): string[] {
  assert.ok(Array.isArray(value), 'value must be an array');
  return value.map((entry) => {
    if (typeof entry !== 'string') throw new Error('entry must be a string');
    return entry;
  });
}

function parseProviderEvent(line: string): ProviderEvent {
  const parsed = parseJsonText(line);
  assert.ok(isRecord(parsed), 'provider event must be an object');
  const event: ProviderEvent = { ...parsed };
  if (parsed['summaries'] !== undefined) event.summaries = stringArray(parsed['summaries']);
  if (typeof parsed['callCount'] === 'number') event.callCount = parsed['callCount'];
  return event;
}

async function providerEvents(path: string): Promise<ProviderEvent[]> {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, 'utf8');
  return raw.trim() ? raw.trim().split('\n').map(parseProviderEvent) : [];
}

async function fakeCallCount(path: string): Promise<number> {
  if (!existsSync(path)) return 0;
  const raw = await readFile(path, 'utf8');
  return raw.trim() ? raw.trim().split('\n').length : 0;
}

async function fakeStages(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, 'utf8');
  if (!raw.trim()) return [];
  return raw
    .trim()
    .split('\n')
    .map((line) => {
      const parsed = parseJsonText(line);
      assert.ok(isRecord(parsed), 'fake invocation must be an object');
      const stage = parsed['stage'];
      if (typeof stage !== 'string') throw new Error('fake invocation stage must be a string');
      return stage;
    });
}

function assistantTexts(session: AgentSession): string[] {
  return session.sessionManager.getEntries().flatMap((entry) => {
    if (!isRecord(entry) || !isRecord(entry['message']) || entry['message']['role'] !== 'assistant')
      return [];
    const content = entry['message']['content'];
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) =>
      isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string'
        ? [part['text']]
        : [],
    );
  });
}

function toolResults(session: AgentSession, toolName: string): JsonRecord[] {
  return session.sessionManager.getEntries().flatMap((entry) => {
    if (!isRecord(entry) || !isRecord(entry['message'])) return [];
    const message = entry['message'];
    if (message['role'] === 'toolResult' && message['toolName'] === toolName) return [message];
    return [];
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function harness(): Promise<Harness> {
  rememberEnv();
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-fusion-scripted-'));
  roots.push(root);
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  const eventsPath = join(root, 'provider-events.jsonl');
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const fake = await installFusionFakePi(root, {
    mergedText: 'Scripted fused answer.',
    invalidFirstEvaluation: true,
  });
  Object.assign(process.env, isolatedTestEnv, {
    PATH: fake.env['PATH'],
    PI_CODING_AGENT_DIR: agentDir,
    UNIPI_BG_SCRIPTED_SCENARIO: 'fusion-reason',
    UNIPI_BG_SCRIPTED_EVENTS: eventsPath,
    UNIPI_BG_SCRIPTED_API_KEY: 'scripted-api-key',
    NPM_CONFIG_CACHE: join(tmpdir(), 'pi-npm-cache'),
  });
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: 'pi-bg-scripted',
    defaultModel: 'scripted-model',
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [scriptedProviderPath, backgroundTasksExtensionPath],
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
  const model = modelRegistry.find('pi-bg-scripted', 'scripted-model');
  assert.ok(model, 'scripted model should be registered');
  await session.setModel(model);
  await session.extensionRunner.emit({ type: 'session_start', reason: 'startup' });
  return { session, eventsPath, fakeLogPath: fake.logPath };
}

async function disposeHarness(h: Harness): Promise<void> {
  try {
    await h.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  } finally {
    h.session.dispose();
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  restoreEnv();
});

void describe('scripted provider fusion_reason integration', { concurrency: false }, () => {
  void it(
    'lets the parent launch Fusion, avoid polling, and consume the verified bg_result after wake',
    { timeout: 15_000 },
    async (t: TestContext) => {
      // This case intercepts the Pi child by placing a fake `pi` on PATH. That
      // cannot work on win32, where production deliberately resolves the Pi
      // package and launches it through Node rather than consulting PATH, and
      // the extension layer exposes no launch seam to redirect it. The same
      // constraint host-gates the equivalent cases in tests/sdk/fusion-sdk.test.ts.
      // Fusion orchestration itself stays covered on Windows by the injected
      // childRunner cases in tests/unit/fusion-orchestrator.test.ts.
      if (process.platform === 'win32') {
        t.skip(
          'fake Pi PATH interception is not applicable on win32 because production resolves the Pi package instead of PATH by design',
        );
        return;
      }
      const h = await harness();
      try {
        await h.session.prompt('Use fusion for this scripted task.');
        await waitFor(
          async () => (await providerEvents(h.eventsPath)).length >= 4,
          'fourth parent provider call after background completion and retrieval',
          15_000,
        );
        await h.session.agent.waitForIdle();
        assert.equal(await fakeCallCount(h.fakeLogPath), 6);
        assert.deepEqual(
          (await fakeStages(h.fakeLogPath)).sort(),
          [
            'candidate',
            'candidate',
            'candidate',
            'evaluation',
            'evaluation-repair',
            'merge',
          ].sort(),
        );

        const events = await providerEvents(h.eventsPath);
        assert.equal(events.length, 4);
        assert.match((events[0]?.summaries ?? []).join('\n'), /user:Use fusion/);
        assert.match(
          (events[1]?.summaries ?? []).join('\n'),
          /toolResult:fusion_reason:Started fusion reason in the background/,
        );
        assert.doesNotMatch(
          (events[1]?.summaries ?? []).join('\n'),
          /toolResult:bg_status|toolResult:bg_logs/,
        );
        assert.match(
          (events[2]?.summaries ?? []).join('\n'),
          /background-task-notification|<task-id>reason-/,
        );
        assert.match(
          (events[3]?.summaries ?? []).join('\n'),
          /toolResult:bg_result:.*Scripted fused answer/s,
        );
        assert.ok(
          assistantTexts(h.session).some((text) =>
            text.includes('Parent observed verified Fusion result'),
          ),
        );

        const launchResults = toolResults(h.session, 'fusion_reason');
        assert.equal(launchResults.length, 1);
        const launchResult = launchResults[0];
        assert.ok(launchResult, 'Fusion launch result should be persisted');
        const launchDetails = launchResult['details'];
        assert.ok(isRecord(launchDetails));
        assert.equal(launchDetails['schema_version'], 'pi-background-tasks.fusion-launch.v1');
        assert.equal(Reflect.get(launchResult, 'usage'), undefined);

        const retrievedResults = toolResults(h.session, 'bg_result');
        assert.equal(retrievedResults.length, 1);
        const retrieved = retrievedResults[0];
        assert.ok(retrieved);
        const content = retrieved['content'];
        assert.ok(Array.isArray(content));
        assert.match(
          String(isRecord(content[0]) ? content[0]['text'] : ''),
          /Scripted fused answer/,
        );
        const details = retrieved['details'];
        assert.ok(isRecord(details));
        assert.equal(details['schema_version'], 'pi-background-tasks.fusion-result-view.v1');
        assert.equal(isRecord(details) ? details['usage_delivered'] : undefined, true);
      } finally {
        await disposeHarness(h);
      }
    },
  );
});
