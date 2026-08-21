import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareDelegateLaunch } from '../../delegate/runner.js';
import { loadDelegateHookContractEvidence } from '../../delegate/launch.js';
import type { DelegateExtensionMode } from '../../delegate/types.js';
import { sessionWith, userMessage } from '../helpers/fusion-canonical.js';
import { isolatedTestEnv } from '../helpers/normalize.js';

/**
 * Fresh-process regression for extension-registered delegate providers.
 *
 * The provider exists only as an auto-discovered global extension in a temp Pi
 * agent directory. It is never passed through `--extension`, so isolated mode
 * cannot resolve it while explicit ambient mode can. The ambient child still
 * receives the package guard and every non-extension isolation flag from the
 * production argv builder.
 */
const roots: string[] = [];
const providerExtension = resolve('tests/scripted-provider/delegate-guard-provider.ts');
const piExecutable = resolve('node_modules/.bin/pi');

async function runChild(
  mode: DelegateExtensionMode,
): Promise<{ code: number | null; stderr: string; artifactDir: string; argv: readonly string[] }> {
  const root = await mkdtemp(join(tmpdir(), `pi-bg-delegate-${mode}-`));
  roots.push(root);
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  const extensionsDir = join(agentDir, 'extensions');
  await mkdir(cwd, { recursive: true });
  await mkdir(extensionsDir, { recursive: true });
  // A symlink keeps package imports resolving from this repository while still
  // exercising Pi's global ambient-extension discovery path.
  await symlink(providerExtension, join(extensionsDir, 'custom-provider.ts'));

  const evidenceRaw = await readFile(
    resolve('src/core/delegate/hook-contract-evidence.json'),
    'utf8',
  );
  const prepared = await prepareDelegateLaunch({
    ctx: {
      cwd,
      sessionManager: sessionWith([userMessage('ambient provider regression')]),
      getSystemPrompt: () => 'parent system prompt',
    },
    toolCallId: 'ambient-provider-call',
    prompt: 'Return the deterministic delegate answer.',
    capability: 'inspect',
    extensionMode: mode,
    route: {
      provider: 'pi-bg-delegate',
      model: 'delegate-model',
      qualified_id: 'pi-bg-delegate/delegate-model',
      context_window_tokens: 200_000,
      thinking_level: 'medium',
      origin: 'explicit',
    },
    limitOverrides: { maxTurns: 4, maxToolCalls: 8, timeoutSeconds: 30 },
    hookEvidence: loadDelegateHookContractEvidence(evidenceRaw),
    cwd,
    sessionId: `ambient-provider-${mode}`,
    autoDeliver: 'never',
    env: {
      ...process.env,
      ...isolatedTestEnv,
      PI_CODING_AGENT_DIR: agentDir,
      UNIPI_BG_DELEGATE_API_KEY: 'delegate-api-key',
      UNIPI_BG_DELEGATE_SCENARIO: 'plain-answer',
    },
  });

  const result = await new Promise<{ code: number | null; stderr: string }>((resolveResult, reject) => {
    const child = spawn(piExecutable, [...prepared.argv], {
      cwd,
      env: prepared.env,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolveResult({ code, stderr }));
    child.stdin.end(prepared.stdinBytes);
  });

  return {
    ...result,
    artifactDir: prepared.store.artifactDirAbs,
    argv: prepared.argv,
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

void describe('delegate ambient extension provider discovery', { concurrency: false }, () => {
  void it(
    'fails closed in isolated mode and resolves the same pinned provider in ambient mode',
    { timeout: 60_000 },
    async () => {
      const isolated = await runChild('isolated');
      assert.notEqual(isolated.code, 0);
      assert.match(isolated.stderr, /Unknown provider "pi-bg-delegate"/);
      assert.ok(isolated.argv.includes('--no-extensions'));
      assert.equal(existsSync(join(isolated.artifactDir, 'result.json')), false);

      const ambient = await runChild('ambient');
      assert.equal(ambient.code, 0, ambient.stderr);
      assert.ok(!ambient.argv.includes('--no-extensions'));
      assert.ok(ambient.argv.includes('--no-skills'));
      assert.ok(ambient.argv.includes('--no-prompt-templates'));
      assert.ok(ambient.argv.includes('--no-themes'));
      assert.ok(ambient.argv.includes('--no-context-files'));
      const explicitExtensions = ambient.argv.flatMap((entry, index) =>
        entry === '--extension' ? [ambient.argv[index + 1] ?? ''] : [],
      );
      assert.equal(explicitExtensions.length, 1);
      assert.match(explicitExtensions[0] ?? '', /extensions\/delegate-child\.(?:ts|js)$/);
      assert.ok(existsSync(join(ambient.artifactDir, 'result.json')));
    },
  );
});
