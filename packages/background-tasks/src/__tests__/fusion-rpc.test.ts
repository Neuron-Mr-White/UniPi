import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseJsonText } from '../types.js';
import { installFusionFakePi, resolveRealPiCli } from './helpers/fusion-fake-pi.js';
import { piLaunchArgv, resolvePiLaunch } from '../pi-launch.js';

// npm installs `pi` as a pi.cmd shim on Windows, and a shell-less spawn does not
// consult PATHEXT, so spawning the bare name fails with ENOENT. Production resolves
// the Pi package bin and launches it through Node; reusing that resolver keeps this
// harness aligned with real launch behaviour on every platform.
const piLaunch = resolvePiLaunch();
import { isolatedTestEnv } from './helpers/normalize.js';

const backgroundTasksExtensionPath = resolve('src/index.ts');
const scriptedProviderPath = resolve('src/__tests__/scripted-provider/scripted-provider-extension.ts');

type JsonRecord = Record<string, unknown>;

interface Pending {
  resolve: (event: JsonRecord) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface FusionFakeInvocation {
  stage: string;
  stdin: string;
  args: string[];
}

function skipWin32FusionRpcPiPathFixture(t: TestContext): boolean {
  if (process.platform !== 'win32') return false;
  t.skip(
    'RPC fake Pi PATH interception is not applicable on win32 because production resolves fusion children through the Pi package instead of PATH by design',
  );
  return true;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: JsonRecord, key: string): unknown {
  return value[key];
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function parseJsonRecord(text: string): JsonRecord {
  const parsed = parseJsonText(text);
  assert.ok(isRecord(parsed), 'JSONL record must be an object');
  return parsed;
}

function commandNames(event: JsonRecord): string[] {
  const data = field(event, 'data');
  assert.ok(isRecord(data), 'response data must be an object');
  const commands = data['commands'];
  assert.ok(Array.isArray(commands), 'commands must be an array');
  return commands.map((command) => {
    assert.ok(isRecord(command), 'command must be an object');
    return requireString(command['name'], 'command name');
  });
}

function parseInvocation(line: string): FusionFakeInvocation {
  const parsed = parseJsonRecord(line);
  const args = parsed['args'];
  assert.ok(Array.isArray(args), 'invocation args must be an array');
  return {
    stage: requireString(parsed['stage'], 'stage'),
    stdin: requireString(parsed['stdin'], 'stdin'),
    args: args.map((value) => requireString(value, 'arg')),
  };
}

async function readInvocations(path: string): Promise<FusionFakeInvocation[]> {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, 'utf8');
  return raw.trim() ? raw.trim().split('\n').map(parseInvocation) : [];
}

class FusionRpc {
  readonly events: JsonRecord[] = [];
  readonly pending = new Map<string, Pending>();
  private buffer = '';
  private seq = 0;
  private stderr = '';
  readonly proc: ChildProcessWithoutNullStreams;

  constructor(cwd: string, env: NodeJS.ProcessEnv) {
    this.proc = spawn(
      piLaunch.executable,
      piLaunchArgv(piLaunch, [
        '--mode',
        'rpc',
        '--no-session',
        '--offline',
        '--no-extensions',
        '-e',
        scriptedProviderPath,
        '-e',
        backgroundTasksExtensionPath,
        '--no-skills',
        '--no-prompt-templates',
        '--no-context-files',
        '--no-tools',
        '--model',
        'pi-bg-scripted/scripted-model',
      ]),
      { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.proc.stdout.on('data', (chunk: Buffer) => {
      this.onData(chunk.toString('utf8'));
    });
    this.proc.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf8');
    });
  }

  send(command: JsonRecord): Promise<JsonRecord> {
    this.seq += 1;
    const id = `fusion-rpc-${String(this.seq)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(this.stderr || `RPC timeout for ${JSON.stringify(command)}`));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  sendUiResponse(id: string, value: string): void {
    this.proc.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id, value })}\n`);
  }

  async wait(predicate: (event: JsonRecord) => boolean, timeoutMs = 20_000): Promise<JsonRecord> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = this.events.find(predicate);
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `timeout ${this.stderr}\nEvents: ${JSON.stringify(this.events.slice(-12), null, 2)}`,
    );
  }

  stop(): Promise<void> {
    this.proc.kill('SIGTERM');
    return Promise.resolve();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    const event = parseJsonRecord(line);
    this.events.push(event);
    if (event['type'] !== 'response' || typeof event['id'] !== 'string') return;
    const pending = this.pending.get(event['id']);
    if (pending === undefined) return;
    this.pending.delete(event['id']);
    clearTimeout(pending.timer);
    pending.resolve(event);
  }
}

interface FusionRpcHarnessOptions {
  configText?: string | undefined;
  failStage?: 'candidate' | 'evaluation' | 'evaluation-repair' | 'merge' | undefined;
}

async function withRpc(
  fn: (rpc: FusionRpc, fakeLogPath: string) => Promise<void>,
  options: FusionRpcHarnessOptions = {},
): Promise<void> {
  const realPi = resolveRealPiCli();
  if (realPi === undefined) {
    const check = spawnSync('bash', ['-lc', 'command -v pi'], { encoding: 'utf8' });
    assert.fail(`pi CLI is required for fusion RPC tests: ${check.stderr || check.stdout}`);
  }
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-fusion-rpc-'));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  if (options.configText !== undefined) {
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'fusion-models.json'), options.configText, 'utf8');
  }
  const fake = await installFusionFakePi(root, {
    delegatePi: realPi,
    mergedText: 'RPC fused answer.',
    failStage: options.failStage,
  });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...isolatedTestEnv,
    PATH: `${fake.binDir}${delimiter}${process.env['PATH'] ?? ''}`,
    PI_CODING_AGENT_DIR: agentDir,
    UNIPI_BG_SCRIPTED_API_KEY: 'scripted-api-key',
    UNIPI_BG_SCRIPTED_SCENARIO: 'display-only-bg',
    NPM_CONFIG_CACHE: '/tmp/pi-npm-cache',
  };
  const rpc = new FusionRpc(cwd, env);
  try {
    await fn(rpc, fake.logPath);
  } finally {
    await rpc.stop();
    await rm(root, { recursive: true, force: true });
  }
}

function fusionTerminalMessage(status: 'completed' | 'failed'): (event: JsonRecord) => boolean {
  return (event) => {
    if (event['type'] !== 'message_end') return false;
    const message = event['message'];
    if (!isRecord(message) || message['customType'] !== 'background-task-notification')
      return false;
    const details = message['details'];
    return isRecord(details) && isRecord(details['fusion']) && details['status'] === status;
  };
}

function notifyWith(text: RegExp): (event: JsonRecord) => boolean {
  return (event) => {
    if (event['type'] !== 'extension_ui_request' || event['method'] !== 'notify') return false;
    return text.test(String(event['message'] ?? ''));
  };
}

void describe('fusion RPC integration', () => {
  void it('discovers commands and runs /fusion through deterministic child Pi without parent rewrite', async (t) => {
    if (skipWin32FusionRpcPiPathFixture(t)) return;
    await withRpc(async (rpc, fakeLogPath) => {
      const commands = await rpc.send({ type: 'get_commands' });
      assert.equal(commands['success'], true);
      const names = commandNames(commands);
      assert.ok(names.includes('unipi:fusion'));
      assert.ok(names.includes('unipi:fusion-models'));

      const promptText = '/unipi:fusion rpc prompt with separators \u2028 and \u2029 kept';
      const response = await rpc.send({ type: 'prompt', message: promptText });
      assert.equal(response['success'], true);
      await rpc.wait(fusionTerminalMessage('completed'));
      assert.equal(
        rpc.events.some((event) => event['type'] === 'agent_start'),
        false,
      );
      const calls = await readInvocations(fakeLogPath);
      assert.equal(calls.length, 5);
      const candidate = calls.find((call) => call.stage === 'candidate');
      assert.ok(candidate, 'candidate call should be logged');
      const input = parseJsonRecord(candidate.stdin);
      const request = input['request'];
      assert.ok(isRecord(request), 'canonical request must be an object');
      assert.equal(request['text'], 'rpc prompt with separators \u2028 and \u2029 kept');
      assert.equal(request['authority'], 'directive_over_projected_conversation');
      assert.ok(candidate.args.includes('--no-tools'));
      assert.equal(candidate.args.includes('--no-builtin-tools'), false);
      for (const flag of [
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--no-context-files',
        '--no-session',
      ]) {
        assert.ok(candidate.args.includes(flag), flag);
      }
      for (const call of calls) {
        assert.ok(call.args.includes('--no-tools'), `${call.stage} must run with --no-tools`);
      }
    });
  });

  void it('uses the RPC multiline editor for no-argument /fusion and rejects /fusion-models outside TUI mode', async (t) => {
    if (skipWin32FusionRpcPiPathFixture(t)) return;
    await withRpc(async (rpc, fakeLogPath) => {
      const pendingPrompt = rpc.send({ type: 'prompt', message: '/unipi:fusion' });
      const editor = await rpc.wait(
        (event) => event['type'] === 'extension_ui_request' && event['method'] === 'editor',
      );
      rpc.sendUiResponse(requireString(editor['id'], 'editor id'), 'rpc editor prompt');
      const response = await pendingPrompt;
      assert.equal(response['success'], true);
      await rpc.wait(fusionTerminalMessage('completed'));
      const calls = await readInvocations(fakeLogPath);
      assert.equal(calls.length, 5);

      const modelResponse = await rpc.send({ type: 'prompt', message: '/unipi:fusion-models' });
      assert.equal(modelResponse['success'], true);
      await rpc.wait(notifyWith(/requires Pi TUI mode/));
    });
  });

  void it('reports malformed config before child spawn and child failures without fallback output', async (t) => {
    if (skipWin32FusionRpcPiPathFixture(t)) return;
    await withRpc(
      async (rpc, fakeLogPath) => {
        const response = await rpc.send({ type: 'prompt', message: '/unipi:fusion blocked by config' });
        assert.equal(response['success'], true);
        await rpc.wait(
          notifyWith(
            /Fusion failed:.*schema_version|Fusion failed:.*unknown key|Fusion failed:.*missing key/s,
          ),
        );
        assert.equal((await readInvocations(fakeLogPath)).length, 0);
      },
      { configText: '{"bad":true}\n' },
    );

    await withRpc(
      async (rpc, fakeLogPath) => {
        const response = await rpc.send({ type: 'prompt', message: '/unipi:fusion child failure' });
        assert.equal(response['success'], true);
        const terminal = await rpc.wait(fusionTerminalMessage('failed'));
        const message = terminal['message'];
        assert.ok(isRecord(message));
        assert.match(
          String(message['content'] ?? ''),
          /Fusion failed(?: \([^)]*\))?:.*exited with code 42/s,
        );
        const calls = await readInvocations(fakeLogPath);
        // The candidate wave launches three children, but the first failure
        // aborts its siblings. A sibling that is signalled while still blocked
        // reading its prompt from stdin exits before it can append its
        // invocation line, so the observed count is bounded rather than exact.
        // Pinning it to exactly three encodes a timing assumption that
        // cancellation deliberately breaks. The exact-count contract is proven
        // deterministically, without real processes, by the
        // 'cancels sibling candidates on first failure and never degrades to
        // evaluation' case in tests/unit/fusion-orchestrator.test.ts.
        const candidateCalls = calls.filter((call) => call.stage === 'candidate').length;
        assert.ok(
          candidateCalls >= 1,
          `the candidate wave must launch at least one child, saw ${String(candidateCalls)}`,
        );
        assert.ok(
          candidateCalls <= 3,
          `the candidate wave must not exceed three children, saw ${String(candidateCalls)}`,
        );
        // The safety property: a failed candidate wave must never degrade into
        // a later stage. This stays exact and must not be relaxed.
        assert.equal(
          calls.some((call) => call.stage === 'evaluation' || call.stage === 'merge'),
          false,
        );
      },
      { failStage: 'candidate' },
    );
  });
});
