import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { parseJsonText } from '../../types.js';
import { isolatedTestEnv } from '../helpers/normalize.js';
import {
  HOOK_PROBE_INJECTED_TEXT,
  HOOK_PROBE_REPLACED_TOOL_TEXT,
  type HookProbeMode,
} from './hook-probe-extension.js';
import {
  DELEGATE_HOOK_CONTRACT_ID,
  DELEGATE_REQUIRED_HOOK_GUARANTEES,
  type DelegateHookContractEvidence,
} from '../../delegate/hook-contract.js';

/**
 * Pi hook-contract characterisation gate.
 *
 * The delegate child-side guard depends on documented Pi behaviour that must be
 * proven by execution rather than read from type declarations. This gate drives
 * a real Pi agent loop against a deterministic provider and records the observed
 * guarantees as durable evidence consumed by the delegate launch preflight.
 */
const providerPath = resolve('src/__tests__/scripted-provider/hook-contract-provider.ts');
const probeAPath = resolve('src/__tests__/scripted-provider/hook-probe-a.ts');
const probeBPath = resolve('src/__tests__/scripted-provider/hook-probe-b.ts');
const evidencePath = resolve('src/__tests__/scripted-provider/pi-hook-contract-evidence.json');

const roots: string[] = [];

type JsonObject = Record<PropertyKey, unknown>;

interface ProbeRecord extends JsonObject {
  hook?: unknown;
  probeId?: unknown;
  providerCalls?: unknown;
  texts?: unknown;
  roles?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  isError?: unknown;
  role?: unknown;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(line: string): ProbeRecord {
  const parsed = parseJsonText(line);
  assert.ok(isJsonObject(parsed), 'hook probe record must be a JSON object');
  return parsed;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

interface Harness {
  session: Awaited<ReturnType<typeof createAgentSession>>['session'];
  logPath: string;
  restore: () => void;
}

interface HarnessOptions {
  mode: HookProbeMode;
  withTool?: boolean;
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

async function harness(options: HarnessOptions): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-hook-contract-'));
  roots.push(root);
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  const logPath = join(root, 'hook-probe.jsonl');
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(logPath, '', 'utf8');

  const previous = {
    mode: process.env['UNIPI_BG_HOOK_PROBE_MODE'],
    log: process.env['UNIPI_BG_HOOK_PROBE_LOG'],
    tool: process.env['UNIPI_BG_HOOK_PROBE_TOOL'],
    apiKey: process.env['UNIPI_BG_HOOK_CONTRACT_API_KEY'],
  };
  Object.assign(process.env, isolatedTestEnv, {
    UNIPI_BG_HOOK_PROBE_MODE: options.mode,
    UNIPI_BG_HOOK_PROBE_LOG: logPath,
    UNIPI_BG_HOOK_PROBE_TOOL: options.withTool === true ? '1' : '0',
    UNIPI_BG_HOOK_CONTRACT_API_KEY: 'hook-contract-api-key',
  });

  const settingsManager = SettingsManager.inMemory({
    defaultProvider: 'pi-bg-hook-contract',
    defaultModel: 'hook-contract-model',
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    // Load order fixes handler ordering: provider, then probe-a, then probe-b.
    additionalExtensionPaths: [providerPath, probeAPath, probeBPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    noThemes: true,
  });
  await loader.reload();
  const authStorage = AuthStorage.create(join(agentDir, 'auth.json'));
  const modelRegistry = ModelRegistry.create(authStorage);
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
  const model = modelRegistry.find('pi-bg-hook-contract', 'hook-contract-model');
  assert.ok(model, 'hook-contract provider model should be registered');
  await session.setModel(model);
  return {
    session,
    logPath,
    restore: () => {
      restoreEnvValue('UNIPI_BG_HOOK_PROBE_MODE', previous.mode);
      restoreEnvValue('UNIPI_BG_HOOK_PROBE_LOG', previous.log);
      restoreEnvValue('UNIPI_BG_HOOK_PROBE_TOOL', previous.tool);
      restoreEnvValue('UNIPI_BG_HOOK_CONTRACT_API_KEY', previous.apiKey);
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

async function records(logPath: string): Promise<ProbeRecord[]> {
  if (!existsSync(logPath)) return [];
  const raw = await readFile(logPath, 'utf8');
  return raw.trim().length === 0 ? [] : raw.trim().split('\n').map(parseRecord);
}

function hooksOf(rows: readonly ProbeRecord[], hook: string): ProbeRecord[] {
  return rows.filter((row) => row['hook'] === hook);
}

const observed = new Map<string, boolean>();

function note(guarantee: string, value: boolean): void {
  observed.set(guarantee, value);
}

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

void describe('Pi hook contract characterisation', { concurrency: false }, () => {
  void it(
    'fires context before every model call and delivers returned messages to the provider',
    { timeout: 20_000 },
    async () => {
      const h = await harness({ mode: 'context-replace', withTool: true });
      try {
        await h.session.prompt('probe the context hook');
        await h.session.agent.waitForIdle();
        const rows = await records(h.logPath);
        const providerCalls = hooksOf(rows, 'provider_call');
        const contextFires = hooksOf(rows, 'context').filter((row) => row['probeId'] === 'probe-a');
        assert.equal(
          providerCalls.length,
          2,
          'a tool-using turn should produce exactly two provider calls',
        );
        assert.equal(
          contextFires.length,
          providerCalls.length,
          'context must fire exactly once before every model call',
        );
        // Ordering: each context fire strictly precedes its provider call.
        const ordered = rows.filter(
          (row) =>
            (row['hook'] === 'context' && row['probeId'] === 'probe-a') ||
            row['hook'] === 'provider_call',
        );
        for (let index = 0; index < ordered.length; index += 2) {
          assert.equal(ordered[index]?.['hook'], 'context');
          assert.equal(ordered[index + 1]?.['hook'], 'provider_call');
        }
        note('context_fires_before_every_model_call', true);

        for (const call of providerCalls) {
          assert.ok(
            stringArray(call['texts']).some((text) => text.includes(HOOK_PROBE_INJECTED_TEXT)),
            'messages returned from a context handler must reach the provider',
          );
        }
        note('context_result_messages_reach_provider', true);
      } finally {
        await dispose(h);
      }
    },
  );

  void it(
    'records whether throwing inside a context handler prevents the provider call',
    { timeout: 20_000 },
    async () => {
      const h = await harness({ mode: 'context-throw' });
      try {
        await h.session.prompt('probe the context throw path');
        await h.session.agent.waitForIdle();
        const rows = await records(h.logPath);
        const threw = hooksOf(rows, 'context_throwing').length > 0;
        assert.equal(threw, true, 'probe-a must have thrown from its context handler');
        const providerCalls = hooksOf(rows, 'provider_call');
        const blocked = providerCalls.length === 0;
        note('context_throw_blocks_provider_call', blocked);
        // Pi 0.83 catches context-handler exceptions and continues, so a throw is
        // NOT a dispatch barrier. Recorded, not assumed.
        assert.equal(
          blocked,
          false,
          'Pi 0.83 is expected to swallow context-handler throws; if this changes the recorded evidence must be regenerated',
        );
        const laterProbeRan = hooksOf(rows, 'context').some((row) => row['probeId'] === 'probe-b');
        assert.equal(
          laterProbeRan,
          true,
          'a throwing handler must not prevent later extensions from running',
        );
        note('context_throw_isolated_to_throwing_handler', laterProbeRan);
      } finally {
        await dispose(h);
      }
    },
  );

  void it(
    'records whether ctx.abort() inside a context handler prevents the provider request',
    { timeout: 20_000 },
    async () => {
      const h = await harness({ mode: 'context-abort' });
      try {
        await h.session.prompt('probe the context abort path');
        await h.session.agent.waitForIdle();
        const rows = await records(h.logPath);
        assert.equal(hooksOf(rows, 'context_aborting').length > 0, true);
        const providerCalls = hooksOf(rows, 'provider_call');
        // Pi 0.81.1-0.83.0 invoke streamSimple with an already-aborted signal;
        // Pi 0.84.0 propagates the signal through auth resolution and skips the
        // provider entry point entirely. Both modes block transport. The exact
        // per-version behavior is pinned again by scripts/test-compat.ts.
        const skippedStreamInvocation = providerCalls.length === 0;
        note('context_abort_skips_stream_invocation', skippedStreamInvocation);
        const everyDispatchedCallAborted = providerCalls.every(
          (call) => call['signalAborted'] === true,
        );
        assert.equal(
          skippedStreamInvocation || everyDispatchedCallAborted,
          true,
          'ctx.abort() must either skip stream invocation or hand every dispatched call an already-aborted signal',
        );
        note('context_abort_blocks_provider_call', true);

        // The run must also terminate rather than continuing to further turns.
        assert.ok(
          providerCalls.length <= 1,
          'an aborted context handler must not allow the agent loop to keep issuing model calls',
        );
        note('context_abort_terminates_run', true);
      } finally {
        await dispose(h);
      }
    },
  );

  void it(
    'fires tool_result before the result enters the transcript and honours content replacement',
    { timeout: 20_000 },
    async () => {
      const h = await harness({ mode: 'tool-result-replace', withTool: true });
      try {
        await h.session.prompt('probe the tool_result hook');
        await h.session.agent.waitForIdle();
        const rows = await records(h.logPath);
        const toolResults = hooksOf(rows, 'tool_result');
        assert.equal(toolResults.length, 2, 'both probes must observe the tool result');
        const first = toolResults[0];
        const second = toolResults[1];
        assert.ok(first && second);
        assert.equal(first['probeId'], 'probe-a');
        assert.equal(second['probeId'], 'probe-b');
        assert.ok(
          stringArray(first['texts']).some((text) => text.includes('ORIGINAL_TOOL_PAYLOAD:seed')),
          'the first handler must see the original tool payload',
        );
        assert.ok(
          stringArray(second['texts']).some((text) => text === HOOK_PROBE_REPLACED_TOOL_TEXT),
          'later handlers must observe the earlier handler replacement (middleware chaining)',
        );
        note('tool_result_chains_in_load_order', true);

        // tool_result must run before tool_execution_end and before the result
        // reaches the provider transcript.
        const executionEndIndex = rows.findIndex((row) => row['hook'] === 'tool_execution_end');
        const lastToolResultIndex = rows.reduce(
          (last, row, index) => (row['hook'] === 'tool_result' ? index : last),
          -1,
        );
        assert.ok(
          lastToolResultIndex >= 0 && lastToolResultIndex < executionEndIndex,
          'tool_result must fire before tool_execution_end',
        );
        note('tool_result_fires_before_transcript_entry', true);

        const followUpCall = hooksOf(rows, 'provider_call')[1];
        assert.ok(followUpCall, 'the tool turn must produce a follow-up provider call');
        const followUpTexts = stringArray(followUpCall['texts']);
        assert.ok(
          followUpTexts.some((text) => text.includes(HOOK_PROBE_REPLACED_TOOL_TEXT)),
          'the replaced tool-result content must be what reaches the provider',
        );
        assert.ok(
          followUpTexts.every((text) => !text.includes('ORIGINAL_TOOL_PAYLOAD:seed')),
          'the original tool payload must never reach the provider after replacement',
        );
        note('tool_result_replacement_reaches_provider', true);
      } finally {
        await dispose(h);
      }
    },
  );

  void it(
    'preserves tool-call identity, role, and error flag after replacement',
    { timeout: 20_000 },
    async () => {
      const h = await harness({ mode: 'tool-result-replace', withTool: true });
      try {
        await h.session.prompt('probe tool result identity');
        await h.session.agent.waitForIdle();
        const rows = await records(h.logPath);
        const toolResults = hooksOf(rows, 'tool_result');
        const executionEnd = hooksOf(rows, 'tool_execution_end');
        const toolCallIds = new Set(toolResults.map((row) => row['toolCallId']));
        assert.equal(toolCallIds.size, 1, 'the tool call id must be stable across handlers');
        assert.equal([...toolCallIds][0], 'probe-call-1');
        for (const row of toolResults) assert.equal(row['isError'], false);
        for (const row of executionEnd) {
          assert.equal(row['toolCallId'], 'probe-call-1');
          assert.equal(row['isError'], false);
        }
        const entries: readonly unknown[] = h.session.sessionManager.getEntries();
        const toolResultRoles = entries.flatMap((entry) => {
          if (!isJsonObject(entry) || entry['type'] !== 'message') return [];
          const message = entry['message'];
          if (!isJsonObject(message) || message['role'] !== 'toolResult') return [];
          return [message];
        });
        assert.equal(toolResultRoles.length, 1);
        const toolResultMessage = toolResultRoles[0];
        assert.ok(toolResultMessage);
        assert.equal(toolResultMessage['role'], 'toolResult');
        assert.equal(toolResultMessage['toolCallId'], 'probe-call-1');
        assert.equal(toolResultMessage['toolName'], 'probe_echo');
        assert.equal(toolResultMessage['isError'], false);
        const content = toolResultMessage['content'];
        assert.ok(Array.isArray(content));
        const contentTexts = content.flatMap((part) =>
          isJsonObject(part) && typeof part['text'] === 'string' ? [part['text']] : [],
        );
        assert.deepEqual(contentTexts, [HOOK_PROBE_REPLACED_TOOL_TEXT]);
        note('tool_result_replacement_preserves_identity', true);
      } finally {
        await dispose(h);
      }
    },
  );

  void it(
    'fires handlers from separate extensions in deterministic load order',
    { timeout: 20_000 },
    async () => {
      const h = await harness({ mode: 'observe', withTool: true });
      try {
        await h.session.prompt('probe handler ordering');
        await h.session.agent.waitForIdle();
        const rows = await records(h.logPath);
        const contextProbes = hooksOf(rows, 'context').map((row) => row['probeId']);
        assert.deepEqual(
          contextProbes,
          ['probe-a', 'probe-b', 'probe-a', 'probe-b'],
          'context handlers must run in extension load order for every model call',
        );
        const toolProbes = hooksOf(rows, 'tool_result').map((row) => row['probeId']);
        assert.deepEqual(toolProbes, ['probe-a', 'probe-b']);
        note('handlers_run_in_extension_load_order', true);
      } finally {
        await dispose(h);
      }
    },
  );

  void it('matches the supported-range hook-contract evidence consumed by delegate preflight', async () => {
    for (const guarantee of DELEGATE_REQUIRED_HOOK_GUARANTEES) {
      assert.equal(
        observed.get(guarantee),
        true,
        `required delegate hook guarantee "${guarantee}" was not observed by this gate`,
      );
    }
    const throwBlocks = observed.get('context_throw_blocks_provider_call');
    assert.equal(typeof throwBlocks, 'boolean', 'throw behaviour must have been observed');
    const evidence: DelegateHookContractEvidence = {
      schema_version: 'pi-background-tasks.delegate-hook-contract.v1',
      contract_id: DELEGATE_HOOK_CONTRACT_ID,
      guarantees: {
        context_fires_before_every_model_call: true,
        context_result_messages_reach_provider: true,
        context_abort_blocks_provider_call: true,
        // The shipped evidence is the conservative contract shared by every
        // supported Pi line. Pi 0.84 skips the call, but 0.81.1-0.83.0 do not.
        context_abort_skips_stream_invocation: false,
        context_abort_terminates_run: true,
        context_throw_blocks_provider_call: throwBlocks === true,
        context_throw_isolated_to_throwing_handler: true,
        tool_result_fires_before_transcript_entry: true,
        tool_result_replacement_reaches_provider: true,
        tool_result_replacement_preserves_identity: true,
        tool_result_chains_in_load_order: true,
        handlers_run_in_extension_load_order: true,
      },
    };
    const existing = existsSync(evidencePath) ? await readFile(evidencePath, 'utf8') : undefined;
    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    if (existing === undefined) {
      await writeFile(evidencePath, serialized, 'utf8');
      return;
    }
    assert.equal(
      existing,
      serialized,
      'the recorded Pi hook-contract evidence no longer matches observed Pi behaviour; regenerate it deliberately and re-review the delegate child guard',
    );
  });
});
