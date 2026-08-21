import { afterEach, describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import type { AssistantMessage, UserMessage } from '@earendil-works/pi-ai';
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  Theme,
  type AgentSession,
  type ExtensionUIContext,
  type KeybindingsManager,
} from '@earendil-works/pi-coding-agent';
import type { Component, TUI } from '@earendil-works/pi-tui';
import { parseJsonText } from '../types.js';
import { resolvePiLaunch } from '../pi-launch.js';
import { CURRENT_MODEL_SELECTION, FUSION_MODEL_CONFIG_FILE } from '../fusion/config.js';
import {
  FUSION_INPUT_SCHEMA_VERSION,
  FUSION_LEGACY_RESULT_SCHEMA_VERSION,
  FUSION_RESULT_SCHEMA_VERSION,
  type FusionResultDetails,
} from '../fusion/types.js';
import { installFusionFakePi } from './helpers/fusion-fake-pi.js';
import { isolatedTestEnv, stripAnsi } from './helpers/normalize.js';

const backgroundTasksExtensionPath = resolve('src/index.ts');
const roots: string[] = [];
const savedEnv = new Map<string, string | undefined>();
const envKeys = [
  'PATH',
  'PI_CODING_AGENT_DIR',
  'UNIPI_BG_FUSION_TEST_KEY',
  'PI_SESSION_ID',
  'PI_PROVIDER',
  'PI_MODEL',
] as const;

type JsonRecord = Record<string, unknown>;

interface FusionFakeInvocation {
  stage: string;
  workflow: string;
  provider: string;
  model: string;
  args: string[];
  stdin: string;
  env: {
    PI_SESSION_ID: string | null;
    PI_PROVIDER: string | null;
    PI_MODEL: string | null;
    PI_SKIP_VERSION_CHECK: string | null;
  };
}

interface Harness {
  session: AgentSession;
  cwd: string;
  root: string;
  agentDir: string;
  fakeLogPath: string;
}

interface HarnessOptions {
  fakeDelayMs?: number | undefined;
  fakeFailStage?: 'candidate' | 'evaluation' | 'evaluation-repair' | 'merge' | undefined;
}

function skipWin32FusionChildPathFixture(t: TestContext): boolean {
  if (process.platform !== 'win32') return false;
  t.skip(
    'PATH-based fake Pi child interception is not applicable on win32 because production resolves the Pi package instead of PATH by design',
  );
  return true;
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

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value;
}

function stringArray(value: unknown): string[] {
  assert.ok(Array.isArray(value), 'expected string array');
  return value.map((entry) => {
    if (typeof entry !== 'string') throw new Error('array entry must be a string');
    return entry;
  });
}

function parseInvocation(line: string): FusionFakeInvocation {
  const parsed = parseJsonText(line);
  assert.ok(isRecord(parsed), 'fake invocation must be an object');
  const env = parsed['env'];
  assert.ok(isRecord(env), 'fake invocation env must be an object');
  return {
    stage: stringField(parsed, 'stage'),
    workflow: stringField(parsed, 'workflow'),
    provider: stringField(parsed, 'provider'),
    model: stringField(parsed, 'model'),
    args: stringArray(parsed['args']),
    stdin: stringField(parsed, 'stdin'),
    env: {
      PI_SESSION_ID: env['PI_SESSION_ID'] === null ? null : stringField(env, 'PI_SESSION_ID'),
      PI_PROVIDER: env['PI_PROVIDER'] === null ? null : stringField(env, 'PI_PROVIDER'),
      PI_MODEL: env['PI_MODEL'] === null ? null : stringField(env, 'PI_MODEL'),
      PI_SKIP_VERSION_CHECK:
        env['PI_SKIP_VERSION_CHECK'] === null ? null : stringField(env, 'PI_SKIP_VERSION_CHECK'),
    },
  };
}

async function invocations(path: string): Promise<FusionFakeInvocation[]> {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, 'utf8');
  return raw.trim() ? raw.trim().split('\n').map(parseInvocation) : [];
}

async function waitForInvocationCount(path: string, minimum: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if ((await invocations(path)).length >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${String(minimum)} fusion child calls`);
}

function isFusionResultDetails(value: unknown): value is FusionResultDetails {
  return (
    isRecord(value) &&
    value['schema_version'] === FUSION_RESULT_SCHEMA_VERSION &&
    typeof value['run_id'] === 'string'
  );
}

function isFusionLaunchDetails(value: unknown): value is JsonRecord {
  return (
    isRecord(value) &&
    value['schema_version'] === 'pi-background-tasks.fusion-launch.v1' &&
    typeof value['run_id'] === 'string' &&
    isRecord(value['task'])
  );
}

async function waitForFusionTerminal(session: AgentSession, taskId?: string): Promise<JsonRecord> {
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    const found = customEntries(session, 'background-task-notification').find((entry) => {
      const details = entry['details'];
      return (
        isRecord(details) &&
        details['status'] !== 'running' &&
        isRecord(details['fusion']) &&
        (taskId === undefined || details['id'] === taskId)
      );
    });
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for Fusion task ${taskId ?? '(unspecified)'}`);
}

async function retrieveFusionLaunch(h: Harness, launch: { details?: unknown }) {
  assert.ok(
    isFusionLaunchDetails(launch.details),
    'Fusion tool must return a background launch receipt',
  );
  const task = launch.details['task'];
  assert.ok(isRecord(task));
  const taskId = stringField(task, 'id');
  await waitForFusionTerminal(h.session, taskId);
  const resultTool = h.session.getToolDefinition('bg_result');
  assert.ok(resultTool, 'bg_result should be registered');
  const result = await resultTool.execute(
    `result-${taskId}`,
    { taskId, delivery: 'inline' },
    undefined,
    undefined,
    h.session.extensionRunner.createContext(),
  );
  return { result, launchDetails: launch.details };
}

async function committedDetails(h: Harness, launchDetails: unknown): Promise<FusionResultDetails> {
  assert.ok(isFusionLaunchDetails(launchDetails));
  const artifactDir = stringField(launchDetails, 'artifact_dir');
  // OUR artifact_dir is absolute (temp root); only join when relative.
  const resultPath = isAbsolute(artifactDir) ? join(artifactDir, 'result.json') : join(h.cwd, artifactDir, 'result.json');
  const committed = parseJsonText(await readFile(resultPath, 'utf8'));
  assert.ok(isRecord(committed));
  const details = committed['details'];
  assert.ok(isFusionResultDetails(details));
  return details;
}

function customEntries(session: AgentSession, customType: string): JsonRecord[] {
  const entries: readonly unknown[] = session.sessionManager.getEntries();
  return entries.filter((entry): entry is JsonRecord => {
    return (
      isRecord(entry) && entry['type'] === 'custom_message' && entry['customType'] === customType
    );
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fusionArtifactText(cwd: string, artifactDir: string): Promise<Map<string, string>> {
  const root = join(cwd, artifactDir);
  const files = await readdir(root);
  const out = new Map<string, string>();
  for (const file of files) out.set(file, await readFile(join(root, file), 'utf8'));
  return out;
}

async function assertCleanArtifactBoundary(
  cwd: string,
  details: FusionResultDetails,
  sentinel: string,
): Promise<void> {
  const artifacts = await fusionArtifactText(cwd, details.artifact_dir);
  assert.equal(
    artifacts.has('context-omission-ledger.json'),
    false,
    'clean runs must not write a parent omission ledger',
  );
  assert.ok(artifacts.has('canonical-input.json'), 'clean runs must persist canonical input');
  assert.ok(artifacts.has('budget-plan.json'), 'clean runs must persist budget plan');
  assert.ok(artifacts.has('manifest.json'), 'clean runs must persist manifest');
  assert.ok(artifacts.has('merged.md'), 'clean runs must persist merged output');
  const manifest = parseJsonText(artifacts.get('manifest.json') ?? '');
  assert.ok(isRecord(manifest), 'manifest must be an object');
  assert.equal(manifest['run_id'], details.run_id);
  assert.equal(manifest['workflow'], details.workflow);
  const context = manifest['context'];
  assert.ok(isRecord(context), 'manifest context must be an object');
  assert.equal(context['kind'], 'clean_task');
  assert.equal(context['ledger_artifact'], undefined);
  const canonical = parseJsonText(artifacts.get('canonical-input.json') ?? '');
  assert.ok(isRecord(canonical), 'canonical input must be an object');
  assert.equal(canonical['schema_version'], FUSION_INPUT_SCHEMA_VERSION);
  assert.equal(canonical['workflow'], details.workflow);
  assert.equal(canonical['system_prompt'], undefined);
  assert.equal(canonical['conversation_projection'], undefined);
  assert.equal(canonical['context_omission_ledger'], undefined);
  const canonicalContext = canonical['context'];
  assert.ok(isRecord(canonicalContext), 'canonical context must be an object');
  assert.equal(canonicalContext['kind'], 'clean_task');
  const forbidden = new RegExp(escapeRegExp(sentinel));
  for (const [file, text] of artifacts) {
    assert.doesNotMatch(text, forbidden, `${file} must not contain parent sentinel`);
  }
}

function assistantMessageCount(session: AgentSession): number {
  return session.sessionManager.getEntries().filter((entry) => {
    return (
      isRecord(entry) && isRecord(entry['message']) && entry['message']['role'] === 'assistant'
    );
  }).length;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  rememberEnv();
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-fusion-sdk-'));
  roots.push(root);
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  process.env['UNIPI_BG_FUSION_TEST_KEY'] = 'test-key';
  process.env['PI_SESSION_ID'] = 'stale-session';
  process.env['PI_PROVIDER'] = 'stale-provider';
  process.env['PI_MODEL'] = 'stale-model';
  Object.assign(process.env, isolatedTestEnv);
  const fake = await installFusionFakePi(root, {
    mergedText: 'SDK fused answer.',
    delayMs: options.fakeDelayMs,
    failStage: options.fakeFailStage,
  });
  process.env['PATH'] = fake.env['PATH'];
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: 'pi-bg-fusion',
    defaultModel: 'current-model',
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [backgroundTasksExtensionPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    noThemes: true,
  });
  await loader.reload();
  const authStorage = AuthStorage.create(join(agentDir, 'auth.json'));
  const modelRegistry = ModelRegistry.create(authStorage, undefined);
  modelRegistry.registerProvider('pi-bg-fusion', {
    name: 'Fusion SDK Provider',
    baseUrl: 'https://example.invalid',
    apiKey: 'UNIPI_BG_FUSION_TEST_KEY',
    api: 'openai-responses',
    models: [
      {
        id: 'current-model',
        name: 'Current Model',
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 272000,
        maxTokens: 4096,
      },
      {
        id: 'alt-model',
        name: 'Alt Model',
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 272000,
        maxTokens: 4096,
      },
    ],
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    authStorage,
    modelRegistry,
    noTools: 'builtin',
  });
  const model = modelRegistry.find('pi-bg-fusion', 'current-model');
  assert.ok(model, 'fusion model should exist');
  await session.setModel(model);
  assert.equal(session.model?.provider, 'pi-bg-fusion');
  assert.equal(session.model?.id, 'current-model');
  session.setThinkingLevel('low');
  await session.extensionRunner.emit({ type: 'session_start', reason: 'startup' });
  return { session, cwd, root, agentDir, fakeLogPath: fake.logPath };
}

async function disposeHarness(h: Harness): Promise<void> {
  try {
    await h.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  } finally {
    h.session.dispose();
  }
}

function command(session: AgentSession, name: string) {
  const found = session.extensionRunner
    .getRegisteredCommands()
    .find((cmd) => cmd.invocationName === name);
  assert.ok(found, `missing command ${name}`);
  return found;
}

function commandContext(session: AgentSession, mode?: string) {
  const ctx = session.extensionRunner.createCommandContext();
  if (mode !== undefined) Object.defineProperty(ctx, 'mode', { value: mode, configurable: true });
  return ctx;
}

function baseUi(session: AgentSession): ExtensionUIContext {
  return session.extensionRunner.getUIContext();
}

function makeTheme(): Theme {
  return new Theme(
    {
      accent: '#ffffff',
      border: '#ffffff',
      borderAccent: '#ffffff',
      borderMuted: '#ffffff',
      success: '#ffffff',
      error: '#ffffff',
      warning: '#ffffff',
      muted: '#ffffff',
      dim: '#ffffff',
      text: '#ffffff',
      thinkingText: '#ffffff',
      userMessageText: '#ffffff',
      customMessageText: '#ffffff',
      customMessageLabel: '#ffffff',
      toolTitle: '#ffffff',
      toolOutput: '#ffffff',
      mdHeading: '#ffffff',
      mdLink: '#ffffff',
      mdLinkUrl: '#ffffff',
      mdCode: '#ffffff',
      mdCodeBlock: '#ffffff',
      mdCodeBlockBorder: '#ffffff',
      mdQuote: '#ffffff',
      mdQuoteBorder: '#ffffff',
      mdHr: '#ffffff',
      mdListBullet: '#ffffff',
      toolDiffAdded: '#ffffff',
      toolDiffRemoved: '#ffffff',
      toolDiffContext: '#ffffff',
      syntaxComment: '#ffffff',
      syntaxKeyword: '#ffffff',
      syntaxFunction: '#ffffff',
      syntaxVariable: '#ffffff',
      syntaxString: '#ffffff',
      syntaxNumber: '#ffffff',
      syntaxType: '#ffffff',
      syntaxOperator: '#ffffff',
      syntaxPunctuation: '#ffffff',
      thinkingOff: '#ffffff',
      thinkingMinimal: '#ffffff',
      thinkingLow: '#ffffff',
      thinkingMedium: '#ffffff',
      thinkingHigh: '#ffffff',
      thinkingXhigh: '#ffffff',
      bashMode: '#ffffff',
    },
    {
      selectedBg: '#000000',
      userMessageBg: '#000000',
      customMessageBg: '#000000',
      toolPendingBg: '#000000',
      toolSuccessBg: '#000000',
      toolErrorBg: '#000000',
    },
    'truecolor',
  );
}

function fakeTui(): TUI {
  return { requestRender: () => undefined } as TUI;
}

function fakeKeybindings(): KeybindingsManager {
  return {} as KeybindingsManager;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  restoreEnv();
});

void describe('fusion SDK integration', { concurrency: false }, () => {
  void it('builds a fake Pi package accepted by the win32 launch resolver', async () => {
    rememberEnv();
    const root = await mkdtemp(join(tmpdir(), 'pi-bg-fusion-launch-'));
    roots.push(root);
    const fake = await installFusionFakePi(root);
    const launch = resolvePiLaunch({
      platform: 'win32',
      resolvePackageJson: fake.resolvePackageJson,
      execPath: process.execPath,
    });
    assert.equal(launch.executable, process.execPath);
    // The expected value must be resolved with the same function the resolver
    // uses. On Windows the synchronous and promise-based realpath implementations
    // disagree about 8.3 short names: one preserves a component such as RUNNER~1
    // while the other expands it to its long form.
    assert.deepEqual(launch.argvPrefix, [realpathSync(fake.packageCliPath)]);
    assert.equal(launch.kind, 'package-node-cli');
    assert.equal((await readFile(fake.packageCliPath, 'utf8')).startsWith('#!'), false);
  });

  void it('registers real public surfaces and /fusion launches a tracked background run', async (t) => {
    if (skipWin32FusionChildPathFixture(t)) return;
    const h = await harness();
    try {
      const activeTools = h.session.getActiveToolNames();
      assert.ok(!activeTools.includes('fusion_brainstorm'));
      for (const name of [
        'fusion_reason',
        'fusion_investigate',
        'fusion_research',
        'fusion_validate',
      ]) {
        assert.ok(activeTools.includes(name), `${name} should be active`);
      }
      const fusionTool = h.session.getToolDefinition('fusion_reason');
      assert.ok(fusionTool);
      assert.equal(Reflect.get(fusionTool.parameters, 'additionalProperties'), false);
      assert.ok(fusionTool.prepareArguments);
      assert.throws(
        () => fusionTool.prepareArguments?.({ prompt: 'x', capability: 'reason' }),
        /unsupported key\(s\): capability/,
      );
      assert.deepEqual(fusionTool.prepareArguments?.({ prompt: 'x' }), { prompt: 'x' });
      const commandNames = h.session.extensionRunner
        .getRegisteredCommands()
        .map((cmd) => cmd.invocationName);
      assert.ok(commandNames.includes('unipi:fusion'));
      assert.ok(commandNames.includes('unipi:fusion-models'));
      const renderer = h.session.extensionRunner.getMessageRenderer('fusion-result');
      assert.ok(renderer, 'fusion result renderer should be registered');
      const legacyDetails = {
        schema_version: FUSION_LEGACY_RESULT_SCHEMA_VERSION,
        run_id: 'brainstorm-' + '1'.repeat(32),
        workflow: 'brainstorm',
        source: 'tool',
        status: 'completed',
        artifact_dir: '.pi/fusion/historical/brainstorm-' + '1'.repeat(32),
        models: {},
        evaluator_attempts: 1,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const legacyRendered = renderer(
        {
          role: 'custom',
          customType: 'fusion-result',
          content: 'Historical fused answer.',
          display: true,
          details: legacyDetails,
          timestamp: Date.now(),
        },
        { expanded: false },
        makeTheme(),
      );
      assert.ok(legacyRendered, 'historical v4 fusion result should still render');
      assert.match(stripAnsi(legacyRendered.render(100).join('\n')), /Historical fused answer/);
      assert.ok(!h.session.getActiveToolNames().includes('fusion_brainstorm'));
      await command(h.session, 'unipi:fusion').handler(
        '  command prompt\nwith body  ',
        commandContext(h.session, 'print'),
      );
      await waitForInvocationCount(h.fakeLogPath, 5);
      const terminal = await waitForFusionTerminal(h.session);
      const calls = await invocations(h.fakeLogPath);
      assert.equal(calls.length, 5);
      assert.equal(calls.filter((call) => call.stage === 'candidate').length, 3);
      assert.equal(calls.filter((call) => call.stage === 'evaluation').length, 1);
      assert.equal(calls.filter((call) => call.stage === 'merge').length, 1);
      const candidateCalls = calls.filter((call) => call.stage === 'candidate');
      const adjudicationCalls = calls.filter((call) => call.stage !== 'candidate');
      for (const call of [...candidateCalls, ...adjudicationCalls]) {
        assert.ok(call.args.includes('--no-tools'), `${call.stage} must run with --no-tools`);
        assert.equal(call.args.includes('--no-builtin-tools'), false);
      }
      for (const call of calls) {
        for (const flag of [
          '--mode',
          '--no-session',
          '--no-extensions',
          '--no-skills',
          '--no-prompt-templates',
          '--no-themes',
          '--no-context-files',
          '--provider',
          '--model',
          '--thinking',
          '--system-prompt',
        ]) {
          assert.ok(call.args.includes(flag), flag);
        }
        assert.equal(call.provider, 'pi-bg-fusion');
        assert.equal(call.model, 'current-model');
        assert.equal(call.env.PI_SESSION_ID, null);
        assert.equal(call.env.PI_PROVIDER, null);
        assert.equal(call.env.PI_MODEL, null);
        assert.equal(call.env.PI_SKIP_VERSION_CHECK, '1');
      }
      const firstInput = parseJsonText(calls[0]?.stdin ?? '');
      assert.ok(isRecord(firstInput));
      assert.equal(firstInput['schema_version'], FUSION_INPUT_SCHEMA_VERSION);
      const commandRequest = firstInput['request'];
      assert.ok(isRecord(commandRequest), 'canonical request must be an object');
      assert.equal(commandRequest['text'], 'command prompt\nwith body');
      assert.equal(commandRequest['source'], 'command');
      assert.equal(commandRequest['authority'], 'directive_over_projected_conversation');

      assert.equal(customEntries(h.session, 'fusion-request').length, 0);
      assert.equal(customEntries(h.session, 'fusion-result').length, 0);
      const terminalDetails = terminal['details'];
      assert.ok(isRecord(terminalDetails));
      assert.equal(terminalDetails['status'], 'completed');
      const terminalFusion = terminalDetails['fusion'];
      assert.ok(isRecord(terminalFusion));
      assert.equal(terminalFusion['workflow'], 'reason');
      assert.equal(assistantMessageCount(h.session), 0);
    } finally {
      await disposeHarness(h);
    }
  });

  void it('runs fusion_reason as the host-level no-tools path', async (t) => {
    if (skipWin32FusionChildPathFixture(t)) return;
    const h = await harness();
    try {
      const tool = h.session.getToolDefinition('fusion_reason');
      assert.ok(tool, 'fusion_reason tool should be registered');
      const launch = await tool.execute(
        'call-fusion-reason',
        { prompt: 'reason without repository inspection' },
        undefined,
        undefined,
        h.session.extensionRunner.createContext(),
      );
      assert.ok(isFusionLaunchDetails(launch.details));
      const { launchDetails } = await retrieveFusionLaunch(h, launch);
      const details = await committedDetails(h, launchDetails);
      const calls = await invocations(h.fakeLogPath);
      assert.equal(calls.length, 5);
      for (const call of calls) {
        assert.ok(call.args.includes('--no-tools'));
        assert.equal(call.args.includes('--no-builtin-tools'), false);
      }
      const artifactFiles = await readdir(join(h.cwd, details.artifact_dir));
      assert.equal(
        artifactFiles.some((name) => name.includes('.tool-calls.')),
        false,
        'reason-only children must not create tool-call audit logs',
      );
    } finally {
      await disposeHarness(h);
    }
  });

  void it('keeps all clean Fusion workflows free of parent sentinels in prompts and artifacts', async (t) => {
    if (skipWin32FusionChildPathFixture(t)) return;
    const h = await harness();
    try {
      const sentinel = 'PARENT-CLEAN-LEAK-SENTINEL-7f0d';
      h.session.sessionManager.appendMessage({
        role: 'user',
        content: `visible parent ${sentinel}`,
        timestamp: Date.now(),
      });
      h.session.sessionManager.appendMessage({
        role: 'assistant',
        api: 'openai-responses',
        provider: 'pi-bg-fusion',
        model: 'current-model',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'toolUse',
        content: [
          { type: 'thinking', thinking: `hidden parent ${sentinel}` },
          { type: 'text', text: `assistant parent ${sentinel}` },
          { type: 'toolCall', id: 'parent-call', name: 'read', arguments: { sentinel } },
        ],
        timestamp: Date.now(),
      });
      h.session.sessionManager.appendMessage({
        role: 'toolResult',
        toolCallId: 'parent-call',
        toolName: 'read',
        content: [{ type: 'text', text: `tool result parent ${sentinel}` }],
        details: { sentinel },
        isError: false,
        timestamp: Date.now(),
      });

      const cases = [
        {
          name: 'fusion_investigate',
          workflow: 'investigate',
          candidateTools: 'read,grep,find,ls',
          params: {
            objective: 'inspect clean workflow',
            background: ['self-contained public facts only'],
            deliverable: 'answer',
            scope: ['README.md'],
          },
        },
        {
          name: 'fusion_research',
          workflow: 'research',
          candidateTools: 'read,grep,find,ls,fusion_web_fetch',
          params: {
            objective: 'research clean workflow',
            background: ['self-contained public facts only'],
            deliverable: 'answer with source policy',
            sources: [{ url: 'https://example.com/docs#section', purpose: 'declared source' }],
          },
        },
        {
          name: 'fusion_validate',
          workflow: 'validate',
          candidateTools: 'read,grep,find,ls',
          params: {
            objective: 'validate clean workflow',
            background: ['self-contained validation facts only'],
            changeSummary: 'changed public Fusion workflow facade',
            scope: ['README.md'],
            acceptanceCriteria: ['no parent sentinel reaches children'],
            verification: { status: 'not_run', reason: 'SDK sentinel proof only' },
          },
        },
      ] as const;

      for (const item of cases) {
        await writeFile(h.fakeLogPath, '', 'utf8');
        const tool = h.session.getToolDefinition(item.name);
        assert.ok(tool, `${item.name} should be registered`);
        const launch = await tool.execute(
          `call-${item.workflow}`,
          item.params,
          undefined,
          undefined,
          h.session.extensionRunner.createContext(),
        );
        assert.ok(isFusionLaunchDetails(launch.details));
        const retrieved = await retrieveFusionLaunch(h, launch);
        const details = await committedDetails(h, retrieved.launchDetails);
        assert.equal(details.workflow, item.workflow);
        assert.ok(details.run_id.startsWith(`${item.workflow}-`));
        assert.deepEqual(details.context, {
          kind: 'clean_task',
          policy_id: 'fusion-clean-task-v1',
        });
        assert.deepEqual(details.tool_policy.evaluation_tools, []);
        assert.deepEqual(details.tool_policy.merge_tools, []);
        assert.deepEqual(details.tool_policy.candidate_tools, item.candidateTools.split(','));
        await assertCleanArtifactBoundary(h.cwd, details, sentinel);

        const calls = await invocations(h.fakeLogPath);
        assert.equal(calls.length, 5, `${item.name} must make exactly five child calls`);
        const candidateCalls = calls.filter((call) => call.stage === 'candidate');
        const adjudicators = calls.filter((call) => call.stage !== 'candidate');
        assert.equal(candidateCalls.length, 3);
        assert.equal(adjudicators.length, 2);
        for (const call of calls) {
          assert.doesNotMatch(call.stdin, new RegExp(escapeRegExp(sentinel)));
          assert.doesNotMatch(call.stdin, /conversation_projection|conversation_transcript/);
          assert.doesNotMatch(call.stdin, /context-omission-ledger/);
        }
        for (const call of candidateCalls) {
          assert.equal(call.args.includes('--no-tools'), false);
          assert.ok(call.args.includes('--no-builtin-tools'));
          assert.equal(call.args[call.args.indexOf('--tools') + 1], item.candidateTools);
        }
        for (const call of adjudicators) {
          assert.ok(call.args.includes('--no-tools'));
          assert.equal(call.args.includes('--tools'), false);
        }
      }
    } finally {
      await disposeHarness(h);
    }
  });

  void it('BUG-182 returns exact merged text with host-valid usage and excludes the active tool-call leaf', async (t) => {
    if (skipWin32FusionChildPathFixture(t)) return;
    const h = await harness();
    try {
      const user: UserMessage = {
        role: 'user',
        content: [
          { type: 'text', text: 'prior user context before image ' },
          { type: 'image', data: 'sdk-raw-image-base64', mimeType: 'image/png' },
          { type: 'text', text: ' after image context' },
        ],
        timestamp: Date.now(),
      };
      h.session.sessionManager.appendMessage(user);
      const assistant: AssistantMessage = {
        role: 'assistant',
        api: 'openai-responses',
        provider: 'pi-bg-fusion',
        model: 'current-model',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'toolUse',
        content: [
          { type: 'text', text: 'partial assistant text that must be excluded' },
          {
            type: 'toolCall',
            id: 'call-fusion',
            name: 'fusion_reason',
            arguments: { prompt: 'tool prompt' },
          },
          { type: 'toolCall', id: 'call-sibling', name: 'bg_status', arguments: {} },
        ],
        timestamp: Date.now(),
      };
      h.session.sessionManager.appendMessage(assistant);
      const tool = h.session.getToolDefinition('fusion_reason');
      assert.ok(tool, 'fusion_reason tool should be registered');
      const updates: string[] = [];
      const launch = await tool.execute(
        'call-fusion',
        { prompt: 'tool prompt' },
        undefined,
        (partial) => {
          const text = partial.content[0]?.type === 'text' ? partial.content[0].text : '';
          updates.push(text);
        },
        h.session.extensionRunner.createContext(),
      );
      assert.ok(isFusionLaunchDetails(launch.details));
      const retrieved = await retrieveFusionLaunch(h, launch);
      const result = retrieved.result;
      const resultText = result.content[0]?.type === 'text' ? result.content[0].text : '';
      assert.match(resultText, /SDK fused answer\.$/);
      const details = await committedDetails(h, retrieved.launchDetails);
      assert.equal(details.workflow, 'reason');
      const resultUsage = Reflect.get(result, 'usage');
      assert.ok(isRecord(resultUsage));
      assert.equal(resultUsage['totalTokens'], 115);
      assert.equal(resultUsage['costTotal'], undefined);
      const resultCost = resultUsage['cost'];
      assert.ok(isRecord(resultCost), 'tool usage must carry Pi Usage.cost');
      assert.deepEqual(resultCost, {
        input: 0.005,
        output: 0.01,
        cacheRead: 0.015,
        cacheWrite: 0.02,
        total: 0.05,
      });
      const task = retrieved.launchDetails['task'];
      assert.ok(isRecord(task));
      const resultTool = h.session.getToolDefinition('bg_result');
      assert.ok(resultTool);
      const repeated = await resultTool.execute(
        'repeat-result',
        { taskId: stringField(task, 'id'), delivery: 'inline' },
        undefined,
        undefined,
        h.session.extensionRunner.createContext(),
      );
      assert.equal(
        Reflect.get(repeated, 'usage'),
        undefined,
        'repeated retrieval must not double-count usage',
      );
      assert.ok(updates.every((update) => !/failed/.test(update)));

      const calls = await invocations(h.fakeLogPath);
      const candidate = calls.find((call) => call.stage === 'candidate');
      assert.ok(candidate, 'candidate invocation should be logged');
      assert.ok(candidate.args.includes('--no-tools'));
      assert.equal(candidate.args.includes('--no-builtin-tools'), false);
      const parsedInput = parseJsonText(candidate.stdin);
      assert.ok(isRecord(parsedInput), 'canonical input should be an object');
      const toolRequest = parsedInput['request'];
      assert.ok(isRecord(toolRequest), 'canonical request must be an object');
      assert.equal(toolRequest['text'], 'tool prompt');
      assert.equal(toolRequest['authority'], 'explicit_text');
      // The exact bytes sent to the child carry the projection, not a raw transcript.
      assert.doesNotMatch(candidate.stdin, /conversation_transcript/);
      assert.match(candidate.stdin, /conversation_projection/);
      // Scope conversation assertions to the projection: the parent system prompt
      // legitimately names package tools such as bg_status.
      const projection = parsedInput['conversation_projection'];
      assert.ok(isRecord(projection), 'projection must be an object');
      const projectionText = JSON.stringify(projection);
      assert.match(projectionText, /prior user context before image/);
      assert.match(projectionText, /after image context/);
      assert.match(projectionText, /\[Image omitted from fusion text transcript: image\/png\]/);
      assert.doesNotMatch(projectionText, /partial assistant text/);
      assert.doesNotMatch(projectionText, /call-sibling|bg_status/);
      // Raw image bytes must not appear anywhere in the child prompt.
      assert.doesNotMatch(candidate.stdin, /sdk-raw-image-base64/);
    } finally {
      await disposeHarness(h);
    }
  });

  void it('hands cancellation ownership from the tool call to the managed task after launch', async (t) => {
    if (skipWin32FusionChildPathFixture(t)) return;
    const h = await harness({ fakeDelayMs: 100 });
    try {
      const tool = h.session.getToolDefinition('fusion_reason');
      assert.ok(tool);
      const callController = new AbortController();
      const launch = await tool.execute(
        'call-signal-handoff',
        { prompt: 'continue after parent tool signal closes' },
        callController.signal,
        undefined,
        h.session.extensionRunner.createContext(),
      );
      callController.abort();
      const retrieved = await retrieveFusionLaunch(h, launch);
      const text =
        retrieved.result.content[0]?.type === 'text' ? retrieved.result.content[0].text : '';
      assert.match(text, /SDK fused answer/);
    } finally {
      await disposeHarness(h);
    }
  });

  void it('reports tool failure stage, slot, attempt, and durable artifact directory', async (t) => {
    if (skipWin32FusionChildPathFixture(t)) return;
    const h = await harness({ fakeFailStage: 'candidate' });
    try {
      const tool = h.session.getToolDefinition('fusion_reason');
      assert.ok(tool, 'fusion_reason tool should be registered');
      const launch = await tool.execute(
        'call-failure-diagnostics',
        { prompt: 'fail with coordinates' },
        undefined,
        undefined,
        h.session.extensionRunner.createContext(),
      );
      assert.ok(isFusionLaunchDetails(launch.details));
      const task = launch.details['task'];
      assert.ok(isRecord(task));
      const taskId = stringField(task, 'id');
      await waitForFusionTerminal(h.session, taskId);
      const resultTool = h.session.getToolDefinition('bg_result');
      assert.ok(resultTool);
      const terminal = await resultTool.execute(
        'result-failure-diagnostics',
        { taskId, delivery: 'inline' },
        undefined,
        undefined,
        h.session.extensionRunner.createContext(),
      );
      assert.ok(isRecord(terminal.details));
      assert.equal(terminal.details['state'], 'failed');
      assert.equal(terminal.details['delivery'], 'none');
      assert.deepEqual(terminal.details['answer'], { present: false, reason: 'run_did_not_commit' });
      assert.equal(terminal.details['summary_status'], 'verified');
      assert.equal(terminal.details['answer_bytes'], undefined);
      assert.equal(terminal.details['answer_sha256'], undefined);
      assert.ok(isRecord(terminal.details['failure']));
      assert.equal(terminal.details['failure']['stage'], 'candidate');
      assert.equal('usage' in terminal, false);
      for (const delivery of [undefined, 'artifact'] as const) {
        const repeat = await resultTool.execute(
          `result-failure-${delivery ?? 'default'}`,
          delivery === undefined ? { taskId } : { taskId, delivery },
          undefined,
          undefined,
          h.session.extensionRunner.createContext(),
        );
        assert.ok(isRecord(repeat.details));
        assert.equal(repeat.details['state'], 'failed');
        assert.equal(repeat.details['delivery'], 'none');
        assert.deepEqual(repeat.details['answer'], {
          present: false,
          reason: 'run_did_not_commit',
        });
        assert.equal('usage' in repeat, false);
      }
    } finally {
      await disposeHarness(h);
    }
  });

  void it('cancels live fusion children on session shutdown', async (t) => {
    if (skipWin32FusionChildPathFixture(t)) return;
    const h = await harness({ fakeDelayMs: 10000 });
    let disposed = false;
    try {
      const tool = h.session.getToolDefinition('fusion_reason');
      assert.ok(tool, 'fusion_reason tool should be registered');
      const launchStarted = Date.now();
      const launch = await tool.execute(
        'call-shutdown',
        { prompt: 'shutdown prompt' },
        undefined,
        undefined,
        h.session.extensionRunner.createContext(),
      );
      assert.ok(isFusionLaunchDetails(launch.details));
      assert.ok(
        Date.now() - launchStarted < 2_000,
        'launch receipt must not wait for delayed Fusion children',
      );
      const task = launch.details['task'];
      assert.ok(isRecord(task));
      const taskId = stringField(task, 'id');
      await waitForInvocationCount(h.fakeLogPath, 3);
      await h.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'reload' });
      const resultTool = h.session.getToolDefinition('bg_result');
      assert.ok(resultTool);
      const terminal = await resultTool.execute(
        'result-shutdown',
        { taskId, delivery: 'artifact' },
        undefined,
        undefined,
        h.session.extensionRunner.createContext(),
      );
      assert.ok(isRecord(terminal.details));
      assert.equal(terminal.details['state'], 'cancelled');
      assert.equal(terminal.details['delivery'], 'none');
      assert.deepEqual(terminal.details['answer'], { present: false, reason: 'run_did_not_commit' });
      assert.equal(terminal.details['summary_status'], 'verified');
      assert.equal(terminal.details['usage_delivered'], undefined);
      assert.equal('usage' in terminal, false);
      for (const delivery of [undefined, 'inline'] as const) {
        const repeat = await resultTool.execute(
          `result-shutdown-${delivery ?? 'default'}`,
          delivery === undefined ? { taskId } : { taskId, delivery },
          undefined,
          undefined,
          h.session.extensionRunner.createContext(),
        );
        assert.ok(isRecord(repeat.details));
        assert.equal(repeat.details['state'], 'cancelled');
        assert.equal(repeat.details['delivery'], 'none');
        assert.deepEqual(repeat.details['answer'], {
          present: false,
          reason: 'run_did_not_commit',
        });
        assert.equal('usage' in repeat, false);
      }
      h.session.dispose();
      disposed = true;
    } finally {
      if (!disposed) await disposeHarness(h);
    }
  });

  void it('rejects /fusion-models without UI instead of using the no-op notifier', async () => {
    const h = await harness();
    try {
      await assert.rejects(
        command(h.session, 'unipi:fusion-models').handler('', commandContext(h.session)),
        /requires Pi TUI mode/,
      );
      assert.equal((await invocations(h.fakeLogPath)).length, 0);
    } finally {
      await disposeHarness(h);
    }
  });

  void it('supports no-argument editor flow, editor cancellation, selector save, and invalid config without child calls', async (t) => {
    if (skipWin32FusionChildPathFixture(t)) return;
    const h = await harness();
    try {
      const originalUi = baseUi(h.session);
      h.session.extensionRunner.setUIContext({
        ...originalUi,
        editor: () => Promise.resolve(' editor prompt '),
      });
      await command(h.session, 'unipi:fusion').handler('', commandContext(h.session, 'print'));
      await waitForInvocationCount(h.fakeLogPath, 5);
      await waitForFusionTerminal(h.session);
      assert.equal((await invocations(h.fakeLogPath)).length, 5);

      await writeFile(h.fakeLogPath, '', 'utf8');
      h.session.extensionRunner.setUIContext({
        ...baseUi(h.session),
        editor: () => Promise.resolve(undefined),
      });
      await command(h.session, 'unipi:fusion').handler('', commandContext(h.session, 'print'));
      assert.equal((await invocations(h.fakeLogPath)).length, 0);

      const selectorCustom: ExtensionUIContext['custom'] = (factory) => {
        return new Promise((resolvePromise, reject) => {
          Promise.resolve(factory(fakeTui(), makeTheme(), fakeKeybindings(), resolvePromise))
            .then((component: Component & { dispose?(): void }) => {
              component.handleInput?.('\r');
              component.handleInput?.('a');
              component.handleInput?.('l');
              component.handleInput?.('t');
              component.handleInput?.('\r');
              component.handleInput?.('\x1b[B');
              component.handleInput?.('\r');
              component.handleInput?.('a');
              component.handleInput?.('l');
              component.handleInput?.('t');
              component.handleInput?.('\r');
              component.handleInput?.('s');
            })
            .catch((error: unknown) => {
              reject(error);
            });
        });
      };
      // Pi 0.83 takes the run mode as a second setUIContext argument (default
      // "print"); /fusion-models is TUI-only, so the selector needs "tui".
      h.session.extensionRunner.setUIContext(
        {
          ...baseUi(h.session),
          custom: selectorCustom,
        },
        'tui',
      );
      const selectorCtx = h.session.extensionRunner.createCommandContext();
      await command(h.session, 'unipi:fusion-models').handler('', selectorCtx);
      const savedConfigText = await readFile(join(h.agentDir, FUSION_MODEL_CONFIG_FILE), 'utf8');
      const savedConfig = parseJsonText(savedConfigText);
      assert.ok(isRecord(savedConfig));
      assert.deepEqual(savedConfig['candidates'], [
        'pi-bg-fusion/alt-model',
        'pi-bg-fusion/alt-model',
        CURRENT_MODEL_SELECTION,
      ]);

      await writeFile(h.fakeLogPath, '', 'utf8');
      await writeFile(join(h.agentDir, FUSION_MODEL_CONFIG_FILE), '{"bad":true}\n', 'utf8');
      const invalidTool = h.session.getToolDefinition('fusion_reason');
      assert.ok(invalidTool, 'fusion_reason tool should remain registered');
      await assert.rejects(
        () =>
          invalidTool.execute(
            'call-invalid',
            { prompt: 'should not spawn' },
            undefined,
            undefined,
            h.session.extensionRunner.createContext(),
          ),
        /schema_version|unknown key|missing key/,
      );
      assert.equal((await invocations(h.fakeLogPath)).length, 0);
    } finally {
      await disposeHarness(h);
    }
  });

  void it('runs fusion_validate end to end with inspect-only reviewers', async (t) => {
    if (skipWin32FusionChildPathFixture(t)) return;
    const h = await harness();
    try {
      assert.ok(h.session.getActiveToolNames().includes('fusion_validate'));
      const tool = h.session.getToolDefinition('fusion_validate');
      assert.ok(tool, 'fusion_validate should be registered at load');
      assert.equal(Reflect.get(tool.parameters, 'additionalProperties'), false);
      assert.throws(() => tool.prepareArguments?.({ prompt: 'x' }), /no longer accepts \{prompt\}/);
      assert.throws(
        () => tool.prepareArguments?.({ objective: 'x', extra: true }),
        /unsupported key\(s\): extra/,
      );

      const launch = await tool.execute(
        'call-validate',
        {
          objective: 'validate the change',
          background: ['SDK integration test'],
          changeSummary: 'fusion public facade changed',
          scope: ['src/fusion-extension.ts'],
          acceptanceCriteria: ['validation runs with read-only reviewers'],
          verification: { status: 'provided', evidence: [{ check: 'sdk', outcome: 'running' }] },
        },
        undefined,
        undefined,
        h.session.extensionRunner.createContext(),
      );
      assert.ok(isFusionLaunchDetails(launch.details));
      const retrieved = await retrieveFusionLaunch(h, launch);
      const validateText =
        retrieved.result.content[0]?.type === 'text' ? retrieved.result.content[0].text : '';
      assert.match(validateText, /# Validation report/);
      assert.match(validateText, /Location: README\.md:1/);
      const details = await committedDetails(h, retrieved.launchDetails);
      assert.equal(details.workflow, 'validate');
      assert.ok(details.run_id.startsWith('validate-'));

      const calls = await invocations(h.fakeLogPath);
      assert.equal(calls.length, 5, 'validate must make exactly five child calls');
      const candidates = calls.filter((call) => call.stage === 'candidate');
      const others = calls.filter((call) => call.stage !== 'candidate');
      assert.equal(candidates.length, 3);
      assert.equal(others.length, 2);

      for (const call of candidates) {
        assert.equal(call.workflow, 'validate');
        // Reviewers get the read-only allowlist by argv, never --no-tools.
        assert.ok(!call.args.includes('--no-tools'));
        assert.ok(call.args.includes('--no-builtin-tools'));
        assert.equal(call.args[call.args.indexOf('--tools') + 1], 'read,grep,find,ls');
        const excluded = call.args[call.args.indexOf('--exclude-tools') + 1] ?? '';
        for (const forbidden of ['bash', 'edit', 'write', 'fusion_brainstorm', 'fusion_validate']) {
          assert.ok(excluded.includes(forbidden), `${forbidden} must be denied`);
        }
      }
      // Evaluator and merger adjudicate the review and must stay reasoning-only.
      for (const call of others) {
        assert.ok(call.args.includes('--no-tools'), `${call.stage} must run with --no-tools`);
        assert.ok(!call.args.includes('--tools'));
      }
      // Validate is clean by construction: no parent projection/transcript enters child prompts.
      for (const call of calls) {
        assert.ok(!call.stdin.includes('conversation_projection'));
        assert.ok(!call.stdin.includes('conversation_transcript'));
        assert.ok(call.stdin.includes(FUSION_INPUT_SCHEMA_VERSION));
      }
    } finally {
      await disposeHarness(h);
    }
  });
});
