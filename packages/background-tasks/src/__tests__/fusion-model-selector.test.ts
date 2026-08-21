import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Theme, type ThemeColor } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import {
  FusionModelSelector,
  type FusionModelChoice,
  type FusionModelSelectorResult,
} from '../ui/fusion-model-selector.js';
import { CURRENT_MODEL_SELECTION, defaultFusionModelConfig } from '../fusion/config.js';
import type { FusionModelConfigV1 } from '../fusion/types.js';
import { stripAnsi } from './helpers/normalize.js';

const themeColors: readonly ThemeColor[] = [
  'accent',
  'border',
  'borderAccent',
  'borderMuted',
  'success',
  'error',
  'warning',
  'muted',
  'dim',
  'text',
  'thinkingText',
  'userMessageText',
  'customMessageText',
  'customMessageLabel',
  'toolTitle',
  'toolOutput',
  'mdHeading',
  'mdLink',
  'mdLinkUrl',
  'mdCode',
  'mdCodeBlock',
  'mdCodeBlockBorder',
  'mdQuote',
  'mdQuoteBorder',
  'mdHr',
  'mdListBullet',
  'toolDiffAdded',
  'toolDiffRemoved',
  'toolDiffContext',
  'syntaxComment',
  'syntaxKeyword',
  'syntaxFunction',
  'syntaxVariable',
  'syntaxString',
  'syntaxNumber',
  'syntaxType',
  'syntaxOperator',
  'syntaxPunctuation',
  'thinkingOff',
  'thinkingMinimal',
  'thinkingLow',
  'thinkingMedium',
  'thinkingHigh',
  'thinkingXhigh',
  'bashMode',
];
const themeBackgrounds = [
  'selectedBg',
  'userMessageBg',
  'customMessageBg',
  'toolPendingBg',
  'toolSuccessBg',
  'toolErrorBg',
] as const;
type ThemeForegrounds = ConstructorParameters<typeof Theme>[0];
type ThemeBackgrounds = ConstructorParameters<typeof Theme>[1];
const theme = new Theme(
  Object.fromEntries(themeColors.map((color) => [color, '#ffffff'])) as ThemeForegrounds,
  Object.fromEntries(themeBackgrounds.map((color) => [color, '#000000'])) as ThemeBackgrounds,
  'truecolor',
);

const choices: readonly FusionModelChoice[] = [
  {
    value: CURRENT_MODEL_SELECTION,
    label: CURRENT_MODEL_SELECTION,
    description: 'currently pi-bg/current-model',
    available: true,
  },
  {
    value: 'pi-bg/model-one',
    label: 'pi-bg/model-one',
    description: 'Model One',
    available: true,
  },
  {
    value: 'pi-bg/model/two',
    label: 'pi-bg/model/two',
    description: 'Slash model',
    available: true,
  },
  {
    value: 'stale/model-old',
    label: 'stale/model-old',
    description: 'configured but not currently available',
    available: false,
  },
];

function initialConfig(): FusionModelConfigV1 {
  return {
    schema_version: 'pi-background-tasks.fusion-models.v1',
    candidates: [CURRENT_MODEL_SELECTION, 'stale/model-old', CURRENT_MODEL_SELECTION],
    evaluator: CURRENT_MODEL_SELECTION,
    merger: CURRENT_MODEL_SELECTION,
  };
}

function selector(save: (config: FusionModelConfigV1) => Promise<void> = () => Promise.resolve()) {
  let renders = 0;
  let result: FusionModelSelectorResult | undefined;
  const instance = new FusionModelSelector({
    initialConfig: initialConfig(),
    choices,
    theme,
    onSave: save,
    onDone: (value) => {
      result = value;
    },
    onRenderRequest: () => {
      renders += 1;
    },
  });
  return {
    instance,
    get result() {
      return result;
    },
    get renders() {
      return renders;
    },
  };
}

function assertWidth(lines: readonly string[], width: number): void {
  for (const line of lines) assert.ok(visibleWidth(stripAnsi(line)) <= width, line);
}

void describe('FusionModelSelector component', () => {
  void it('renders all five slots, hints current and stale models, and remains width-safe', () => {
    const h = selector();
    const lines = h.instance.render(62);
    const text = stripAnsi(lines.join('\n'));
    for (const label of ['Candidate 1', 'Candidate 2', 'Candidate 3', 'Evaluator', 'Merger']) {
      assert.match(text, new RegExp(label));
    }
    assert.match(text, /currently pi-bg\/current-model/);
    assert.match(text, /stale\/model-old \(unavailable\)/);
    assertWidth(lines, 62);
    assertWidth(h.instance.render(24), 24);
  });

  void it('opens searchable choices, selects duplicate slash-containing models, resets, saves, and cancels', async () => {
    const saved: FusionModelConfigV1[] = [];
    const h = selector((config) => {
      saved.push(config);
      return Promise.resolve();
    });
    h.instance.handleInput('\r');
    h.instance.handleInput('t');
    h.instance.handleInput('w');
    assert.match(stripAnsi(h.instance.render(80).join('\n')), /pi-bg\/model\/two/);
    h.instance.handleInput('\r');
    h.instance.handleInput('\x1b[B');
    h.instance.handleInput('\r');
    h.instance.handleInput('t');
    h.instance.handleInput('w');
    h.instance.handleInput('\r');
    h.instance.handleInput('s');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const savedConfig = saved[0];
    assert.ok(savedConfig, 'selector should save a draft');
    assert.deepEqual(savedConfig.candidates, [
      'pi-bg/model/two',
      'pi-bg/model/two',
      CURRENT_MODEL_SELECTION,
    ]);
    assert.equal(h.result?.type, 'saved');

    const reset = selector();
    reset.instance.handleInput('r');
    reset.instance.handleInput('s');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const resetResult = reset.result;
    assert.ok(resetResult?.type === 'saved');
    assert.deepEqual(resetResult.config, defaultFusionModelConfig());

    const cancelled = selector();
    cancelled.instance.handleInput('\x1b');
    assert.equal(cancelled.result?.type, 'cancelled');
  });

  void it('keeps the dialog open and renders the save error when persistence fails', async () => {
    const h = selector(() => Promise.reject(new Error('revision conflict')));
    h.instance.handleInput('s');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.result, undefined);
    assert.match(stripAnsi(h.instance.render(80).join('\n')), /revision conflict/);
    assert.ok(h.renders > 0);
  });
});
