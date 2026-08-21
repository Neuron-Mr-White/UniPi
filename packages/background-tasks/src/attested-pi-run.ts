import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';
import type {
  BackgroundTaskChildProcess,
  BackgroundTaskContext,
  BackgroundTaskSpawn,
} from './registry.js';
import { isJsonObject, parseJsonText, type BgTaskSnapshot, type JsonObject } from './types.js';
import { replaceFileDurable, writeFileDurable } from './durable-fs.js';
import {
  assertWindowsCommandLineWithinLimit,
  piLaunchArgv,
  resolvePiLaunch,
  type PiLaunchSpec,
} from './pi-launch.js';

export const PI_TASK_ATTESTATION_SCHEMA_VERSION = 'phase2.pi_task_attestation.v1';
export const ATTESTED_TASK_ID_PATTERN = /^b[0-9a-f]{32}$/;

export interface StructuredPiLaunchRequest {
  name: string;
  provider: string;
  model: string;
  prompt: string;
  reportPath: string;
  extraPiArgs?: string[] | undefined;
  thinking?: string | undefined;
  timeoutSeconds?: number | undefined;
}

export interface AttestedTaskPaths {
  outputAbsPath: string;
  metadataAbsPath: string;
  eventsAbsPath: string;
  stderrAbsPath: string;
  wrapperAbsPath: string;
  attestationAbsPath: string;
  outputPath: string;
  metadataPath: string;
  eventsPath: string;
  stderrPath: string;
  wrapperPath: string;
  attestationPath: string;
}

export interface GitAuthoritySnapshot {
  commit: string;
  tree: string;
  clean: boolean;
}

export interface ParsedPiEvents {
  piSessionId: string;
  piCwd: string;
  provider: string;
  model: string;
  providerScopedModelId: string;
  finalStopReason: string;
  tokenUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    costTotal?: number | undefined;
  };
  assistantCount: number;
  toolUsage: { total: number; failed: number; byName: Record<string, number> };
  humanTranscript: string;
}

export interface AuthObservation {
  apiIdentity: string;
  authClass: string;
  credentialKind: 'oauth';
  routeClass: 'subscription-agent';
  channel: string;
  directApiKey: false;
  selectedModel: Model<Api>;
}

export interface FinalAttestationInputs {
  task: BgTaskSnapshot;
  paths: AttestedTaskPaths;
  sessionDir: string;
  argv: string[];
  cwdRealpath: string;
  repoRootRealpath: string;
  startAuthority: GitAuthoritySnapshot;
  finishAuthority: GitAuthoritySnapshot;
  parsedEvents: ParsedPiEvents;
  auth: AuthObservation;
  prompt: Buffer;
  reportAbsPath: string;
}

export function makeAttestedTaskId(): string {
  return `b${randomBytes(16).toString('hex')}`;
}

export function validateStructuredPiLaunchRequest(input: StructuredPiLaunchRequest): void {
  if (!input.name.trim()) throw new Error('Attested Pi task requires a concise name');
  if (!input.provider.trim()) throw new Error('Attested Pi task requires provider');
  if (!input.model.trim()) throw new Error('Attested Pi task requires model');
  if (!input.prompt) throw new Error('Attested Pi task requires prompt text');
  if (!input.reportPath.trim()) throw new Error('Attested Pi task requires a report path');
  const args = input.extraPiArgs ?? [];
  for (const arg of args) {
    if (arg === '--api-key' || arg.startsWith('--api-key=')) {
      throw new Error('Attested Pi tasks forbid direct --api-key launch arguments');
    }
    if (arg === '--auth-file' || arg.startsWith('--auth-file=')) {
      throw new Error('Attested Pi tasks forbid alternate auth-file launch arguments');
    }
    if (arg === '-p' || arg === '--print' || arg === '--mode' || arg.startsWith('--mode=')) {
      throw new Error('Attested Pi tasks own print/json mode arguments');
    }
    if (
      arg === '--provider' ||
      arg.startsWith('--provider=') ||
      arg === '--model' ||
      arg.startsWith('--model=')
    ) {
      throw new Error('Use structured provider/model fields, not duplicate Pi args');
    }
    if (arg === '--thinking' || arg.startsWith('--thinking=')) {
      throw new Error('Use the structured thinking field, not duplicate Pi args');
    }
  }
}

const ATTESTED_PI_REMOVED_ENV_KEYS = [
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'PI_API_KEY',
  'PI_API_BASE_URL',
  'PI_AUTH_FILE',
] as const;

export function attestedPiChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of ATTESTED_PI_REMOVED_ENV_KEYS) Reflect.deleteProperty(out, key);
  return out;
}

export function buildAttestedPiArgv(
  input: StructuredPiLaunchRequest,
  attributionExtensionPath?: string,
): string[] {
  validateStructuredPiLaunchRequest(input);
  const args = ['pi', '--mode', 'json', '--provider', input.provider, '--model', input.model];
  if (input.provider === 'anthropic') {
    if (!attributionExtensionPath?.trim()) {
      throw new Error('Anthropic attested Pi tasks require the package attribution extension');
    }
    args.push('--extension', attributionExtensionPath);
  }
  if (input.thinking?.trim()) args.push('--thinking', input.thinking.trim());
  args.push(...(input.extraPiArgs ?? []), input.prompt);
  return args;
}

export async function resolveReportPath(cwd: string, reportPath: string): Promise<string> {
  if (isAbsolute(reportPath))
    throw new Error('Attested Pi report path must be relative to task cwd');
  const resolved = resolve(cwd, reportPath);
  const relativePath = relative(cwd, resolved);
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('Attested Pi report path must stay inside task cwd');
  }
  const parts = relativePath.split(sep);
  if (parts[0] === '.git' || (parts[0] === '.pi' && parts[1] === 'tasks')) {
    throw new Error('Attested Pi report path cannot target Git metadata or the fixed task store');
  }
  return resolved;
}

export async function gitAuthoritySnapshot(cwd: string): Promise<GitAuthoritySnapshot> {
  const commit = await runGit(cwd, ['rev-parse', 'HEAD']);
  const tree = await runGit(cwd, ['rev-parse', 'HEAD^{tree}']);
  const status = await runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
  return { commit, tree, clean: status.length === 0 };
}

export async function gitRepoRoot(cwd: string): Promise<string> {
  return realpath(await runGit(cwd, ['rev-parse', '--show-toplevel']));
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = nodeSpawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(out).toString('utf8').trim());
        return;
      }
      reject(
        new Error(`git ${args.join(' ')} failed: ${Buffer.concat(err).toString('utf8').trim()}`),
      );
    });
  });
}

export function observePiOAuth(
  ctx: BackgroundTaskContext,
  provider: string,
  modelId: string,
): AuthObservation {
  const registry = ctx.modelRegistry;
  const selected = registry.find?.(provider, modelId);
  if (!selected) throw new Error(`Pi model not found in ModelRegistry: ${provider}/${modelId}`);
  if (!registry.isUsingOAuth) throw new Error('ModelRegistry OAuth observation is unavailable');
  if (!registry.isUsingOAuth(selected)) {
    throw new Error(`Attested Pi task requires OAuth credentials for ${provider}/${modelId}`);
  }
  const channel =
    provider === 'openai-codex'
      ? 'subscription-codex'
      : provider === 'anthropic'
        ? 'subscription-anthropic'
        : undefined;
  const authClass =
    provider === 'openai-codex'
      ? 'pi-codex-oauth'
      : provider === 'anthropic'
        ? 'pi-anthropic-oauth'
        : undefined;
  if (!channel || !authClass)
    throw new Error(`Unsupported attested Pi OAuth provider: ${provider}`);
  return {
    apiIdentity: selected.api,
    authClass,
    credentialKind: 'oauth',
    routeClass: 'subscription-agent',
    channel,
    directApiKey: false,
    selectedModel: selected,
  };
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(record: JsonObject, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function normalizeUsage(value: unknown): ParsedPiEvents['tokenUsage'] {
  if (!isJsonObject(value))
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  const input = nonNegativeInteger(value['input']);
  const output = nonNegativeInteger(value['output']);
  const cacheRead = nonNegativeInteger(value['cacheRead']);
  const cacheWrite = nonNegativeInteger(value['cacheWrite']);
  const totalTokens =
    nonNegativeInteger(value['totalTokens']) || input + output + cacheRead + cacheWrite;
  const cost = isJsonObject(value['cost']) ? readNumber(value['cost'], 'total') : undefined;
  const usage: ParsedPiEvents['tokenUsage'] = { input, output, cacheRead, cacheWrite, totalTokens };
  if (cost !== undefined && cost >= 0) usage.costTotal = cost;
  return usage;
}

function appendUsage(
  target: ParsedPiEvents['tokenUsage'],
  delta: ParsedPiEvents['tokenUsage'],
): void {
  target.input += delta.input;
  target.output += delta.output;
  target.cacheRead += delta.cacheRead;
  target.cacheWrite += delta.cacheWrite;
  target.totalTokens += delta.totalTokens;
  if (delta.costTotal !== undefined) target.costTotal = (target.costTotal ?? 0) + delta.costTotal;
}

function textFromAssistantMessage(message: JsonObject): string[] {
  const content = message['content'];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!isJsonObject(part)) return [];
    if (part['type'] === 'text' && typeof part['text'] === 'string') return [part['text']];
    return [];
  });
}

function countToolCalls(message: JsonObject, tools: ParsedPiEvents['toolUsage']): void {
  const content = message['content'];
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (!isJsonObject(part) || part['type'] !== 'toolCall') continue;
    const name = typeof part['name'] === 'string' && part['name'] ? part['name'] : 'tool';
    tools.total += 1;
    tools.byName[name] = (tools.byName[name] ?? 0) + 1;
  }
}

export function parsePiJsonEvents(raw: Buffer): ParsedPiEvents {
  const text = raw.toString('utf8');
  if (!text.endsWith('\n')) throw new Error('Pi JSON event stream is not newline-terminated');
  let sessionId: string | undefined;
  let sessionCwd: string | undefined;
  let sessionCount = 0;
  let agentStartCount = 0;
  let agentEndCount = 0;
  let provider: string | undefined;
  let model: string | undefined;
  let finalStopReason: string | undefined;
  let assistantCount = 0;
  const usage: ParsedPiEvents['tokenUsage'] = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
  };
  const tools: ParsedPiEvents['toolUsage'] = { total: 0, failed: 0, byName: {} };
  const transcript: string[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const parsed = parseJsonText(line);
    if (!isJsonObject(parsed)) throw new Error('Pi JSON event line is not an object');
    const eventType = parsed['type'];
    if (eventType === 'session') {
      sessionCount += 1;
      sessionId = readString(parsed, 'id');
      sessionCwd = readString(parsed, 'cwd');
      continue;
    }
    if (eventType === 'agent_start') agentStartCount += 1;
    if (eventType === 'agent_end') agentEndCount += 1;
    if (eventType === 'tool_execution_start') {
      const name = readString(parsed, 'toolName') ?? readString(parsed, 'tool_name') ?? 'tool';
      tools.total += 1;
      tools.byName[name] = (tools.byName[name] ?? 0) + 1;
      transcript.push(`→ ${name}`);
      continue;
    }
    if (eventType === 'tool_execution_end') {
      if (parsed['isError'] === true) {
        tools.failed += 1;
        const name = readString(parsed, 'toolName') ?? readString(parsed, 'tool_name') ?? 'tool';
        transcript.push(`✗ ${name} failed`);
      }
      continue;
    }
    if (eventType !== 'message_end' || !isJsonObject(parsed['message'])) continue;
    const message = parsed['message'];
    if (message['role'] !== 'assistant') continue;
    assistantCount += 1;
    const messageProvider = readString(message, 'provider');
    const messageModel = readString(message, 'model');
    if (!messageProvider || !messageModel) {
      throw new Error('Assistant message lacks provider/model in Pi JSON events');
    }
    if (provider !== undefined && provider !== messageProvider)
      throw new Error('Pi assistant provider changed during task');
    if (model !== undefined && model !== messageModel)
      throw new Error('Pi assistant model changed during task');
    provider = messageProvider;
    model = messageModel;
    appendUsage(usage, normalizeUsage(message['usage']));
    countToolCalls(message, tools);
    transcript.push(...textFromAssistantMessage(message));
    if (message['error'] !== undefined && message['error'] !== null)
      throw new Error('Assistant message reported an error');
    const stopReason = readString(message, 'stopReason');
    if (stopReason) finalStopReason = stopReason;
  }
  if (sessionCount !== 1 || !sessionId || !sessionCwd)
    throw new Error('Pi JSON events must contain exactly one session header');
  if (agentStartCount !== 1) throw new Error('Pi JSON events must contain exactly one agent_start');
  if (agentEndCount !== 1) throw new Error('Pi JSON events must contain exactly one agent_end');
  if (assistantCount < 1 || !provider || !model)
    throw new Error('Pi JSON events contain no assistant message');
  if (finalStopReason !== 'stop')
    throw new Error(`Pi final stop reason is not stop: ${finalStopReason ?? 'missing'}`);
  return {
    piSessionId: sessionId,
    piCwd: sessionCwd,
    provider,
    model,
    providerScopedModelId: `${provider}/${model}`,
    finalStopReason,
    tokenUsage: usage,
    assistantCount,
    toolUsage: tools,
    humanTranscript: transcript.filter((line) => line.trim()).join('\n') + '\n',
  };
}

export function sha256Buffer(buffer: Buffer): string {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

export async function sha256File(path: string): Promise<{ byteLength: number; sha256: string }> {
  const bytes = await readFile(path);
  return { byteLength: bytes.length, sha256: sha256Buffer(bytes) };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

export async function writeFileFsynced(path: string, data: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFileDurable(path, data);
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await replaceFileDurable(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function closeAndFsyncOutputStream(
  stream: NodeJS.WritableStream | undefined,
): Promise<void> {
  if (!stream) return;
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      stream.off('error', fail);
      stream.off('close', finish);
      stream.off('finish', finish);
      resolvePromise();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      stream.off('close', finish);
      reject(error);
    };
    stream.once('close', finish);
    stream.once('finish', finish);
    stream.once('error', fail);
    stream.end();
  });
}

export function spawnAndCapturePi(
  spawnImpl: BackgroundTaskSpawn,
  argv: string[],
  options: SpawnOptions,
  platform: NodeJS.Platform = process.platform,
  launchOverride?: PiLaunchSpec | undefined,
): { child: BackgroundTaskChildProcess; stdoutChunks: Buffer[]; stderrChunks: Buffer[] } {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const logicalExecutable = argv[0];
  if (logicalExecutable !== 'pi') throw new Error('Attested Pi argv must start with pi');
  const piArgs = argv.slice(1);
  const launch = launchOverride ?? resolvePiLaunch({ platform });
  assertWindowsCommandLineWithinLimit(launch, piArgs, platform, 'attested-pi-run');
  const child = spawnImpl(launch.executable, piLaunchArgv(launch, piArgs), options);
  child.stdout?.on('data', (chunk: Buffer | string) => {
    stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'));
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'));
  });
  return { child, stdoutChunks, stderrChunks };
}

export async function buildPiTaskAttestation(input: FinalAttestationInputs): Promise<JsonObject> {
  if (
    input.startAuthority.commit !== input.finishAuthority.commit ||
    input.startAuthority.tree !== input.finishAuthority.tree
  ) {
    throw new Error('Git authority changed during attested Pi task');
  }
  if (!input.startAuthority.clean || !input.finishAuthority.clean) {
    throw new Error('Git worktree must be clean at attested Pi task start and finish');
  }
  if (
    input.parsedEvents.provider !== input.auth.selectedModel.provider ||
    input.parsedEvents.model !== input.auth.selectedModel.id
  ) {
    throw new Error('Observed Pi provider/model do not match selected ModelRegistry model');
  }
  const metadata = await sha256File(input.paths.metadataAbsPath);
  const output = await sha256File(input.paths.outputAbsPath);
  const events = await sha256File(input.paths.eventsAbsPath);
  const stderr = await sha256File(input.paths.stderrAbsPath);
  const wrapper = await sha256File(input.paths.wrapperAbsPath);
  const report = await sha256File(input.reportAbsPath);
  const promptHash = sha256Buffer(input.prompt);
  const attestation: { [key: string]: unknown } = {
    schema_version: PI_TASK_ATTESTATION_SCHEMA_VERSION,
    locator: {
      session_dir: input.sessionDir,
      task_id: input.task.id,
      metadata_ref: input.paths.metadataPath,
      output_ref: input.paths.outputPath,
      events_ref: input.paths.eventsPath,
      stderr_ref: input.paths.stderrPath,
      wrapper_ref: input.paths.wrapperPath,
    },
    source_hashes: {
      metadata_sha256: metadata.sha256,
      output_sha256: output.sha256,
      events_sha256: events.sha256,
      stderr_sha256: stderr.sha256,
      wrapper_sha256: wrapper.sha256,
    },
    lifecycle: {
      status: input.task.status,
      is_agent: input.task.isAgent,
      start_time_ms: input.task.startTime,
      end_time_ms: input.task.endTime ?? input.task.startTime,
      exit_code: input.task.exitCode ?? null,
      signal: input.task.signal ?? null,
      bytes_written: input.task.bytesWritten,
    },
    invocation: {
      pi_session_id: input.parsedEvents.piSessionId,
      argv: input.argv,
      cwd_realpath: input.cwdRealpath,
      provider: input.parsedEvents.provider,
      model_id: input.parsedEvents.model,
      provider_scoped_model_id: input.parsedEvents.providerScopedModelId,
      api_identity: input.auth.apiIdentity,
      auth_class: input.auth.authClass,
      credential_kind: input.auth.credentialKind,
      route_class: input.auth.routeClass,
      channel: input.auth.channel,
      direct_api_key: input.auth.directApiKey,
      final_stop_reason: input.parsedEvents.finalStopReason,
    },
    authority: {
      repo_root_realpath: input.repoRootRealpath,
      start_commit_oid: input.startAuthority.commit,
      start_tree_oid: input.startAuthority.tree,
      finish_commit_oid: input.finishAuthority.commit,
      finish_tree_oid: input.finishAuthority.tree,
      start_worktree_clean: input.startAuthority.clean,
      finish_worktree_clean: input.finishAuthority.clean,
    },
    artifacts: {
      prompt: { byte_length: input.prompt.length, sha256: promptHash },
      task_output: { byte_length: output.byteLength, sha256: output.sha256 },
      stderr: { byte_length: stderr.byteLength, sha256: stderr.sha256 },
      transcript: { byte_length: events.byteLength, sha256: events.sha256 },
      report: { byte_length: report.byteLength, sha256: report.sha256 },
    },
    attestation_sha256: '',
  };
  const withoutSelf = { ...attestation, attestation_sha256: undefined };
  Reflect.deleteProperty(withoutSelf, 'attestation_sha256');
  attestation['attestation_sha256'] = sha256Buffer(Buffer.from(canonicalJson(withoutSelf), 'utf8'));
  return attestation;
}

export function makeAttestedTaskPaths(
  runtimeAbs: string,
  runtimeDisplay: string,
  id: string,
): AttestedTaskPaths {
  return {
    outputAbsPath: join(runtimeAbs, `${id}.output`),
    metadataAbsPath: join(runtimeAbs, `${id}.json`),
    eventsAbsPath: join(runtimeAbs, `${id}.pi-events.jsonl`),
    stderrAbsPath: join(runtimeAbs, `${id}.stderr`),
    wrapperAbsPath: join(runtimeAbs, `${id}.pi-telemetry-wrapper.cjs`),
    attestationAbsPath: join(runtimeAbs, `${id}.attestation.json`),
    outputPath: join(runtimeDisplay, `${id}.output`),
    metadataPath: join(runtimeDisplay, `${id}.json`),
    eventsPath: join(runtimeDisplay, `${id}.pi-events.jsonl`),
    stderrPath: join(runtimeDisplay, `${id}.stderr`),
    wrapperPath: join(runtimeDisplay, `${id}.pi-telemetry-wrapper.cjs`),
    attestationPath: join(runtimeDisplay, `${id}.attestation.json`),
  };
}

export function pathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return (
    rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'))
  );
}

export async function assertRegularReadable(path: string): Promise<void> {
  const stats = await stat(path);
  if (!stats.isFile()) throw new Error(`Expected regular file: ${path}`);
}
