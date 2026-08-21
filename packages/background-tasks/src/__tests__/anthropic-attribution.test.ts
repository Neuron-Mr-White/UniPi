import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import spawnAnthropicAttribution, {
  ANTHROPIC_ATTRIBUTION_CLAIM_CHANNEL,
  rewriteAnthropicRequestPayload,
  type PiExtensionHost,
  type PiContextLike,
} from '../anthropic-attribution.js';
import { isJsonObject } from '../types.js';
import { buildAttestedPiArgv } from '../attested-pi-run.js';

const BAD_SYSTEM_LINES = [
  '- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)',
  '- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)',
  '- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing',
] as const;

function context(provider = 'anthropic'): PiContextLike {
  return {
    model: {
      provider,
      id: provider === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-5.5',
      maxTokens: 64_000,
      reasoning: true,
    },
    sessionManager: {
      getSessionId: () => '11111111-2222-4333-8444-555555555555',
      getBranch: () => [],
    },
  };
}

class SynchronousTestBus {
  private readonly handlers = new Map<string, Array<(data: unknown) => void>>();

  emit(channel: string, data: unknown): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(data);
  }

  on(channel: string, handler: (data: unknown) => void): () => void {
    const handlers = this.handlers.get(channel) ?? [];
    handlers.push(handler);
    this.handlers.set(channel, handlers);
    return () => {
      this.handlers.set(
        channel,
        (this.handlers.get(channel) ?? []).filter((candidate) => candidate !== handler),
      );
    };
  }

  listenerCount(channel: string): number {
    return this.handlers.get(channel)?.length ?? 0;
  }
}

function recordingHost(bus: SynchronousTestBus): {
  host: PiExtensionHost;
  registrations: { commands: number; handlers: number; providers: number; entries: number };
} {
  const registrations = { commands: 0, handlers: 0, providers: 0, entries: 0 };
  const on: PiExtensionHost['on'] = () => {
    registrations.handlers += 1;
  };
  return {
    host: {
      events: bus,
      on,
      registerCommand: () => {
        registrations.commands += 1;
      },
      registerProvider: () => {
        registrations.providers += 1;
      },
      appendEntry: () => {
        registrations.entries += 1;
      },
    },
    registrations,
  };
}

void describe('global Anthropic attribution extension', () => {
  void it('matches all SPS exact-line variants while preserving unrelated blocks and cache controls', () => {
    const original = {
      model: 'claude-sonnet-4-5',
      max_tokens: 64_000,
      system: [
        {
          type: 'text',
          text: ['keep before', ...BAD_SYSTEM_LINES, 'keep after'].join('\n'),
          cache_control: { type: 'ephemeral', ttl: '1h' },
          custom_field: 'preserved',
        },
        { type: 'custom', payload: 'unchanged' },
      ],
      messages: [{ role: 'user', content: 'hello' }],
    };

    const rewritten = rewriteAnthropicRequestPayload({
      payload: original,
      ctx: context(),
      account: {
        deviceId: 'd'.repeat(64),
        accountUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      },
    });
    assert.ok(isJsonObject(rewritten));
    const system: unknown = rewritten['system'];
    assert.ok(Array.isArray(system));
    const retained = system.find(
      (block) => isJsonObject(block) && block['custom_field'] === 'preserved',
    );
    assert.ok(isJsonObject(retained));
    assert.equal(retained['text'], 'keep before\nkeep after');
    assert.deepEqual(retained['cache_control'], { type: 'ephemeral', ttl: '1h' });
    assert.equal(retained['custom_field'], 'preserved');
    assert.deepEqual(system.at(-1), { type: 'custom', payload: 'unchanged' });
    assert.deepEqual(original.system[0]?.cache_control, { type: 'ephemeral', ttl: '1h' });
    for (const rejected of BAD_SYSTEM_LINES) {
      assert.equal(JSON.stringify(rewritten).includes(rejected), false);
    }
  });

  void it('leaves non-Anthropic payloads untouched', () => {
    const payload = { model: 'gpt-5.5', metadata: { untouched: true } };
    assert.equal(
      rewriteAnthropicRequestPayload({
        payload,
        ctx: context('openai-codex'),
        account: { deviceId: 'd', accountUuid: 'a' },
      }),
      undefined,
    );
    assert.deepEqual(payload, { model: 'gpt-5.5', metadata: { untouched: true } });
  });

  void it('adds package attribution to attested Anthropic argv only', () => {
    const base = {
      name: 'Attested child',
      model: 'model',
      prompt: 'write report.md',
      reportPath: 'report.md',
    };
    assert.deepEqual(
      buildAttestedPiArgv(
        { ...base, provider: 'anthropic' },
        '/pkg/extensions/anthropic-attribution.ts',
      ),
      [
        'pi',
        '--mode',
        'json',
        '--provider',
        'anthropic',
        '--model',
        'model',
        '--extension',
        '/pkg/extensions/anthropic-attribution.ts',
        'write report.md',
      ],
    );
    assert.deepEqual(buildAttestedPiArgv({ ...base, provider: 'openai-codex' }), [
      'pi',
      '--mode',
      'json',
      '--provider',
      'openai-codex',
      '--model',
      'model',
      'write report.md',
    ]);
    assert.throws(
      () => buildAttestedPiArgv({ ...base, provider: 'anthropic' }),
      /require the package attribution extension/,
    );
  });

  void it('allows exactly one independently loaded copy to own global registration', () => {
    const bus = new SynchronousTestBus();
    const first = recordingHost(bus);
    const second = recordingHost(bus);

    spawnAnthropicAttribution(first.host);
    spawnAnthropicAttribution(second.host);

    assert.equal(first.registrations.commands, 1);
    assert.equal(first.registrations.handlers, 4);
    assert.equal(first.registrations.providers, 1);
    assert.equal(second.registrations.commands, 0);
    assert.equal(second.registrations.handlers, 0);
    assert.equal(second.registrations.providers, 0);
    assert.equal(bus.listenerCount(ANTHROPIC_ATTRIBUTION_CLAIM_CHANNEL), 1);
  });
});
