import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isJsonObject, parseJsonText } from '../../types.js';
import { FUSION_CANDIDATE_MAX_OUTPUT_BYTES } from '../../fusion/output-contract.js';
import {
  OUTPUT_RECOVERY_MODEL,
  OUTPUT_RECOVERY_ORIGINAL,
  OUTPUT_RECOVERY_PROVIDER,
  OUTPUT_RECOVERY_REPLACEMENT,
} from './output-recovery-provider.js';

const roots: string[] = [];

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
}

async function runPi(args: readonly string[], env: NodeJS.ProcessEnv): Promise<ProcessResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(resolve('node_modules/.bin/pi'), args, {
      cwd: process.cwd(),
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer | string) =>
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')),
    );
    child.stderr.on('data', (chunk: Buffer | string) =>
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')),
    );
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolveRun({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    child.stdin.end('produce the candidate answer');
  });
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

void describe('Fusion same-session candidate output recovery', { concurrency: false }, () => {
  void it(
    'keeps print mode alive for one no-tool continuation and settles only after replacement',
    { timeout: 30_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'pi-bg-fusion-output-recovery-'));
      roots.push(root);
      const logPath = join(root, 'provider.jsonl');
      const recoveryPath = join(root, 'candidate.response.oversized.md');
      const providerPath = resolve('src/__tests__/scripted-provider/output-recovery-provider.ts');
      const result = await runPi(
        [
          '--mode',
          'text',
          '--no-session',
          '--no-builtin-tools',
          '--tools',
          'recovery_probe',
          '--no-extensions',
          '--no-skills',
          '--no-prompt-templates',
          '--no-themes',
          '--no-context-files',
          '--extension',
          providerPath,
          '--provider',
          OUTPUT_RECOVERY_PROVIDER,
          '--model',
          OUTPUT_RECOVERY_MODEL,
          '--thinking',
          'off',
          '--system-prompt',
          'output recovery characterization',
        ],
        {
          ...process.env,
          PI_OFFLINE: '1',
          PI_SKIP_VERSION_CHECK: '1',
          PI_TELEMETRY: '0',
          UNIPI_BG_OUTPUT_RECOVERY_API_KEY: 'test-key',
          UNIPI_BG_OUTPUT_RECOVERY_LOG: logPath,
          UNIPI_BG_OUTPUT_RECOVERY_ARTIFACT: recoveryPath,
        },
      );

      assert.equal(result.code, 0, result.stderr.toString('utf8'));
      assert.equal(result.signal, null);
      assert.equal(result.stdout.toString('utf8'), `${OUTPUT_RECOVERY_REPLACEMENT}\n`);
      assert.equal(await readFile(recoveryPath, 'utf8'), OUTPUT_RECOVERY_ORIGINAL);
      assert.equal(
        Buffer.byteLength(JSON.stringify(OUTPUT_RECOVERY_ORIGINAL), 'utf8'),
        FUSION_CANDIDATE_MAX_OUTPUT_BYTES + 2,
      );

      const rows = (await readFile(logPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => {
          const parsed = parseJsonText(line);
          assert.ok(isJsonObject(parsed));
          return parsed;
        });
      assert.deepEqual(
        rows.map((row) => row['event']),
        ['provider_call', 'provider_call', 'agent_settled'],
        'agent_settled must wait until the queued continuation completes',
      );
      const first = rows[0];
      const second = rows[1];
      assert.ok(first);
      assert.ok(second);
      assert.equal(first['pid'], second['pid'], 'both turns must use one child process');
      assert.deepEqual(first['tools'], ['recovery_probe']);
      assert.deepEqual(second['tools'], []);
      assert.equal(second['saw_original'], true, 'turn two must retain turn-one context');
      assert.equal(second['saw_compression_prompt'], true);
      assert.deepEqual(second['roles'], ['user', 'assistant', 'user']);
    },
  );
});
