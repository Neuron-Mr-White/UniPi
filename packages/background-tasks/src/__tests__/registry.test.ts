import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseJsonText } from '../types.js';
import {
  BackgroundTaskRegistry,
  WIN32_CMD_PI_TELEMETRY_UNAVAILABLE_REASON,
  commandMayLaunchPiAgent,
  type BackgroundTaskContext,
  type BackgroundTaskSpawn,
  type CompletionNotificationMessage,
  type CompletionNotificationOptions,
} from '../registry.js';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { BgTask, BgTaskSnapshot } from '../types.js';
import type { TaskkillOutcome, WindowsKillPhase } from '../windows-taskkill.js';
import type { BackgroundTaskChildProcess, BackgroundTaskSpawnOptions } from '../child-process.js';

type JsonObject = Record<PropertyKey, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string, message: string): JsonObject {
  const parsed = parseJsonText(text);
  assert.ok(isJsonObject(parsed), message);
  return parsed;
}

function requiredJsonObject(value: unknown, message: string): JsonObject {
  assert.ok(isJsonObject(value), message);
  return value;
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid: number;
  killCalls: Array<NodeJS.Signals | undefined> = [];
  killImpl: (signal?: NodeJS.Signals) => boolean;

  constructor(pid: number, killImpl?: (signal?: NodeJS.Signals) => boolean) {
    super();
    this.pid = pid;
    this.killImpl = killImpl ?? (() => true);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killCalls.push(signal);
    return this.killImpl(signal);
  }

  writeStdout(value: string): void {
    this.stdout.emit('data', Buffer.from(value, 'utf8'));
  }

  writeStderr(value: string): void {
    this.stderr.emit('data', Buffer.from(value, 'utf8'));
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.emit('close', code, signal);
  }

  fail(error: Error): void {
    this.emit('error', error);
  }
}

interface SpawnRecord {
  child: FakeChild;
  shell: string;
  args: string[];
  options: BackgroundTaskSpawnOptions;
}

interface HarnessOptions {
  platform?: NodeJS.Platform;
  maxRecentTasks?: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
  stopWaitMs?: number;
  killProcess?: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  killTree?: (
    pid: number,
    phase: WindowsKillPhase,
    signal?: AbortSignal,
  ) => Promise<TaskkillOutcome>;
  sendCompletionNotification?: (
    message: CompletionNotificationMessage,
    options: CompletionNotificationOptions,
  ) => void;
  publishTerminal?: (task: BgTaskSnapshot) => void;
  logger?: Pick<Console, 'error'>;
  makeTaskId?: () => string;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  childFactory?: (pid: number) => FakeChild;
  modelRegistry?: BackgroundTaskContext['modelRegistry'];
}

async function createHarness(options: HarnessOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-registry-'));
  const cwd = join(root, 'project');
  await mkdir(cwd, { recursive: true });
  let pid = 4200;
  let idSeq = 0;
  const children: SpawnRecord[] = [];
  const notifications: Array<{
    message: CompletionNotificationMessage;
    options: CompletionNotificationOptions;
  }> = [];
  const errors: unknown[][] = [];
  let changes = 0;
  const registryOptions: ConstructorParameters<typeof BackgroundTaskRegistry>[0] = {
    logger: options.logger ?? {
      error: (...args: unknown[]) => {
        errors.push(args);
      },
    },
    makeTaskId: options.makeTaskId ?? (() => `bunit${String(++idSeq).padStart(3, '0')}`),
    sendCompletionNotification:
      options.sendCompletionNotification ??
      ((message, opts) => {
        notifications.push({ message, options: opts });
      }),
    onChange: () => {
      changes++;
    },
    spawn: (shell, args, spawnOptions) => {
      const child = options.childFactory?.(++pid) ?? new FakeChild(++pid);
      children.push({ child, shell, args: [...args], options: spawnOptions ?? {} });
      return child as unknown as BackgroundTaskChildProcess;
    },
  };
  if (options.publishTerminal !== undefined)
    registryOptions.publishTerminal = options.publishTerminal;
  if (options.platform !== undefined) registryOptions.platform = options.platform;
  if (options.env !== undefined) registryOptions.env = options.env;
  if (options.maxRecentTasks !== undefined) registryOptions.maxRecentTasks = options.maxRecentTasks;
  if (options.maxOutputBytes !== undefined) registryOptions.maxOutputBytes = options.maxOutputBytes;
  if (options.killGraceMs !== undefined) registryOptions.killGraceMs = options.killGraceMs;
  if (options.stopWaitMs !== undefined) registryOptions.stopWaitMs = options.stopWaitMs;
  if (options.now !== undefined) registryOptions.now = options.now;
  if (options.killProcess !== undefined) registryOptions.killProcess = options.killProcess;
  if (options.killTree !== undefined) registryOptions.killTree = options.killTree;
  const registry = new BackgroundTaskRegistry(registryOptions);
  const ctx: BackgroundTaskContext = {
    cwd,
    sessionId: 'registry-test',
    modelRegistry: options.modelRegistry ?? { getAll: () => [] },
    model: undefined,
  };
  return {
    root,
    cwd,
    ctx,
    registry,
    children,
    notifications,
    errors,
    get changes() {
      return changes;
    },
  };
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function initCleanGit(cwd: string): Promise<void> {
  git(cwd, ['init']);
  git(cwd, ['config', 'user.email', 'pi-bg@example.invalid']);
  git(cwd, ['config', 'user.name', 'Pi BG Tests']);
  await writeFile(join(cwd, 'README.md'), 'clean\n', 'utf8');
  await writeFile(join(cwd, '.gitignore'), '.pi/\nreport.md\n', 'utf8');
  git(cwd, ['add', 'README.md', '.gitignore']);
  git(cwd, ['commit', '-m', 'init']);
}

function oauthModel(provider = 'openai-codex', modelId = 'gpt-5.5'): Model<Api> {
  return {
    id: modelId,
    name: modelId,
    api: provider === 'anthropic' ? 'anthropic-messages' : 'openai-codex-responses',
    provider,
    baseUrl: 'https://example.invalid',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 4096,
  };
}

function oauthRegistry(model = oauthModel()): BackgroundTaskContext['modelRegistry'] {
  return {
    getAll: () => [model],
    find: (provider, modelId) =>
      provider === model.provider && modelId === model.id ? model : undefined,
    isUsingOAuth: () => true,
  };
}

function piJsonEvents(provider = 'openai-codex', model = 'gpt-5.5'): string {
  return (
    [
      {
        type: 'session',
        version: 3,
        id: 'pi-session-unit',
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd: '/unit',
      },
      { type: 'agent_start' },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          provider,
          model,
          usage: {
            input: 10,
            output: 4,
            cacheRead: 0,
            cacheWrite: 1,
            totalTokens: 15,
            cost: { total: 0.12 },
          },
          content: [{ type: 'text', text: 'attested done' }],
          stopReason: 'stop',
        },
      },
      { type: 'agent_end', messages: [] },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n'
  );
}

async function cleanup(root: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!(error instanceof Error) || !/ENOTEMPTY/.test(error.message) || attempt === 4)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function waitFor(
  predicate: () => boolean,
  message = 'condition',
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

async function readJsonEventually(path: string, timeoutMs = 1000): Promise<JsonObject> {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    last = await readFile(path, 'utf8').catch(() => '');
    try {
      if (last.trim()) return parseJsonObject(last, 'metadata JSON must be an object');
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return parseJsonObject(last, 'metadata JSON must be an object');
}

function lastSpawn(h: Awaited<ReturnType<typeof createHarness>>): SpawnRecord {
  const spawn = h.children.at(-1);
  assert.ok(spawn, 'test harness should have recorded a child process spawn');
  return spawn;
}

function taskkillOutcome(exitCode: number | null, stderr = ''): TaskkillOutcome {
  return {
    exitCode,
    signal: null,
    stdout: '',
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn: ((value: T) => void) | undefined;
  let rejectFn: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  assert.ok(resolveFn, 'deferred resolve should initialize');
  assert.ok(rejectFn, 'deferred reject should initialize');
  return { promise, resolve: resolveFn, reject: rejectFn };
}

function isKillRequester(value: unknown): value is (task: BgTask, signal?: NodeJS.Signals) => void {
  return typeof value === 'function';
}

function requestKillForTest(
  registry: BackgroundTaskRegistry,
  task: BgTask,
  signal?: NodeJS.Signals,
): void {
  const method = Reflect.get(registry, 'requestKill');
  assert.ok(isKillRequester(method), 'registry requestKill should be callable');
  method.call(registry, task, signal);
}

async function startFakeTask(
  h: Awaited<ReturnType<typeof createHarness>>,
  name = 'Registry Task',
): Promise<{ task: BgTask; child: FakeChild }> {
  const task = await h.registry.startTask(h.ctx, 'node fake.js', {
    name,
    isAgent: false,
    notifyOnCompletion: true,
    triggerOnCompletion: true,
  });
  return { task, child: lastSpawn(h).child };
}

void describe('BackgroundTaskRegistry', () => {
  void it('preserves full shell command bytes except surrounding whitespace', async () => {
    const h = await createHarness({ platform: 'linux' });
    try {
      const command = `'${process.execPath}' '${join(h.cwd, 'bin', 'autopilot-agent-run.mjs')}' --spec '${join(h.cwd, 'specs', 'unit spec.json')}'`;
      const task = await h.registry.startTask(h.ctx, `  ${command}  `, {
        name: 'Quoted Runner',
        isAgent: true,
        notifyOnCompletion: false,
      });
      const spawn = lastSpawn(h);
      assert.equal(task.command, command);
      assert.equal(spawn.args.at(-1), command);
      assert.equal(JSON.parse(readFileSync(task.metadataAbsPath, 'utf8')).command, command);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('uses explicit isAgent to decide Pi telemetry wrapping', async () => {
    assert.equal(commandMayLaunchPiAgent('pi -p hello'), true);
    assert.equal(
      commandMayLaunchPiAgent('/usr/local/bin/pi -p hello'),
      false,
      'shell-function wrapper cannot intercept path-qualified pi commands',
    );

    const h = await createHarness({ platform: 'linux' });
    try {
      const scriptLikePi = await h.registry.startTask(h.ctx, 'pi -p hello', {
        name: 'Plain Pi Script',
        isAgent: false,
        notifyOnCompletion: false,
      });
      assert.equal(scriptLikePi.isAgent, false);
      assert.doesNotMatch(lastSpawn(h).args.join('\n'), /pi-telemetry-wrapper/);

      const agentPi = await h.registry.startTask(h.ctx, 'pi -p hello', {
        name: 'Agent Pi',
        isAgent: true,
        notifyOnCompletion: false,
      });
      assert.equal(agentPi.isAgent, true);
      const wrappedCommand = lastSpawn(h).args.join('\n');
      assert.match(wrappedCommand, /pi\(\) \{ .*pi-telemetry-wrapper\.cjs/);
      assert.ok(wrappedCommand.includes(process.execPath));
      assert.doesNotMatch(wrappedCommand, /pi\(\) \{ node /);
      const wrapperPath = join(
        dirname(agentPi.outputAbsPath),
        `${agentPi.id}.pi-telemetry-wrapper.cjs`,
      );
      const wrapperSource = await readFile(wrapperPath, 'utf8');
      assert.match(wrapperSource, /const launch = /);
      assert.match(wrapperSource, /spawn\(launch\.executable, childArgs, \{[^}]*shell: false/);
      assert.doesNotMatch(wrapperSource, /spawn\("pi"/);
      assert.doesNotThrow(
        () => new Function('require', 'process', wrapperSource.replace(/^#!.*\n/, '')),
      );

      const pathQualifiedPi = await h.registry.startTask(h.ctx, '/usr/local/bin/pi -p hello', {
        name: 'Path Pi',
        isAgent: true,
        notifyOnCompletion: false,
      });
      assert.equal(pathQualifiedPi.isAgent, true);
      assert.doesNotMatch(lastSpawn(h).args.join('\n'), /pi-telemetry-wrapper/);
    } finally {
      await cleanup(h.root);
    }

    const disabled = await createHarness({
      env: { ...process.env, UNIPI_BG_DISABLE_PI_TELEMETRY: '1' },
    });
    try {
      await disabled.registry.startTask(disabled.ctx, 'pi -p hello', {
        name: 'Disabled Agent',
        isAgent: true,
        notifyOnCompletion: false,
      });
      assert.doesNotMatch(lastSpawn(disabled).args.join('\n'), /pi-telemetry-wrapper/);
    } finally {
      await cleanup(disabled.root);
    }
  });

  void it('leaves Pi agent commands unchanged under Windows cmd and records telemetry unavailability', async () => {
    const h = await createHarness({
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    });
    try {
      const command = 'pi --mode json "hello & echo pwned"';
      const task = await h.registry.startTask(h.ctx, command, {
        name: 'Cmd Pi Agent',
        isAgent: true,
        notifyOnCompletion: false,
      });
      const spawn = lastSpawn(h);
      assert.equal(task.command, command);
      assert.equal(spawn.shell, 'C:\\Windows\\System32\\cmd.exe');
      assert.deepEqual(spawn.args, ['/d', '/s', '/c', `"${command}"`]);
      assert.equal(spawn.options.shell, undefined);
      assert.equal(spawn.options.windowsVerbatimArguments, true);
      assert.equal(task.telemetryWrapped, undefined);
      assert.equal(task.telemetryUnavailableReason, WIN32_CMD_PI_TELEMETRY_UNAVAILABLE_REASON);
      const files = await readdir(dirname(task.outputAbsPath));
      assert.equal(
        files.some((file) => file.includes('pi-telemetry-wrapper')),
        false,
      );
      const metadata = parseJsonObject(
        await readFile(task.metadataAbsPath, 'utf8'),
        'metadata must be an object',
      );
      assert.equal(
        metadata['telemetryUnavailableReason'],
        WIN32_CMD_PI_TELEMETRY_UNAVAILABLE_REASON,
      );
      spawn.child.close(0, null);
      await waitFor(() => task.status === 'completed', 'cmd telemetry task completion');
      assert.equal(await readFile(task.outputAbsPath, 'utf8'), '');
    } finally {
      await cleanup(h.root);
    }
  });

  void it('rejects unresolved Windows bash before creating a task', async () => {
    const h = await createHarness({ platform: 'win32', env: { UNIPI_BG_SHELL: 'bash', PATH: '' } });
    try {
      await assert.rejects(
        h.registry.startTask(h.ctx, 'echo ok', { name: 'Bad Bash', notifyOnCompletion: false }),
        /could not resolve bash/,
      );
      assert.equal(h.children.length, 0);
      assert.equal(h.registry.allTasks().length, 0);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('uses POSIX process-group kill before child fallback', async () => {
    let childRef: FakeChild | undefined;
    const killCalls: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
    const h = await createHarness({
      platform: 'darwin',
      killProcess: (pid, signal) => {
        const call: { pid: number; signal?: NodeJS.Signals | number } = { pid };
        if (signal !== undefined) call.signal = signal;
        killCalls.push(call);
        queueMicrotask(() => {
          childRef?.close(null, typeof signal === 'string' ? signal : null);
        });
        return true;
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task, child } = await startFakeTask(h);
      await h.registry.stopTask(task, 'user');
      assert.deepEqual(killCalls, [{ pid: -child.pid, signal: 'SIGTERM' }]);
      assert.deepEqual(child.killCalls, []);
      assert.equal(task.status, 'killed');
    } finally {
      await cleanup(h.root);
    }
  });

  void it('falls back to child.kill when process-group kill fails and reports when both fail', async () => {
    const h = await createHarness({
      platform: 'linux',
      killProcess: () => {
        throw new Error('group unavailable');
      },
      childFactory: (pid) =>
        new FakeChild(pid, function (this: FakeChild, signal) {
          queueMicrotask(() => {
            this.close(null, signal ?? null);
          });
          return true;
        }),
    });
    try {
      const { task, child } = await startFakeTask(h, 'Fallback Kill');
      await h.registry.stopTask(task, 'user');
      assert.deepEqual(child.killCalls, ['SIGTERM']);
      assert.equal(task.status, 'killed');
    } finally {
      await cleanup(h.root);
    }

    const failing = await createHarness({
      platform: 'linux',
      killProcess: () => {
        throw new Error('group unavailable');
      },
      childFactory: (pid) =>
        new FakeChild(pid, () => {
          throw new Error('child unavailable');
        }),
    });
    try {
      const { task } = await startFakeTask(failing, 'Failed Kill');
      await assert.rejects(
        () => failing.registry.stopTask(task, 'user'),
        /Could not kill task[\s\S]*group unavailable[\s\S]*child unavailable/,
      );
      assert.equal(task.status, 'running');
    } finally {
      await cleanup(failing.root);
    }
  });

  void it('uses taskkill tree termination on Windows and never falls back to child.kill', async () => {
    let processKillCalled = false;
    let childRef: FakeChild | undefined;
    const killTreeCalls: Array<{ pid: number; phase: WindowsKillPhase }> = [];
    const h = await createHarness({
      platform: 'win32',
      killGraceMs: 20,
      stopWaitMs: 500,
      killProcess: () => {
        processKillCalled = true;
        return true;
      },
      killTree: (pid, phase) => {
        killTreeCalls.push({ pid, phase });
        if (phase === 'force') {
          queueMicrotask(() => {
            childRef?.close(null, 'SIGKILL');
          });
        }
        return Promise.resolve(taskkillOutcome(0));
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid, () => {
          throw new Error('root-only kill must not run');
        });
        return childRef;
      },
    });
    try {
      const { task, child } = await startFakeTask(h, 'Windows Kill');
      await h.registry.stopTask(task, 'user');
      assert.equal(processKillCalled, false);
      assert.deepEqual(killTreeCalls, [
        { pid: child.pid, phase: 'terminate' },
        { pid: child.pid, phase: 'force' },
      ]);
      assert.deepEqual(child.killCalls, []);
      const windowsSpawn = h.children[0];
      assert.ok(windowsSpawn, 'Windows shell spawn should be recorded');
      // ComSpec is a full path on a real Windows host, so compare the basename.
      assert.equal(basename(windowsSpawn.shell).toLowerCase(), 'cmd.exe');
      assert.deepEqual(windowsSpawn.args.slice(0, 3), ['/d', '/s', '/c']);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('shares duplicate Windows graceful stops and aborts soft taskkill when force starts', async () => {
    let childRef: FakeChild | undefined;
    let softAbortCount = 0;
    let firstTimer: NodeJS.Timeout | undefined;
    const phases: WindowsKillPhase[] = [];
    const h = await createHarness({
      platform: 'win32',
      killGraceMs: 20,
      stopWaitMs: 500,
      killTree: (_pid, phase, signal) => {
        phases.push(phase);
        if (phase === 'terminate') {
          if (signal !== undefined) {
            signal.addEventListener(
              'abort',
              () => {
                softAbortCount += 1;
              },
              { once: true },
            );
          }
          return new Promise<TaskkillOutcome>(() => undefined);
        }
        assert.equal(signal, undefined, 'force taskkill must not reuse the soft abort signal');
        assert.equal(softAbortCount, 1, 'soft attempt should be aborted before force starts');
        queueMicrotask(() => {
          childRef?.close(null, 'SIGKILL');
        });
        return Promise.resolve(taskkillOutcome(0));
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task } = await startFakeTask(h, 'Windows Duplicate Stop');
      const first = h.registry.stopTask(task, 'user');
      firstTimer = task.killEscalationTimer;
      assert.ok(firstTimer, 'first graceful stop should arm an escalation timer');
      const second = h.registry.stopTask(task, 'user');
      const third = h.registry.stopTask(task, 'user');
      assert.equal(task.killEscalationTimer, firstTimer, 'duplicate stops must share one timer');
      await Promise.all([first, second, third]);
      assert.deepEqual(phases, ['terminate', 'force']);
      assert.equal(task.killEscalationTimer, undefined);
      assert.equal(softAbortCount, 1);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('treats explicit Windows force as terminal and does not arm escalation', async () => {
    const phases: WindowsKillPhase[] = [];
    const h = await createHarness({
      platform: 'win32',
      killGraceMs: 20,
      killTree: (_pid, phase) => {
        phases.push(phase);
        return Promise.resolve(taskkillOutcome(0));
      },
    });
    try {
      const { task } = await startFakeTask(h, 'Windows Explicit Force');
      requestKillForTest(h.registry, task, 'SIGKILL');
      assert.equal(task.killEscalationTimer, undefined);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.deepEqual(phases, ['force']);
      assert.equal(task.killEscalationTimer, undefined);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('records Windows taskkill exit 128 as an already-exited race', async () => {
    const h = await createHarness({
      platform: 'win32',
      killGraceMs: 500,
      stopWaitMs: 1000,
      killTree: () => Promise.resolve(taskkillOutcome(128, 'process not found')),
    });
    try {
      const { task, child } = await startFakeTask(h, 'Windows Missing Process');
      const stopped = h.registry.stopTask(task, 'user');
      await waitFor(
        () => readFileSync(task.outputAbsPath, 'utf8').includes('process not found'),
        'exit 128 notice',
      );
      child.close(0, null);
      await stopped;
      assert.equal(task.status, 'killed');
      assert.match(await readFile(task.outputAbsPath, 'utf8'), /already-exited race/);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('persists a Windows soft failure and still escalates to force after grace', async () => {
    let childRef: FakeChild | undefined;
    const phases: WindowsKillPhase[] = [];
    const h = await createHarness({
      platform: 'win32',
      killGraceMs: 20,
      stopWaitMs: 500,
      killTree: (_pid, phase) => {
        phases.push(phase);
        if (phase === 'terminate') return Promise.resolve(taskkillOutcome(1, 'soft denied'));
        queueMicrotask(() => {
          childRef?.close(null, 'SIGKILL');
        });
        return Promise.resolve(taskkillOutcome(0));
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task } = await startFakeTask(h, 'Windows Soft Failure');
      await h.registry.stopTask(task, 'user');
      assert.deepEqual(phases, ['terminate', 'force']);
      assert.match(task.error ?? '', /soft denied/);
      const metadata = parseJsonObject(await readFile(task.metadataAbsPath, 'utf8'), 'metadata');
      assert.match(String(metadata['error']), /soft denied/);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('surfaces Windows force failure loudly without root-only fallback', async () => {
    const h = await createHarness({
      platform: 'win32',
      killGraceMs: 20,
      stopWaitMs: 500,
      killTree: (_pid, phase) =>
        Promise.resolve(
          phase === 'terminate'
            ? taskkillOutcome(1, 'soft denied')
            : taskkillOutcome(5, 'force denied'),
        ),
      childFactory: (pid) =>
        new FakeChild(pid, () => {
          throw new Error('root-only kill must not run');
        }),
    });
    try {
      const { task, child } = await startFakeTask(h, 'Windows Force Failure');
      await assert.rejects(
        () => h.registry.stopTask(task, 'user'),
        /Windows taskkill \/T \/F force termination failed[\s\S]*Descendant processes may have leaked/,
      );
      assert.equal(task.status, 'running');
      assert.match(task.error ?? '', /force denied/);
      assert.deepEqual(child.killCalls, []);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('keeps terminal metadata running until in-flight Windows force settles', async () => {
    let childRef: FakeChild | undefined;
    let forceStarted = false;
    const force = deferred<TaskkillOutcome>();
    const terminals: BgTaskSnapshot[] = [];
    const h = await createHarness({
      platform: 'win32',
      killGraceMs: 20,
      stopWaitMs: 1000,
      publishTerminal: (task) => {
        terminals.push(task);
      },
      killTree: (_pid, phase) => {
        if (phase === 'terminate') return Promise.resolve(taskkillOutcome(0));
        forceStarted = true;
        queueMicrotask(() => {
          childRef?.close(null, 'SIGKILL');
        });
        return force.promise;
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task } = await startFakeTask(h, 'Windows Force Barrier');
      const stopped = h.registry.stopTask(task, 'user');
      await waitFor(() => forceStarted, 'force taskkill start');
      await waitFor(() => task.finalized === true, 'child close reached finalization');
      const runningMetadata = parseJsonObject(
        await readFile(task.metadataAbsPath, 'utf8'),
        'metadata before force settles',
      );
      assert.equal(runningMetadata['status'], 'running');
      assert.equal(terminals.length, 0);
      force.resolve(taskkillOutcome(0));
      await stopped;
      assert.equal(task.status, 'killed');
      const terminalMetadata = parseJsonObject(
        await readFile(task.metadataAbsPath, 'utf8'),
        'metadata after force settles',
      );
      assert.equal(terminalMetadata['status'], 'killed');
      assert.equal(terminals.length, 1);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('keeps duplicate stop requests idempotent and escalates to SIGKILL after grace', async () => {
    let childRef: FakeChild | undefined;
    const killCalls: Array<NodeJS.Signals | number | undefined> = [];
    const h = await createHarness({
      platform: 'linux',
      killGraceMs: 20,
      stopWaitMs: 500,
      killProcess: (_pid, signal) => {
        killCalls.push(signal);
        if (signal === 'SIGKILL') {
          queueMicrotask(() => {
            childRef?.close(null, 'SIGKILL');
          });
        }
        return true;
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task } = await startFakeTask(h, 'Escalate Kill');
      const first = h.registry.stopTask(task, 'user');
      const second = h.registry.stopTask(task, 'user');
      await Promise.all([first, second]);
      assert.deepEqual(killCalls, ['SIGTERM', 'SIGKILL']);
      assert.equal(task.status, 'killed');
      assert.equal(task.killEscalationTimer, undefined, 'escalation timer must be cleared');
    } finally {
      await cleanup(h.root);
    }
  });

  void it('schedules exactly one SIGKILL escalation for concurrent stop requests', async () => {
    // Regression: SIGTERM de-duplication guarded the signal but not the timer,
    // so each concurrent stopTask scheduled its own escalation. When the child
    // outlived the grace window that produced duplicate SIGKILLs.
    const killCalls: Array<NodeJS.Signals | number | undefined> = [];
    const h = await createHarness({
      platform: 'linux',
      killGraceMs: 20,
      stopWaitMs: 120,
      // Never close the child, so every scheduled escalation timer can fire.
      killProcess: (_pid, signal) => {
        killCalls.push(signal);
        return true;
      },
      childFactory: (pid) => new FakeChild(pid),
    });
    try {
      const { task } = await startFakeTask(h, 'Escalate Once');
      await Promise.all([
        h.registry.stopTask(task, 'user').catch(() => undefined),
        h.registry.stopTask(task, 'user').catch(() => undefined),
        h.registry.stopTask(task, 'user').catch(() => undefined),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.deepEqual(
        killCalls,
        ['SIGTERM', 'SIGKILL'],
        'concurrent stop requests must escalate to SIGKILL exactly once',
      );
    } finally {
      await cleanup(h.root);
    }
  });

  void it('finalizes and notifies once under error/close and output-cap races', async () => {
    const h = await createHarness({
      maxOutputBytes: 8,
      killProcess: () => true,
    });
    try {
      const { task, child } = await startFakeTask(h, 'Race Failure');
      child.fail(new Error('spawn exploded'));
      child.close(0, null);
      await waitFor(() => task.status !== 'running', 'spawn race finalization');
      await waitFor(() => h.notifications.length === 1, 'single spawn-race notification');
      assert.equal(task.status, 'failed');
      assert.match(task.error ?? '', /spawn exploded/);
      assert.equal(h.notifications.length, 1);
      // BUG-181: the terminal event itself is authoritative; agents must not poll to reconfirm it.
      const notification = h.notifications[0];
      assert.ok(notification, 'terminal notification should be captured');
      assert.match(
        notification.message.content,
        /<guidance>Terminal state and output metadata are durable\. Do not call bg_status to reconfirm; use bg_logs only if output is needed\.<\/guidance>/,
      );
      assert.deepEqual(notification.options, { deliverAs: 'followUp', triggerTurn: true });

      const capped = await h.registry.startTask(h.ctx, 'node noisy.js', {
        name: 'Output Race',
        notifyOnCompletion: true,
        triggerOnCompletion: true,
      });
      const cappedChild = lastSpawn(h).child;
      cappedChild.writeStdout('0123456789abcdef');
      cappedChild.close(1, null);
      cappedChild.close(0, null);
      await waitFor(() => capped.status !== 'running', 'output-cap finalization');
      await waitFor(() => h.notifications.length === 2, 'single output-cap notification');
      assert.equal(capped.status, 'failed');
      assert.match(capped.error ?? '', /Output exceeded cap/);
      assert.equal(h.notifications.length, 2);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('publishes terminal snapshots exactly once after durable metadata', async () => {
    const terminals: BgTaskSnapshot[] = [];
    const metadataStatuses: unknown[] = [];
    let metadataPath = '';
    const h = await createHarness({
      publishTerminal: (task) => {
        terminals.push(task);
        metadataStatuses.push(
          parseJsonObject(readFileSync(metadataPath, 'utf8'), 'terminal metadata must be written')[
            'status'
          ],
        );
      },
    });
    try {
      const { task, child } = await startFakeTask(h, 'Terminal Once');
      metadataPath = task.metadataAbsPath;
      child.close(0, null);
      child.close(1, null);
      await waitFor(() => task.status !== 'running', 'terminal status');
      await waitFor(() => terminals.length === 1, 'single terminal publication');
      const terminal = terminals[0];
      assert.ok(terminal, 'terminal snapshot should be present');
      assert.equal(terminal.id, task.id);
      assert.equal(terminal.status, 'completed');
      assert.deepEqual(metadataStatuses, ['completed']);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('keeps failed terminal EventBus delivery loud and retriable', async () => {
    const terminals: BgTaskSnapshot[] = [];
    let attempts = 0;
    const h = await createHarness({
      publishTerminal: (task) => {
        attempts += 1;
        if (attempts === 1) throw new Error('terminal bus unavailable');
        terminals.push(task);
      },
    });
    try {
      const { task, child } = await startFakeTask(h, 'Terminal Retry');
      child.close(0, null);
      await waitFor(() => task.status === 'completed', 'terminal retry completion');
      await waitFor(() => terminals.length === 1, 'terminal retry publication');
      assert.equal(attempts, 2);
      assert.equal(task.terminalPublished, true);
      assert.equal(terminals[0]?.id, task.id);
      assert.match(
        h.errors.flat().join(' '),
        /terminal publication failed|terminal bus unavailable/,
      );
    } finally {
      await cleanup(h.root);
    }
  });

  void it('resets notified when completion notification delivery fails and records loud metadata errors', async () => {
    const failingNotify = await createHarness({
      sendCompletionNotification: () => {
        throw new Error('send failed');
      },
    });
    try {
      const { task, child } = await startFakeTask(failingNotify, 'Notify Failure');
      child.close(0, null);
      await waitFor(() => task.status === 'completed', 'notification failure task completion');
      await waitFor(() => failingNotify.errors.length > 0, 'notification failure log');
      assert.equal(task.notified, false);
      const metadata = parseJsonObject(
        await readFile(task.metadataAbsPath, 'utf8'),
        'notification metadata must be an object',
      );
      assert.equal(metadata['notified'], false);
      assert.match(failingNotify.errors.flat().join(' '), /notification failed|send failed/);
    } finally {
      await cleanup(failingNotify.root);
    }

    const metadataFailure = await createHarness();
    try {
      const { task, child } = await startFakeTask(metadataFailure, 'Metadata Failure');
      // OUR runtime dir lives under UNIPI_BG_TMP_DIR (not .pi/tasks); delete it to force
      // the terminal-metadata write failure this test exercises.
      await rm(task.outputAbsPath, { recursive: true, force: true });
      await rm(join(task.outputAbsPath, '..'), { recursive: true, force: true });
      child.close(0, null);
      await waitFor(() => task.status === 'failed', 'metadata failure task completion');
      await waitFor(
        () => metadataFailure.notifications.length === 1,
        'notification despite metadata failure',
      );
      await waitFor(() => metadataFailure.errors.length > 0, 'metadata failure log');
      assert.equal(task.notified, true);
      assert.match(task.error ?? '', /Terminal metadata write failed/);
      assert.match(
        metadataFailure.errors.flat().join(' '),
        /failed to (write failed terminal|write|update )?metadata|ENOENT/,
      );
    } finally {
      await cleanup(metadataFailure.root);
    }
  });

  void it('ingests split, malformed, and large telemetry records without losing task state', async () => {
    const h = await createHarness();
    try {
      const { task, child } = await startFakeTask(h, 'Telemetry Chunks');
      child.writeStdout('not-json-but-user-output\n');
      child.writeStdout('{"type":"background-task-telemetry",');
      assert.equal(task.contextUsage, undefined);

      const byName = Object.fromEntries(
        Array.from({ length: 2500 }, (_, index) => [`tool-${String(index)}`, 1]),
      );
      const telemetry = JSON.stringify({
        type: 'background-task-telemetry',
        contextUsage: { tokens: 12_345, contextWindow: 200_000, percent: 6.1725 },
        tokenUsage: {
          input: 10_000,
          output: 2000,
          cacheRead: 300,
          cacheWrite: 45,
          totalTokens: 12_345,
        },
        toolUsage: { total: 2500, failed: 3, byName },
        model: 'openai-codex/gpt-5.5',
      });
      assert.ok(telemetry.length > 16 * 1024, 'fixture must exceed the old 16KiB telemetry buffer');
      const telemetryPrefix = '{"type":"background-task-telemetry",';
      assert.ok(telemetry.startsWith(telemetryPrefix));
      const continuation = telemetry.slice(telemetryPrefix.length);
      for (const chunk of [
        continuation.slice(0, 257),
        ...(continuation.slice(257).match(/.{1,113}/gs) ?? []),
        '\n',
      ]) {
        child.writeStdout(chunk);
      }

      assert.deepEqual(task.contextUsage, {
        tokens: 12_345,
        contextWindow: 200_000,
        percent: 6.1725,
      });
      assert.deepEqual(task.tokenUsage, {
        input: 10_000,
        output: 2000,
        cacheRead: 300,
        cacheWrite: 45,
        totalTokens: 12_345,
      });
      const toolUsage = task.toolUsage;
      assert.ok(toolUsage, 'valid telemetry should populate tool usage');
      assert.equal(toolUsage.total, 2500);
      assert.equal(toolUsage.failed, 3);
      assert.equal(toolUsage.byName['tool-2499'], 1);
      assert.equal(task.model, 'openai-codex/gpt-5.5');

      child.writeStdout('{"type":"background-task-telemetry",bad}\n');
      const retainedToolUsage = task.toolUsage;
      assert.ok(retainedToolUsage, 'malformed telemetry must not clear previous tool usage');
      assert.equal(retainedToolUsage.total, 2500);
      assert.equal(task.model, 'openai-codex/gpt-5.5');
      child.close(0, null);
      await waitFor(() => task.status === 'completed', 'telemetry task completion');
      let metadata = await readJsonEventually(task.metadataAbsPath);
      for (let attempt = 0; attempt < 20; attempt++) {
        metadata = await readJsonEventually(task.metadataAbsPath);
        if (JSON.stringify(metadata['tokenUsage']) === JSON.stringify(task.tokenUsage)) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.deepEqual(metadata['tokenUsage'], task.tokenUsage);
      const metadataToolUsage = requiredJsonObject(
        metadata['toolUsage'],
        'metadata tool usage must be an object',
      );
      const metadataToolCounts = requiredJsonObject(
        metadataToolUsage['byName'],
        'metadata tool counts must be an object',
      );
      assert.equal(metadataToolCounts['tool-2499'], 1);
      assert.equal(metadata['model'], 'openai-codex/gpt-5.5');
    } finally {
      await cleanup(h.root);
    }
  });

  void it('renders wrapped Pi-agent activity transcripts and keeps telemetry out of the output file', async () => {
    const h = await createHarness({ platform: 'linux' });
    try {
      const task = await h.registry.startTask(h.ctx, 'pi -p hello', {
        name: 'Wrapped Agent',
        isAgent: true,
        notifyOnCompletion: false,
      });
      assert.equal(task.telemetryWrapped, true);
      const child = lastSpawn(h).child;

      child.writeStdout(
        '{"type":"background-task-activity","kind":"tool_start","tool":"read","argsSummary":"README.md"}\n',
      );
      // Telemetry split across two stdout chunks must reassemble before parsing.
      child.writeStdout(
        '{"type":"background-task-telemetry","tokenUsage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":15},',
      );
      child.writeStdout(
        '"toolUsage":{"total":1,"failed":1,"byName":{"read":1}},"model":"prov/model","contextUsage":{"tokens":15,"contextWindow":1000,"percent":1.5}}\n',
      );
      child.writeStdout(
        '{"type":"background-task-activity","kind":"tool_end","tool":"read","isError":true,"error":"boom"}\n',
      );
      child.writeStdout(
        '{"type":"background-task-activity","kind":"assistant_text","text":"final answer"}\n',
      );
      child.writeStderr('child stderr diagnostic\n');
      // Trailing partial line (no newline) must be flushed verbatim on finalize.
      child.writeStdout('trailing fragment without newline');

      assert.deepEqual(task.tokenUsage, {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
      });
      assert.deepEqual(task.toolUsage, { total: 1, failed: 1, byName: { read: 1 } });
      assert.equal(task.model, 'prov/model');
      assert.deepEqual(task.contextUsage, { tokens: 15, contextWindow: 1000, percent: 1.5 });

      child.close(0, null);
      await waitFor(() => task.status === 'completed', 'wrapped-agent completion');

      let output = '';
      await waitFor(() => {
        try {
          output = readFileSync(task.outputAbsPath, 'utf8');
        } catch {
          output = '';
        }
        return output.includes('trailing fragment without newline');
      }, 'wrapped-agent transcript flushed');

      assert.match(output, /\u2192 read README\.md/);
      assert.match(output, /\u2717 read failed: boom/);
      assert.match(output, /^final answer$/m);
      assert.match(output, /child stderr diagnostic/);
      assert.doesNotMatch(output, /background-task-telemetry/);
      assert.doesNotMatch(output, /background-task-activity/);
      assert.doesNotMatch(output, /"kind"/);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('preserves split multiline XML context telemetry across newline boundaries', async () => {
    const h = await createHarness();
    try {
      const { task, child } = await startFakeTask(h, 'XML Telemetry');
      child.writeStdout('prefix\n<background-task-context-usage>\n  <tokens>321</tokens>\n');
      assert.equal(task.contextUsage, undefined);
      child.writeStdout(
        '  <context-window>1000</context-window>\n  <percent>32.1</percent>\n</background-task-context-usage>\n',
      );
      assert.deepEqual(task.contextUsage, { tokens: 321, contextWindow: 1000, percent: 32.1 });
      child.close(0, null);
      await waitFor(() => task.status === 'completed', 'xml telemetry task completion');
    } finally {
      await cleanup(h.root);
    }
  });

  void it('produces a direct-spawn attested Pi sidecar with raw events, stderr, hashes, and exact argv', async () => {
    const h = await createHarness({ modelRegistry: oauthRegistry() });
    try {
      await initCleanGit(h.cwd);
      const task = await h.registry.startAttestedPiTask(h.ctx, {
        name: 'Unit Attested',
        provider: 'openai-codex',
        model: 'gpt-5.5',
        prompt: 'write report.md',
        reportPath: 'report.md',
        extraPiArgs: ['--no-extensions'],
      });
      await writeFile(join(h.cwd, 'report.md'), 'unit report\n', 'utf8');
      assert.match(task.id, /^b[0-9a-f]{32}$/);
      const spawn = lastSpawn(h);
      // This harness inherits the host platform, so the launch shape is
      // asserted per platform. On POSIX the resolved executable is the `pi`
      // entry on PATH. On Windows npm installs `pi` as a `pi.cmd` shim that a
      // shell-less spawn cannot resolve, so the Pi package bin is launched
      // through the current Node executable instead. Both are correct
      // production behaviour for their platform.
      const piArgs = process.platform === 'win32' ? spawn.args.slice(1) : [...spawn.args];
      if (process.platform === 'win32') {
        assert.equal(spawn.shell, process.execPath);
        assert.ok(
          spawn.args[0]?.endsWith('cli.js'),
          'Windows launches the resolved Pi bin as the first argument',
        );
      } else {
        assert.equal(spawn.shell, 'pi');
      }
      assert.equal(spawn.options.env?.['OPENAI_API_KEY'], undefined);
      assert.equal(spawn.options.env?.['OPENAI_BASE_URL'], undefined);
      assert.equal(spawn.options.env?.['ANTHROPIC_API_KEY'], undefined);
      assert.equal(spawn.options.env?.['OPENROUTER_API_KEY'], undefined);
      assert.deepEqual(piArgs, [
        '--mode',
        'json',
        '--provider',
        'openai-codex',
        '--model',
        'gpt-5.5',
        '--no-extensions',
        'write report.md',
      ]);
      spawn.child.writeStdout(piJsonEvents());
      spawn.child.writeStderr('diagnostic\n');
      spawn.child.close(0, null);
      await waitFor(() => task.status === 'completed', 'attested sidecar completion');
      assert.ok(task.attestationAbsPath, 'attestation path should be recorded on task');
      assert.equal(
        existsSync(task.attestationAbsPath ?? ''),
        true,
        'completed must not become externally visible before the attestation is durable',
      );
      const attestation = parseJsonObject(
        await readFile(task.attestationAbsPath, 'utf8'),
        'attestation sidecar must be an object',
      );
      assert.equal(attestation['schema_version'], 'phase2.pi_task_attestation.v1');
      assert.equal(
        requiredJsonObject(attestation['lifecycle'], 'lifecycle')['status'],
        'completed',
      );
      const invocation = requiredJsonObject(attestation['invocation'], 'invocation');
      assert.equal(invocation['pi_session_id'], 'pi-session-unit');
      assert.equal(invocation['provider'], 'openai-codex');
      assert.equal(invocation['model_id'], 'gpt-5.5');
      assert.equal(invocation['credential_kind'], 'oauth');
      assert.equal(invocation['direct_api_key'], false);
      // The recorded evidence argv is the logical Pi invocation on every
      // platform. It deliberately stays ['pi', ...] rather than echoing the
      // Windows Node-plus-cli.js launch form, so attestation evidence keeps one
      // stable meaning across platforms.
      assert.deepEqual(invocation['argv'], ['pi', ...piArgs]);
      const sourceHashes = requiredJsonObject(attestation['source_hashes'], 'source hashes');
      const artifacts = requiredJsonObject(attestation['artifacts'], 'artifacts');
      assert.equal(
        requiredJsonObject(artifacts['task_output'], 'task output artifact')['sha256'],
        sourceHashes['output_sha256'],
      );
      assert.equal(
        requiredJsonObject(artifacts['stderr'], 'stderr artifact')['sha256'],
        sourceHashes['stderr_sha256'],
      );
      assert.equal(
        requiredJsonObject(artifacts['transcript'], 'transcript artifact')['sha256'],
        sourceHashes['events_sha256'],
      );
      assert.match(await readFile(task.outputAbsPath, 'utf8'), /attested done/);
      assert.match(await readFile(task.eventsAbsPath ?? '', 'utf8'), /pi-session-unit/);
      assert.match(await readFile(task.stderrAbsPath ?? '', 'utf8'), /diagnostic/);
      const metadata = parseJsonObject(
        await readFile(task.metadataAbsPath, 'utf8'),
        'metadata must remain parseable after attestation',
      );
      assert.equal(metadata['bytesWritten'], readFileSync(task.outputAbsPath).length);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('rejects duplicate thinking in attested Pi extra args before spawn', async () => {
    const h = await createHarness({ modelRegistry: oauthRegistry() });
    try {
      await initCleanGit(h.cwd);
      await assert.rejects(
        h.registry.startAttestedPiTask(h.ctx, {
          name: 'Duplicate Thinking',
          provider: 'openai-codex',
          model: 'gpt-5.5',
          thinking: 'high',
          prompt: 'write report.md',
          reportPath: 'report.md',
          extraPiArgs: ['--thinking', 'low'],
        }),
        /structured thinking field|duplicate Pi args/,
      );
      assert.equal(h.children.length, 0, 'duplicate thinking must fail before spawning pi');
    } finally {
      await cleanup(h.root);
    }
  });

  void it('launches attested Pi on Windows through Node while preserving logical argv', async () => {
    const h = await createHarness({ platform: 'win32', modelRegistry: oauthRegistry() });
    try {
      await initCleanGit(h.cwd);
      const prompt = 'write report.md & echo pwned "%VAR%" C:\\tmp\\space path\\';
      const task = await h.registry.startAttestedPiTask(h.ctx, {
        name: 'Win Attested',
        provider: 'openai-codex',
        model: 'gpt-5.5',
        prompt,
        reportPath: 'report.md',
        extraPiArgs: ['--no-extensions', 'quoted "value"'],
      });
      await writeFile(join(h.cwd, 'report.md'), 'unit report\n', 'utf8');
      const spawn = lastSpawn(h);
      assert.equal(spawn.shell, process.execPath);
      assert.equal(spawn.options.shell, false);
      assert.equal(spawn.options.detached, false);
      assert.equal(spawn.args.at(-1), prompt);
      assert.ok(spawn.args[0]?.endsWith('cli.js'));
      assert.deepEqual(spawn.args.slice(1), [
        '--mode',
        'json',
        '--provider',
        'openai-codex',
        '--model',
        'gpt-5.5',
        '--no-extensions',
        'quoted "value"',
        prompt,
      ]);
      spawn.child.writeStdout(piJsonEvents());
      spawn.child.close(0, null);
      await waitFor(() => task.status === 'completed', 'Windows attested completion');
      assert.ok(task.attestationAbsPath);
      const attestation = parseJsonObject(
        await readFile(task.attestationAbsPath, 'utf8'),
        'attestation sidecar must be an object',
      );
      const invocation = requiredJsonObject(attestation['invocation'], 'invocation');
      assert.deepEqual(invocation['argv'], [
        'pi',
        '--mode',
        'json',
        '--provider',
        'openai-codex',
        '--model',
        'gpt-5.5',
        '--no-extensions',
        'quoted "value"',
        prompt,
      ]);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('strips metered API environment from attested Pi child process', async () => {
    const h = await createHarness({
      modelRegistry: oauthRegistry(),
      env: {
        ...process.env,
        OPENAI_API_KEY: 'metered-openai',
        OPENAI_BASE_URL: 'https://api.openai.invalid',
        ANTHROPIC_API_KEY: 'metered-anthropic',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.invalid',
        OPENROUTER_API_KEY: 'metered-openrouter',
        OPENROUTER_BASE_URL: 'https://openrouter.invalid',
        PI_API_KEY: 'metered-pi',
        PI_AUTH_FILE: '/tmp/forbidden-auth.json',
      },
    });
    try {
      await initCleanGit(h.cwd);
      const task = await h.registry.startAttestedPiTask(h.ctx, {
        name: 'Env Strip',
        provider: 'openai-codex',
        model: 'gpt-5.5',
        prompt: 'write report.md',
        reportPath: 'report.md',
      });
      await writeFile(join(h.cwd, 'report.md'), 'unit report\n', 'utf8');
      const spawn = lastSpawn(h);
      for (const key of [
        'OPENAI_API_KEY',
        'OPENAI_BASE_URL',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_BASE_URL',
        'OPENROUTER_API_KEY',
        'OPENROUTER_BASE_URL',
        'PI_API_KEY',
        'PI_AUTH_FILE',
      ]) {
        assert.equal(spawn.options.env?.[key], undefined, `${key} must be stripped`);
      }
      spawn.child.writeStdout(piJsonEvents());
      spawn.child.close(0, null);
      await waitFor(() => task.status === 'completed', 'attested env-strip completion');
    } finally {
      await cleanup(h.root);
    }
  });

  void it('rejects malformed attested Pi events and does not emit a sidecar', async () => {
    const h = await createHarness({ modelRegistry: oauthRegistry() });
    try {
      await initCleanGit(h.cwd);
      const task = await h.registry.startAttestedPiTask(h.ctx, {
        name: 'Bad Attested',
        provider: 'openai-codex',
        model: 'gpt-5.5',
        prompt: 'write report.md',
        reportPath: 'report.md',
      });
      await writeFile(join(h.cwd, 'report.md'), 'unit report\n', 'utf8');
      lastSpawn(h).child.writeStdout('{"type":"session","id":"s","cwd":"/tmp"}\n');
      lastSpawn(h).child.close(0, null);
      await waitFor(() => task.status === 'failed', 'malformed attested failure');
      assert.match(task.error ?? '', /agent_start|assistant|agent_end|session/i);
      assert.equal(existsSync(task.attestationAbsPath ?? ''), false);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('keeps ordinary bg_run tasks free of attestation sidecars', async () => {
    const h = await createHarness();
    try {
      const { task, child } = await startFakeTask(h, 'Ordinary No Sidecar');
      child.writeStdout('ordinary\n');
      child.close(0, null);
      await waitFor(() => task.status === 'completed', 'ordinary completion');
      assert.equal(task.attestationPath, undefined);
      assert.equal(existsSync(task.outputAbsPath.replace(/\.output$/, '.attestation.json')), false);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('tracks managed Fusion completion, durable progress, once-only usage, and cancellation', async () => {
    const h = await createHarness({ stopWaitMs: 100 });
    try {
      let complete: (() => void) | undefined;
      const completion = new Promise<void>((resolve) => {
        complete = resolve;
      });
      let releaseTerminal: (() => void) | undefined;
      const terminalPublicationGate = new Promise<void>((resolve) => {
        releaseTerminal = resolve;
      });
      const facts = {
        runId: 'reason-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        workflow: 'reason' as const,
        artifactDir: '.pi/fusion/test/reason-a',
        artifactDirAbs: join(h.cwd, '.pi', 'fusion', 'test', 'reason-a'),
        state: 'initializing',
        usageDelivered: false,
      };
      const task = await h.registry.startManagedTask(h.ctx, {
        id: facts.runId,
        name: 'fusion reason',
        command: 'fusion_reason',
        isAgent: true,
        completion,
        cancel: () => undefined,
        notifyOnCompletion: true,
        triggerOnCompletion: true,
        fusion: facts,
        terminalPublicationGate,
      });
      assert.equal(h.children.length, 0, 'managed task must not create a registry child process');
      await h.registry.updateManagedTask(task, 'candidates_running', 'candidate wave started');
      assert.equal(task.fusion?.state, 'candidates_running');
      assert.match(await readFile(task.outputAbsPath, 'utf8'), /candidate wave started/);
      assert.equal(await h.registry.claimFusionUsage(task), true);
      assert.equal(await h.registry.claimFusionUsage(task), false);
      assert.equal(task.fusion?.usageDelivered, true);
      complete?.();
      await waitFor(() => task.status === 'completed', 'managed Fusion completion');
      assert.equal(
        h.notifications.length,
        0,
        'completion must wait behind the launch publication gate',
      );
      releaseTerminal?.();
      await waitFor(() => h.notifications.length === 1, 'gated managed Fusion notification');
      assert.match(h.notifications[0]?.message.content ?? '', /Call bg_result/);

      let rejectCancelled: ((error: Error) => void) | undefined;
      const cancelled = new Promise<void>((_resolve, reject) => {
        rejectCancelled = reject;
      });
      const cancelledFacts = {
        ...facts,
        runId: 'reason-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        usageDelivered: false,
      };
      const cancelledTask = await h.registry.startManagedTask(h.ctx, {
        id: cancelledFacts.runId,
        name: 'fusion reason',
        command: 'fusion_reason',
        isAgent: true,
        completion: cancelled,
        cancel: () => rejectCancelled?.(new Error('fusion cancelled')),
        notifyOnCompletion: false,
        triggerOnCompletion: false,
        fusion: cancelledFacts,
        stopWaitMs: 100,
      });
      await h.registry.stopTask(cancelledTask, 'user');
      assert.equal(cancelledTask.status, 'killed');
      assert.equal(cancelledTask.managedCancelRequested, true);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('prunes oldest finished tasks while preserving running tasks', async () => {
    let clock = 1_000;
    const h = await createHarness({
      maxRecentTasks: 3,
      now: () => clock++,
    });
    try {
      const running = await h.registry.startTask(h.ctx, 'sleep forever', {
        name: 'Still Running',
        notifyOnCompletion: false,
      });
      assert.equal(running.status, 'running');

      for (let i = 1; i <= 4; i++) {
        const suffix = String(i);
        const task = await h.registry.startTask(h.ctx, `printf ${suffix}`, {
          name: `Finished ${suffix}`,
          notifyOnCompletion: false,
        });
        lastSpawn(h).child.close(0, null);
        await waitFor(() => task.status === 'completed', `finished ${suffix}`);
      }

      await waitFor(() => h.registry.allTasks().length <= 3, 'old finished tasks pruned');
      const names = h.registry
        .allTasks()
        .map((task) => task.name)
        .sort();
      assert.deepEqual(names, ['Finished 3', 'Finished 4', 'Still Running'].sort());
    } finally {
      await cleanup(h.root);
    }
  });
});
