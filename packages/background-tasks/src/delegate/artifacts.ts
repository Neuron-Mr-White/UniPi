import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { canonicalJson } from '../attested-pi-run.js';
import { sanitizePathSegment } from '../types.js';
import { replaceFileDurable, writeFileDurable } from '../durable-fs.js';
import {
  DELEGATE_MANIFEST_SCHEMA_VERSION,
  DELEGATE_RECEIPT_SCHEMA_VERSION,
  DelegateError,
  type DelegateExtensionMode,
  type DelegateLimits,
  type DelegatePinnedRoute,
  type DelegateSpillReceipt,
} from './types.js';
import {
  DELEGATE_RESULT_PACKAGE_FILENAME,
  serializeDelegateResultPackage,
} from './result-package.js';
import type { DelegateResultPackageV1 } from './types.js';
import type { DelegateAdmissionPlanV1 } from './budget.js';

/**
 * Durable delegate artifacts.
 *
 * The commit discipline is the same everywhere: write to a same-directory
 * temporary file, fsync it, rename it into place, then fsync the directory on
 * POSIX. A file present under its final name is complete. A partially written
 * file never appears under a final name, so a crash or a full disk cannot leave
 * a truncated artifact that looks whole.
 *
 * `result.json` is the commit point for the whole run. It is written by the
 * CHILD, so `manifest.state` deliberately records only what the PARENT knows at
 * launch time and is never used to decide success. The parent's adjudicated view
 * is written separately as `outcome.json` once the run is evaluated, so the two
 * writers never race over one field and no artifact can claim a state its writer
 * did not observe.
 */

export const DELEGATE_ARTIFACT_NAMES = {
  seed: 'seed.json',
  ledger: 'context-omission-ledger.json',
  budgetPlan: 'budget-plan.json',
  manifest: 'manifest.json',
  outcome: 'outcome.json',
  result: DELEGATE_RESULT_PACKAGE_FILENAME,
  childPrompt: 'child-prompt.txt',
  runtimeBudget: 'runtime-budget.json',
  error: 'error.json',
} as const;

/** Spilled tool payloads live in their own subdirectory so they cannot collide with control artifacts. */
export const DELEGATE_SPILL_DIRNAME = 'spill';

export interface DelegateArtifactRef {
  path: string;
  byte_length: number;
  sha256: string;
}

export interface DelegateManifestV1 {
  schema_version: typeof DELEGATE_MANIFEST_SCHEMA_VERSION;
  task_id: string;
  launch_nonce: string;
  created_at: string;
  updated_at: string;
  cwd: string;
  child_session_id: string;
  child_session_dir: string;
  extension_mode: DelegateExtensionMode;
  route: DelegatePinnedRoute;
  limits: DelegateLimits;
  seed_sha256: string;
  state: DelegateManifestState;
  error?: string;
  artifacts: Readonly<Record<string, DelegateArtifactRef>>;
}

export const DELEGATE_MANIFEST_STATES = [
  'launched',
  'running',
  'committed',
  'failed',
  'cancelled',
] as const;
export type DelegateManifestState = (typeof DELEGATE_MANIFEST_STATES)[number];

function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'));
}

function artifactError(message: string, cause?: unknown): DelegateError {
  const suffix = cause === undefined ? '' : `: ${cause instanceof Error ? cause.message : String(cause)}`;
  return new DelegateError(`${message}${suffix}`, {
    code: 'artifact_error',
    childCreated: true,
    remediation: [
      'The delegate artifact directory could not be written. Check free disk space and directory permissions.',
    ],
  });
}

export interface CreateDelegateArtifactStoreOptions {
  cwd: string;
  taskId: string;
  launchNonce: string;
  sessionId?: string | undefined;
  childSessionId: string;
  childSessionDir: string;
  extensionMode: DelegateExtensionMode;
  route: DelegatePinnedRoute;
  limits: DelegateLimits;
  seedSha256: string;
  now?: () => Date;
}

export class DelegateArtifactStore {
  private readonly rootAbs: string;
  private readonly rootDisplay: string;
  private readonly spillAbs: string;
  private readonly now: () => Date;
  private manifest: DelegateManifestV1;
  private writeChain: Promise<void> = Promise.resolve();
  private totalSpilledBytes = 0;

  private constructor(
    rootAbs: string,
    rootDisplay: string,
    now: () => Date,
    manifest: DelegateManifestV1,
  ) {
    this.rootAbs = rootAbs;
    this.rootDisplay = rootDisplay;
    this.spillAbs = join(rootAbs, DELEGATE_SPILL_DIRNAME);
    this.now = now;
    this.manifest = manifest;
  }

  /**
   * Create the artifact root with exclusive semantics.
   *
   * The directory name embeds the task id, which is cryptographically random, so
   * two delegates launched in the same assistant message cannot collide. The
   * directory is created with `recursive: false` so a pre-existing directory is
   * a loud failure rather than a silent reuse.
   */
  static async create(
    options: CreateDelegateArtifactStoreOptions,
  ): Promise<DelegateArtifactStore> {
    const sessionSegment = sanitizePathSegment(
      options.sessionId ?? `session-${String(process.pid)}`,
    );
    // USER DECISION (2026-08-21): durable delegate artifacts live under the
    // workspace .unipi/ dir (our convention), not .pi/ and not tmp.
    const runDirName = `${sessionSegment}-${String(process.pid)}`;
    const parentAbs = join(options.cwd, '.unipi', 'delegate', runDirName);
    const rootAbs = join(parentAbs, options.taskId);
    const rootDisplay = join('.unipi', 'delegate', runDirName, options.taskId);
    try {
      await mkdir(parentAbs, { recursive: true, mode: 0o700 });
      await mkdir(rootAbs, { recursive: false, mode: 0o700 });
      await chmod(rootAbs, 0o700);
      await mkdir(join(rootAbs, DELEGATE_SPILL_DIRNAME), { recursive: false, mode: 0o700 });
    } catch (error) {
      throw artifactError(`could not create delegate artifact directory ${rootDisplay}`, error);
    }
    const timestamp = (options.now ?? (() => new Date()))().toISOString();
    const manifest: DelegateManifestV1 = {
      schema_version: DELEGATE_MANIFEST_SCHEMA_VERSION,
      task_id: options.taskId,
      launch_nonce: options.launchNonce,
      created_at: timestamp,
      updated_at: timestamp,
      cwd: options.cwd,
      child_session_id: options.childSessionId,
      child_session_dir: options.childSessionDir,
      extension_mode: options.extensionMode,
      route: options.route,
      limits: options.limits,
      seed_sha256: options.seedSha256,
      state: 'launched',
      artifacts: {},
    };
    const store = new DelegateArtifactStore(
      rootAbs,
      rootDisplay,
      options.now ?? (() => new Date()),
      manifest,
    );
    await store.persistManifest();
    return store;
  }

  get artifactDir(): string {
    return this.rootDisplay;
  }

  get artifactDirAbs(): string {
    return this.rootAbs;
  }

  get spillDirAbs(): string {
    return this.spillAbs;
  }

  get resultPathAbs(): string {
    return join(this.rootAbs, DELEGATE_ARTIFACT_NAMES.result);
  }

  snapshot(): DelegateManifestV1 {
    return { ...this.manifest, artifacts: { ...this.manifest.artifacts } };
  }

  async writeSeed(serialized: string): Promise<DelegateArtifactRef> {
    return this.write(DELEGATE_ARTIFACT_NAMES.seed, serialized);
  }

  /** Persist the exact prompt bytes handed to the child over stdin. */
  async writeChildPrompt(bytes: Buffer): Promise<DelegateArtifactRef> {
    return this.write(DELEGATE_ARTIFACT_NAMES.childPrompt, bytes);
  }

  async writeLedger(ledger: unknown): Promise<DelegateArtifactRef> {
    return this.write(DELEGATE_ARTIFACT_NAMES.ledger, `${canonicalJson(ledger)}\n`);
  }

  async writeBudgetPlan(plan: DelegateAdmissionPlanV1): Promise<DelegateArtifactRef> {
    return this.write(DELEGATE_ARTIFACT_NAMES.budgetPlan, `${canonicalJson(plan)}\n`);
  }

  /** Commit the run. The rename performed here is the single success point. */
  async commitResult(pkg: DelegateResultPackageV1): Promise<DelegateArtifactRef> {
    const ref = await this.write(
      DELEGATE_ARTIFACT_NAMES.result,
      serializeDelegateResultPackage(pkg),
    );
    await this.setState('committed');
    return ref;
  }

  async readCommittedResult(): Promise<string> {
    try {
      return await readFile(this.resultPathAbs, 'utf8');
    } catch (error) {
      const diagnosticNames = [
        DELEGATE_ARTIFACT_NAMES.error,
        DELEGATE_ARTIFACT_NAMES.outcome,
        DELEGATE_ARTIFACT_NAMES.runtimeBudget,
        DELEGATE_ARTIFACT_NAMES.manifest,
      ].filter((name) => existsSync(join(this.rootAbs, name)));
      throw new DelegateError(
        `delegate result package could not be read at ${join(this.rootDisplay, DELEGATE_ARTIFACT_NAMES.result)}; no committed answer is available (${error instanceof Error ? error.message : String(error)})`,
        {
          code: 'result_unavailable',
          childCreated: true,
          taskId: this.manifest.task_id,
          artifactDir: this.rootDisplay,
          preserved: diagnosticNames,
          remediation: diagnosticNames.length === 0
            ? ['No diagnostic control artifact exists; inspect the background task merged output if one was created.']
            : [`Inspect the existing delegate control artifacts: ${diagnosticNames.join(', ')}.`],
        },
      );
    }
  }

  async writeError(state: 'failed' | 'cancelled', message: string): Promise<void> {
    await this.write(
      DELEGATE_ARTIFACT_NAMES.error,
      `${canonicalJson({ state, error: message })}\n`,
    );
    await this.setState(state, message);
  }

  async setState(state: DelegateManifestState, error?: string): Promise<void> {
    await this.update((manifest) => {
      manifest.state = state;
      if (error !== undefined) manifest.error = error;
    });
  }

  /**
   * Spill one oversized tool payload.
   *
   * The filename encodes `(turnSequence, sourceCallIndex, toolCallId)` assigned
   * before the tool executed, so a receipt can never be associated with the
   * wrong call when parallel results complete out of order.
   *
   * A spill that cannot be committed is a terminal failure. The original payload
   * is never returned as a fallback and no receipt is emitted for a file that
   * was not committed.
   */
  async spillToolPayload(input: {
    toolName: string;
    toolCallId: string;
    turnSequence: number;
    sourceCallIndex: number;
    payload: Buffer;
    maxTotalBytes: number;
  }): Promise<DelegateSpillReceipt> {
    const nextTotal = this.totalSpilledBytes + input.payload.length;
    if (nextTotal > input.maxTotalBytes) {
      throw new DelegateError(
        `delegate aggregate tool output would reach ${String(nextTotal)} bytes, exceeding the ${String(input.maxTotalBytes)}-byte cap for one run`,
        {
          code: 'aggregate_tool_output_cap',
          childCreated: true,
          taskId: this.manifest.task_id,
          artifactDir: this.rootDisplay,
          preserved: [this.rootDisplay],
          remediation: [
            'The delegate read more tool output than one run is allowed to accumulate. Narrow the investigation prompt or raise the cap deliberately.',
          ],
        },
      );
    }
    const safeCallId = sanitizePathSegment(input.toolCallId).slice(0, 64);
    const name = `t${String(input.turnSequence).padStart(4, '0')}-c${String(
      input.sourceCallIndex,
    ).padStart(4, '0')}-${safeCallId}.bin`;
    const absPath = join(this.spillAbs, name);
    if (!pathInside(this.spillAbs, absPath)) {
      throw artifactError(`delegate spill path escapes the artifact directory: ${name}`);
    }
    try {
      await this.durableReplace(absPath, input.payload);
    } catch (error) {
      throw new DelegateError(
        `delegate could not durably spill a ${String(input.payload.length)}-byte tool result; the payload is not forwarded and no receipt is emitted`,
        {
          code: 'artifact_spill_failed',
          childCreated: true,
          taskId: this.manifest.task_id,
          artifactDir: this.rootDisplay,
          preserved: [this.rootDisplay],
          remediation: [
            `Underlying cause: ${error instanceof Error ? error.message : String(error)}`,
            'Check free disk space and permissions on the delegate artifact directory.',
          ],
        },
      );
    }
    this.totalSpilledBytes = nextTotal;
    return {
      schema_version: DELEGATE_RECEIPT_SCHEMA_VERSION,
      artifact: join(DELEGATE_SPILL_DIRNAME, name),
      tool_name: input.toolName,
      tool_call_id: input.toolCallId,
      turn_sequence: input.turnSequence,
      source_call_index: input.sourceCallIndex,
      byte_length: input.payload.length,
      sha256: sha256Bytes(input.payload),
      content_format: 'opaque_bytes',
    };
  }

  /**
   * Read an exact byte range from a spilled artifact.
   *
   * Returns exactly the requested range or fails. It never returns a shorter
   * range than requested, and it never clamps the request to what happens to be
   * available: a request past end-of-file is a loud error naming the real size.
   */
  async readSpillRange(
    relativePath: string,
    offset: number,
    length: number,
  ): Promise<{ bytes: Buffer; totalBytes: number }> {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw this.readFailure(relativePath, 'offset must be a non-negative integer');
    if (!Number.isSafeInteger(length) || length <= 0)
      throw this.readFailure(relativePath, 'length must be a positive integer');
    const absPath = join(this.rootAbs, relativePath);
    if (!pathInside(this.rootAbs, absPath))
      throw this.readFailure(relativePath, 'path escapes the delegate artifact directory');
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(absPath, 'r');
    } catch (error) {
      throw this.readFailure(
        relativePath,
        `cannot open artifact: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      const stats = await handle.stat();
      const totalBytes = stats.size;
      if (offset + length > totalBytes) {
        throw this.readFailure(
          relativePath,
          `requested bytes ${String(offset)}..${String(offset + length)} exceed the artifact size of ${String(totalBytes)} bytes; the read is refused rather than silently shortened`,
        );
      }
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) {
        throw this.readFailure(
          relativePath,
          `read returned ${String(bytesRead)} of ${String(length)} requested bytes`,
        );
      }
      return { bytes: buffer, totalBytes };
    } finally {
      await handle.close();
    }
  }

  private readFailure(relativePath: string, reason: string): DelegateError {
    return new DelegateError(`delegate artifact read failed for ${relativePath}: ${reason}`, {
      code: 'artifact_read_failed',
      childCreated: true,
      taskId: this.manifest.task_id,
      artifactDir: this.rootDisplay,
    });
  }

  private async durableReplace(absPath: string, data: Buffer | string): Promise<void> {
    await replaceFileDurable(absPath, data);
  }

  private async write(name: string, data: Buffer | string): Promise<DelegateArtifactRef> {
    const absPath = join(this.rootAbs, name);
    if (name.length === 0 || name.includes('/') || name.includes('\\'))
      throw artifactError(`invalid delegate artifact name: ${name}`);
    if (!pathInside(this.rootAbs, absPath))
      throw artifactError(`delegate artifact path escapes the run directory: ${name}`);
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    try {
      await this.durableReplace(absPath, data);
    } catch (error) {
      throw artifactError(`could not durably write delegate artifact ${name}`, error);
    }
    const ref: DelegateArtifactRef = {
      path: basename(absPath),
      byte_length: bytes.length,
      sha256: sha256Bytes(bytes),
    };
    await this.update((manifest) => {
      manifest.artifacts = { ...manifest.artifacts, [name]: ref };
    });
    return ref;
  }

  private async persistManifest(): Promise<void> {
    const absPath = join(this.rootAbs, DELEGATE_ARTIFACT_NAMES.manifest);
    try {
      await this.durableReplace(absPath, `${canonicalJson(this.snapshot())}\n`);
    } catch (error) {
      throw artifactError('could not durably write the delegate manifest', error);
    }
  }

  private async update(mutator: (manifest: DelegateManifestV1) => void): Promise<void> {
    const apply = async () => {
      mutator(this.manifest);
      this.manifest.updated_at = this.now().toISOString();
      await this.persistManifest();
    };
    const next = this.writeChain.then(apply, apply);
    this.writeChain = next.catch(() => undefined);
    await next;
  }
}

/** Best-effort removal of an artifact root that must not be left half-created. */
export async function discardDelegateArtifactRoot(rootAbs: string): Promise<void> {
  await rm(rootAbs, { recursive: true, force: true });
}

/** Exposed so tests can prove control artifacts are written durably, not streamed. */
export async function writeDelegateArtifactDirect(
  absPath: string,
  data: Buffer | string,
): Promise<void> {
  await writeFileDurable(absPath, data);
}

/** Exposed for recovery flows that must rename a staged package into place. */
export async function renameIntoPlace(source: string, target: string): Promise<void> {
  await rename(source, target);
}
