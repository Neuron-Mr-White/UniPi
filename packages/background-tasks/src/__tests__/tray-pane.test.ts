// The work tray's Background tasks tab: same list/detail design as the
// Subagents tab (core pane-kit), replacing the old "bg tasks focused" box.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { visibleWidth } from '@earendil-works/pi-tui';
import {
  BackgroundTasksPane,
  BG_LIST_HINT,
  BG_VIEW_HINT,
  orderTasks,
  taskRow,
  type BackgroundTaskForUi,
} from '../tray-pane.js';
import { stripAnsi } from './helpers/normalize.js';

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const LEFT = '\x1b[D';
const now = Date.now();

function task(over: Partial<BackgroundTaskForUi> = {}): BackgroundTaskForUi {
  return {
    id: 'b12345678',
    name: 'ticker',
    command: 'for i in $(seq 1 300); do echo tick $i; sleep 1; done',
    status: 'running',
    outputPath: '/tmp/x/b12345678.output',
    outputAbsPath: join(tmpdir(), 'missing-output-bg-pane'),
    cwd: tmpdir(),
    startTime: now - 70_000,
    bytesWritten: 559,
    isAgent: false,
    notified: false,
    notifyOnCompletion: true,
    triggerOnCompletion: true,
    ...over,
  };
}

function pane(tasks: BackgroundTaskForUi[], initialId?: string) {
  const calls: string[] = [];
  let closed = false;
  const p = new BackgroundTasksPane(
    { requestRender() {} },
    theme,
    {
      tasks: () => tasks,
      stop: (t) => {
        calls.push(`stop:${t.id}`);
        t.status = 'killed';
        t.endTime = Date.now();
        return Promise.resolve();
      },
      kill: (t) => {
        calls.push(`kill:${t.id}`);
        t.status = 'killed';
        t.endTime = Date.now();
        return Promise.resolve();
      },
      stopAll: () => {
        const running = tasks.filter((t) => t.status === 'running');
        for (const t of running) t.status = 'killed';
        calls.push(`stopAll:${String(running.length)}`);
        return Promise.resolve({ stopped: running.length, failures: [] });
      },
      rerun: (t) => {
        const r = task({ id: `brerun${String(tasks.length)}`, name: t.name, startTime: Date.now() });
        tasks.push(r);
        calls.push(`rerun:${t.id}`);
        return Promise.resolve(r);
      },
      dismiss: (ids) => {
        const before = tasks.length;
        for (let i = tasks.length - 1; i >= 0; i--) {
          const t = tasks[i]!;
          if (t.status !== 'running' && (ids === undefined || ids.includes(t.id))) tasks.splice(i, 1);
        }
        calls.push(`dismiss:${ids?.join(',') ?? '*'}`);
        return before - tasks.length;
      },
      showOutputPath: (t) => calls.push(`path:${t.id}`),
    },
    () => {
      closed = true;
    },
    initialId,
  );
  const text = (w = 140) => p.render(w).map(stripAnsi).join('\n');
  return { p, calls, text, isClosed: () => closed };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

void describe('Background tasks tray pane', () => {
  void it('list: subagent-style rows (chip, kind, name, short command, right stats), grouped Running / Recent, hint', () => {
    const { p, text } = pane([
      task(),
      task({ id: 'bdone0001', name: 'build', command: 'npm run build', status: 'completed', exitCode: 0, triggerOnCompletion: false, startTime: now - 20_000, endTime: now - 5_000 }),
      task({ id: 'bfail0001', name: 'lint', command: 'npm run lint', status: 'failed', exitCode: 2, triggerOnCompletion: false, startTime: now - 30_000, endTime: now - 10_000 }),
    ]);
    const out = text();
    const lines = out.split('\n');
    assert.match(lines[0]!, /^ {2}Running$/);
    assert.match(lines[1]!, /^❭ {2}RUN {3}Shell ticker for i in \$\(seq 1 300\).*·+ .*1m10s · 559B · wakes agent$/);
    assert.match(lines[2]!, /^ {2}Recent$/);
    assert.match(lines[3]!, /DONE {2}Shell build npm run build ·+ 15s · /);
    assert.match(lines[4]!, /FAIL {2}Shell lint .*exit 2$/);
    assert.ok(out.endsWith(BG_LIST_HINT));
    assert.doesNotMatch(out, /bg tasks focused|history|╭/, 'old manager chrome is gone');
    assert.equal(p.capturesArrows(), false);
    for (const w of [40, 80, 140]) for (const l of p.render(w)) assert.ok(visibleWidth(l) <= w, `w=${String(w)}: ${l}`);
    p.dispose();
  });

  void it('no group headers when everything is in one group; empty state', () => {
    const one = pane([task()]);
    assert.doesNotMatch(one.text(), /Running|Recent/);
    one.p.dispose();
    const empty = pane([]);
    assert.match(empty.text(), /No background tasks\./);
    empty.p.dispose();
  });

  void it('ordering + row model', () => {
    const order = orderTasks([
      task({ id: 'a', status: 'completed', startTime: 1, endTime: 5 }),
      task({ id: 'b', startTime: 2 }),
      task({ id: 'c', status: 'failed', startTime: 1, endTime: 9 }),
      task({ id: 'd', startTime: 3 }),
    ]).map((t) => t.id);
    assert.deepEqual(order, ['d', 'b', 'c', 'a']);
    const agent = taskRow(task({ isAgent: true, model: 'openrouter/ds/flash', tokenUsage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 1500 } as never }));
    assert.equal(agent.kind, 'Agent');
    assert.ok(agent.tags.includes('flash'));
    assert.ok(agent.tags.includes('1.5k tok'));
  });

  void it('Enter opens the detail view (← back, captures arrows); esc in list closes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bg-pane-'));
    const out = join(dir, 'o.output');
    await writeFile(out, Array.from({ length: 80 }, (_, i) => `tick ${String(i + 1)}`).join('\n') + '\n');
    const { p, text, isClosed } = pane([task({ outputAbsPath: out })]);
    p.handleInput('\r');
    await p.readLog();
    const view = text();
    assert.match(view.split('\n')[0]!, /^── .* Shell › ticker ─+ 1m10s · 559B ──$/);
    assert.match(view, /id b12345678 · .*running · wakes agent/);
    assert.doesNotMatch(view, /Command/, 'scrolled to the end of a long log');
    assert.match(view, /tick 80/, 'follows the end of the log');
    assert.ok(view.endsWith(BG_VIEW_HINT));
    assert.equal(p.capturesArrows(), true);
    p.handleInput(LEFT);
    assert.match(text(), /navigate/);
    p.handleInput('\x1b');
    assert.equal(isClosed(), true);
    p.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  void it('detail scrolls back (frozen), g top, G resumes following; l toggles the full log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bg-pane-'));
    const out = join(dir, 'o.output');
    await writeFile(out, Array.from({ length: 200 }, (_, i) => `line ${String(i + 1)}`).join('\n') + '\n');
    const { p, text } = pane([task({ outputAbsPath: out })], 'b12345678');
    await p.readLog();
    assert.match(text(), /line 200/);
    p.handleInput(UP);
    p.handleInput('g');
    assert.match(text(), /Command/);
    assert.doesNotMatch(text(), /line 200/);
    p.handleInput('G');
    await tick();
    assert.match(text(), /line 200/);
    p.handleInput('l');
    await tick();
    assert.match(text(), /full log/);
    p.handleInput(DOWN);
    p.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  void it('missing log → error line; finished task shows its outcome', async () => {
    const { p, text } = pane([task({ status: 'failed', exitCode: 1, endTime: now, error: 'boom' })], 'b12345678');
    await p.readLog();
    const v = text();
    assert.match(v, /Output file not found/);
    assert.match(v, /✗ Failed · exit 1 · boom/);
    p.dispose();
  });

  void it('s stops; x kills only after confirming; finished tasks say so', async () => {
    const tasks = [task({ id: 'b1' }), task({ id: 'b2', startTime: now - 1000 })];
    const { p, calls, text } = pane(tasks);
    // newest running first → b2 selected
    p.handleInput('x');
    assert.match(text(), /Press x again to kill/);
    assert.deepEqual(calls, []);
    p.handleInput('x');
    await tick();
    assert.deepEqual(calls, ['kill:b2']);
    assert.match(text(), /Killed ticker\./);
    // b2 is now under Recent; b1 (still running) is first
    p.handleInput('s');
    await tick();
    assert.deepEqual(calls, ['kill:b2', 'stop:b1']);
    p.handleInput('s');
    assert.match(text(), /already ended/);
    p.dispose();
  });

  void it('a/K stop all with confirmation; d dismisses a finished task, D all finished; running refuses d', async () => {
    const tasks = [task({ id: 'r1' }), task({ id: 'f1', status: 'completed', endTime: now }), task({ id: 'f2', status: 'killed', endTime: now - 1 })];
    const { p, calls, text } = pane(tasks);
    p.handleInput('d');
    assert.match(text(), /still running — s stop first/);
    p.handleInput('j');
    p.handleInput('d');
    assert.deepEqual(calls, ['dismiss:f1']);
    p.handleInput('D');
    assert.deepEqual(calls, ['dismiss:f1', 'dismiss:*']);
    assert.match(text(), /Dismissed 1 finished task\./);
    p.handleInput('a');
    assert.match(text(), /Press a again to stop all 1 running task\./);
    p.handleInput('a');
    await tick();
    assert.ok(calls.includes('stopAll:1'));
    p.dispose();
  });

  void it('R reruns and selects the new task; c shows the log path', async () => {
    const tasks = [task({ id: 'b1', status: 'completed', endTime: now })];
    const { p, calls, text } = pane(tasks);
    p.handleInput('c');
    assert.deepEqual(calls, ['path:b1']);
    assert.match(text(), /Log: \/tmp\/x\/b12345678\.output/);
    p.handleInput('R');
    await tick();
    assert.deepEqual(calls, ['path:b1', 'rerun:b1']);
    assert.match(text(), /❭ {2}RUN /);
    p.dispose();
  });

  void it('opens directly on initialId; unknown id falls back to the list', () => {
    const a = pane([task()], 'b12345678');
    assert.equal(a.p.capturesArrows(), true);
    a.p.dispose();
    const b = pane([task()], 'nope');
    assert.equal(b.p.capturesArrows(), false);
    b.p.dispose();
  });
});
