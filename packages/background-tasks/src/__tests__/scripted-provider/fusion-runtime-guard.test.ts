import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { RUNTIME_GUARD_MODEL, RUNTIME_GUARD_PROVIDER } from './runtime-guard-provider.js';

const providerPath = resolve('tests/scripted-provider/runtime-guard-provider.ts');
const governorPath = resolve('tests/scripted-provider/runtime-guard-probe.ts');
const roots: string[] = [];
const servers: Server[] = [];

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolveClose();
    });
  });
}

afterEach(async () => {
  for (const server of servers.splice(0)) await close(server);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

void describe('Fusion final provider-request guard contract', { concurrency: false }, () => {
  void it(
    'observes the final transformed payload and aborts before network transport',
    { timeout: 20_000 },
    async () => {
      let httpRequests = 0;
      const server = createServer((_request, response) => {
        httpRequests += 1;
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'the guard failed to block transport' } }));
      });
      servers.push(server);
      const port = await listen(server);

      const root = await mkdtemp(join(tmpdir(), 'pi-bg-fusion-runtime-guard-'));
      roots.push(root);
      const cwd = join(root, 'project');
      const agentDir = join(root, 'agent');
      const logPath = join(root, 'guard.jsonl');
      await mkdir(cwd, { recursive: true });
      await mkdir(agentDir, { recursive: true });
      await writeFile(logPath, '', 'utf8');

      const previous = {
        baseUrl: process.env['UNIPI_BG_RUNTIME_GUARD_BASE_URL'],
        log: process.env['UNIPI_BG_RUNTIME_GUARD_LOG'],
        apiKey: process.env['UNIPI_BG_RUNTIME_GUARD_API_KEY'],
      };
      const codexToken = [
        Buffer.from('{}', 'utf8').toString('base64url'),
        Buffer.from(
          JSON.stringify({
            'https://api.openai.com/auth': { chatgpt_account_id: 'runtime-guard-test-account' },
          }),
          'utf8',
        ).toString('base64url'),
        'test-signature',
      ].join('.');
      Object.assign(process.env, isolatedTestEnv, {
        UNIPI_BG_RUNTIME_GUARD_BASE_URL: `http://127.0.0.1:${String(port)}/v1`,
        UNIPI_BG_RUNTIME_GUARD_LOG: logPath,
        UNIPI_BG_RUNTIME_GUARD_API_KEY: codexToken,
      });

      let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
      try {
        const settingsManager = SettingsManager.inMemory({
          defaultProvider: RUNTIME_GUARD_PROVIDER,
          defaultModel: RUNTIME_GUARD_MODEL,
        });
        const loader = new DefaultResourceLoader({
          cwd,
          agentDir,
          settingsManager,
          // The provider mutator must load before the governor.
          additionalExtensionPaths: [providerPath, governorPath],
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
        const registry = new ModelRegistry(modelRuntime);
        ({ session } = await createAgentSession({
          cwd,
          agentDir,
          resourceLoader: loader,
          sessionManager: SessionManager.inMemory(cwd),
          settingsManager,
          modelRuntime,
          noTools: 'builtin',
        }));
        const model = registry.find(RUNTIME_GUARD_PROVIDER, RUNTIME_GUARD_MODEL);
        assert.ok(model);
        await session.setModel(model);
        await session.prompt('prove the final request guard blocks transport');
        await session.agent.waitForIdle();

        const rows = (await readFile(logPath, 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        assert.deepEqual(
          rows.map((row) => row['hook']),
          ['mutator', 'governor'],
          `provider-request handlers must run exactly once in extension load order; session=${JSON.stringify(session.sessionManager.getEntries())}`,
        );
        assert.equal(rows[1]?.['marker_seen'], true, 'the governor must observe prior transforms');
        assert.equal(rows[1]?.['provider'], RUNTIME_GUARD_PROVIDER);
        assert.equal(rows[1]?.['model'], RUNTIME_GUARD_MODEL);
        assert.equal(typeof rows[1]?.['payload_bytes'], 'number');
        assert.match(String(rows[1]?.['payload_sha256']), /^[0-9a-f]{64}$/);
        assert.equal(httpRequests, 0, 'ctx.abort() must prevent the HTTP request from being sent');
      } finally {
        if (session) {
          await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
          session.dispose();
        }
        restoreEnvValue('UNIPI_BG_RUNTIME_GUARD_BASE_URL', previous.baseUrl);
        restoreEnvValue('UNIPI_BG_RUNTIME_GUARD_LOG', previous.log);
        restoreEnvValue('UNIPI_BG_RUNTIME_GUARD_API_KEY', previous.apiKey);
      }
    },
  );
});
