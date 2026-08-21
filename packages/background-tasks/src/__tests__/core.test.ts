import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  boundedRead,
  compareSemver,
  deriveCompletionDeliveryGuidance,
  deriveTaskNameFromCommand,
  formatAgentActivityLine,
  parseAgentActivity,
  formatCompactNumber,
  formatDuration,
  formatModelSummary,
  formatSnapshotList,
  formatUpdateSegment,
  isNewerVersion,
  normalizeMaxBytes,
  normalizeTaskName,
  parseBgCommandArgs,
  parseSemver,
  sanitizePathSegment,
  shellInvocation,
  TASK_STATUS_VALUES,
  taskDisplayName,
  TERMINAL_TASK_STATUS_VALUES,
  truncateChars,
} from '../types.js';

void describe('core', () => {
  void it('parses /bg names, aliases, equals forms, quotes, and empty commands', () => {
    assert.deepEqual(parseBgCommandArgs('--name "Build Docs" npm run docs'), {
      name: 'Build Docs',
      command: 'npm run docs',
      isAgent: false,
    });
    assert.deepEqual(parseBgCommandArgs('--name=Build npm test'), {
      name: 'Build',
      command: 'npm test',
      isAgent: false,
    });
    assert.deepEqual(parseBgCommandArgs("-n 'Quoted Name' printf ok"), {
      name: 'Quoted Name',
      command: 'printf ok',
      isAgent: false,
    });
    assert.deepEqual(parseBgCommandArgs('-n=One printf one'), {
      name: 'One',
      command: 'printf one',
      isAgent: false,
    });
    assert.deepEqual(parseBgCommandArgs('--agent --name Agent pi -p hi'), {
      name: 'Agent',
      command: 'pi -p hi',
      isAgent: true,
    });
    assert.deepEqual(parseBgCommandArgs('--name Agent --script pi -p hi'), {
      name: 'Agent',
      command: 'pi -p hi',
      isAgent: false,
    });
    assert.deepEqual(parseBgCommandArgs('echo ok'), { command: 'echo ok', isAgent: false });
    assert.deepEqual(parseBgCommandArgs("--name 'Only Name'"), {
      name: 'Only Name',
      command: '',
      isAgent: false,
    });
    assert.throws(() => parseBgCommandArgs('--name'), /requires a task name/);
    assert.throws(() => parseBgCommandArgs('--name "unterminated'), /requires a task name/);
  });

  void it('normalizes task names and derives stable fallbacks', () => {
    assert.equal(normalizeTaskName(' "A   B" '), 'A B');
    assert.equal(normalizeTaskName('\n\t'), undefined);
    assert.equal(normalizeTaskName(123), undefined);
    assert.equal(normalizeTaskName('x'.repeat(100)), `${'x'.repeat(79)}…`);
    assert.equal(deriveTaskNameFromCommand('npm run test -- --watch'), 'npm run test');
    assert.equal(deriveTaskNameFromCommand('pnpm build && echo done'), 'pnpm build');
    assert.equal(deriveTaskNameFromCommand(''), 'Background task');
    assert.equal(
      taskDisplayName({ description: 'Longer description', command: 'echo ok' }),
      'Longer description',
    );
    assert.equal(
      taskDisplayName({ command: 'echo one two three four five six' }),
      'echo one two three four',
    );
    assert.equal(taskDisplayName({ id: 'b123' }), 'b123');
  });

  void it('derives truthful completion delivery for every notification and wake combination', () => {
    assert.deepEqual(deriveCompletionDeliveryGuidance(true, true), {
      mode: 'notification-and-wake',
      notificationEnabled: true,
      automaticWakeEnabled: true,
      text: [
        'Terminal notification: enabled.',
        'Automatic follow-up turn: enabled.',
        'Next action: do not poll or sleep merely to wait; continue only independent useful work, otherwise end this turn and wait for <background-task-notification>.',
      ].join('\n'),
    });
    assert.deepEqual(deriveCompletionDeliveryGuidance(true, false), {
      mode: 'notification-only',
      notificationEnabled: true,
      automaticWakeEnabled: false,
      text: [
        'Terminal notification: enabled.',
        'Automatic follow-up turn: disabled. The terminal notification will be delivered, but it will not start an agent turn.',
        'Next action: automatic wake-up was explicitly disabled; use bg_status/bg_logs only when deliberate monitoring is required, without tight polling.',
      ].join('\n'),
    });
    const notifyDisabledWithRequestedWake = deriveCompletionDeliveryGuidance(false, true);
    assert.equal(notifyDisabledWithRequestedWake.mode, 'manual-monitoring');
    assert.equal(notifyDisabledWithRequestedWake.notificationEnabled, false);
    assert.equal(notifyDisabledWithRequestedWake.automaticWakeEnabled, false);
    assert.match(notifyDisabledWithRequestedWake.text, /triggerOnCompletion has no effect/);
    const manual = deriveCompletionDeliveryGuidance(false, false);
    assert.equal(manual.mode, 'manual-monitoring');
    assert.match(manual.text, /deliberate manual monitoring/);
    assert.doesNotMatch(manual.text, /triggerOnCompletion has no effect/);
  });

  void it('formats durations, paths, snapshots, and byte limits', () => {
    assert.equal(formatDuration(999), '999ms');
    assert.equal(formatDuration(1000), '1s');
    assert.equal(formatDuration(65_000), '1m5s');
    assert.equal(formatDuration(3_660_000), '1h1m');
    assert.equal(formatCompactNumber(999), '999');
    assert.equal(formatCompactNumber(1250), '1.3k');
    assert.equal(formatCompactNumber(42_000), '42k');
    assert.equal(sanitizePathSegment('a/b c'), 'a-b-c');
    assert.equal(sanitizePathSegment('///'), 'session');
    // Pin both dialects explicitly. The host default differs by platform:
    // cmd.exe requires the paired outer-quoted form, POSIX passes the command
    // through verbatim, so an unpinned assertion fails on Windows.
    assert.equal(shellInvocation('echo ok', 'linux', {}).args.includes('echo ok'), true);
    assert.deepEqual(shellInvocation('echo ok', 'win32', { ComSpec: 'cmd.exe' }).args, [
      '/d',
      '/s',
      '/c',
      '"echo ok"',
    ]);
    assert.equal(normalizeMaxBytes(-1, 123), 1);
    assert.equal(normalizeMaxBytes(Number.NaN, 123), 123);
    assert.equal(normalizeMaxBytes(1.9, 123), 1);
    assert.equal(truncateChars('abcdef', 4), 'abc…');
    assert.deepEqual([...TASK_STATUS_VALUES], ['running', 'completed', 'failed', 'killed']);
    assert.deepEqual([...TERMINAL_TASK_STATUS_VALUES], ['completed', 'failed', 'killed']);

    const text = formatSnapshotList(
      [
        {
          id: 'b12345678',
          name: 'Unit Task',
          command: 'echo ok',
          status: 'completed',
          outputPath: '.pi/tasks/run/b12345678.output',
          cwd: '/tmp',
          startTime: 1000,
          endTime: 2000,
          exitCode: 0,
          bytesWritten: 3,
          isAgent: true,
          notified: true,
          notifyOnCompletion: true,
          triggerOnCompletion: false,
          contextUsage: { tokens: 1250, contextWindow: 200_000, percent: 0.625 },
          tokenUsage: {
            input: 1000,
            output: 200,
            cacheRead: 30,
            cacheWrite: 20,
            totalTokens: 1250,
          },
          toolUsage: { total: 2, failed: 1, byName: { read: 1, bash: 1 } },
          model: 'anthropic/claude-sonnet-4',
        },
        {
          id: 'b99999999',
          command: 'bad',
          status: 'failed',
          outputPath: '.pi/tasks/run/b99999999.output',
          cwd: '/tmp',
          startTime: 1000,
          endTime: 2000,
          exitCode: 1,
          bytesWritten: 0,
          isAgent: false,
          error: 'x'.repeat(100),
          notified: false,
          notifyOnCompletion: true,
          triggerOnCompletion: true,
        },
      ],
      2000,
    );
    assert.match(text, /Unit Task/);
    assert.match(text, /ctx=0\.6%\/200k/);
    assert.match(text, /model=anthropic\/claude-sonnet-4/);
    assert.match(text, /tokens=1\.3k/);
    assert.match(text, /tools=2 failed=1/);
    assert.match(text, /✗ b99999999 failed/);
    assert.match(text, /output: \.pi\/tasks/);
    assert.equal(
      formatModelSummary('anthropic/claude-sonnet-4'),
      'model=anthropic/claude-sonnet-4',
    );
    assert.equal(formatModelSummary(undefined), undefined);
    assert.equal(formatModelSummary(''), undefined);
  });

  void it('parses and compares semver including prerelease precedence', () => {
    assert.deepEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] });
    assert.deepEqual(parseSemver('v0.4.0'), { major: 0, minor: 4, patch: 0, prerelease: [] });
    assert.deepEqual(parseSemver('1.0.0-beta.2'), {
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: ['beta', '2'],
    });
    assert.deepEqual(parseSemver('1.2.3+build.5'), {
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
    assert.equal(parseSemver('1.2'), undefined);
    assert.equal(parseSemver('latest'), undefined);
    assert.equal(parseSemver(''), undefined);

    assert.equal(compareSemver('1.2.3', '1.2.2'), 1);
    assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
    assert.equal(compareSemver('1.2.3', '1.3.0'), -1);
    assert.equal(compareSemver('2.0.0', '1.9.9'), 1);
    assert.equal(compareSemver('1.0.0', '1.0.0-beta'), 1);
    assert.equal(compareSemver('1.0.0-alpha', '1.0.0'), -1);
    assert.equal(compareSemver('1.0.0-alpha', '1.0.0-beta'), -1);
    assert.equal(compareSemver('1.0.0-alpha.2', '1.0.0-alpha.1'), 1);
    assert.equal(compareSemver('1.0.0-alpha.1', '1.0.0-alpha'), 1);
    assert.equal(compareSemver('1.0.0-1', '1.0.0-alpha'), -1);
    assert.equal(compareSemver('1.0.0-2', '1.0.0-10'), -1);
    assert.equal(compareSemver('garbage', '1.0.0'), undefined);
    assert.equal(compareSemver('1.0.0', 'garbage'), undefined);
  });

  void it('derives newer-version flags and footer update segments', () => {
    assert.equal(isNewerVersion('0.4.0', '0.3.0'), true);
    assert.equal(isNewerVersion('v0.4.0', '0.3.0'), true);
    assert.equal(isNewerVersion('0.3.0', '0.3.0'), false);
    assert.equal(isNewerVersion('0.2.0', '0.3.0'), false);
    assert.equal(isNewerVersion('garbage', '0.3.0'), false);
    assert.equal(formatUpdateSegment('0.4.0', '0.3.0'), '\u2b06 v0.4.0 /unipi:bg-update');
    assert.equal(formatUpdateSegment('0.3.0', '0.3.0'), undefined);
    assert.equal(formatUpdateSegment('0.2.0', '0.3.0'), undefined);
    assert.equal(formatUpdateSegment(undefined, '0.3.0'), undefined);
    assert.equal(formatUpdateSegment('garbage', '0.3.0'), undefined);
    assert.equal(formatUpdateSegment('0.4.0', ''), undefined);
  });

  void it('applies the Windows shell dialect policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-bg-shell-'));
    try {
      const bashPath = join(root, 'bash.exe');
      const cmdPath = join(root, 'cmd.com');
      await writeFile(bashPath, '', 'utf8');
      await writeFile(cmdPath, '', 'utf8');

      assert.deepEqual(
        shellInvocation('echo %USERPROFILE%', 'win32', {
          SHELL: bashPath,
          ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        }),
        {
          shell: 'C:\\Windows\\System32\\cmd.exe',
          args: ['/d', '/s', '/c', '"echo %USERPROFILE%"'],
          dialect: 'cmd',
          windowsVerbatimArguments: true,
        },
      );
      assert.deepEqual(shellInvocation('dir C:\\work', 'win32', {}), {
        shell: 'cmd.exe',
        args: ['/d', '/s', '/c', '"dir C:\\work"'],
        dialect: 'cmd',
        windowsVerbatimArguments: true,
      });
      assert.deepEqual(
        shellInvocation('printf ok', 'win32', {
          UNIPI_BG_SHELL: 'bash',
          UNIPI_BG_SHELL_PATH: bashPath,
        }),
        {
          shell: bashPath,
          args: ['-c', 'printf ok'],
          dialect: 'posix',
          windowsVerbatimArguments: false,
        },
      );
      assert.notDeepEqual(
        shellInvocation('printf ok', 'win32', {
          UNIPI_BG_SHELL: 'bash',
          UNIPI_BG_SHELL_PATH: bashPath,
        }).args,
        ['-lc', 'printf ok'],
      );
      assert.equal(
        shellInvocation('printf ok', 'win32', { UNIPI_BG_SHELL: 'bash', PATH: root }).shell,
        bashPath,
      );
      assert.equal(
        shellInvocation('set X=1', 'win32', { UNIPI_BG_SHELL: 'cmd', UNIPI_BG_SHELL_PATH: cmdPath })
          .shell,
        cmdPath,
      );
      for (const value of ['', ' bash', 'bash ', 'zsh']) {
        assert.throws(() => shellInvocation('echo bad', 'win32', { UNIPI_BG_SHELL: value }), /cmd or bash/);
      }
      assert.throws(
        () => shellInvocation('echo bad', 'win32', { UNIPI_BG_SHELL_PATH: bashPath }),
        /requires UNIPI_BG_SHELL/,
      );
      assert.throws(
        () =>
          shellInvocation('echo bad', 'win32', {
            UNIPI_BG_SHELL: 'bash',
            UNIPI_BG_SHELL_PATH: 'bash.exe',
          }),
        /absolute path/,
      );
      assert.deepEqual(
        shellInvocation('echo $SHELL', 'linux', {
          SHELL: '/bin/zsh',
          UNIPI_BG_SHELL: 'cmd',
          UNIPI_BG_SHELL_PATH: bashPath,
        }),
        {
          shell: '/bin/zsh',
          args: ['-c', 'echo $SHELL'],
          dialect: 'posix',
          windowsVerbatimArguments: false,
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('parses and formats agent activity transcript lines', () => {
    assert.deepEqual(
      parseAgentActivity({
        type: 'background-task-activity',
        kind: 'assistant_text',
        text: 'Done.\n',
      }),
      { kind: 'assistant_text', text: 'Done.\n' },
    );
    assert.equal(
      formatAgentActivityLine({ kind: 'assistant_text', text: 'Looks good\n\n' }),
      'Looks good',
    );
    assert.equal(formatAgentActivityLine({ kind: 'assistant_text', text: '  \n ' }), undefined);

    assert.equal(
      formatAgentActivityLine({ kind: 'reasoning', text: 'weighing options' }),
      '\u2026 weighing options',
    );
    assert.equal(formatAgentActivityLine({ kind: 'reasoning', text: '   ' }), undefined);

    assert.deepEqual(
      parseAgentActivity({
        type: 'background-task-activity',
        kind: 'tool_start',
        tool: 'read',
        argsSummary: 'README.md',
      }),
      { kind: 'tool_start', tool: 'read', argsSummary: 'README.md' },
    );
    assert.equal(
      formatAgentActivityLine({
        kind: 'tool_start',
        tool: 'read',
        argsSummary: '  src/index.ts  ',
      }),
      '\u2192 read src/index.ts',
    );
    assert.equal(
      formatAgentActivityLine({ kind: 'tool_start', tool: 'bash', argsSummary: '' }),
      '\u2192 bash',
    );
    assert.equal(
      formatAgentActivityLine({ kind: 'tool_start', tool: 'bash', argsSummary: 'x'.repeat(120) }),
      `\u2192 bash ${'x'.repeat(79)}\u2026`,
    );
    assert.deepEqual(
      parseAgentActivity({ type: 'background-task-activity', kind: 'tool_start', tool: 'ls' }),
      { kind: 'tool_start', tool: 'ls', argsSummary: '' },
    );

    assert.deepEqual(
      parseAgentActivity({
        type: 'background-task-activity',
        kind: 'tool_end',
        tool: 'bash',
        isError: true,
        error: 'boom',
      }),
      { kind: 'tool_end', tool: 'bash', isError: true, error: 'boom' },
    );
    assert.equal(
      formatAgentActivityLine({ kind: 'tool_end', tool: 'read', isError: false }),
      undefined,
    );
    assert.equal(
      formatAgentActivityLine({ kind: 'tool_end', tool: 'bash', isError: true }),
      '\u2717 bash failed',
    );
    assert.equal(
      formatAgentActivityLine({
        kind: 'tool_end',
        tool: 'bash',
        isError: true,
        error: 'exit 1\nmore',
      }),
      '\u2717 bash failed: exit 1 more',
    );

    assert.equal(parseAgentActivity(null), undefined);
    assert.equal(parseAgentActivity('background-task-activity'), undefined);
    assert.equal(
      parseAgentActivity({ type: 'background-task-telemetry', kind: 'tool_start', tool: 'read' }),
      undefined,
    );
    assert.equal(
      parseAgentActivity({ type: 'background-task-activity', kind: 'mystery' }),
      undefined,
    );
    assert.equal(
      parseAgentActivity({ type: 'background-task-activity', kind: 'tool_start' }),
      undefined,
    );
    assert.equal(
      parseAgentActivity({ type: 'background-task-activity', kind: 'assistant_text' }),
      undefined,
    );
    const end = parseAgentActivity({
      type: 'background-task-activity',
      kind: 'tool_end',
      tool: 'x',
      isError: false,
      error: '   ',
    });
    assert.equal(end?.kind, 'tool_end');
    assert.equal(end?.tool, 'x');
    assert.equal(end?.isError, false);
    assert.ok(!end || !('error' in end) || end.error === undefined);
  });

  void it('boundedRead supports head, tail, truncation, and empty files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-bg-unit-'));
    try {
      const f = join(dir, 'out');
      await writeFile(f, 'abcdef');
      assert.deepEqual(await boundedRead(f, 3, true), {
        content: 'def',
        truncated: true,
        bytesRead: 3,
        totalBytes: 6,
      });
      assert.deepEqual(await boundedRead(f, 3, false), {
        content: 'abc',
        truncated: true,
        bytesRead: 3,
        totalBytes: 6,
      });
      assert.deepEqual(await boundedRead(f, 99, false), {
        content: 'abcdef',
        truncated: false,
        bytesRead: 6,
        totalBytes: 6,
      });
      const empty = join(dir, 'empty');
      await writeFile(empty, '');
      assert.deepEqual(await boundedRead(empty, 3, true), {
        content: '',
        truncated: false,
        bytesRead: 0,
        totalBytes: 0,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
