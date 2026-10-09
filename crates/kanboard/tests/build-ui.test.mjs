// node --test crates/kanboard/tests/build-ui.test.mjs — the UI source chain
// (UNI-117): env dir, pinned tarball checks, legacy fallback, --if-missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'build-ui.mjs');
const run = (args, env) => spawnSync(process.execPath, [script, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });

function fakeDist(version = '9.9.9') {
  const dir = mkdtempSync(join(tmpdir(), 'kb-ui-src-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>UniPi</title>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'index-abc.js'), 'console.log(1)');
  writeFileSync(join(dir, 'unipi-web.json'), JSON.stringify({ version }));
  return dir;
}

test('env source copies the dist and records where it came from', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'kb-ui-out-')), 'ui-dist');
  const src = fakeDist();
  const result = run(['--source', 'env'], { UNIPI_KANBOARD_UI_DIST: src, UNIPI_KANBOARD_UI_OUT: out });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(out, 'assets', 'index-abc.js')));
  const meta = JSON.parse(readFileSync(join(out, '.source.json'), 'utf8'));
  assert.equal(meta.source, 'app');
  assert.equal(meta.version, '9.9.9');
});

test('--if-missing leaves an existing ui-dist alone', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'kb-ui-out-')), 'ui-dist');
  mkdirSync(out);
  writeFileSync(join(out, 'index.html'), 'keep');
  const result = run(['--if-missing', '--source', 'env'], { UNIPI_KANBOARD_UI_DIST: fakeDist(), UNIPI_KANBOARD_UI_OUT: out });
  assert.equal(result.status, 0);
  assert.equal(readFileSync(join(out, 'index.html'), 'utf8'), 'keep');
});

test('pin refuses an unpinned lock and a URL off unipi.nrn.one (never downloads)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-ui-lock-'));
  const out = join(dir, 'ui-dist');
  writeFileSync(join(dir, 'empty.json'), JSON.stringify({ url: null, sha256: null }));
  let result = run(['--source', 'pin'], { UNIPI_KANBOARD_UI_OUT: out, UNIPI_KANBOARD_UI_LOCK: join(dir, 'empty.json') });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pins no published web build/);
  writeFileSync(join(dir, 'evil.json'), JSON.stringify({ url: 'https://example.com/x.tgz', sha256: 'a'.repeat(64) }));
  result = run(['--source', 'pin'], { UNIPI_KANBOARD_UI_OUT: out, UNIPI_KANBOARD_UI_LOCK: join(dir, 'evil.json') });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be on https:\/\/unipi\.nrn\.one/);
  assert.ok(!existsSync(out));
});

test('a failing chain explains every source it tried', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-ui-none-'));
  const result = run(['--source', 'env'], { UNIPI_KANBOARD_UI_DIST: '', UNIPI_KANBOARD_UI_OUT: join(dir, 'ui-dist') });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no UI source worked/);
  assert.match(result.stderr, /env: UNIPI_KANBOARD_UI_DIST is not set/);
});

test('the committed lock file is well-formed', () => {
  const lock = JSON.parse(readFileSync(resolve(dirname(script), '..', 'ui.lock.json'), 'utf8'));
  assert.ok('url' in lock && 'sha256' in lock && 'version' in lock);
  if (lock.url) {
    assert.match(lock.url, /^https:\/\/unipi\.nrn\.one\//);
    assert.match(lock.sha256, /^[0-9a-f]{64}$/);
  }
});
