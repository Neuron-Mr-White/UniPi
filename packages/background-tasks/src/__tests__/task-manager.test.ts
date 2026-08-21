import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Theme, type ThemeColor } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import {
  BackgroundTasksManager,
  type BackgroundTaskForUi,
} from '../task-manager.js';
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

function task(overrides: Partial<BackgroundTaskForUi> = {}): BackgroundTaskForUi {
  const now = Date.now();
  return {
    id: 'b12345678',
    name: 'Component Task',
    command: 'printf component-ok',
    status: 'running',
    outputPath: '.pi/tasks/test/b12345678.output',
    outputAbsPath: join(tmpdir(), 'missing-output'),
    cwd: tmpdir(),
    startTime: now - 1000,
    bytesWritten: 0,
    isAgent: false,
    notified: false,
    notifyOnCompletion: true,
    triggerOnCompletion: false,
    ...overrides,
  };
}

function manager(
  options: Partial<ConstructorParameters<typeof BackgroundTasksManager>[3]> = {},
  tasks: BackgroundTaskForUi[] = [task()],
) {
  let closed = false;
  let renders = 0;
  const stopped: string[] = [];
  const paths: string[] = [];
  const seen = new Set<string>();
  const instance = new BackgroundTasksManager(
    {
      requestRender: () => {
        renders++;
      },
    },
    theme,
    () => {
      closed = true;
    },
    {
      getTasks: () => tasks,
      stopTask: (t) => {
        stopped.push(t.id);
        t.status = 'killed';
        t.endTime = Date.now();
        return Promise.resolve();
      },
      stopAllRunning: () => {
        const running = tasks.filter((t) => t.status === 'running');
        for (const t of running) {
          stopped.push(t.id);
          t.status = 'killed';
          t.endTime = Date.now();
        }
        return Promise.resolve({ stopped: running.length, failures: [] });
      },
      rerunTask: (t) => {
        const overrides: Partial<BackgroundTaskForUi> = {
          id: `babcdef${String(tasks.length)}`,
          name: t.name,
          command: t.command,
          startTime: Date.now(),
        };
        if (t.description !== undefined) overrides.description = t.description;
        if (t.timeoutSeconds !== undefined) overrides.timeoutSeconds = t.timeoutSeconds;
        const rerun = task(overrides);
        tasks.unshift(rerun);
        return Promise.resolve(rerun);
      },
      showOutputPath: (t) => {
        paths.push(t.outputPath);
      },
      markSeen: (id) => {
        seen.add(id);
      },
      markFinishedSeen: (ids) => {
        for (const id of ids) seen.add(id);
      },
      isSeen: (id) => seen.has(id),
      ...options,
    },
  );
  return {
    instance,
    get closed() {
      return closed;
    },
    get renders() {
      return renders;
    },
    stopped,
    paths,
    seen,
  };
}

function assertWidth(lines: string[], width: number) {
  for (const line of lines) assert.ok(visibleWidth(stripAnsi(line)) <= width, line);
}

void describe('BackgroundTasksManager component', () => {
  void it('renders list within width and handles selection/actions', async () => {
    const baseTime = Date.now();
    const tasks = [
      task({ id: 'b11111111', name: 'First Task', startTime: baseTime + 1000 }),
      task({ id: 'b22222222', name: 'Second Task', startTime: baseTime }),
    ];
    const h = manager({}, tasks);
    try {
      const lines = h.instance.render(90);
      assert.match(stripAnsi(lines.join('\n')), /bg tasks focused/);
      assert.match(stripAnsi(lines.join('\n')), /First Task/);
      assertWidth(lines, 90);

      h.instance.handleInput('\x1b[B');
      h.instance.handleInput('k');
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(h.stopped, ['b22222222']);

      h.instance.handleInput('h');
      h.instance.handleInput('R');
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.ok(tasks.some((candidate) => candidate.id.startsWith('babcdef')));

      h.instance.handleInput('c');
      assert.ok(h.paths.length >= 1);

      h.instance.handleInput('x');
      assert.equal(h.closed, true);
    } finally {
      h.instance.dispose();
    }
  });

  void it('renders task-owned context, model, token, and tool telemetry in list/detail rows and placeholder when absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-bg-context-'));
    try {
      const outputAbsPath = join(dir, 'task.output');
      await writeFile(outputAbsPath, 'context-output\n', 'utf8');
      const tasks = [
        task({
          id: 'bctx00001',
          name: 'Context Task',
          outputAbsPath,
          isAgent: true,
          model: 'openai-codex/gpt-5.5',
          contextUsage: { tokens: 42_000, contextWindow: 200_000, percent: 21 },
          tokenUsage: {
            input: 1000,
            output: 200,
            cacheRead: 30,
            cacheWrite: 20,
            totalTokens: 1250,
          },
          toolUsage: { total: 3, failed: 1, byName: { bash: 2, read: 1 } },
        }),
        task({
          id: 'bctx00002',
          name: 'No Context Task',
          outputAbsPath,
          startTime: Date.now() - 2000,
        }),
      ];
      const h = manager({}, tasks);
      try {
        let text = stripAnsi(h.instance.render(120).join('\n'));
        assert.match(text, /ctx 21\.0%\/200k/);
        assert.match(text, /model gpt-5\.5/);
        assert.match(text, /tok 1\.3k/);
        assert.match(text, /tools 3\/1 failed/);
        assert.match(text, /ctx —/);
        h.instance.handleInput('\r');
        await new Promise((resolve) => setTimeout(resolve, 20));
        text = stripAnsi(h.instance.render(120).join('\n'));
        assert.match(text, /Model: openai-codex\/gpt-5\.5/);
        assert.match(text, /Context: 21\.0% of 200k window \(42k tokens\)/);
        assert.match(
          text,
          /Tokens: input 1\.0k · output 200 · cache read 30 · cache write 20 · total 1\.3k/,
        );
        assert.match(text, /Tools: 3 total · 1 failed · bash 2 · read 1/);
        h.instance.handleInput('\x1b[D');
        h.instance.handleInput('\x1b[B');
        h.instance.handleInput('\r');
        await new Promise((resolve) => setTimeout(resolve, 20));
        text = stripAnsi(h.instance.render(120).join('\n'));
        assert.match(text, /Model: not reported by this background task/);
      } finally {
        h.instance.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  void it('opens detail, reads bounded tail, refreshes, acts, and returns to list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-bg-component-'));
    try {
      const outputAbsPath = join(dir, 'task.output');
      await writeFile(outputAbsPath, 'line one\ncomponent-tail\n', 'utf8');
      const tasks = [task({ outputAbsPath, bytesWritten: 24 })];
      const h = manager({ initialTaskId: 'b12345678' }, tasks);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        let text = stripAnsi(h.instance.render(100).join('\n'));
        assert.match(text, /bg: Component Task/);
        assert.match(text, /component-tail/);
        assert.ok(h.seen.has('b12345678'));

        h.instance.handleInput('r');
        h.instance.handleInput('c');
        h.instance.handleInput('k');
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.deepEqual(h.paths, ['.pi/tasks/test/b12345678.output']);
        assert.deepEqual(h.stopped, ['b12345678']);
        h.instance.handleInput('R');
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.ok(tasks.some((candidate) => candidate.id.startsWith('babcdef')));

        h.instance.handleInput('\x1b[D');
        text = stripAnsi(h.instance.render(100).join('\n'));
        assert.match(text, /bg tasks focused/);
      } finally {
        h.instance.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  void it('scrolls the detail output tail with arrows/pages and resumes follow at the bottom', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-bg-scroll-'));
    try {
      const outputAbsPath = join(dir, 'task.output');
      const fileLines = Array.from(
        { length: 40 },
        (_, i) => `LINE-${String(i + 1).padStart(3, '0')}`,
      );
      await writeFile(outputAbsPath, `${fileLines.join('\n')}\n`, 'utf8');
      const h = manager({ initialTaskId: 'b12345678' }, [
        task({ outputAbsPath, bytesWritten: 400 }),
      ]);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        let text = stripAnsi(h.instance.render(100).join('\n'));
        assert.match(text, /following tail/);
        assert.match(text, /LINE-040/);
        assert.match(text, /LINE-029/);
        assert.doesNotMatch(text, /LINE-001/);
        assert.doesNotMatch(text, /LINE-005/);

        // Scroll up 20 lines: pauses follow, reveals earlier lines, hides the latest.
        for (let i = 0; i < 20; i++) h.instance.handleInput('\x1b[A');
        text = stripAnsi(h.instance.render(100).join('\n'));
        assert.match(text, /lines 9\u201320 of 40/);
        assert.match(text, /LINE-009/);
        assert.match(text, /LINE-020/);
        assert.doesNotMatch(text, /LINE-040/);

        // PageUp reaches the top of the buffer.
        h.instance.handleInput('\x1b[5~');
        text = stripAnsi(h.instance.render(100).join('\n'));
        assert.match(text, /lines 1\u201312 of 40/);
        assert.match(text, /LINE-001/);

        // Paging back past the end resumes the live tail.
        h.instance.handleInput('\x1b[6~');
        h.instance.handleInput('\x1b[6~');
        h.instance.handleInput('\x1b[6~');
        await new Promise((resolve) => setTimeout(resolve, 20));
        text = stripAnsi(h.instance.render(100).join('\n'));
        assert.match(text, /following tail/);
        assert.match(text, /LINE-040/);
      } finally {
        h.instance.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  void it('does not enter scroll mode when the output fits the detail window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-bg-noscroll-'));
    try {
      const outputAbsPath = join(dir, 'task.output');
      await writeFile(outputAbsPath, 'only-line-a\nonly-line-b\nonly-line-c\n', 'utf8');
      const h = manager({ initialTaskId: 'b12345678' }, [
        task({ outputAbsPath, bytesWritten: 33 }),
      ]);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        h.instance.handleInput('\x1b[A');
        h.instance.handleInput('\x1b[A');
        const text = stripAnsi(h.instance.render(100).join('\n'));
        assert.match(text, /only-line-c/);
        assert.match(text, /following tail/);
        assert.doesNotMatch(text, /lines \d+\u2013\d+ of/);
      } finally {
        h.instance.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  void it('requires confirmation before stopping all running tasks and reports no-op clearly', async () => {
    const tasks = [task({ id: 'b11111111' }), task({ id: 'b22222222' })];
    const h = manager({}, tasks);
    try {
      h.instance.handleInput('a');
      assert.deepEqual(h.stopped, []);
      assert.match(stripAnsi(h.instance.render(100).join('\n')), /Press a\/K again/);
      h.instance.handleInput('a');
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(h.stopped.sort(), ['b11111111', 'b22222222']);
      h.instance.handleInput('a');
      assert.match(stripAnsi(h.instance.render(100).join('\n')), /No running background tasks/);
    } finally {
      h.instance.dispose();
    }
  });

  void it('shows empty and history states, unread badges, and does not auto-clear finished notices on close', () => {
    const h = manager({}, []);
    try {
      const text = stripAnsi(h.instance.render(72).join('\n'));
      assert.match(text, /No background tasks/);
      h.instance.handleInput('h');
      assert.match(stripAnsi(h.instance.render(72).join('\n')), /No background tasks/);
    } finally {
      h.instance.dispose();
    }

    const finished = [
      task({
        id: 'bfailed01',
        name: 'Failed Task',
        status: 'failed',
        error: 'boom',
        endTime: Date.now(),
        exitCode: 1,
      }),
    ];
    const hf = manager({}, finished);
    try {
      const text = stripAnsi(hf.instance.render(80).join('\n'));
      assert.match(text, /1 failed/);
      assert.match(text, /1 unread/);
      assert.match(text, /●/);
      hf.instance.handleInput('x');
      assert.equal(hf.seen.has('bfailed01'), false);
    } finally {
      hf.instance.dispose();
    }
  });

  void it('handles non-running stop, output read failures, paging, long text, and close aliases', async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      task({
        id: `b${String(i).padStart(8, '0')}`,
        name: `Very Long Component Task Name ${String(i)} ${'x'.repeat(80)}`,
        command: `printf ${String(i)}`,
        startTime: Date.now() - i * 1000,
      }),
    );
    const firstTask = many[0];
    assert.ok(firstTask);
    firstTask.status = 'completed';
    firstTask.endTime = Date.now();
    const h = manager({}, many);
    try {
      h.instance.handleInput('\x1b[6~');
      h.instance.handleInput('\x1b[5~');
      const lines = h.instance.render(50);
      assertWidth(lines, 50);
      h.instance.handleInput('h');
      h.instance.handleInput('\x1b[5~');
      assertWidth(h.instance.render(64), 64);
      h.instance.handleInput('\r');
      await new Promise((resolve) => setTimeout(resolve, 20));
      let text = stripAnsi(h.instance.render(80).join('\n'));
      assert.match(text, /Output file not found|No output yet|bg:/);
      h.instance.handleInput('\x1b[D');
      h.instance.handleInput('h');
      h.instance.handleInput('k');
      await new Promise((resolve) => setTimeout(resolve, 0));
      text = stripAnsi(h.instance.render(90).join('\n'));
      assert.match(text, /nothing to stop|Stopped/);
      h.instance.handleInput('q');
      assert.equal(h.closed, true);
    } finally {
      h.instance.dispose();
    }

    const esc = manager({}, [task()]);
    try {
      esc.instance.handleInput('\x1b');
      assert.equal(esc.closed, true);
    } finally {
      esc.instance.dispose();
    }
  });
});
