import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createDurableFileWriter,
  DurableFileError,
  replaceFileDurable,
  writeFileDurable,
} from '../durable-fs.js';
import type {
  DurableData,
  DurableDirectoryHandle,
  DurableFailure,
  DurableFileOperations,
  DurableOperation,
  DurableWritableHandle,
  DurableWriteFlag,
} from '../durable-fs.js';

interface OpenWritableCall {
  kind: 'openWritable';
  path: string;
  flag: string;
  mode: number | undefined;
}

interface WriteFileCall {
  kind: 'writeFile';
  path: string;
  data: DurableData;
}

interface PathCall {
  kind: 'syncFile' | 'closeFile' | 'remove' | 'openDirectory' | 'syncDirectory' | 'closeDirectory';
  path: string;
}

interface RenameCall {
  kind: 'rename';
  source: string;
  target: string;
}

type RecordedCall = OpenWritableCall | WriteFileCall | PathCall | RenameCall;

interface RecordingOptions {
  readonly platform?: NodeJS.Platform;
  readonly temporaryPath?: string;
}

function codedError(message: string, code: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, 'code', { value: code, enumerable: true });
  return error;
}

class RecordingDurableFileOperations implements DurableFileOperations {
  readonly platform: NodeJS.Platform;
  readonly calls: RecordedCall[] = [];
  private readonly failures = new Map<DurableOperation, Error>();
  private readonly existingPaths = new Set<string>();
  private readonly tempPath: string;

  constructor(options: RecordingOptions = {}) {
    this.platform = options.platform ?? 'linux';
    this.tempPath = options.temporaryPath ?? '/virtual/.target.tmp';
  }

  fail(operation: DurableOperation, error: Error = new Error(`${operation} failed`)): Error {
    this.failures.set(operation, error);
    return error;
  }

  failureFor(operation: DurableOperation): Error | undefined {
    return this.failures.get(operation);
  }

  addExisting(path: string): void {
    this.existingPaths.add(path);
  }

  hasPath(path: string): boolean {
    return this.existingPaths.has(path);
  }

  async openWritable(
    path: string,
    flag: DurableWriteFlag,
    mode?: number,
  ): Promise<DurableWritableHandle> {
    this.calls.push({ kind: 'openWritable', path, flag, mode });
    const configured = this.failureFor('open_file');
    if (configured !== undefined) throw configured;
    if (flag === 'wx' && this.existingPaths.has(path)) throw codedError('path exists', 'EEXIST');
    this.existingPaths.add(path);
    return new RecordingWritableHandle(this, path);
  }

  async openDirectory(path: string): Promise<DurableDirectoryHandle> {
    this.calls.push({ kind: 'openDirectory', path });
    const configured = this.failureFor('open_directory');
    if (configured !== undefined) throw configured;
    return new RecordingDirectoryHandle(this, path);
  }

  async rename(source: string, target: string): Promise<void> {
    this.calls.push({ kind: 'rename', source, target });
    const configured = this.failureFor('rename_file');
    if (configured !== undefined) throw configured;
    if (this.existingPaths.has(source)) {
      this.existingPaths.delete(source);
      this.existingPaths.add(target);
    }
  }

  async remove(path: string): Promise<void> {
    this.calls.push({ kind: 'remove', path });
    const configured = this.failureFor('remove_temp');
    if (configured !== undefined) throw configured;
    this.existingPaths.delete(path);
  }

  temporaryPath(_target: string): string {
    return this.tempPath;
  }
}

class RecordingWritableHandle implements DurableWritableHandle {
  constructor(
    private readonly operations: RecordingDurableFileOperations,
    private readonly path: string,
  ) {}

  async writeFile(data: DurableData): Promise<void> {
    this.operations.calls.push({ kind: 'writeFile', path: this.path, data });
    const configured = this.operations.failureFor('write_file');
    if (configured !== undefined) throw configured;
  }

  async sync(): Promise<void> {
    this.operations.calls.push({ kind: 'syncFile', path: this.path });
    const configured = this.operations.failureFor('sync_file');
    if (configured !== undefined) throw configured;
  }

  async close(): Promise<void> {
    this.operations.calls.push({ kind: 'closeFile', path: this.path });
    const configured = this.operations.failureFor('close_file');
    if (configured !== undefined) throw configured;
  }
}

class RecordingDirectoryHandle implements DurableDirectoryHandle {
  constructor(
    private readonly operations: RecordingDurableFileOperations,
    private readonly path: string,
  ) {}

  async sync(): Promise<void> {
    this.operations.calls.push({ kind: 'syncDirectory', path: this.path });
    const configured = this.operations.failureFor('sync_directory');
    if (configured !== undefined) throw configured;
  }

  async close(): Promise<void> {
    this.operations.calls.push({ kind: 'closeDirectory', path: this.path });
    const configured = this.operations.failureFor('close_directory');
    if (configured !== undefined) throw configured;
  }
}

function callsNamed<K extends RecordedCall['kind']>(
  calls: readonly RecordedCall[],
  kind: K,
): Array<RecordedCall & { kind: K }> {
  return calls.filter((call): call is RecordedCall & { kind: K } => call.kind === kind);
}

function single<T>(items: readonly T[], label: string): T {
  assert.equal(items.length, 1, label);
  const item = items[0];
  assert.ok(item !== undefined, label);
  return item;
}

function callKinds(calls: readonly RecordedCall[]): string[] {
  return calls.map((call) => call.kind);
}

function cleanupOperations(error: DurableFileError): DurableOperation[] {
  return error.cleanupFailures.map((entry: DurableFailure) => entry.operation);
}

async function durableRejects(promise: Promise<void>): Promise<DurableFileError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DurableFileError, error instanceof Error ? error.stack : String(error));
    return error;
  }
  assert.fail('expected DurableFileError');
}

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function posixMode(mode: number): number {
  return mode & 0o777;
}

void describe('durable file writer operation sequencing', () => {
  void it('direct write opens exactly once with write flag and inherited mode', async () => {
    const ops = new RecordingDurableFileOperations();
    const writer = createDurableFileWriter(ops);

    await writer.write('/virtual/data.txt', 'data');

    const open = single(callsNamed(ops.calls, 'openWritable'), 'direct write open count');
    assert.equal(open.path, '/virtual/data.txt');
    assert.equal(open.flag, 'w');
    assert.equal(open.mode, undefined);
  });

  void it('atomic replace opens the temp exactly once with exclusive create mode', async () => {
    const temp = '/virtual/.target.txt.tmp';
    const ops = new RecordingDurableFileOperations({ temporaryPath: temp });
    const writer = createDurableFileWriter(ops);

    await writer.replace('/virtual/target.txt', 'data');

    const tempOpens = callsNamed(ops.calls, 'openWritable').filter((call) => call.path === temp);
    const open = single(tempOpens, 'atomic temp open count');
    assert.equal(open.flag, 'wx');
    assert.equal(open.mode, 0o600);
  });

  void it('atomic replace records write, file sync, close, rename, and directory sync in order', async () => {
    const ops = new RecordingDurableFileOperations({ temporaryPath: '/virtual/.target.tmp' });
    const writer = createDurableFileWriter(ops);

    await writer.replace('/virtual/target.txt', 'data');

    assert.deepEqual(callKinds(ops.calls), [
      'openWritable',
      'writeFile',
      'syncFile',
      'closeFile',
      'rename',
      'openDirectory',
      'syncDirectory',
      'closeDirectory',
    ]);
  });

  void it('does not reopen the data file after writing or use read flags for sync', async () => {
    const path = '/virtual/data.txt';
    const ops = new RecordingDurableFileOperations();
    const writer = createDurableFileWriter(ops);

    await writer.write(path, 'data');

    const opens = callsNamed(ops.calls, 'openWritable');
    const dataOpens = opens.filter((call) => call.path === path);
    assert.equal(dataOpens.length, 1);
    assert.ok(!opens.some((call) => call.flag === 'r' || call.flag === 'r+'));
    const writeIndex = ops.calls.findIndex((call) => call.kind === 'writeFile' && call.path === path);
    assert.ok(writeIndex >= 0);
    const laterDataOpens = ops.calls
      .slice(writeIndex + 1)
      .filter((call): call is OpenWritableCall => call.kind === 'openWritable' && call.path === path);
    assert.equal(laterDataOpens.length, 0);
  });

  void it('write flag overwrites existing content on the real filesystem', async () => {
    await withTempDir('unipi-bg-durable-write-', async (dir) => {
      const file = join(dir, 'data.txt');
      await writeFile(file, 'old');

      await writeFileDurable(file, 'new');

      assert.equal(await readFile(file, 'utf8'), 'new');
    });
  });

  void it('exclusive temp collision fails without removing the pre-existing temp path', async () => {
    const temp = '/virtual/.target.tmp';
    const ops = new RecordingDurableFileOperations({ temporaryPath: temp });
    ops.addExisting(temp);
    const writer = createDurableFileWriter(ops);

    const error = await durableRejects(writer.replace('/virtual/target.txt', 'data'));

    assert.equal(error.operation, 'open_file');
    assert.equal(error.path, temp);
    assert.equal(error.nativeCode, 'EEXIST');
    assert.equal(ops.hasPath(temp), true);
    assert.equal(callsNamed(ops.calls, 'remove').length, 0);
  });

  void it('write failure still closes the handle', async () => {
    const ops = new RecordingDurableFileOperations();
    ops.fail('write_file');
    const writer = createDurableFileWriter(ops);

    const error = await durableRejects(writer.write('/virtual/data.txt', 'data'));

    assert.equal(error.operation, 'write_file');
    assert.deepEqual(callKinds(ops.calls), ['openWritable', 'writeFile', 'closeFile']);
  });

  void it('sync failure still closes the handle', async () => {
    const ops = new RecordingDurableFileOperations();
    ops.fail('sync_file');
    const writer = createDurableFileWriter(ops);

    const error = await durableRejects(writer.write('/virtual/data.txt', 'data'));

    assert.equal(error.operation, 'sync_file');
    assert.deepEqual(callKinds(ops.calls), ['openWritable', 'writeFile', 'syncFile', 'closeFile']);
  });

  void it('successful write followed by close failure reports close as the primary operation', async () => {
    const ops = new RecordingDurableFileOperations();
    ops.fail('close_file');
    const writer = createDurableFileWriter(ops);

    const error = await durableRejects(writer.write('/virtual/data.txt', 'data'));

    assert.equal(error.operation, 'close_file');
    assert.equal(error.path, '/virtual/data.txt');
    assert.deepEqual(cleanupOperations(error), []);
  });

  void it('write failure plus close failure keeps write primary and records close cleanup', async () => {
    const ops = new RecordingDurableFileOperations();
    ops.fail('write_file');
    ops.fail('close_file');
    const writer = createDurableFileWriter(ops);

    const error = await durableRejects(writer.write('/virtual/data.txt', 'data'));

    assert.equal(error.operation, 'write_file');
    assert.deepEqual(cleanupOperations(error), ['close_file']);
  });

  void it('sync failure plus close failure keeps sync primary and records close cleanup', async () => {
    const ops = new RecordingDurableFileOperations();
    ops.fail('sync_file');
    ops.fail('close_file');
    const writer = createDurableFileWriter(ops);

    const error = await durableRejects(writer.write('/virtual/data.txt', 'data'));

    assert.equal(error.operation, 'sync_file');
    assert.deepEqual(cleanupOperations(error), ['close_file']);
  });

  void it('temp write, sync, and close failures remove the owned temp path', async () => {
    for (const operation of ['write_file', 'sync_file', 'close_file'] as const) {
      const temp = `/virtual/.target.${operation}.tmp`;
      const ops = new RecordingDurableFileOperations({ temporaryPath: temp });
      ops.fail(operation);
      const writer = createDurableFileWriter(ops);

      const error = await durableRejects(writer.replace('/virtual/target.txt', 'data'));

      assert.equal(error.operation, operation);
      assert.equal(ops.hasPath(temp), false);
      assert.equal(single(callsNamed(ops.calls, 'remove'), `remove call for ${operation}`).path, temp);
    }
  });

  void it('temp cleanup failure is attached without replacing the primary operation', async () => {
    const temp = '/virtual/.target.tmp';
    const ops = new RecordingDurableFileOperations({ temporaryPath: temp });
    ops.fail('write_file');
    ops.fail('remove_temp');
    const writer = createDurableFileWriter(ops);

    const error = await durableRejects(writer.replace('/virtual/target.txt', 'data'));

    assert.equal(error.operation, 'write_file');
    assert.deepEqual(cleanupOperations(error), ['remove_temp']);
    assert.equal(ops.hasPath(temp), true);
  });

  void it('rename failure removes the owned temp path', async () => {
    const temp = '/virtual/.target.tmp';
    const ops = new RecordingDurableFileOperations({ temporaryPath: temp });
    ops.fail('rename_file');
    const writer = createDurableFileWriter(ops);

    const error = await durableRejects(writer.replace('/virtual/target.txt', 'data'));

    assert.equal(error.operation, 'rename_file');
    assert.equal(ops.hasPath(temp), false);
    assert.equal(single(callsNamed(ops.calls, 'remove'), 'rename cleanup call').path, temp);
  });

  void it('rename failure plus cleanup failure preserves both failures', async () => {
    const temp = '/virtual/.target.tmp';
    const ops = new RecordingDurableFileOperations({ temporaryPath: temp });
    ops.fail('rename_file');
    ops.fail('remove_temp');
    const writer = createDurableFileWriter(ops);

    const error = await durableRejects(writer.replace('/virtual/target.txt', 'data'));

    assert.equal(error.operation, 'rename_file');
    assert.deepEqual(cleanupOperations(error), ['remove_temp']);
    assert.equal(ops.hasPath(temp), true);
  });

  void it('directory open, directory sync, and directory close failures are loud', async () => {
    const target = '/virtual/target.txt';
    for (const operation of ['open_directory', 'sync_directory', 'close_directory'] as const) {
      const ops = new RecordingDurableFileOperations({ temporaryPath: `/virtual/.${operation}.tmp` });
      ops.fail(operation);
      const writer = createDurableFileWriter(ops);

      const error = await durableRejects(writer.replace(target, 'data'));

      assert.equal(error.operation, operation);
      assert.equal(error.path, dirname(target));
    }
  });

  void it('directory sync failure plus directory close failure preserves both failures', async () => {
    const target = '/virtual/target.txt';
    const ops = new RecordingDurableFileOperations({ temporaryPath: '/virtual/.target.tmp' });
    ops.fail('sync_directory');
    ops.fail('close_directory');
    const writer = createDurableFileWriter(ops);

    const error = await durableRejects(writer.replace(target, 'data'));

    assert.equal(error.operation, 'sync_directory');
    assert.deepEqual(cleanupOperations(error), ['close_directory']);
  });

  void it('post-rename directory failure marks the replacement as completed', async () => {
    const ops = new RecordingDurableFileOperations({ temporaryPath: '/virtual/.target.tmp' });
    ops.fail('open_directory');
    const writer = createDurableFileWriter(ops);

    const error = await durableRejects(writer.replace('/virtual/target.txt', 'data'));

    assert.equal(error.operation, 'open_directory');
    assert.equal(error.renameCompleted, true);
  });

  void it('win32 replacement skips directory opens', async () => {
    const ops = new RecordingDurableFileOperations({
      platform: 'win32',
      temporaryPath: 'C:\\virtual\\.target.tmp',
    });
    ops.fail('open_directory');
    const writer = createDurableFileWriter(ops);

    await writer.replace('C:\\virtual\\target.txt', 'data');

    assert.equal(callsNamed(ops.calls, 'openDirectory').length, 0);
    assert.deepEqual(callKinds(ops.calls), ['openWritable', 'writeFile', 'syncFile', 'closeFile', 'rename']);
  });

  void it('successful atomic replacement leaves no temp residue on the real filesystem', async () => {
    await withTempDir('unipi-bg-durable-replace-clean-', async (dir) => {
      const target = join(dir, 'target.txt');

      await replaceFileDurable(target, 'new');

      assert.equal(await readFile(target, 'utf8'), 'new');
      assert.deepEqual((await readdir(dir)).sort(), ['target.txt']);
    });
  });

  void it('DurableFileError exposes operation, path, native code, and primary cause', async () => {
    const ops = new RecordingDurableFileOperations();
    const native = codedError('denied', 'EACCES');
    ops.fail('open_file', native);
    const writer = createDurableFileWriter(ops);

    const error = await durableRejects(writer.write('/virtual/data.txt', 'data'));

    assert.equal(error.operation, 'open_file');
    assert.equal(error.path, '/virtual/data.txt');
    assert.equal(error.nativeCode, 'EACCES');
    assert.equal(error.primaryCause, native);
  });

  void it('file sync failure is never tolerated', async () => {
    const ops = new RecordingDurableFileOperations();
    ops.fail('sync_file');
    const writer = createDurableFileWriter(ops);

    const error = await durableRejects(writer.write('/virtual/data.txt', 'data'));

    assert.equal(error.operation, 'sync_file');
  });
});

void describe('durable file writer real filesystem integration', () => {
  void it('writeFileDurable overwrites content with writeFile mode parity', async () => {
    await withTempDir('unipi-bg-durable-mode-', async (dir) => {
      const durablePath = join(dir, 'durable.txt');
      const referencePath = join(dir, 'reference.txt');

      await writeFileDurable(durablePath, 'first');
      await writeFileDurable(durablePath, 'second');
      await writeFile(referencePath, 'reference');

      assert.equal(await readFile(durablePath, 'utf8'), 'second');
      if (process.platform !== 'win32') {
        const durableMode = posixMode((await stat(durablePath)).mode);
        const referenceMode = posixMode((await stat(referencePath)).mode);
        const expectedMode = 0o666 & ~process.umask();
        assert.equal(durableMode, referenceMode);
        assert.equal(durableMode, expectedMode);
      }
    });
  });

  void it('replaceFileDurable installs a private complete replacement', async () => {
    await withTempDir('unipi-bg-durable-private-', async (dir) => {
      const target = join(dir, 'target.txt');
      await writeFile(target, 'old');

      await replaceFileDurable(target, 'new');

      assert.equal(await readFile(target, 'utf8'), 'new');
      if (process.platform !== 'win32') assert.equal(posixMode((await stat(target)).mode), 0o600);
    });
  });

  void it('concurrent replaceFileDurable calls leave one complete payload', async () => {
    await withTempDir('unipi-bg-durable-concurrent-', async (dir) => {
      const target = join(dir, 'target.json');
      const payloads = Array.from({ length: 12 }, (_value, index) =>
        `${JSON.stringify({ index, marker: `payload-${String(index)}`, data: 'x'.repeat(8192) })}\n`,
      );

      await Promise.all(payloads.map((payload) => replaceFileDurable(target, payload)));

      const finalPayload = await readFile(target, 'utf8');
      assert.ok(payloads.includes(finalPayload));
      assert.doesNotThrow(() => JSON.parse(finalPayload));
      if (process.platform !== 'win32') assert.equal(posixMode((await stat(target)).mode), 0o600);
    });
  });

});
