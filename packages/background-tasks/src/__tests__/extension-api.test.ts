import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EventBus } from '@earendil-works/pi-coding-agent';
import {
  BG_EXTENSION_CAPABILITIES,
  BG_REQUEST_CHANNEL,
  BG_REQUEST_SCHEMA,
  BG_RESPONSE_CHANNEL,
  BG_RESPONSE_SCHEMA,
  BG_TERMINAL_CHANNEL,
  BG_TERMINAL_SCHEMA,
  installBackgroundTaskExtensionApi,
  type BackgroundTaskExtensionResponse,
  type BackgroundTaskExtensionService,
  type BackgroundTaskExtensionTerminal,
} from '../extension-api.js';
import {
  BackgroundTaskRegistry,
  type BackgroundTaskContext,
  type BackgroundTaskSpawn,
} from '../registry.js';
import type { TaskkillOutcome, WindowsKillPhase } from '../windows-taskkill.js';
import type { BgTaskSnapshot } from '../types.js';

class MemoryEventBus implements EventBus {
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();

  emit(channel: string, data: unknown): void {
    for (const listener of [...(this.listeners.get(channel) ?? [])]) listener(data);
  }

  on(channel: string, handler: (data: unknown) => void): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid: number;
  killCalls: Array<NodeJS.Signals | undefined> = [];
  closeOnKill = true;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killCalls.push(signal);
    if (this.closeOnKill) queueMicrotask(() => this.close(null, signal ?? 'SIGTERM'));
    return true;
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.emit('close', code, signal);
  }
}

interface Harness {
  root: string;
  ctx: BackgroundTaskContext;
  bus: MemoryEventBus;
  registry: BackgroundTaskRegistry;
  setCtx(value: BackgroundTaskContext | undefined): void;
  setShutdown(value: boolean): void;
  close(): void;
  spawnCount(): number;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-api-'));
  const cwd = join(root, 'project');
  await mkdir(cwd, { recursive: true });
  const bus = new MemoryEventBus();
  let currentCtx: BackgroundTaskContext | undefined;
  let shuttingDown = false;
  let spawns = 0;
  const registry = new BackgroundTaskRegistry({
    sendCompletionNotification: () => {},
    spawn: () => {
      spawns += 1;
      throw new Error('spawn should not be reached by this protocol test');
    },
  });
  const ctx: BackgroundTaskContext = {
    cwd,
    sessionId: 'extension-api-unit',
    modelRegistry: { getAll: () => [] },
    model: undefined,
  };
  currentCtx = ctx;
  const service = installBackgroundTaskExtensionApi({
    events: bus,
    registry,
    getContext: () => currentCtx,
    isShuttingDown: () => shuttingDown,
  });
  return {
    root,
    ctx,
    bus,
    registry,
    setCtx(value) {
      currentCtx = value;
    },
    setShutdown(value) {
      shuttingDown = value;
    },
    close() {
      service.close();
    },
    spawnCount() {
      return spawns;
    },
  };
}

interface ProtocolHarness {
  root: string;
  ctx: BackgroundTaskContext;
  bus: MemoryEventBus;
  children: FakeChild[];
  close(): void;
}

async function createProtocolHarness(
  options: {
    onSpawn?: ((child: FakeChild) => void) | undefined;
  } = {},
): Promise<ProtocolHarness> {
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-api-protocol-'));
  const cwd = join(root, 'project');
  await mkdir(cwd, { recursive: true });
  const bus = new MemoryEventBus();
  const children: FakeChild[] = [];
  let pid = 5100;
  let idSeq = 0;
  let service: BackgroundTaskExtensionService | undefined;
  const spawn: BackgroundTaskSpawn = () => {
    const child = new FakeChild(++pid);
    children.push(child);
    options.onSpawn?.(child);
    return child;
  };
  // This harness spawns a FakeChild rather than a real process, so its pid is
  // fabricated. Both termination seams are therefore injected and routed back
  // to the fake child.
  //
  // Without them the registry would resolve the live host platform: on Windows
  // it took the taskkill branch and issued a real process-tree kill against a
  // pid that never existed, so FakeChild.kill was never called, no 'close' was
  // ever emitted, and the task never reached a terminal state.
  //
  // Pinning the platform keeps this protocol test deterministic on every host.
  // Real Windows termination behaviour is proven on a real Windows host by
  // tests/windows/windows-integration.test.ts (grandchild tree teardown) and
  // by the injected killTree cases in tests/unit/registry.test.ts.
  const killProcess = (pid: number, signal?: NodeJS.Signals | number): boolean => {
    const target = children.find((child) => child.pid === Math.abs(pid));
    if (!target) throw new Error(`no fake child for pid ${String(pid)}`);
    target.kill(typeof signal === 'string' ? signal : 'SIGTERM');
    return true;
  };
  const killTree = (pid: number, phase: WindowsKillPhase): Promise<TaskkillOutcome> => {
    killProcess(pid, phase === 'force' ? 'SIGKILL' : 'SIGTERM');
    return Promise.resolve({
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  };
  const registry = new BackgroundTaskRegistry({
    makeTaskId: () => `bproto${String(++idSeq).padStart(3, '0')}`,
    sendCompletionNotification: () => {},
    killGraceMs: 20,
    stopWaitMs: 500,
    platform: 'linux',
    killProcess,
    killTree,
    spawn,
    publishTerminal: (task) => {
      if (!service) throw new Error('test EventBus service is not installed');
      service.publishTerminal(task);
    },
  });
  const ctx: BackgroundTaskContext = {
    cwd,
    sessionId: 'extension-api-protocol-unit',
    modelRegistry: { getAll: () => [] },
    model: undefined,
  };
  service = installBackgroundTaskExtensionApi({
    events: bus,
    registry,
    getContext: () => ctx,
    isShuttingDown: () => false,
  });
  return {
    root,
    ctx,
    bus,
    children,
    close() {
      service?.close();
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireResponse(value: unknown): BackgroundTaskExtensionResponse {
  assert.ok(isRecord(value), 'response must be an object');
  assert.equal(value['schema_version'], BG_RESPONSE_SCHEMA);
  assert.equal(typeof value['request_id'], 'string');
  assert.equal(typeof value['operation'], 'string');
  assert.equal(typeof value['ok'], 'boolean');
  const hasResult = Object.prototype.hasOwnProperty.call(value, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(value, 'error');
  assert.notEqual(hasResult, hasError, 'response must contain exactly one of result/error');
  return value as BackgroundTaskExtensionResponse;
}

function requireTask(value: unknown, label: string): BgTaskSnapshot {
  assert.ok(isRecord(value), `${label} must be an object`);
  const id = value['id'];
  const command = value['command'];
  const status = value['status'];
  const outputPath = value['outputPath'];
  if (typeof id !== 'string') assert.fail(`${label}.id`);
  if (typeof command !== 'string') assert.fail(`${label}.command`);
  if (
    status !== 'running' &&
    status !== 'completed' &&
    status !== 'failed' &&
    status !== 'killed'
  ) {
    assert.fail(`${label}.status`);
  }
  if (typeof outputPath !== 'string') assert.fail(`${label}.outputPath`);
  const partial = value as Partial<BgTaskSnapshot>;
  return {
    ...partial,
    id,
    command,
    status,
    outputPath,
    cwd: partial.cwd ?? '',
    startTime: partial.startTime ?? 0,
    bytesWritten: partial.bytesWritten ?? 0,
    isAgent: partial.isAgent ?? false,
    notified: partial.notified ?? false,
    notifyOnCompletion: partial.notifyOnCompletion ?? false,
    triggerOnCompletion: partial.triggerOnCompletion ?? false,
  };
}

function requireTerminal(value: unknown): BackgroundTaskExtensionTerminal {
  assert.ok(isRecord(value), 'terminal must be an object');
  assert.deepEqual(Object.keys(value).sort(), ['schema_version', 'task']);
  assert.equal(value['schema_version'], BG_TERMINAL_SCHEMA);
  return { schema_version: BG_TERMINAL_SCHEMA, task: requireTask(value['task'], 'terminal.task') };
}

function waitForResponse(
  bus: EventBus,
  requestId: string,
): Promise<BackgroundTaskExtensionResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for ${requestId}`));
    }, 500);
    const unsubscribe = bus.on(BG_RESPONSE_CHANNEL, (data) => {
      const response = requireResponse(data);
      if (response.request_id !== requestId) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(response);
    });
  });
}

async function emitRequest(
  bus: EventBus,
  request: unknown,
): Promise<BackgroundTaskExtensionResponse> {
  const requestId =
    isRecord(request) && typeof request['request_id'] === 'string'
      ? request['request_id']
      : 'malformed';
  const pending = waitForResponse(bus, requestId);
  bus.emit(BG_REQUEST_CHANNEL, request);
  return pending;
}

// This suite drives the EventBus terminal-publication protocol against an
// injected fake child, so no real process is ever created and the budget does
// not depend on host process-creation cost. A genuine hang must still fail
// fast on every platform.
const TERMINAL_WAIT_TIMEOUT_MS = 1500;

async function waitForTerminal(
  terminals: readonly BackgroundTaskExtensionTerminal[],
  taskId: string,
  timeoutMs = TERMINAL_WAIT_TIMEOUT_MS,
): Promise<BackgroundTaskExtensionTerminal> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const terminal = terminals.find((entry) => entry.task.id === taskId);
    if (terminal) return terminal;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for terminal ${taskId}`);
}

void describe('background EventBus protocol', () => {
  void it('handshakes capabilities and rejects malformed, duplicate, and unavailable requests', async () => {
    const h = await createHarness();
    try {
      const ok = await emitRequest(h.bus, {
        schema_version: BG_REQUEST_SCHEMA,
        request_id: 'cap-1',
        operation: 'capabilities',
        payload: {},
      });
      assert.equal(ok.ok, true);
      assert.deepEqual(ok.ok ? ok.result : undefined, BG_EXTENSION_CAPABILITIES);

      const duplicate = await emitRequest(h.bus, {
        schema_version: BG_REQUEST_SCHEMA,
        request_id: 'cap-1',
        operation: 'capabilities',
        payload: {},
      });
      assert.equal(duplicate.ok, false);
      assert.match(duplicate.ok ? '' : duplicate.error, /duplicate request_id/u);

      const unknown = await emitRequest(h.bus, {
        schema_version: BG_REQUEST_SCHEMA,
        request_id: 'unknown-op',
        operation: 'bogus',
        payload: {},
      });
      assert.equal(unknown.ok, false);
      assert.equal(unknown.operation, 'bogus');
      assert.match(unknown.ok ? '' : unknown.error, /capabilities, run, status, logs, kill/u);

      const extra = await emitRequest(h.bus, {
        schema_version: BG_REQUEST_SCHEMA,
        request_id: 'extra-key',
        operation: 'capabilities',
        payload: {},
        extra: true,
      });
      assert.equal(extra.ok, false);
      assert.match(extra.ok ? '' : extra.error, /unknown key extra/u);

      const notObject = await emitRequest(h.bus, []);
      assert.equal(notObject.ok, false);
      assert.equal(notObject.request_id, 'malformed');
      assert.match(notObject.ok ? '' : notObject.error, /request frame must be an object/u);

      const missingPayload = await emitRequest(h.bus, {
        schema_version: BG_REQUEST_SCHEMA,
        request_id: 'missing-payload',
        operation: 'status',
      });
      assert.equal(missingPayload.ok, false);
      assert.match(missingPayload.ok ? '' : missingPayload.error, /payload is required/u);

      const unknownPayloadKey = await emitRequest(h.bus, {
        schema_version: BG_REQUEST_SCHEMA,
        request_id: 'unknown-payload-key',
        operation: 'status',
        payload: { taskId: 'b123', extra: true },
      });
      assert.equal(unknownPayloadKey.ok, false);
      assert.match(unknownPayloadKey.ok ? '' : unknownPayloadKey.error, /unknown key extra/u);

      const malformedPayload = await emitRequest(h.bus, {
        schema_version: BG_REQUEST_SCHEMA,
        request_id: 'bad-run',
        operation: 'run',
        payload: {
          name: 'Bad Run',
          command: 'printf nope',
          isAgent: false,
          timeoutSeconds: null,
          notifyOnCompletion: true,
          triggerOnCompletion: true,
        },
      });
      assert.equal(malformedPayload.ok, false);
      assert.match(malformedPayload.ok ? '' : malformedPayload.error, /positive integer/u);
      assert.equal(h.spawnCount(), 0);

      h.setCtx(undefined);
      const missingCtx = await emitRequest(h.bus, {
        schema_version: BG_REQUEST_SCHEMA,
        request_id: 'missing-ctx',
        operation: 'capabilities',
        payload: {},
      });
      assert.equal(missingCtx.ok, false);
      assert.match(missingCtx.ok ? '' : missingCtx.error, /before session_start/u);

      h.setCtx(h.ctx);
      h.setShutdown(true);
      h.registry.setShuttingDown(true);
      const shutdown = await emitRequest(h.bus, {
        schema_version: BG_REQUEST_SCHEMA,
        request_id: 'shutdown',
        operation: 'status',
        payload: {},
      });
      assert.equal(shutdown.ok, false);
      assert.match(shutdown.ok ? '' : shutdown.error, /shutting down/u);
    } finally {
      h.close();
      await rm(h.root, { recursive: true, force: true });
    }
  });

  void it('publishes exactly one correlated terminal after the run response for every terminal path', async () => {
    async function runCase(options: {
      label: string;
      expectedStatus: 'completed' | 'failed' | 'killed';
      timeoutMs?: number | undefined;
      timeoutSeconds?: number | undefined;
      onSpawn?: ((child: FakeChild) => void) | undefined;
      afterRun?:
        | ((h: ProtocolHarness, task: BgTaskSnapshot, order: string[]) => Promise<void> | void)
        | undefined;
    }): Promise<void> {
      const h = await createProtocolHarness({ onSpawn: options.onSpawn });
      const terminals: BackgroundTaskExtensionTerminal[] = [];
      const order: string[] = [];
      const unsubscribeResponse = h.bus.on(BG_RESPONSE_CHANNEL, (data) => {
        const response = requireResponse(data);
        if (response.request_id === `run-${options.label}`) order.push('run-response');
        if (response.request_id === `kill-${options.label}`) order.push('kill-response');
      });
      const unsubscribeTerminal = h.bus.on(BG_TERMINAL_CHANNEL, (data) => {
        const terminal = requireTerminal(data);
        terminals.push(terminal);
        order.push(`terminal:${terminal.task.id}:${terminal.task.status}`);
      });
      try {
        // The spawn seam returns a FakeChild, so this command string is never
        // executed by a real shell. It is asserted verbatim on the task record.
        const echoCommand = `echo ${options.label}`;
        const payload: Record<string, unknown> = {
          name: `Case ${options.label}`,
          command: echoCommand,
          isAgent: false,
          notifyOnCompletion: false,
          triggerOnCompletion: false,
        };
        if (options.timeoutSeconds !== undefined)
          payload['timeoutSeconds'] = options.timeoutSeconds;
        const run = await emitRequest(h.bus, {
          schema_version: BG_REQUEST_SCHEMA,
          request_id: `run-${options.label}`,
          operation: 'run',
          payload,
        });
        assert.equal(run.ok, true, run.ok ? 'ok' : run.error);
        const task = requireTask(run.ok ? run.result : undefined, `${options.label}.run.result`);
        assert.equal(task.command, echoCommand);
        await options.afterRun?.(h, task, order);
        const terminal = await waitForTerminal(
          terminals,
          task.id,
          options.timeoutMs ?? TERMINAL_WAIT_TIMEOUT_MS,
        );
        assert.equal(terminal.task.id, task.id);
        assert.equal(terminal.task.status, options.expectedStatus);
        assert.equal(
          terminals.filter((entry) => entry.task.id === task.id).length,
          1,
          `${options.label} must publish exactly one terminal`,
        );
        const responseIndex = order.indexOf('run-response');
        const terminalIndex = order.findIndex((entry) => entry.startsWith(`terminal:${task.id}:`));
        assert.ok(responseIndex >= 0, `${options.label} missing run response order marker`);
        assert.ok(
          terminalIndex > responseIndex,
          `${options.label} terminal must follow run response`,
        );
        if (options.expectedStatus === 'killed') {
          const killResponseIndex = order.indexOf('kill-response');
          assert.ok(killResponseIndex >= 0, 'killed case missing kill response marker');
          assert.ok(terminalIndex > killResponseIndex, 'killed terminal must follow kill response');
        }
      } finally {
        unsubscribeTerminal();
        unsubscribeResponse();
        h.close();
        await new Promise((resolve) => setTimeout(resolve, 25));
        await rm(h.root, { recursive: true, force: true });
      }
    }

    await runCase({
      label: 'immediate',
      expectedStatus: 'completed',
      onSpawn: (child) => queueMicrotask(() => child.close(0, null)),
    });
    await runCase({
      label: 'normal',
      expectedStatus: 'completed',
      afterRun: (h) => h.children[0]?.close(0, null),
    });
    await runCase({
      label: 'failed',
      expectedStatus: 'failed',
      afterRun: (h) => h.children[0]?.close(9, null),
    });
    await runCase({
      label: 'timeout',
      expectedStatus: 'failed',
      timeoutSeconds: 1,
      timeoutMs: 2500,
    });
    await runCase({
      label: 'killed',
      expectedStatus: 'killed',
      afterRun: async (h, task) => {
        const kill = await emitRequest(h.bus, {
          schema_version: BG_REQUEST_SCHEMA,
          request_id: 'kill-killed',
          operation: 'kill',
          payload: { taskId: task.id },
        });
        assert.equal(kill.ok, true, kill.ok ? 'ok' : kill.error);
        const result = kill.ok ? kill.result : undefined;
        assert.ok(isRecord(result), 'kill result must be an object');
        const resultRecord: Record<string, unknown> = result;
        assert.equal(requireTask(resultRecord['task'], 'kill.result.task').status, 'killed');
      },
    });
  });

  void it('unsubscribes cleanly when the service closes', async () => {
    const h = await createHarness();
    try {
      h.close();
      const pending = waitForResponse(h.bus, 'after-close');
      h.bus.emit(BG_REQUEST_CHANNEL, {
        schema_version: BG_REQUEST_SCHEMA,
        request_id: 'after-close',
        operation: 'capabilities',
        payload: {},
      });
      await assert.rejects(pending, /timed out/u);
    } finally {
      await rm(h.root, { recursive: true, force: true });
    }
  });
});
