import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import { parseJsonText } from '../../types.js';
import { isolatedTestEnv } from '../helpers/normalize.js';

const backgroundExtensionPath = resolve('src/index.ts');
const scriptedProviderPath = resolve('src/__tests__/scripted-provider/scripted-provider-extension.ts');
const roots: string[] = [];

type Scenario =
  | 'bg-run-follow-up'
  | 'notify-false'
  | 'wake-false'
  | 'failed-follow-up'
  | 'display-only-bg';

async function harness(scenario: Scenario) {
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-agent-loop-'));
  roots.push(root);
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  const eventsPath = join(root, 'provider-events.jsonl');
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const previousScenario = process.env['UNIPI_BG_SCRIPTED_SCENARIO'];
  const previousEvents = process.env['UNIPI_BG_SCRIPTED_EVENTS'];
  const previousApiKey = process.env['UNIPI_BG_SCRIPTED_API_KEY'];
  Object.assign(process.env, isolatedTestEnv, {
    UNIPI_BG_SCRIPTED_SCENARIO: scenario,
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
    additionalExtensionPaths: [scriptedProviderPath, backgroundExtensionPath],
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
  const scriptedModel = modelRegistry.find('pi-bg-scripted', 'scripted-model');
  assert.ok(scriptedModel, 'scripted provider model should be registered');
  await session.setModel(scriptedModel);
  const restoreEnv = () => {
    restoreEnvValue('UNIPI_BG_SCRIPTED_SCENARIO', previousScenario);
    restoreEnvValue('UNIPI_BG_SCRIPTED_EVENTS', previousEvents);
    restoreEnvValue('UNIPI_BG_SCRIPTED_API_KEY', previousApiKey);
  };
  return { session, cwd, root, eventsPath, restoreEnv };
}

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type JsonObject = Record<PropertyKey, unknown>;

interface CustomNotificationEntry {
  type: 'custom_message';
  customType: string;
  content: string;
  details: JsonObject;
}

interface EventDrivenContractCheck extends JsonObject {
  systemPrompt: boolean;
  toolDescriptions: boolean;
  launchReceipt: boolean;
}

interface ProviderEvent extends JsonObject {
  callCount?: number;
  summaries?: string[];
  eventDrivenContract?: EventDrivenContractCheck;
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isEventDrivenContractCheck(value: unknown): value is EventDrivenContractCheck {
  return (
    isJsonObject(value) &&
    typeof value['systemPrompt'] === 'boolean' &&
    typeof value['toolDescriptions'] === 'boolean' &&
    typeof value['launchReceipt'] === 'boolean'
  );
}

function isProviderEvent(value: unknown): value is ProviderEvent {
  return (
    isJsonObject(value) &&
    (value['callCount'] === undefined || typeof value['callCount'] === 'number') &&
    (value['summaries'] === undefined || isStringArray(value['summaries'])) &&
    (value['eventDrivenContract'] === undefined ||
      isEventDrivenContractCheck(value['eventDrivenContract']))
  );
}

function parseProviderEvent(line: string): ProviderEvent {
  const parsed = parseJsonText(line);
  assert.ok(
    isProviderEvent(parsed),
    'scripted provider event must match the provider-event contract',
  );
  return parsed;
}

function isCustomNotificationEntry(value: unknown): value is CustomNotificationEntry {
  return (
    isJsonObject(value) &&
    value['type'] === 'custom_message' &&
    value['customType'] === 'background-task-notification' &&
    typeof value['content'] === 'string' &&
    isJsonObject(value['details'])
  );
}

function customNotifications(session: AgentSession): CustomNotificationEntry[] {
  const entries: readonly unknown[] = session.sessionManager.getEntries();
  return entries.filter(isCustomNotificationEntry);
}

function requiredAt<T>(values: readonly T[], index: number, message: string): T {
  const value = values[index];
  assert.ok(value, message);
  return value;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new Error(message);
  return value;
}

const ENTRY_TYPE_KEY = 'type';
const ENTRY_MESSAGE_KEY = 'message';
const ENTRY_ROLE_KEY = 'role';
const ENTRY_CONTENT_KEY = 'content';
const ENTRY_TEXT_KEY = 'text';

function assistantContentParts(session: AgentSession): JsonObject[] {
  return session.sessionManager.getEntries().flatMap((entry) => {
    if (
      !isJsonObject(entry) ||
      entry[ENTRY_TYPE_KEY] !== 'message' ||
      !isJsonObject(entry[ENTRY_MESSAGE_KEY]) ||
      entry[ENTRY_MESSAGE_KEY][ENTRY_ROLE_KEY] !== 'assistant'
    )
      return [];
    const content: unknown = entry[ENTRY_MESSAGE_KEY][ENTRY_CONTENT_KEY];
    if (!Array.isArray(content)) return [];
    const parts: readonly unknown[] = content;
    return parts.filter(isJsonObject);
  });
}

function assistantTexts(session: AgentSession): string[] {
  return assistantContentParts(session).flatMap((part) =>
    part[ENTRY_TYPE_KEY] === 'text' && typeof part[ENTRY_TEXT_KEY] === 'string'
      ? [part[ENTRY_TEXT_KEY]]
      : [],
  );
}

function assistantToolNames(session: AgentSession): string[] {
  return assistantContentParts(session).flatMap((part) =>
    part[ENTRY_TYPE_KEY] === 'toolCall' && typeof part['name'] === 'string' ? [part['name']] : [],
  );
}

async function providerEvents(path: string): Promise<ProviderEvent[]> {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, 'utf8');
  return raw.trim() ? raw.trim().split('\n').map(parseProviderEvent) : [];
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

async function disposeHarness(h: Awaited<ReturnType<typeof harness>>) {
  try {
    await h.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  } finally {
    h.session.dispose();
    h.restoreEnv();
  }
}

void describe('scripted-provider completion follow-up behavior', { concurrency: false }, () => {
  void it(
    'BUG-181 bg_run yields without polling and its completion event triggers one real follow-up turn',
    { timeout: 15_000 },
    async () => {
      const h = await harness('bg-run-follow-up');
      try {
        await h.session.prompt('Start the scripted background task.');
        await waitFor(() => customNotifications(h.session).length === 1, 'background notification');
        await waitFor(
          async () => (await providerEvents(h.eventsPath)).length >= 3,
          'third provider call from follow-up',
        );
        await h.session.agent.waitForIdle();

        const events = await providerEvents(h.eventsPath);
        assert.equal(events.length, 3);
        const launchEvent = requiredAt(events, 0, 'launch provider event should be recorded');
        const launchContract = launchEvent.eventDrivenContract;
        assert.ok(launchContract, 'launch event should record the effective prompt contract');
        assert.equal(launchContract.systemPrompt, true);
        assert.equal(launchContract.toolDescriptions, true);
        const postToolEvent = requiredAt(events, 1, 'post-tool provider event should be recorded');
        assert.equal(postToolEvent.eventDrivenContract?.launchReceipt, true);
        assert.deepEqual(
          assistantToolNames(h.session),
          ['bg_run'],
          'ordinary event-driven waiting must not issue bg_status, bg_logs, or a sleep tool',
        );
        const followUpEvent = requiredAt(events, 2, 'follow-up provider event should be recorded');
        assert.equal(followUpEvent.callCount, 3);
        assert.match(
          (followUpEvent.summaries ?? []).join('\n'),
          /background-task-notification|Scripted Wakeup/,
        );
        assert.ok(
          assistantTexts(h.session).some((text) =>
            text.includes('Follow-up turn observed background-task-notification'),
          ),
        );

        const note = requiredAt(
          customNotifications(h.session),
          0,
          'completion notification should be recorded',
        );
        assert.match(note.content, /<task-name>Scripted Wakeup<\/task-name>/);
        assert.match(note.content, /<status>completed<\/status>/);
        assert.match(note.content, /<guidance>Terminal state and output metadata are durable\./);
        assert.match(note.content, /Do not call bg_status to reconfirm/);
        assert.equal(note.details['triggerOnCompletion'], true);
        assert.equal(note.details['notified'], true);
      } finally {
        await disposeHarness(h);
      }
    },
  );

  void it(
    'notifyOnCompletion:false suppresses notification and prevents completion wakeup',
    { timeout: 15_000 },
    async () => {
      const h = await harness('notify-false');
      try {
        await h.session.prompt('Start the no-notify scripted background task.');
        await new Promise((resolve) => setTimeout(resolve, 500));
        await h.session.agent.waitForIdle();
        assert.equal(customNotifications(h.session).length, 0);
        const events = await providerEvents(h.eventsPath);
        assert.equal(events.length, 2);
        assert.ok(
          assistantTexts(h.session).some((text) =>
            text.includes('No-notify initial turn finished'),
          ),
        );
      } finally {
        await disposeHarness(h);
      }
    },
  );

  void it(
    'notifyOnCompletion:true with triggerOnCompletion:false notifies without a provider wakeup',
    { timeout: 15_000 },
    async () => {
      const h = await harness('wake-false');
      try {
        await h.session.prompt('Start the notification-only scripted background task.');
        await waitFor(() => customNotifications(h.session).length === 1, 'notification-only event');
        await new Promise((resolve) => setTimeout(resolve, 350));
        await h.session.agent.waitForIdle();

        const events = await providerEvents(h.eventsPath);
        assert.equal(events.length, 2);
        assert.equal(events[1]?.eventDrivenContract?.launchReceipt, false);
        assert.deepEqual(assistantToolNames(h.session), ['bg_run']);
        const note = requiredAt(
          customNotifications(h.session),
          0,
          'notification-only completion should be recorded',
        );
        assert.match(note.content, /<task-name>No Wake Scripted<\/task-name>/);
        assert.match(note.content, /<status>completed<\/status>/);
        assert.equal(note.details['triggerOnCompletion'], false);
        assert.ok(
          assistantTexts(h.session).some((text) =>
            text.includes('Notification-only initial turn finished'),
          ),
        );
      } finally {
        await disposeHarness(h);
      }
    },
  );

  void it(
    'failed background tasks include error fields and still wake a follow-up turn',
    { timeout: 15_000 },
    async () => {
      const h = await harness('failed-follow-up');
      try {
        await h.session.prompt('Start the failing scripted background task.');
        await waitFor(
          () => customNotifications(h.session).length === 1,
          'failed background notification',
        );
        await waitFor(
          async () => (await providerEvents(h.eventsPath)).length >= 3,
          'failed-task follow-up provider call',
        );
        await h.session.agent.waitForIdle();

        const note = requiredAt(
          customNotifications(h.session),
          0,
          'failed-task notification should be recorded',
        );
        assert.match(note.content, /<task-name>Failing Scripted<\/task-name>/);
        assert.match(note.content, /<status>failed<\/status>/);
        assert.match(note.content, /<exit-code>7<\/exit-code>/);
        assert.match(note.content, /<error>Exited with code 7<\/error>/);
        assert.equal(note.details['status'], 'failed');
        assert.equal(note.details['exitCode'], 7);
        assert.match(
          requiredString(
            note.details['error'],
            'failed notification should include an error string',
          ),
          /Exited with code 7/,
        );

        const events = await providerEvents(h.eventsPath);
        assert.equal(events.length, 3);
        const failedFollowUpEvent = requiredAt(
          events,
          2,
          'failed-task follow-up provider event should be recorded',
        );
        assert.match(
          (failedFollowUpEvent.summaries ?? []).join('\n'),
          /background-task-notification|Failing Scripted/,
        );
        assert.ok(
          assistantTexts(h.session).some((text) =>
            text.includes('Follow-up turn observed failed background task notification'),
          ),
        );
      } finally {
        await disposeHarness(h);
      }
    },
  );

  void it(
    '/bg remains display-only: it notifies but does not trigger a provider follow-up',
    { timeout: 15_000 },
    async () => {
      const h = await harness('display-only-bg');
      try {
        await h.session.prompt(
          '/unipi:bg --name "Display Only Scripted" node -e "setTimeout(() => { console.log(\'display done\'); }, 80);"',
        );
        await waitFor(
          () => customNotifications(h.session).length === 1,
          'display-only notification',
        );
        await new Promise((resolve) => setTimeout(resolve, 350));
        await h.session.agent.waitForIdle();
        const note = requiredAt(
          customNotifications(h.session),
          0,
          'display-only notification should be recorded',
        );
        assert.match(note.content, /<task-name>Display Only Scripted<\/task-name>/);
        assert.match(note.content, /<status>completed<\/status>/);
        assert.equal(note.details['triggerOnCompletion'], false);
        assert.equal((await providerEvents(h.eventsPath)).length, 0);
      } finally {
        await disposeHarness(h);
      }
    },
  );
});
