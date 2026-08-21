import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { SpawnOptions } from 'node:child_process';
import {
  resolveTaskkillPath,
  runWindowsTaskkill,
  type WindowsKillPhase,
  type WindowsTaskkillOptions,
} from '../windows-taskkill.js';

type WindowsTaskkillSpawn = NonNullable<WindowsTaskkillOptions['spawn']>;

class FakeTaskkillChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly killCalls: NodeJS.Signals[] = [];

  kill(signal?: NodeJS.Signals): boolean {
    if (signal !== undefined) this.killCalls.push(signal);
    return true;
  }

  writeStdout(value: Buffer | string): void {
    this.stdout.emit('data', value);
  }

  writeStderr(value: Buffer | string): void {
    this.stderr.emit('data', value);
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('close', code, signal);
  }
}

interface SpawnCall {
  readonly command: string;
  readonly args: string[];
  readonly options: SpawnOptions;
  readonly child: FakeTaskkillChild;
}

function fakeSpawn(calls: SpawnCall[], onSpawn?: (child: FakeTaskkillChild) => void): WindowsTaskkillSpawn {
  return (command, args, options) => {
    const child = new FakeTaskkillChild();
    calls.push({ command, args: [...args], options, child });
    onSpawn?.(child);
    return child;
  };
}

function env(root = 'C:\\Windows'): NodeJS.ProcessEnv {
  return {
    SystemRoot: root,
    PATH: 'C:\\attacker\\bin',
  };
}

void describe('windows taskkill helper', () => {
  void it('resolves taskkill from System32 and never PATH', () => {
    assert.equal(
      resolveTaskkillPath({ SystemRoot: 'C:\\Windows', PATH: 'C:\\attacker\\bin' }),
      'C:\\Windows\\System32\\taskkill.exe',
    );
    assert.equal(
      resolveTaskkillPath({ WINDIR: 'D:\\WinNT', PATH: 'C:\\attacker\\bin' }),
      'D:\\WinNT\\System32\\taskkill.exe',
    );
    assert.throws(
      () => resolveTaskkillPath({ SystemRoot: 'relative\\windows', WINDIR: 'C:\\Windows' }),
      /SystemRoot must be an absolute Windows path/,
    );
    assert.throws(() => resolveTaskkillPath({ PATH: 'C:\\attacker\\bin' }), /Cannot resolve taskkill/);
  });

  void it('uses structured argv for terminate and force phases', async () => {
    const calls: SpawnCall[] = [];
    const spawn = fakeSpawn(calls, (child) => {
      queueMicrotask(() => {
        child.close(0);
      });
    });

    for (const phase of ['terminate', 'force'] as const satisfies readonly WindowsKillPhase[]) {
      const outcome = await runWindowsTaskkill(1234, phase, { env: env(), spawn });
      assert.equal(outcome.exitCode, 0);
    }

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]?.args, ['/PID', '1234', '/T']);
    assert.deepEqual(calls[1]?.args, ['/PID', '1234', '/T', '/F']);
    for (const call of calls) {
      assert.equal(call.command, 'C:\\Windows\\System32\\taskkill.exe');
      assert.equal(call.options.shell, false);
      assert.equal(call.options.windowsVerbatimArguments, false);
      assert.equal(call.options.windowsHide, true);
      assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
    }
  });

  void it('rejects invalid pid and unresolved taskkill before spawn', async () => {
    const calls: SpawnCall[] = [];
    const spawn = fakeSpawn(calls);

    assert.throws(() => runWindowsTaskkill(0, 'force', { env: env(), spawn }), /Invalid Windows taskkill pid/);
    assert.throws(
      () => runWindowsTaskkill(1, 'force', { env: { PATH: 'C:\\attacker\\bin' }, spawn }),
      /Cannot resolve taskkill/,
    );
    assert.equal(calls.length, 0);
  });

  void it('bounds stdout and stderr capture and sets truncation flags', async () => {
    const calls: SpawnCall[] = [];
    const outcomePromise = runWindowsTaskkill(4321, 'force', {
      env: env(),
      spawn: fakeSpawn(calls),
      maxCaptureBytes: 5,
    });
    const call = calls[0];
    assert.ok(call, 'spawn should be recorded');
    call.child.writeStdout('abcdef');
    call.child.writeStderr(Buffer.from('ghijkl', 'utf8'));
    call.child.close(7);

    const outcome = await outcomePromise;
    assert.equal(outcome.exitCode, 7);
    assert.equal(outcome.stdout, 'abcde');
    assert.equal(outcome.stderr, 'ghijk');
    assert.equal(outcome.stdoutTruncated, true);
    assert.equal(outcome.stderrTruncated, true);
  });

  void it('supports external abort and helper timeout without blocking', async () => {
    const abortCalls: SpawnCall[] = [];
    const controller = new AbortController();
    const abortPromise = runWindowsTaskkill(55, 'terminate', {
      env: env(),
      spawn: fakeSpawn(abortCalls),
      signal: controller.signal,
    });
    const abortCall = abortCalls[0];
    assert.ok(abortCall, 'abort helper spawn should be recorded');
    controller.abort();
    const abortOutcome = await abortPromise;
    assert.equal(abortOutcome.exitCode, null);
    assert.match(abortOutcome.stderr, /aborted/);
    assert.deepEqual(abortCall.child.killCalls, ['SIGKILL']);

    const timeoutCalls: SpawnCall[] = [];
    const timeoutOutcome = await runWindowsTaskkill(56, 'force', {
      env: env(),
      spawn: fakeSpawn(timeoutCalls),
      timeoutMs: 10,
    });
    assert.equal(timeoutOutcome.exitCode, null);
    assert.match(timeoutOutcome.stderr, /timed out/);
    assert.deepEqual(timeoutCalls[0]?.child.killCalls, ['SIGKILL']);
  });
});
