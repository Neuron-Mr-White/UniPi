#!/usr/bin/env node
/**
 * Fills `crates/kanboard/ui-dist/` — the web UI the daemon embeds (rust-embed,
 * src/serve/assets.rs). Since UNI-117 that UI is the UniPi app's web build
 * (unipi-app `apps/mobile`, `npm run build:web`): one frontend for the phone
 * app, the desktop app and the browser. unipi-app is a separate (private)
 * repo, nested in this one and gitignored here, so the UI comes from the
 * first source that works:
 *
 *   1. env   UNIPI_KANBOARD_UI_DIST=<dir>    an already built dist (CI, packagers)
 *   2. app   ../../unipi-app/apps/mobile     `npm run build:web` there (npm ci first if needed)
 *            (or UNIPI_APP_DIR=<unipi-app checkout>)
 *   3. pin   ui.lock.json {url, sha256}      the published web build tarball from
 *                                            unipi.nrn.one, sha256-checked
 *   4. legacy crates/kanboard/web            the old Solid UI (deprecated), with a warning
 *
 * Tests: UNIPI_KANBOARD_UI_OUT (output dir), UNIPI_KANBOARD_UI_LOCK (lock file).
 * `--source env|app|pin|legacy` forces one; `--if-missing` does nothing when
 * ui-dist is already there (what build.rs runs). Writes `ui-dist/.source.json`
 * ({source, version, detail}) — build.rs reads it, warns on `legacy`, and the
 * daemon reports it as `ui` in /api/health.
 *
 *   node crates/kanboard/scripts/build-ui.mjs              # refresh from the best source
 *   node crates/kanboard/scripts/build-ui.mjs --source legacy
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const crate = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(crate, '..', '..');
const out = process.env.UNIPI_KANBOARD_UI_OUT ? resolve(process.env.UNIPI_KANBOARD_UI_OUT) : join(crate, 'ui-dist');
const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const forced = flag('--source');
const ifMissing = args.includes('--if-missing');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const log = (message) => console.error(`[kanboard ui] ${message}`);

if (ifMissing && existsSync(join(out, 'index.html'))) process.exit(0);

/** Replaces ui-dist with `dir` (atomic-ish: build next to it, then swap). */
function install(dir, meta) {
  if (!existsSync(join(dir, 'index.html'))) throw new Error(`${dir} has no index.html`);
  const next = `${out}.next`;
  rmSync(next, { recursive: true, force: true });
  cpSync(dir, next, { recursive: true });
  writeFileSync(join(next, '.source.json'), `${JSON.stringify({ ...meta, builtAt: new Date().toISOString() }, null, 2)}\n`);
  rmSync(out, { recursive: true, force: true });
  renameSync(next, out);
  log(`ui-dist ← ${meta.source}${meta.version ? ` ${meta.version}` : ''} (${meta.detail})`);
}

function fromEnv() {
  const dir = process.env.UNIPI_KANBOARD_UI_DIST;
  if (!dir) return 'UNIPI_KANBOARD_UI_DIST is not set';
  if (!existsSync(join(dir, 'index.html'))) return `UNIPI_KANBOARD_UI_DIST=${dir} has no index.html`;
  install(dir, { source: 'app', version: readVersion(dir), detail: `UNIPI_KANBOARD_UI_DIST=${dir}` });
}

function readVersion(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'unipi-web.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

function fromApp() {
  const root = process.env.UNIPI_APP_DIR ? resolve(process.env.UNIPI_APP_DIR) : join(repo, 'unipi-app');
  const mobile = join(root, 'apps', 'mobile');
  if (!existsSync(join(mobile, 'package.json'))) return `no unipi-app checkout at ${root}`;
  const scripts = JSON.parse(readFileSync(join(mobile, 'package.json'), 'utf8')).scripts ?? {};
  if (!scripts['build:web']) return `${mobile} has no build:web script (update unipi-app)`;
  if (!existsSync(join(root, 'node_modules')) && !existsSync(join(mobile, 'node_modules'))) {
    log(`npm ci in ${root}`);
    execFileSync(npm, ['ci', '--no-audit', '--no-fund'], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
  }
  log(`npm run build:web in ${mobile}`);
  execFileSync(npm, ['run', 'build:web'], { cwd: mobile, stdio: ['ignore', 'inherit', 'inherit'] });
  const dist = join(mobile, 'dist-web');
  let version = null;
  try {
    version = JSON.parse(readFileSync(join(mobile, 'src-tauri', 'tauri.conf.json'), 'utf8')).version ?? null;
  } catch {
    /* no version */
  }
  let commit = null;
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    /* not a git checkout */
  }
  install(dist, { source: 'app', version, detail: `built from ${root}${commit ? ` @ ${commit}` : ''}` });
}

async function fromPin() {
  const lock = JSON.parse(readFileSync(process.env.UNIPI_KANBOARD_UI_LOCK ?? join(crate, 'ui.lock.json'), 'utf8'));
  if (!lock.url || !lock.sha256) return 'ui.lock.json pins no published web build yet';
  if (!/^https:\/\/unipi\.nrn\.one\//.test(lock.url)) return `ui.lock.json url must be on https://unipi.nrn.one/ (got ${lock.url})`;
  log(`downloading ${lock.url}`);
  const response = await fetch(lock.url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) return `${lock.url}: HTTP ${response.status}`;
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== lock.sha256) return `${lock.url}: sha256 ${sha} ≠ pinned ${lock.sha256}`;
  const work = mkdtempSync(join(tmpdir(), 'kanboard-ui-'));
  try {
    const tarball = join(work, 'web.tar.gz');
    writeFileSync(tarball, bytes);
    const dir = join(work, 'dist');
    mkdirSync(dir);
    execFileSync('tar', ['-xzf', tarball, '-C', dir], { stdio: 'inherit' });
    install(dir, { source: 'app', version: lock.version ?? readVersion(dir), detail: `pinned ${lock.url}` });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function fromLegacy() {
  const web = join(crate, 'web');
  if (!existsSync(join(web, 'package.json'))) return 'crates/kanboard/web is gone';
  if (!existsSync(join(web, 'dist', 'index.html'))) {
    if (!existsSync(join(web, 'node_modules'))) execFileSync(npm, ['ci', '--no-audit', '--no-fund'], { cwd: web, stdio: ['ignore', 'inherit', 'inherit'] });
    execFileSync(npm, ['run', 'build'], { cwd: web, stdio: ['ignore', 'inherit', 'inherit'] });
  }
  install(join(web, 'dist'), { source: 'legacy', version: null, detail: 'crates/kanboard/web (deprecated kanboard UI)' });
  log('WARNING: embedding the deprecated kanboard web UI — build unipi-app (apps/mobile npm run build:web) or pin a published web build in ui.lock.json');
}

const SOURCES = { env: fromEnv, app: fromApp, pin: fromPin, legacy: fromLegacy };
const order = forced ? [forced] : ['env', 'app', 'pin', 'legacy'];
const skipped = [];
for (const name of order) {
  const run = SOURCES[name];
  if (!run) {
    log(`unknown --source ${name} (env | app | pin | legacy)`);
    process.exit(2);
  }
  try {
    const reason = await run();
    if (reason === undefined) process.exit(0);
    skipped.push(`${name}: ${reason}`);
  } catch (error) {
    skipped.push(`${name}: ${error?.message ?? error}`);
  }
}
log(`no UI source worked:\n  ${skipped.join('\n  ')}`);
process.exit(1);
