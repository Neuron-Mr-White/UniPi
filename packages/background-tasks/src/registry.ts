import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { formatSize } from '@earendil-works/pi-coding-agent';
import {
  boundedRead,
  deriveTaskNameFromCommand,
  escapeXml,
  formatAgentActivityLine,
  formatDuration,
  isJsonObject,
  normalizeTaskName,
  parseAgentActivity,
  parseJsonText,
  sanitizePathSegment,
  shellInvocation,
  shellQuote,
  snapshot,
  taskDisplayName,
  type BgLogsDetails,
  type BgTask,
  type BgTaskSnapshot,
  type JsonObject,
  type KillKind,
  type StartAttestedPiTaskOptions,
  type StartDelegateTaskOptions,
  type StartManagedTaskOptions,
  type StartTaskOptions,
  type TaskContextUsage,
  type TaskStatus,
  type TaskTokenUsage,
  type TaskToolUsage,
} from './types.js';
import type {
  BackgroundTaskChildProcess,
  BackgroundTaskContext,
  BackgroundTaskSpawn,
} from './child-process.js';
export type { BackgroundTaskChildProcess, BackgroundTaskContext, BackgroundTaskSpawn };
import {
  ATTESTED_TASK_ID_PATTERN,
  attestedPiChildEnv,
  buildAttestedPiArgv,
  buildPiTaskAttestation,
  closeAndFsyncOutputStream,
  gitAuthoritySnapshot,
  gitRepoRoot,
  makeAttestedTaskId,
  makeAttestedTaskPaths,
  observePiOAuth,
  parsePiJsonEvents,
  resolveReportPath,
  spawnAndCapturePi,
  writeFileFsynced,
  writeJsonAtomic,
} from './attested-pi-run.js';
import {
  assertWindowsCommandLineWithinLimit,
  piLaunchArgv,
  resolvePiLaunch,
  type PiLaunchSpec,
} from './pi-launch.js';
import { resolveAnthropicAttributionExtensionPath } from './anthropic-attribution-path.js';
import {
  runWindowsTaskkill,
  type TaskkillOutcome,
  type WindowsKillPhase,
  type WindowsTaskkillOptions,
} from './windows-taskkill.js';

export const MAX_OUTPUT_BYTES = Number(process.env['UNIPI_BG_MAX_OUTPUT_BYTES'] ?? 20 * 1024 * 1024);
export const KILL_GRACE_MS = 3000;
export const STOP_WAIT_MS = KILL_GRACE_MS + 1500;
export const MAX_RECENT_TASKS = 100;
const TELEMETRY_BUFFER_CHARS = 512 * 1024;
export const WIN32_CMD_PI_TELEMETRY_UNAVAILABLE_REASON =
  'win32-cmd-cannot-safely-intercept-pi-argv';

type KillProcessFn = (pid: number, signal?: NodeJS.Signals | number) => boolean;
type KillTreeFn = (
  pid: number,
  phase: WindowsKillPhase,
  signal?: AbortSignal,
) => Promise<TaskkillOutcome>;

interface WindowsKillState {
  softController?: AbortController | undefined;
  softPromise?: Promise<void> | undefined;
  forcePromise?: Promise<void> | undefined;
  forceFailure?: Error | undefined;
  forceFailureListeners?: Array<(error: Error) => void> | undefined;
}

export interface CompletionNotificationMessage {
  customType: 'background-task-notification';
  content: string;
  display: true;
  details: BgTaskSnapshot;
}

export interface CompletionNotificationOptions {
  deliverAs: 'followUp';
  triggerTurn: boolean;
}

export type CompletionNotificationSender = (
  message: CompletionNotificationMessage,
  options: CompletionNotificationOptions,
) => void;

export interface BackgroundTaskRegistryOptions {
  onChange?: () => void;
  sendCompletionNotification: CompletionNotificationSender;
  publishTerminal?: (task: BgTaskSnapshot) => void;
  spawn?: BackgroundTaskSpawn;
  killProcess?: KillProcessFn;
  killTree?: KillTreeFn;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  makeTaskId?: () => string;
  now?: () => number;
  maxOutputBytes?: number;
  maxRecentTasks?: number;
  killGraceMs?: number;
  stopWaitMs?: number;
  logger?: Pick<Console, 'error'>;
}

interface RuntimeDir {
  abs: string;
  display: string;
}

interface ModelWindowIndex {
  byQualifiedId: Record<string, number>;
  byId: Record<string, number>;
  defaultModel?: string | undefined;
  defaultProvider?: string | undefined;
  defaultContextWindow?: number | undefined;
}

function defaultTaskId(): string {
  return `b${randomBytes(4).toString('hex')}`;
}

function dirNameFromDisplay(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts.length >= 2 ? (parts.at(-2) ?? '') : '';
}

export function commandMayLaunchPiAgent(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env['UNIPI_BG_DISABLE_PI_TELEMETRY'] === '1') return false;
  return /(^|[\s;&|()])pi(?=\s)(?=[^\n;&|]*(?:\s-p(?:\s|$)|\s--print(?:\s|$)|\s--mode(?:=|\s+)json\b))/m.test(
    command,
  );
}

export function buildModelWindowIndex(
  ctx: Pick<BackgroundTaskContext, 'modelRegistry' | 'model'>,
): ModelWindowIndex {
  const byQualifiedId: Record<string, number> = {};
  const candidatesById = new Map<string, Set<number>>();
  for (const model of ctx.modelRegistry.getAll()) {
    const contextWindow =
      typeof model.contextWindow === 'number' &&
      Number.isFinite(model.contextWindow) &&
      model.contextWindow > 0
        ? Math.floor(model.contextWindow)
        : undefined;
    if (!contextWindow) continue;
    const providerId = String(model.provider);
    const modelId = String(model.id);
    byQualifiedId[`${providerId}/${modelId}`] = contextWindow;
    let candidates = candidatesById.get(modelId);
    if (!candidates) {
      candidates = new Set<number>();
      candidatesById.set(modelId, candidates);
    }
    candidates.add(contextWindow);
  }
  const byId: Record<string, number> = {};
  for (const [id, windows] of candidatesById) {
    const onlyWindow = windows.values().next();
    if (windows.size === 1 && !onlyWindow.done) byId[id] = onlyWindow.value;
  }
  const current = ctx.model;
  return {
    byQualifiedId,
    byId,
    defaultModel: current?.id,
    defaultProvider: current?.provider,
    defaultContextWindow: current?.contextWindow,
  };
}

export function createPiTelemetryWrapperSource(
  index: ModelWindowIndex,
  launch: PiLaunchSpec = resolvePiLaunch(),
): string {
  return `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const index = ${JSON.stringify(index)};
const launch = ${JSON.stringify(launch)};
const WINDOWS_COMMAND_LINE_LIMIT = 32767;

const tokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
let costTotal = 0;
let hasCostTotal = false;
let agentModel;
const toolUsage = { total: 0, failed: 0, byName: {} };
const seenToolCallIds = new Set();
const failedToolCallIds = new Set();

function nonNegativeInteger(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function normalizeUsage(usage) {
  if (!usage) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  const input = nonNegativeInteger(usage.input);
  const output = nonNegativeInteger(usage.output);
  const cacheRead = nonNegativeInteger(usage.cacheRead);
  const cacheWrite = nonNegativeInteger(usage.cacheWrite);
  const explicitTotal = nonNegativeInteger(usage.totalTokens);
  const totalTokens = explicitTotal || (input + output + cacheRead + cacheWrite);
  const cost = usage.cost && typeof usage.cost.total === "number" && Number.isFinite(usage.cost.total) && usage.cost.total >= 0
    ? usage.cost.total
    : undefined;
  return { input, output, cacheRead, cacheWrite, totalTokens, cost };
}

function addTokenUsage(usage) {
  const normalized = normalizeUsage(usage);
  if (!normalized.totalTokens) return normalized;
  tokenUsage.input += normalized.input;
  tokenUsage.output += normalized.output;
  tokenUsage.cacheRead += normalized.cacheRead;
  tokenUsage.cacheWrite += normalized.cacheWrite;
  tokenUsage.totalTokens += normalized.totalTokens;
  if (normalized.cost !== undefined) {
    costTotal += normalized.cost;
    hasCostTotal = true;
  }
  return normalized;
}

function currentTokenUsage() {
  if (!tokenUsage.totalTokens) return undefined;
  const out = { ...tokenUsage };
  if (hasCostTotal) out.costTotal = costTotal;
  return out;
}

function markToolStarted(id, name) {
  const key = id ? String(id) : undefined;
  if (key && seenToolCallIds.has(key)) return;
  if (key) seenToolCallIds.add(key);
  const toolName = name ? String(name) : "unknown";
  toolUsage.total += 1;
  toolUsage.byName[toolName] = (toolUsage.byName[toolName] || 0) + 1;
}

function markToolFailed(id) {
  const key = id ? String(id) : undefined;
  if (key && failedToolCallIds.has(key)) return;
  if (key) failedToolCallIds.add(key);
  toolUsage.failed += 1;
}

function currentToolUsage() {
  if (!toolUsage.total && !toolUsage.failed) return undefined;
  return { total: toolUsage.total, failed: toolUsage.failed, byName: { ...toolUsage.byName } };
}

function renderWindowsArgument(value) {
  if (value.length > 0 && !/[ \\t\"]/.test(value)) return value;
  let rendered = "\\\"";
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\\\") {
      backslashes += 1;
      continue;
    }
    if (char === "\\\"") {
      rendered += "\\\\".repeat(backslashes * 2 + 1);
      rendered += "\\\"";
      backslashes = 0;
      continue;
    }
    if (backslashes > 0) {
      rendered += "\\\\".repeat(backslashes);
      backslashes = 0;
    }
    rendered += char;
  }
  if (backslashes > 0) rendered += "\\\\".repeat(backslashes * 2);
  rendered += "\\\"";
  return rendered;
}

function assertWindowsLimit(stage, args) {
  if (process.platform !== "win32") return;
  const measured = [launch.executable, ...launch.argvPrefix, ...args].map(renderWindowsArgument).join(" ").length + 1;
  if (measured > WINDOWS_COMMAND_LINE_LIMIT) {
    const error = new Error("pi_command_line_too_long: " + stage + " measured UTF-16 command line length " + String(measured) + " exceeds limit " + String(WINDOWS_COMMAND_LINE_LIMIT));
    error.code = "pi_command_line_too_long";
    throw error;
  }
}

function emitUnifiedTelemetry(payload) {
  const out = { type: "background-task-telemetry", ...payload };
  const tokens = currentTokenUsage();
  const tools = currentToolUsage();
  if (tokens && !out.tokenUsage) out.tokenUsage = tokens;
  if (tools && !out.toolUsage) out.toolUsage = tools;
  if (agentModel && !out.model) out.model = agentModel;
  process.stdout.write(JSON.stringify(out) + "\\n");
}

function emitActivity(activity) {
  process.stdout.write(JSON.stringify({ type: "background-task-activity", ...activity }) + "\\n");
}

function summarizeArgs(args) {
  if (!args || typeof args !== "object") return "";
  const pick = (value) => {
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return undefined;
  };
  const preferred = ["path", "file_path", "file", "filename", "command", "cmd", "pattern", "query", "url", "name", "value", "text", "message"];
  for (const key of preferred) { const summary = pick(args[key]); if (summary) return summary; }
  for (const key of Object.keys(args)) { const summary = pick(args[key]); if (summary) return summary; }
  return "";
}

function emitAssistantActivity(message) {
  const content = message && Array.isArray(message.content) ? message.content : [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      emitActivity({ kind: "assistant_text", text: part.text });
    } else if (part.type === "thinking" || part.type === "reasoning") {
      const text = typeof part.text === "string" ? part.text : (typeof part.thinking === "string" ? part.thinking : "");
      if (text.trim()) emitActivity({ kind: "reasoning", text: text });
    }
  }
}

function resolveModelName(fromMessage, fromArgs, providerFromArgs) {
  const message = fromMessage ? String(fromMessage) : "";
  const args = fromArgs ? String(fromArgs) : "";
  const bareOf = (value) => value.includes("/") ? value.split("/").pop() : value;
  if (message && message.includes("/")) return message;
  if (args && args.includes("/") && (!message || bareOf(args) === message)) return args;
  const primary = message || args;
  if (!primary) return undefined;
  if (primary.includes("/")) return primary;
  if (providerFromArgs) return providerFromArgs + "/" + primary;
  if (index.defaultProvider) return index.defaultProvider + "/" + primary;
  return primary;
}

function parseInvocation(argv) {
  const out = [];
  let model;
  let provider;
  let hasMode = false;
  let modeValue;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-p" || arg === "--print") continue;
    if (arg === "--mode") {
      hasMode = true;
      modeValue = argv[i + 1];
      out.push(arg);
      if (i + 1 < argv.length) out.push(argv[++i]);
      continue;
    }
    if (arg.startsWith("--mode=")) {
      hasMode = true;
      modeValue = arg.slice("--mode=".length);
      out.push(arg);
      continue;
    }
    if (arg === "--model" && i + 1 < argv.length) {
      model = argv[i + 1];
      out.push(arg, argv[++i]);
      continue;
    }
    if (arg.startsWith("--model=")) model = arg.slice("--model=".length);
    if (arg === "--provider" && i + 1 < argv.length) {
      provider = argv[i + 1];
      out.push(arg, argv[++i]);
      continue;
    }
    if (arg.startsWith("--provider=")) provider = arg.slice("--provider=".length);
    out.push(arg);
  }
  if (hasMode && modeValue !== "json") return { args: argv, parseJson: false, model, provider };
  if (!hasMode) out.unshift("--mode", "json");
  return { args: out, parseJson: true, model, provider };
}

function resolveWindow(modelFromArgs, providerFromArgs, modelFromMessage) {
  const candidates = [];
  if (modelFromMessage) candidates.push(modelFromMessage);
  if (modelFromArgs) candidates.push(modelFromArgs);
  if (modelFromArgs && providerFromArgs && !modelFromArgs.includes("/")) candidates.push(providerFromArgs + "/" + modelFromArgs);
  if (modelFromArgs && index.defaultProvider && !modelFromArgs.includes("/")) candidates.push(index.defaultProvider + "/" + modelFromArgs);
  if (index.defaultModel && index.defaultProvider) candidates.push(index.defaultProvider + "/" + index.defaultModel);
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (index.byQualifiedId[candidate]) return index.byQualifiedId[candidate];
    const bare = String(candidate).includes("/") ? String(candidate).split("/").pop() : String(candidate);
    if (bare && index.byId[bare]) return index.byId[bare];
  }
  return index.defaultContextWindow || 0;
}

function countToolCallsFromMessage(message) {
  const content = message && Array.isArray(message.content) ? message.content : [];
  for (const part of content) {
    if (part && part.type === "toolCall") markToolStarted(part.id, part.name);
  }
}

function emitMessageTelemetry(message, modelFromArgs, providerFromArgs) {
  const usage = addTokenUsage(message && message.usage);
  const resolvedModel = resolveModelName(message && message.model, modelFromArgs, providerFromArgs);
  if (resolvedModel) agentModel = resolvedModel;
  const contextWindow = resolveWindow(modelFromArgs, providerFromArgs, message && message.model);
  const contextUsage = usage.totalTokens && contextWindow
    ? { tokens: usage.totalTokens, contextWindow, percent: (usage.totalTokens / contextWindow) * 100 }
    : undefined;
  if (contextUsage) process.stdout.write(JSON.stringify({ type: "background-task-context-usage", ...contextUsage }) + "\\n");
  const payload = {};
  if (contextUsage) payload.contextUsage = contextUsage;
  emitUnifiedTelemetry(payload);
}

function emitToolTelemetry() {
  emitUnifiedTelemetry({});
}

const parsed = parseInvocation(process.argv.slice(2));
let child;
let buffer = "";
try {
  const childArgs = [...launch.argvPrefix, ...parsed.args];
  assertWindowsLimit("telemetry-wrapper-pi", parsed.args);
  child = spawn(launch.executable, childArgs, { stdio: ["ignore", "pipe", "pipe"], env: process.env, shell: false, windowsHide: true });
} catch (error) {
  const message = error && typeof error.message === "string" ? error.message : String(error);
  process.stderr.write("[pi-bg telemetry wrapper error: " + message + "]\\n");
  process.exitCode = 1;
}

if (child) {
  if (!parsed.parseJson) {
    child.stdout.pipe(process.stdout);
  } else {
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });
  }
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.on("error", (error) => {
    process.stderr.write("[pi-bg telemetry wrapper error: " + error.message + "]\\n");
  });
  child.on("close", (code, signal) => {
    if (parsed.parseJson && buffer.trim()) processLine(buffer);
    // Never call process.exit() here: the final message telemetry may still be
    // buffered on wrapper stdout, and forced exit can publish a stale context
    // snapshot from the preceding assistant turn. exitCode lets Node drain the
    // pipe; signal termination is deferred through the same stdout barrier.
    process.stdout.write("", () => {
      if (signal) process.kill(process.pid, signal);
      else process.exitCode = code ?? 0;
    });
  });
}

function processLine(line) {
  if (!line.trim()) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    process.stdout.write(line + "\\n");
    return;
  }
  if (event.type === "tool_execution_start") {
    const toolName = event.toolName || event.tool_name || "tool";
    markToolStarted(event.toolCallId || event.tool_call_id, toolName);
    emitActivity({ kind: "tool_start", tool: String(toolName), argsSummary: summarizeArgs(event.args || event.arguments || event.input || event.parameters) });
    emitToolTelemetry();
    return;
  }
  if (event.type === "tool_execution_end") {
    const toolName = event.toolName || event.tool_name || "tool";
    if (event.isError) markToolFailed(event.toolCallId || event.tool_call_id);
    emitActivity({ kind: "tool_end", tool: String(toolName), isError: !!event.isError, error: typeof event.error === "string" ? event.error : undefined });
    emitToolTelemetry();
    return;
  }
  if (event.type === "message_end" && event.message && event.message.role === "assistant") {
    emitAssistantActivity(event.message);
    countToolCallsFromMessage(event.message);
    emitMessageTelemetry(event.message, parsed.model, parsed.provider);
  }
}
`;
}

interface ContextUsagePayload extends JsonObject {
  readonly contextWindow?: unknown;
  readonly tokens?: unknown;
  readonly percent?: unknown;
}

interface TokenUsagePayload extends JsonObject {
  readonly input?: unknown;
  readonly output?: unknown;
  readonly cacheRead?: unknown;
  readonly cacheWrite?: unknown;
  readonly totalTokens?: unknown;
  readonly costTotal?: unknown;
}

interface ToolUsagePayload extends JsonObject {
  readonly byName?: unknown;
  readonly failed?: unknown;
  readonly total?: unknown;
}

function normalizeContextUsage(value: unknown): TaskContextUsage | undefined {
  if (!isJsonObject(value)) return undefined;
  const input: ContextUsagePayload = value;
  const rawContextWindow = input.contextWindow;
  const contextWindow =
    typeof rawContextWindow === 'number' &&
    Number.isFinite(rawContextWindow) &&
    rawContextWindow > 0
      ? Math.floor(rawContextWindow)
      : undefined;
  if (!contextWindow) return undefined;
  const rawTokens = input.tokens;
  const tokens =
    rawTokens === null
      ? null
      : typeof rawTokens === 'number' && Number.isFinite(rawTokens) && rawTokens >= 0
        ? Math.floor(rawTokens)
        : null;
  const rawPercent = input.percent;
  const percent =
    rawPercent === null
      ? null
      : typeof rawPercent === 'number' && Number.isFinite(rawPercent) && rawPercent >= 0
        ? rawPercent
        : tokens === null
          ? null
          : (tokens / contextWindow) * 100;
  return { tokens, contextWindow, percent };
}

function parseContextUsageXml(xml: string): TaskContextUsage | undefined {
  const readNumber = (tag: string): number | null | undefined => {
    const match = new RegExp(`<${tag}>(.*?)</${tag}>`, 'i').exec(xml);
    if (!match) return undefined;
    const raw = match[1]?.trim();
    if (raw === 'null' || raw === '?') return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const tokens = readNumber('tokens');
  const contextWindow = readNumber('context-window') ?? readNumber('contextWindow');
  const percent = readNumber('percent');
  return normalizeContextUsage({ tokens, contextWindow, percent });
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function normalizeModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed;
}

function normalizeTokenUsage(value: unknown): TaskTokenUsage | undefined {
  if (!isJsonObject(value)) return undefined;
  const input: TokenUsagePayload = value;
  const usage: TaskTokenUsage = {
    input: nonNegativeInteger(input.input),
    output: nonNegativeInteger(input.output),
    cacheRead: nonNegativeInteger(input.cacheRead),
    cacheWrite: nonNegativeInteger(input.cacheWrite),
    totalTokens: nonNegativeInteger(input.totalTokens),
  };
  if (usage.totalTokens <= 0)
    usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const rawCostTotal = input.costTotal;
  if (typeof rawCostTotal === 'number' && Number.isFinite(rawCostTotal) && rawCostTotal >= 0)
    usage.costTotal = rawCostTotal;
  return usage.totalTokens > 0 ? usage : undefined;
}

function normalizeToolUsage(value: unknown): TaskToolUsage | undefined {
  if (!isJsonObject(value)) return undefined;
  const input: ToolUsagePayload = value;
  const byName: Record<string, number> = {};
  const rawByName = input.byName;
  if (isJsonObject(rawByName)) {
    for (const [name, count] of Object.entries(rawByName)) {
      const normalized = nonNegativeInteger(count);
      if (normalized > 0) byName[name] = normalized;
    }
  }
  const byNameTotal = Object.values(byName).reduce((sum, count) => sum + count, 0);
  const failed = nonNegativeInteger(input.failed);
  const total = Math.max(nonNegativeInteger(input.total), byNameTotal, failed);
  return total > 0 || failed > 0 ? { total, failed, byName } : undefined;
}

interface TelemetryControlPayload extends JsonObject {
  readonly type?: unknown;
  readonly contextUsage?: unknown;
  readonly tokenUsage?: unknown;
  readonly toolUsage?: unknown;
  readonly model?: unknown;
}

interface TelemetryDelta {
  context?: TaskContextUsage | undefined;
  tokens?: TaskTokenUsage | undefined;
  tools?: TaskToolUsage | undefined;
  model?: string | undefined;
}

function noopOnChange(): void {
  return undefined;
}

/**
 * Deliver the delegate prompt bytes over stdin.
 *
 * A failure to deliver the seed is loud: the caller terminates the task rather
 * than letting a child run without the context it was supposed to receive.
 */
function writeDelegateStdin(
  child: BackgroundTaskChildProcess,
  bytes: Buffer,
  onError: (error: Error) => void,
): void {
  const stdin = child.stdin;
  if (stdin === undefined || stdin === null) {
    onError(new Error('delegate child stdin pipe is unavailable'));
    return;
  }
  stdin.once('error', onError);
  stdin.write(bytes, (error?: Error | null) => {
    if (error !== undefined && error !== null) {
      onError(error);
      return;
    }
    stdin.end();
  });
}

export class BackgroundTaskRegistry {
  private readonly tasks = new Map<string, BgTask>();
  private runtimeDir: RuntimeDir | undefined;
  private runtimeNonce: string | undefined;
  private shuttingDown = false;
  private readonly spawn: BackgroundTaskSpawn;
  private readonly killProcess: KillProcessFn;
  private readonly killTree: KillTreeFn;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly makeTaskIdFn: () => string;
  private readonly now: () => number;
  private readonly maxOutputBytes: number;
  private readonly maxRecentTasks: number;
  private readonly killGraceMs: number;
  private readonly stopWaitMs: number;
  private readonly logger: Pick<Console, 'error'>;
  private readonly onChange: () => void;
  private readonly sendCompletionNotification: CompletionNotificationSender;
  private readonly publishTerminalSnapshot: (task: BgTaskSnapshot) => void;
  private readonly windowsKillStates = new WeakMap<BgTask, WindowsKillState>();

  constructor(options: BackgroundTaskRegistryOptions) {
    this.spawn =
      options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions ?? {}) as unknown as BackgroundTaskChildProcess);
    this.killProcess = options.killProcess ?? process.kill.bind(process);
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.killTree =
      options.killTree ??
      ((pid, phase, signal) => {
        const taskkillOptions: WindowsTaskkillOptions =
          signal === undefined ? { env: this.env } : { env: this.env, signal };
        return runWindowsTaskkill(pid, phase, taskkillOptions);
      });
    this.makeTaskIdFn = options.makeTaskId ?? defaultTaskId;
    this.now = options.now ?? Date.now;
    this.maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    this.maxRecentTasks = options.maxRecentTasks ?? MAX_RECENT_TASKS;
    this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    this.stopWaitMs = options.stopWaitMs ?? STOP_WAIT_MS;
    this.logger = options.logger ?? console;
    this.onChange = options.onChange ?? noopOnChange;
    this.sendCompletionNotification = options.sendCompletionNotification;
    this.publishTerminalSnapshot = options.publishTerminal ?? noopOnChange;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  setShuttingDown(value: boolean): void {
    this.shuttingDown = value;
  }

  allTasks(): BgTask[] {
    return [...this.tasks.values()];
  }

  snapshot(task: BgTask): BgTaskSnapshot {
    return snapshot(task);
  }

  async ensureRuntimeDir(ctx: BackgroundTaskContext): Promise<RuntimeDir> {
    if (this.runtimeDir) return this.runtimeDir;
    // OUR convention: runtime artifacts under the OS temp root, never .pi/tasks/.
    // A per-instance nonce keeps concurrent registries in one process isolated
    // (the reference relied on per-cwd .pi/tasks for this).
    if (this.runtimeNonce === undefined) this.runtimeNonce = randomBytes(4).toString('hex');
    const sessionId = sanitizePathSegment(ctx.sessionId ?? `session-${String(process.pid)}`);
    const runId = `${sessionId}-${String(process.pid)}-${this.runtimeNonce}`;
    const tmpBase = process.env['UNIPI_BG_TMP_DIR'] ?? (process.env['TMPDIR'] ?? '/tmp');
    const runtimeDirAbs = join(tmpBase, 'unipi-bg-tasks', runId);
    const runtimeDirDisplay = join(tmpBase, 'unipi-bg-tasks', runId);
    await mkdir(runtimeDirAbs, { recursive: true });
    this.runtimeDir = { abs: runtimeDirAbs, display: runtimeDirDisplay };
    return this.runtimeDir;
  }

  async startTask(
    ctx: BackgroundTaskContext,
    command: string,
    options: StartTaskOptions = {},
  ): Promise<BgTask> {
    const normalizedCommand = command.trim();
    if (!normalizedCommand) throw new Error('Background command is empty');
    if (this.shuttingDown)
      throw new Error('Cannot start a background task while Pi is shutting down');

    const isAgent = options.isAgent ?? false;
    const baseInvocation = shellInvocation(normalizedCommand, this.platform, this.env);
    const piTelemetryRequested = isAgent && commandMayLaunchPiAgent(normalizedCommand, this.env);
    const piTelemetryLaunch =
      piTelemetryRequested && baseInvocation.dialect === 'posix'
        ? resolvePiLaunch({ platform: this.platform })
        : undefined;

    const dir = await this.ensureRuntimeDir(ctx);
    const id = this.makeTaskIdFn();
    const outputAbsPath = join(dir.abs, `${id}.output`);
    const metadataAbsPath = join(dir.abs, `${id}.json`);
    const outputPath = join(dir.display, `${id}.output`);
    const timeoutSeconds =
      typeof options.timeoutSeconds === 'number' &&
      Number.isFinite(options.timeoutSeconds) &&
      options.timeoutSeconds > 0
        ? Math.floor(options.timeoutSeconds)
        : undefined;
    const taskName =
      normalizeTaskName(options.name) ??
      normalizeTaskName(options.description) ??
      deriveTaskNameFromCommand(normalizedCommand);
    const trimmedDescription = options.description?.trim();
    const description =
      trimmedDescription && trimmedDescription.length > 0 ? trimmedDescription : undefined;

    const task: BgTask = {
      id,
      name: taskName,
      command: normalizedCommand,
      description,
      status: 'running',
      outputPath,
      outputAbsPath,
      metadataAbsPath,
      cwd: ctx.cwd,
      startTime: this.now(),
      exitCode: undefined,
      pid: undefined,
      bytesWritten: 0,
      isAgent,
      notified: false,
      notifyOnCompletion: options.notifyOnCompletion ?? true,
      triggerOnCompletion: options.triggerOnCompletion ?? false,
      timeoutSeconds,
      terminalPublicationGate: options.terminalPublicationGate,
      waiters: [],
    };
    this.tasks.set(id, task);

    const stream = createWriteStream(outputAbsPath, { flags: 'a', encoding: 'utf8' });
    task.stream = stream;
    stream.on('error', (error) => {
      task.error = `Output file write failed: ${error.message}`;
      if (task.status === 'running') {
        task.killKind = 'output_cap';
        try {
          this.requestKill(task, 'SIGTERM');
        } catch (killError) {
          void this.finalizeTask(
            task,
            'failed',
            null,
            undefined,
            `${task.error}; kill failed: ${killError instanceof Error ? killError.message : String(killError)}`,
          );
        }
      }
    });

    try {
      let commandToSpawn = normalizedCommand;
      if (piTelemetryRequested) {
        if (baseInvocation.dialect === 'posix') {
          if (piTelemetryLaunch === undefined)
            throw new Error('Pi telemetry launch spec was not resolved');
          const wrapperAbsPath = join(dir.abs, `${id}.pi-telemetry-wrapper.cjs`);
          await writeFile(
            wrapperAbsPath,
            createPiTelemetryWrapperSource(buildModelWindowIndex(ctx), piTelemetryLaunch),
            'utf8',
          );
          commandToSpawn = `pi() { ${shellQuote(process.execPath)} ${shellQuote(wrapperAbsPath)} "$@"; }\n${normalizedCommand}`;
          task.telemetryWrapped = true;
        } else {
          task.telemetryUnavailableReason = WIN32_CMD_PI_TELEMETRY_UNAVAILABLE_REASON;
        }
      }
      const invocation =
        commandToSpawn === normalizedCommand
          ? baseInvocation
          : shellInvocation(commandToSpawn, this.platform, this.env);
      const child = this.spawn(invocation.shell, invocation.args, {
        cwd: ctx.cwd,
        detached: this.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: this.env,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });

      task.child = child;
      task.pid = child.pid;

      child.stdout?.on('data', (data) => {
        this.appendChildOutput(task, data, 'stdout');
      });
      child.stderr?.on('data', (data) => {
        this.appendChildOutput(task, data, 'stderr');
      });

      child.on('error', (error) => {
        this.writeNotice(task, `\n[background task spawn error: ${error.message}]\n`);
        void this.finalizeTask(task, 'failed', null, undefined, error.message);
      });

      child.on('close', (code, signalName) => {
        let status: TaskStatus;
        let error: string | undefined;
        if (task.killKind === 'user' || task.killKind === 'shutdown') {
          status = 'killed';
        } else if (task.killKind === 'timeout') {
          status = 'failed';
          error = task.error ?? `Timed out after ${String(timeoutSeconds)}s`;
        } else if (task.killKind === 'output_cap') {
          status = 'failed';
          error = task.error ?? `Output exceeded cap of ${formatSize(this.maxOutputBytes)}`;
        } else if ((code ?? 0) === 0) {
          status = 'completed';
        } else {
          status = 'failed';
          const exitCode = code === null ? 'null' : String(code);
          error = `Exited with code ${exitCode}${signalName ? ` (${signalName})` : ''}`;
        }
        void this.finalizeTask(task, status, code, signalName, error);
      });

      if (timeoutSeconds !== undefined) {
        task.timeoutHandle = setTimeout(() => {
          if (task.status !== 'running') return;
          task.killKind = 'timeout';
          task.error = `Timed out after ${String(timeoutSeconds)}s`;
          this.writeNotice(task, `\n[background task timeout: ${task.error}]\n`);
          try {
            this.requestKill(task, 'SIGTERM');
          } catch (error) {
            void this.finalizeTask(
              task,
              'failed',
              null,
              undefined,
              `${task.error}; kill failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }, timeoutSeconds * 1000);
      }

      await this.writeMetadata(task);
      this.onChange();
      return task;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.writeNotice(task, `\n[background task spawn exception: ${message}]\n`);
      await this.finalizeTask(task, 'failed', null, undefined, message);
      throw new Error(`Failed to start background task: ${message}`);
    }
  }

  /**
   * Track an in-process asynchronous workflow through the same durable task,
   * notification, status, log, and cancellation surfaces as child processes.
   * The supplied completion promise must own all workflow cleanup before it
   * settles; terminal publication happens only after that settlement.
   */
  async startManagedTask(
    ctx: BackgroundTaskContext,
    request: StartManagedTaskOptions,
  ): Promise<BgTask> {
    if (this.shuttingDown)
      throw new Error('Cannot start a managed background task while Pi is shutting down');
    if (!/^[a-zA-Z0-9_.-]+$/u.test(request.id))
      throw new Error(`Managed background task id is invalid: ${request.id}`);
    if (this.tasks.has(request.id))
      throw new Error(`Background task id already exists: ${request.id}`);

    const dir = await this.ensureRuntimeDir(ctx);
    const outputAbsPath = join(dir.abs, `${request.id}.output`);
    const metadataAbsPath = join(dir.abs, `${request.id}.json`);
    const outputPath = join(dir.display, `${request.id}.output`);
    const task: BgTask = {
      id: request.id,
      name: normalizeTaskName(request.name) ?? 'Managed background task',
      command: request.command,
      description: request.description,
      status: 'running',
      outputPath,
      outputAbsPath,
      metadataAbsPath,
      cwd: ctx.cwd,
      startTime: this.now(),
      exitCode: undefined,
      pid: undefined,
      bytesWritten: 0,
      isAgent: request.isAgent,
      notified: false,
      notifyOnCompletion: request.notifyOnCompletion,
      triggerOnCompletion: request.triggerOnCompletion,
      fusion: request.fusion,
      managedCancel: request.cancel,
      managedStopWaitMs: request.stopWaitMs,
      terminalPublicationGate: request.terminalPublicationGate,
      waiters: [],
    };
    this.tasks.set(task.id, task);
    const stream = createWriteStream(outputAbsPath, { flags: 'a', encoding: 'utf8' });
    task.stream = stream;
    stream.on('error', (error) => {
      task.error = `Output file write failed: ${error.message}`;
      if (task.status === 'running' && !task.managedCancelRequested) {
        task.managedCancelRequested = true;
        try {
          request.cancel();
        } catch (cancelError) {
          task.error = `${task.error}; cancellation failed: ${BackgroundTaskRegistry.errorMessage(cancelError)}`;
        }
      }
    });

    try {
      await this.writeMetadata(task);
      this.onChange();
    } catch (error) {
      this.tasks.delete(task.id);
      if (!stream.destroyed) stream.destroy();
      try {
        request.cancel();
      } catch (cancelError) {
        this.logger.error(
          `[background-tasks] managed task cancellation after metadata failure also failed for ${task.id}:`,
          cancelError,
        );
      }
      throw new Error(
        `Failed to register managed background task: ${BackgroundTaskRegistry.errorMessage(error)}`,
      );
    }

    void request.completion
      .then(
        () => this.finalizeTask(task, 'completed', 0),
        (error: unknown) => {
          const message = BackgroundTaskRegistry.errorMessage(error);
          const killed = task.killKind === 'user' || task.killKind === 'shutdown';
          return this.finalizeTask(task, killed ? 'killed' : 'failed', null, undefined, message);
        },
      )
      .catch((error: unknown) => {
        this.logger.error(
          `[background-tasks] managed task finalization failed for ${task.id}:`,
          error,
        );
      });
    return task;
  }

  async updateManagedTask(task: BgTask, state: string, line?: string): Promise<void> {
    if (task.status !== 'running' || task.fusion === undefined) return;
    task.fusion.state = state;
    if (line !== undefined && line.length > 0) this.writeNotice(task, `${line}\n`);
    await this.writeMetadata(task);
    this.onChange();
  }

  /** Claim deferred Fusion usage exactly once before returning it from bg_result. */
  async claimFusionUsage(task: BgTask): Promise<boolean> {
    if (task.fusion === undefined) throw new Error(`Task ${task.id} is not a Fusion task`);
    let claimed = false;
    const write = async () => {
      if (!task.fusion || task.fusion.usageDelivered) return;
      task.fusion.usageDelivered = true;
      await writeJsonAtomic(task.metadataAbsPath, snapshot(task));
      claimed = true;
    };
    const previous = task.metadataWriteChain ?? Promise.resolve();
    const next = previous.then(write, write);
    task.metadataWriteChain = next.catch(() => undefined);
    await next;
    return claimed;
  }

  /**
   * Start a prepared delegate child.
   *
   * The caller has already completed preflight, so by the time this runs the
   * seed, budget plan, and artifact directory exist and the argv is fixed. The
   * child is launched directly, never through a shell, and its terminal state
   * flows through the same durable notification path as `bg_run`.
   */
  async startDelegateTask(
    ctx: BackgroundTaskContext,
    request: StartDelegateTaskOptions,
  ): Promise<BgTask> {
    if (this.shuttingDown)
      throw new Error('Cannot start a delegate task while Pi is shutting down');

    const launch = resolvePiLaunch({ platform: this.platform });
    assertWindowsCommandLineWithinLimit(launch, request.argv, this.platform, 'bg-delegate');

    const dir = await this.ensureRuntimeDir(ctx);
    const id = request.facts.taskId;
    const outputAbsPath = join(dir.abs, `${id}.output`);
    const metadataAbsPath = join(dir.abs, `${id}.json`);
    const outputPath = join(dir.display, `${id}.output`);

    const task: BgTask = {
      id,
      name: normalizeTaskName(request.name) ?? 'Delegate task',
      command: ['pi', ...request.argv].map(shellQuote).join(' '),
      status: 'running',
      outputPath,
      outputAbsPath,
      metadataAbsPath,
      cwd: ctx.cwd,
      startTime: this.now(),
      exitCode: undefined,
      pid: undefined,
      bytesWritten: 0,
      isAgent: true,
      notified: false,
      notifyOnCompletion: request.notifyOnCompletion,
      triggerOnCompletion: request.triggerOnCompletion,
      timeoutSeconds: request.timeoutSeconds,
      model: request.facts.route.qualifiedId,
      delegate: request.facts,
      waiters: [],
    };
    this.tasks.set(id, task);

    const stream = createWriteStream(outputAbsPath, { flags: 'a', encoding: 'utf8' });
    task.stream = stream;
    stream.on('error', (error) => {
      task.error = `Output file write failed: ${error.message}`;
    });

    try {
      const child = this.spawn(launch.executable, piLaunchArgv(launch, [...request.argv]), {
        cwd: ctx.cwd,
        detached: this.platform !== 'win32',
        shell: false,
        // The seed travels over stdin, never as a shell or positional argument,
        // so the bytes the child reads are exactly the bytes that were persisted
        // and hashed, with no quoting or command-line length limit in the path.
        stdio: ['pipe', 'pipe', 'pipe'],
        env: request.env,
        windowsHide: true,
      });
      task.child = child;
      task.pid = child.pid;
      writeDelegateStdin(child, request.stdinBytes, (error) => {
        this.writeNotice(task, `\n[delegate stdin write failed: ${error.message}]\n`);
        if (task.status === 'running') {
          task.killKind = 'user';
          task.error = `Delegate seed could not be delivered: ${error.message}`;
          try {
            this.requestKill(task, 'SIGTERM');
          } catch {
            void this.finalizeTask(task, 'failed', null, undefined, task.error);
          }
        }
      });

      child.stdout?.on('data', (data) => {
        this.appendChildOutput(task, data, 'stdout');
      });
      child.stderr?.on('data', (data) => {
        this.appendChildOutput(task, data, 'stderr');
      });
      child.on('error', (error) => {
        this.writeNotice(task, `\n[delegate spawn error: ${error.message}]\n`);
        void this.finalizeTask(task, 'failed', null, undefined, error.message);
      });
      child.on('close', (code, signalName) => {
        let status: TaskStatus;
        let error: string | undefined;
        if (task.killKind === 'user' || task.killKind === 'shutdown') {
          status = 'killed';
        } else if (task.killKind === 'timeout') {
          status = 'failed';
          error = task.error ?? `Timed out after ${String(request.timeoutSeconds ?? 0)}s`;
        } else if ((code ?? 0) === 0) {
          status = 'completed';
        } else {
          status = 'failed';
          error = `Exited with code ${code === null ? 'null' : String(code)}${signalName ? ` (${signalName})` : ''}`;
        }
        void this.finalizeTask(task, status, code, signalName, error);
      });

      if (request.timeoutSeconds !== undefined) {
        task.timeoutHandle = setTimeout(() => {
          if (task.status !== 'running') return;
          task.killKind = 'timeout';
          task.error = `Timed out after ${String(request.timeoutSeconds)}s`;
          this.writeNotice(task, `\n[delegate timeout: ${task.error}]\n`);
          try {
            this.requestKill(task, 'SIGTERM');
          } catch (error) {
            void this.finalizeTask(
              task,
              'failed',
              null,
              undefined,
              `${task.error}; kill failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }, request.timeoutSeconds * 1000);
      }

      await this.writeMetadata(task);
      this.onChange();
      return task;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.writeNotice(task, `\n[delegate spawn exception: ${message}]\n`);
      await this.finalizeTask(task, 'failed', null, undefined, message);
      throw new Error(`Failed to start delegate task: ${message}`);
    }
  }

  async startAttestedPiTask(
    ctx: BackgroundTaskContext,
    request: StartAttestedPiTaskOptions,
  ): Promise<BgTask> {
    if (this.shuttingDown)
      throw new Error('Cannot start an attested Pi task while Pi is shutting down');

    const attributionExtensionPath =
      request.provider === 'anthropic' ? resolveAnthropicAttributionExtensionPath() : undefined;
    const argv = buildAttestedPiArgv(request, attributionExtensionPath);
    const attestedPiLaunch = resolvePiLaunch({ platform: this.platform });
    assertWindowsCommandLineWithinLimit(
      attestedPiLaunch,
      argv.slice(1),
      this.platform,
      'attested-pi-run',
    );

    const dir = await this.ensureRuntimeDir(ctx);
    const id = makeAttestedTaskId();
    if (!ATTESTED_TASK_ID_PATTERN.test(id))
      throw new Error('Generated attested task id is invalid');
    const paths = makeAttestedTaskPaths(dir.abs, dir.display, id);
    const promptBytes = Buffer.from(request.prompt, 'utf8');
    const reportAbsPath = await resolveReportPath(ctx.cwd, request.reportPath);
    const auth = observePiOAuth(ctx, request.provider, request.model);
    const repoRootRealpath = await gitRepoRoot(ctx.cwd);
    const cwdRealpath = await realpath(ctx.cwd);
    const startAuthority = await gitAuthoritySnapshot(ctx.cwd);
    if (!startAuthority.clean)
      throw new Error('Attested Pi task requires a clean worktree at start');
    const timeoutSeconds =
      typeof request.timeoutSeconds === 'number' &&
      Number.isFinite(request.timeoutSeconds) &&
      request.timeoutSeconds > 0
        ? Math.floor(request.timeoutSeconds)
        : undefined;

    const task: BgTask = {
      id,
      name: normalizeTaskName(request.name) ?? 'Attested Pi task',
      command: argv.map(shellQuote).join(' '),
      status: 'running',
      outputPath: paths.outputPath,
      outputAbsPath: paths.outputAbsPath,
      metadataAbsPath: paths.metadataAbsPath,
      eventsAbsPath: paths.eventsAbsPath,
      stderrAbsPath: paths.stderrAbsPath,
      wrapperAbsPath: paths.wrapperAbsPath,
      attestationAbsPath: paths.attestationAbsPath,
      cwd: ctx.cwd,
      startTime: this.now(),
      exitCode: undefined,
      pid: undefined,
      bytesWritten: 0,
      isAgent: true,
      notified: false,
      notifyOnCompletion: false,
      triggerOnCompletion: false,
      timeoutSeconds,
      attestationPath: paths.attestationPath,
      attestedPi: {
        eventsPath: paths.eventsPath,
        stderrPath: paths.stderrPath,
        wrapperPath: paths.wrapperPath,
        attestationPath: paths.attestationPath,
      },
      waiters: [],
    };
    this.tasks.set(id, task);

    await writeFileFsynced(paths.outputAbsPath, '');
    await writeFileFsynced(paths.eventsAbsPath, '');
    await writeFileFsynced(paths.stderrAbsPath, '');
    await writeFileFsynced(
      paths.wrapperAbsPath,
      'direct-spawn attested Pi task; no shell telemetry wrapper is used\n',
    );
    await this.writeMetadata(task);

    const captured = spawnAndCapturePi(
      this.spawn,
      argv,
      {
        cwd: ctx.cwd,
        detached: this.platform !== 'win32',
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: attestedPiChildEnv(this.env),
        windowsHide: true,
      },
      this.platform,
      attestedPiLaunch,
    );
    task.child = captured.child;
    task.pid = captured.child.pid;
    await this.writeMetadata(task);
    this.onChange();

    captured.child.on('error', (error) => {
      void this.finalizeAttestedPiTask(
        task,
        paths,
        argv,
        cwdRealpath,
        repoRootRealpath,
        startAuthority,
        auth,
        promptBytes,
        reportAbsPath,
        captured.stdoutChunks,
        captured.stderrChunks,
        'failed',
        null,
        null,
        error.message,
      );
    });

    captured.child.on('close', (code, signalName) => {
      let status: TaskStatus = (code ?? 0) === 0 && signalName === null ? 'completed' : 'failed';
      let error: string | undefined;
      if (task.killKind === 'timeout') {
        status = 'failed';
        error = task.error ?? `Timed out after ${String(timeoutSeconds)}s`;
      } else if (task.killKind === 'user' || task.killKind === 'shutdown') {
        status = 'killed';
        error = task.error;
      } else if (status === 'failed') {
        const exitCode = code === null ? 'null' : String(code);
        error = `Exited with code ${exitCode}${signalName ? ` (${signalName})` : ''}`;
      }
      void this.finalizeAttestedPiTask(
        task,
        paths,
        argv,
        cwdRealpath,
        repoRootRealpath,
        startAuthority,
        auth,
        promptBytes,
        reportAbsPath,
        captured.stdoutChunks,
        captured.stderrChunks,
        status,
        code,
        signalName,
        error,
      );
    });

    if (timeoutSeconds !== undefined) {
      task.timeoutHandle = setTimeout(() => {
        if (task.status !== 'running') return;
        task.killKind = 'timeout';
        task.error = `Timed out after ${String(timeoutSeconds)}s`;
        try {
          this.requestKill(task, 'SIGTERM');
        } catch (error) {
          void this.finalizeAttestedPiTask(
            task,
            paths,
            argv,
            cwdRealpath,
            repoRootRealpath,
            startAuthority,
            auth,
            promptBytes,
            reportAbsPath,
            captured.stdoutChunks,
            captured.stderrChunks,
            'failed',
            null,
            null,
            error instanceof Error ? error.message : String(error),
          );
        }
      }, timeoutSeconds * 1000);
    }

    return task;
  }

  private async finalizeAttestedPiTask(
    task: BgTask,
    paths: ReturnType<typeof makeAttestedTaskPaths>,
    argv: string[],
    cwdRealpath: string,
    repoRootRealpath: string,
    startAuthority: Awaited<ReturnType<typeof gitAuthoritySnapshot>>,
    auth: ReturnType<typeof observePiOAuth>,
    promptBytes: Buffer,
    reportAbsPath: string,
    stdoutChunks: Buffer[],
    stderrChunks: Buffer[],
    status: TaskStatus,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    error?: string,
  ): Promise<void> {
    if (task.finalized) return;
    task.finalized = true;
    if (task.timeoutHandle) clearTimeout(task.timeoutHandle);
    if (task.killEscalationTimer !== undefined) {
      clearTimeout(task.killEscalationTimer);
      task.killEscalationTimer = undefined;
    }
    let finalStatus = status;
    let finalError = error;
    const forceFailure = await this.awaitWindowsForceBeforeTerminal(task);
    if (forceFailure !== undefined) {
      finalStatus = 'failed';
      finalError = BackgroundTaskRegistry.appendTaskError(finalError, forceFailure.message);
    }
    task.exitCode = exitCode;
    task.signal = signal;
    task.endTime = this.now();
    if (finalError) task.error = finalError;

    const rawEvents = Buffer.concat(stdoutChunks);
    const rawStderr = Buffer.concat(stderrChunks);
    await writeFileFsynced(paths.eventsAbsPath, rawEvents);
    await writeFileFsynced(paths.stderrAbsPath, rawStderr);

    let parsed: ReturnType<typeof parsePiJsonEvents> | undefined;
    if (finalStatus === 'completed') {
      try {
        parsed = parsePiJsonEvents(rawEvents);
        task.model = parsed.providerScopedModelId;
        task.tokenUsage = {
          input: parsed.tokenUsage.input,
          output: parsed.tokenUsage.output,
          cacheRead: parsed.tokenUsage.cacheRead,
          cacheWrite: parsed.tokenUsage.cacheWrite,
          totalTokens: parsed.tokenUsage.totalTokens,
        };
        if (parsed.tokenUsage.costTotal !== undefined)
          task.tokenUsage.costTotal = parsed.tokenUsage.costTotal;
        task.toolUsage = parsed.toolUsage;
        const outputBytes = Buffer.from(parsed.humanTranscript, 'utf8');
        task.bytesWritten = outputBytes.length;
        await writeFileFsynced(paths.outputAbsPath, outputBytes);
      } catch (parseError) {
        finalStatus = 'failed';
        task.error = parseError instanceof Error ? parseError.message : String(parseError);
        const outputBytes = Buffer.from(`[attested Pi task error: ${task.error}]\n`, 'utf8');
        task.bytesWritten = outputBytes.length;
        await writeFileFsynced(paths.outputAbsPath, outputBytes);
      }
    } else {
      const outputBytes = Buffer.from(rawStderr.toString('utf8'), 'utf8');
      task.bytesWritten = outputBytes.length;
      await writeFileFsynced(paths.outputAbsPath, outputBytes);
    }

    try {
      if (finalStatus === 'completed' && parsed) {
        const finishAuthority = await gitAuthoritySnapshot(task.cwd);
        const completedSnapshot: BgTaskSnapshot = { ...snapshot(task), status: 'completed' };
        await this.writeMetadataSnapshot(task, completedSnapshot);
        const attestation = await buildPiTaskAttestation({
          task: completedSnapshot,
          paths,
          sessionDir: dirNameFromDisplay(paths.outputPath),
          argv,
          cwdRealpath,
          repoRootRealpath,
          startAuthority,
          finishAuthority,
          parsedEvents: parsed,
          auth,
          prompt: promptBytes,
          reportAbsPath,
        });
        await writeJsonAtomic(paths.attestationAbsPath, attestation);
      } else {
        await this.writeMetadataSnapshot(task, { ...snapshot(task), status: finalStatus });
      }
    } catch (attestationError) {
      finalStatus = 'failed';
      task.error =
        attestationError instanceof Error ? attestationError.message : String(attestationError);
      await this.writeMetadataSnapshot(task, { ...snapshot(task), status: 'failed' }).catch(
        (metadataError: unknown) => {
          this.logger.error(
            `[background-tasks] failed to write failed attested metadata for ${task.id}:`,
            metadataError,
          );
        },
      );
    }

    task.status = finalStatus;
    for (const waiter of task.waiters.splice(0)) waiter();
    this.onChange();
    this.publishTerminal(task);
    this.pruneOldTasks();
  }

  resolveTask(idOrPrefix: string): BgTask {
    const id = idOrPrefix.trim();
    if (!id) throw new Error('Task ID is required');
    const exact = this.tasks.get(id);
    if (exact) return exact;
    const matches = [...this.tasks.values()].filter((task) => task.id.startsWith(id));
    const onlyMatch = matches[0];
    if (matches.length === 1 && onlyMatch) return onlyMatch;
    if (matches.length > 1)
      throw new Error(
        `Ambiguous task ID prefix "${id}": ${matches.map((task) => task.id).join(', ')}`,
      );
    throw new Error(`Unknown background task ID: ${id}`);
  }

  async stopTask(task: BgTask, kind: KillKind, reason?: string): Promise<BgTask> {
    if (task.status !== 'running') {
      throw new Error(`Task ${task.id} is ${task.status}, not running`);
    }
    task.killKind = kind;
    if (reason) task.error = reason;
    this.requestKill(task, 'SIGTERM');
    const stopWaitMs = task.managedStopWaitMs ?? this.stopWaitMs;
    const stopped =
      this.platform === 'win32' && task.managedCancel === undefined
        ? await this.waitForEndOrWindowsForceFailure(task, stopWaitMs)
        : await this.waitForEnd(task, stopWaitMs);
    const forceFailure = this.windowsKillStates.get(task)?.forceFailure;
    if (forceFailure !== undefined) throw forceFailure;
    if (!stopped) {
      throw new Error(
        `Task ${task.id} did not exit within ${formatDuration(stopWaitMs)} after cancellation`,
      );
    }
    return task;
  }

  async stopAllRunning(
    kind: KillKind,
    reason?: string,
  ): Promise<{ stopped: number; failures: string[] }> {
    const running = this.allTasks().filter((task) => task.status === 'running');
    const failures: string[] = [];
    let stopped = 0;
    await Promise.all(
      running.map(async (task) => {
        try {
          await this.stopTask(task, kind, reason);
          stopped++;
        } catch (error) {
          failures.push(
            `${taskDisplayName(task)} (${task.id}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
    return { stopped, failures };
  }

  async getTaskLogs(
    task: BgTask,
    maxBytes: number,
    tail: boolean,
  ): Promise<{ text: string; details: BgLogsDetails }> {
    if (!existsSync(task.outputAbsPath)) {
      throw new Error(`Output file does not exist for ${task.id}: ${task.outputPath}`);
    }
    const read = await boundedRead(task.outputAbsPath, maxBytes, tail);
    const direction = tail ? 'tail' : 'head';
    let text = read.content.length > 0 ? read.content : '(no output yet)';
    if (read.truncated) {
      const omitted = read.totalBytes - read.bytesRead;
      const notice = `\n\n[Showing ${direction} ${formatSize(read.bytesRead)} of ${formatSize(read.totalBytes)}; ${formatSize(omitted)} omitted. Full output: ${task.outputPath}]`;
      text = tail ? `${notice}\n\n${text}` : `${text}${notice}`;
    } else {
      text += `\n\n[Full output: ${task.outputPath}]`;
    }
    return {
      text,
      details: {
        task: snapshot(task),
        path: task.outputPath,
        bytesRead: read.bytesRead,
        truncated: read.truncated,
        tail,
      },
    };
  }

  private async writeMetadata(task: BgTask): Promise<void> {
    await this.writeMetadataSnapshot(task, snapshot(task));
  }

  private async writeMetadataSnapshot(task: BgTask, value: BgTaskSnapshot): Promise<void> {
    const write = async () => {
      await writeJsonAtomic(task.metadataAbsPath, value);
    };
    const previous = task.metadataWriteChain ?? Promise.resolve();
    const next = previous.then(write, write);
    task.metadataWriteChain = next.catch(() => undefined);
    await next;
  }

  private ingestTelemetry(task: BgTask, text: string): void {
    if (!text) return;
    const telemetryText = `${task.contextUsageBuffer ?? ''}${text}`;
    let latestContext = task.contextUsage;
    let latestTokens = task.tokenUsage;
    let latestTools = task.toolUsage;
    let latestModel = task.model;
    for (const line of telemetryText.split(/\r?\n/)) {
      if (!line.includes('background-task-')) continue;
      const trimmed = line.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const parsed = parseJsonText(trimmed);
          if (!isJsonObject(parsed)) continue;
          const payload: TelemetryControlPayload = parsed;
          if (payload.type === 'background-task-context-usage') {
            latestContext = normalizeContextUsage(payload) ?? latestContext;
          } else if (payload.type === 'background-task-telemetry') {
            latestContext = normalizeContextUsage(payload.contextUsage) ?? latestContext;
            latestTokens = normalizeTokenUsage(payload.tokenUsage) ?? latestTokens;
            latestTools = normalizeToolUsage(payload.toolUsage) ?? latestTools;
            latestModel = normalizeModel(payload.model) ?? latestModel;
          }
        } catch {
          // Ignore malformed optional telemetry; task output remains authoritative for debugging.
        }
      }
    }
    const xmlMatches = telemetryText.matchAll(
      /<background-task-context-usage>[\s\S]*?<\/background-task-context-usage>/gi,
    );
    for (const match of xmlMatches) latestContext = parseContextUsageXml(match[0]) ?? latestContext;

    const lastNewline = Math.max(telemetryText.lastIndexOf('\n'), telemetryText.lastIndexOf('\r'));
    let retained = lastNewline >= 0 ? telemetryText.slice(lastNewline + 1) : telemetryText;
    const lastXmlOpen = telemetryText.toLowerCase().lastIndexOf('<background-task-context-usage');
    const lastXmlClose = telemetryText
      .toLowerCase()
      .lastIndexOf('</background-task-context-usage>');
    if (lastXmlOpen > lastXmlClose) retained = telemetryText.slice(lastXmlOpen);
    task.contextUsageBuffer = retained.slice(-TELEMETRY_BUFFER_CHARS);

    this.commitTelemetry(task, {
      context: latestContext,
      tokens: latestTokens,
      tools: latestTools,
      model: latestModel,
    });
  }

  /** Apply the latest parsed telemetry to a task, persisting metadata and notifying the UI only on change. */
  private commitTelemetry(task: BgTask, next: TelemetryDelta): void {
    const before = JSON.stringify({
      contextUsage: task.contextUsage,
      tokenUsage: task.tokenUsage,
      toolUsage: task.toolUsage,
      model: task.model,
    });
    if (next.context !== undefined) task.contextUsage = next.context;
    if (next.tokens !== undefined) task.tokenUsage = next.tokens;
    if (next.tools !== undefined) task.toolUsage = next.tools;
    if (next.model !== undefined) task.model = next.model;
    const after = JSON.stringify({
      contextUsage: task.contextUsage,
      tokenUsage: task.tokenUsage,
      toolUsage: task.toolUsage,
      model: task.model,
    });
    if (before !== after) {
      this.onChange();
      void this.writeMetadata(task).catch((error: unknown) => {
        this.logger.error(
          `[background-tasks] failed to write telemetry metadata for ${task.id}:`,
          error,
        );
      });
    }
  }

  /** Cap-enforcing sink for all persisted task output; terminates the task once the byte cap is exceeded. */
  private writeToStream(task: BgTask, buffer: Buffer): void {
    if (!task.stream || task.stream.destroyed) return;
    if (buffer.length === 0) return;

    const nextBytes = task.bytesWritten + buffer.length;
    if (nextBytes <= this.maxOutputBytes) {
      task.stream.write(buffer);
      task.bytesWritten = nextBytes;
      return;
    }

    const remaining = Math.max(0, this.maxOutputBytes - task.bytesWritten);
    if (remaining > 0) {
      task.stream.write(buffer.subarray(0, remaining));
      task.bytesWritten += remaining;
    }

    if (!task.capExceeded) {
      task.capExceeded = true;
      task.error = `Output exceeded cap of ${formatSize(this.maxOutputBytes)}; terminating task`;
      const notice = `\n\n[background task error: ${task.error}]\n`;
      task.stream.write(notice);
      task.bytesWritten += Buffer.byteLength(notice, 'utf8');
      task.killKind = 'output_cap';
      try {
        this.requestKill(task, 'SIGTERM');
      } catch (error) {
        task.error = `${task.error}; kill failed: ${error instanceof Error ? error.message : String(error)}`;
        void this.finalizeTask(task, 'failed', null, undefined, task.error);
      }
    }
  }

  /** Persist an internally generated notice (spawn/timeout/cap diagnostics) verbatim. */
  private writeNotice(task: BgTask, text: string): void {
    if (!text) return;
    this.writeToStream(task, Buffer.from(text, 'utf8'));
  }

  private appendChildOutput(
    task: BgTask,
    data: Buffer | string,
    source: 'stdout' | 'stderr',
  ): void {
    if (!task.stream || task.stream.destroyed) return;
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    if (buffer.length === 0) return;
    if (task.telemetryWrapped) {
      // Wrapped Pi agents stream control lines on stdout (telemetry + activity); child
      // stderr is raw diagnostics and is always passed through to the transcript verbatim.
      if (source === 'stdout') this.processAgentStdout(task, buffer.toString('utf8'));
      else this.writeToStream(task, buffer);
      return;
    }
    this.ingestTelemetry(task, buffer.toString('utf8'));
    this.writeToStream(task, buffer);
  }

  /** Reconstruct wrapped-agent stdout into whole control lines, routing telemetry to metrics and activity to the transcript. */
  private processAgentStdout(task: BgTask, text: string): void {
    const buffered = `${task.agentStdoutBuffer ?? ''}${text}`;
    const lastNewline = buffered.lastIndexOf('\n');
    task.agentStdoutBuffer = lastNewline >= 0 ? buffered.slice(lastNewline + 1) : buffered;
    if (lastNewline < 0) return;
    const latest: TelemetryDelta = {};
    for (const line of buffered.slice(0, lastNewline).split('\n'))
      this.consumeAgentLine(task, line, latest);
    this.commitTelemetry(task, latest);
  }

  /** Flush a trailing partial wrapped-agent line on finalize so the last transcript fragment is never lost. */
  private flushAgentStdout(task: BgTask): void {
    const remainder = task.agentStdoutBuffer;
    if (!remainder) return;
    task.agentStdoutBuffer = '';
    const latest: TelemetryDelta = {};
    this.consumeAgentLine(task, remainder, latest);
    this.commitTelemetry(task, latest);
  }

  private consumeAgentLine(task: BgTask, rawLine: string, latest: TelemetryDelta): void {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
      this.writeNotice(task, `${line}\n`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = parseJsonText(trimmed);
    } catch {
      this.writeNotice(task, `${line}\n`);
      return;
    }
    if (!isJsonObject(parsed)) {
      this.writeNotice(task, `${line}\n`);
      return;
    }
    const record: TelemetryControlPayload = parsed;
    const type = record.type;
    if (type === 'background-task-context-usage') {
      const context = normalizeContextUsage(record);
      if (context) latest.context = context;
      return;
    }
    if (type === 'background-task-telemetry') {
      const context = normalizeContextUsage(record.contextUsage);
      if (context) latest.context = context;
      const tokens = normalizeTokenUsage(record.tokenUsage);
      if (tokens) latest.tokens = tokens;
      const tools = normalizeToolUsage(record.toolUsage);
      if (tools) latest.tools = tools;
      const model = normalizeModel(record.model);
      if (model) latest.model = model;
      return;
    }
    const activity = parseAgentActivity(parsed);
    if (activity) {
      const formatted = formatAgentActivityLine(activity);
      if (formatted) this.writeNotice(task, `${formatted}\n`);
      return;
    }
    // Unknown JSON object: pass through to the transcript rather than silently dropping it.
    this.writeNotice(task, `${line}\n`);
  }

  private getWindowsKillState(task: BgTask): WindowsKillState {
    let state = this.windowsKillStates.get(task);
    if (state === undefined) {
      state = {};
      this.windowsKillStates.set(task, state);
    }
    return state;
  }

  private static errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private static appendTaskError(existing: string | undefined, next: string): string {
    if (existing === undefined || existing.length === 0) return next;
    if (existing.includes(next)) return existing;
    return `${existing}; ${next}`;
  }

  private static describeTaskkillOutcome(outcome: TaskkillOutcome): string {
    const exitCode = outcome.exitCode === null ? 'null' : String(outcome.exitCode);
    const signal = outcome.signal === null ? 'null' : outcome.signal;
    const stdout = outcome.stdout.length > 0 ? ` stdout=${JSON.stringify(outcome.stdout)}` : '';
    const stderr = outcome.stderr.length > 0 ? ` stderr=${JSON.stringify(outcome.stderr)}` : '';
    const stdoutTruncated = outcome.stdoutTruncated ? ' stdout_truncated=true' : '';
    const stderrTruncated = outcome.stderrTruncated ? ' stderr_truncated=true' : '';
    return `exit=${exitCode} signal=${signal}${stdout}${stderr}${stdoutTruncated}${stderrTruncated}`;
  }

  private isWindowsTaskkillTerminalRace(task: BgTask): boolean {
    return task.status !== 'running' || task.finalized === true;
  }

  private clearKillEscalationTimer(task: BgTask): void {
    if (task.killEscalationTimer !== undefined) {
      clearTimeout(task.killEscalationTimer);
      task.killEscalationTimer = undefined;
    }
  }

  private recordWindowsTaskkillNotice(task: BgTask, message: string): void {
    this.writeNotice(task, `\n[background task Windows termination: ${message}]\n`);
  }

  private recordWindowsSoftFailure(task: BgTask, pid: number, detail: string): void {
    const message =
      `Windows taskkill /T logical termination request failed for task ${task.id} pid ${String(pid)}: ` +
      `${detail}; force escalation remains scheduled`;
    task.error = BackgroundTaskRegistry.appendTaskError(task.error, message);
    this.recordWindowsTaskkillNotice(task, message);
    this.onChange();
    void this.writeMetadata(task).catch((metadataError: unknown) => {
      this.logger.error(
        `[background-tasks] failed to write Windows taskkill soft-failure metadata for ${task.id}:`,
        metadataError,
      );
    });
  }

  private makeWindowsForceFailure(task: BgTask, pid: number, detail: string): Error {
    return new Error(
      `Windows taskkill /T /F force termination failed for task ${task.id} pid ${String(pid)}: ${detail}. Descendant processes may have leaked.`,
    );
  }

  private recordWindowsForceFailure(task: BgTask, error: Error): void {
    const state = this.getWindowsKillState(task);
    state.forceFailure = error;
    task.error = BackgroundTaskRegistry.appendTaskError(task.error, error.message);
    this.recordWindowsTaskkillNotice(task, error.message);
    this.onChange();
    void this.writeMetadata(task).catch((metadataError: unknown) => {
      this.logger.error(
        `[background-tasks] failed to write Windows taskkill force-failure metadata for ${task.id}:`,
        metadataError,
      );
    });
    const listeners = state.forceFailureListeners;
    if (listeners !== undefined) {
      delete state.forceFailureListeners;
      for (const listener of listeners) listener(error);
    }
  }

  private evaluateWindowsTaskkillOutcome(
    task: BgTask,
    pid: number,
    phase: WindowsKillPhase,
    outcome: TaskkillOutcome,
  ): Error | undefined {
    if (outcome.exitCode === 0) return undefined;
    const detail = BackgroundTaskRegistry.describeTaskkillOutcome(outcome);
    if (outcome.exitCode === 128) {
      this.recordWindowsTaskkillNotice(
        task,
        `taskkill ${phase} reported process not found for pid ${String(pid)} (${detail}); treating as an already-exited race`,
      );
      return undefined;
    }
    if (this.isWindowsTaskkillTerminalRace(task)) {
      this.recordWindowsTaskkillNotice(
        task,
        `taskkill ${phase} finished after the task became terminal for pid ${String(pid)} (${detail}); treating as a terminal race`,
      );
      return undefined;
    }
    if (phase === 'terminate') {
      this.recordWindowsSoftFailure(task, pid, detail);
      return undefined;
    }
    return this.makeWindowsForceFailure(task, pid, detail);
  }

  private handleWindowsSoftException(
    task: BgTask,
    pid: number,
    error: unknown,
    state: WindowsKillState,
  ): void {
    const message = BackgroundTaskRegistry.errorMessage(error);
    if (state.forcePromise !== undefined || this.isWindowsTaskkillTerminalRace(task)) return;
    this.recordWindowsSoftFailure(task, pid, message);
  }

  private startWindowsSoftKill(task: BgTask, pid: number): Promise<void> {
    const state = this.getWindowsKillState(task);
    if (state.softPromise !== undefined) return state.softPromise;
    const controller = new AbortController();
    state.softController = controller;

    let launched: Promise<TaskkillOutcome>;
    try {
      launched = this.killTree(pid, 'terminate', controller.signal);
    } catch (error) {
      delete state.softController;
      throw new Error(
        `Could not kill task ${task.id}: Windows taskkill /T failed to start: ${BackgroundTaskRegistry.errorMessage(error)}`,
      );
    }

    const promise = launched
      .then((outcome) => {
        if (state.forcePromise !== undefined || this.isWindowsTaskkillTerminalRace(task)) return;
        const failure = this.evaluateWindowsTaskkillOutcome(task, pid, 'terminate', outcome);
        if (failure !== undefined) throw failure;
      })
      .catch((error: unknown) => {
        this.handleWindowsSoftException(task, pid, error, state);
      })
      .finally(() => {
        if (state.softController === controller) delete state.softController;
      });
    state.softPromise = promise;
    return promise;
  }

  private startWindowsForceKill(task: BgTask, pid: number): Promise<void> {
    const state = this.getWindowsKillState(task);
    if (state.forcePromise !== undefined) return state.forcePromise;

    let resolveForce: (() => void) | undefined;
    let rejectForce: ((error: unknown) => void) | undefined;
    const forcePromise = new Promise<void>((resolve, reject) => {
      resolveForce = resolve;
      rejectForce = reject;
    });
    if (resolveForce === undefined || rejectForce === undefined) {
      throw new Error('Windows force termination promise could not be initialized');
    }
    const resolveForceReady = resolveForce;
    const rejectForceReady = rejectForce;
    state.forcePromise = forcePromise;
    void forcePromise.catch((error: unknown) => {
      this.logger.error(
        `[background-tasks] Windows force tree termination failed for ${task.id}:`,
        error,
      );
    });

    this.clearKillEscalationTimer(task);
    if (state.softController !== undefined && !state.softController.signal.aborted) {
      state.softController.abort();
    }

    let launched: Promise<TaskkillOutcome>;
    try {
      launched = this.killTree(pid, 'force');
    } catch (error) {
      const failure = this.makeWindowsForceFailure(
        task,
        pid,
        `helper failed to start: ${BackgroundTaskRegistry.errorMessage(error)}`,
      );
      delete state.forcePromise;
      this.recordWindowsForceFailure(task, failure);
      rejectForceReady(failure);
      throw failure;
    }

    launched.then(
      (outcome) => {
        const failure = this.evaluateWindowsTaskkillOutcome(task, pid, 'force', outcome);
        if (failure !== undefined) {
          this.recordWindowsForceFailure(task, failure);
          rejectForceReady(failure);
          return;
        }
        resolveForceReady();
      },
      (error: unknown) => {
        if (this.isWindowsTaskkillTerminalRace(task)) {
          this.recordWindowsTaskkillNotice(
            task,
            `taskkill force rejected after the task became terminal for pid ${String(pid)} (${BackgroundTaskRegistry.errorMessage(error)}); treating as a terminal race`,
          );
          resolveForceReady();
          return;
        }
        const failure = this.makeWindowsForceFailure(
          task,
          pid,
          BackgroundTaskRegistry.errorMessage(error),
        );
        this.recordWindowsForceFailure(task, failure);
        rejectForceReady(failure);
      },
    );

    return forcePromise;
  }

  private requestWindowsKill(task: BgTask, pid: number, signal: NodeJS.Signals): void {
    if (signal === 'SIGKILL') {
      this.startWindowsForceKill(task, pid);
      task.killSignalSent = true;
      return;
    }

    this.startWindowsSoftKill(task, pid);
    task.killSignalSent = true;
    if (task.killEscalationTimer !== undefined) return;
    task.killEscalationTimer = setTimeout(() => {
      task.killEscalationTimer = undefined;
      if (task.status !== 'running') return;
      try {
        this.requestKill(task, 'SIGKILL');
      } catch (error) {
        task.error = BackgroundTaskRegistry.appendTaskError(
          task.error,
          `SIGKILL failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        void this.writeMetadata(task).catch((metadataError: unknown) => {
          this.logger.error(
            `[background-tasks] failed to write metadata for ${task.id}:`,
            metadataError,
          );
        });
      }
    }, this.killGraceMs).unref();
  }

  private requestKill(task: BgTask, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (task.status !== 'running') {
      throw new Error(`Task ${task.id} is ${task.status}, not running`);
    }
    if (task.managedCancel !== undefined) {
      if (task.managedCancelRequested) return;
      task.managedCancelRequested = true;
      try {
        task.managedCancel();
      } catch (error) {
        throw new Error(
          `Could not cancel managed task ${task.id}: ${BackgroundTaskRegistry.errorMessage(error)}`,
        );
      }
      task.killSignalSent = true;
      return;
    }
    if (!task.child) {
      throw new Error(`Task ${task.id} has no child process handle`);
    }
    if (!task.pid) {
      throw new Error(`Task ${task.id} has no process id`);
    }
    if (task.killSignalSent && signal === 'SIGTERM') return;

    if (this.platform === 'win32') {
      this.requestWindowsKill(task, task.pid, signal);
      return;
    }

    const errors: string[] = [];
    let killed = false;

    try {
      this.killProcess(-task.pid, signal);
      killed = true;
    } catch (error) {
      errors.push(
        `process group kill failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!killed) {
      try {
        task.child.kill(signal);
        killed = true;
      } catch (error) {
        errors.push(`child kill failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!killed) {
      throw new Error(`Could not kill task ${task.id}: ${errors.join('; ')}`);
    }

    task.killSignalSent = true;
    // SIGKILL is the terminal escalation; it must never schedule a further one.
    if (signal === 'SIGKILL') return;
    // Only one escalation timer may be outstanding. Concurrent stop requests
    // previously each scheduled their own, producing duplicate SIGKILLs.
    if (task.killEscalationTimer !== undefined) return;
    task.killEscalationTimer = setTimeout(() => {
      task.killEscalationTimer = undefined;
      if (task.status !== 'running') return;
      try {
        this.requestKill(task, 'SIGKILL');
      } catch (error) {
        task.error = `SIGKILL failed: ${error instanceof Error ? error.message : String(error)}`;
        void this.writeMetadata(task).catch((metadataError: unknown) => {
          this.logger.error(
            `[background-tasks] failed to write metadata for ${task.id}:`,
            metadataError,
          );
        });
      }
    }, this.killGraceMs).unref();
  }

  private waitForEnd(task: BgTask, timeoutMs: number): Promise<boolean> {
    if (task.status !== 'running') return Promise.resolve(true);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const idx = task.waiters.indexOf(done);
        if (idx >= 0) task.waiters.splice(idx, 1);
        resolve(false);
      }, timeoutMs);
      const done = () => {
        clearTimeout(timeout);
        resolve(true);
      };
      task.waiters.push(done);
    });
  }

  private waitForEndOrWindowsForceFailure(task: BgTask, timeoutMs: number): Promise<boolean> {
    const state = this.getWindowsKillState(task);
    if (state.forceFailure !== undefined) return Promise.reject(state.forceFailure);
    if (task.status !== 'running') return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        const waiterIndex = task.waiters.indexOf(done);
        if (waiterIndex >= 0) task.waiters.splice(waiterIndex, 1);
        const listeners = state.forceFailureListeners;
        if (listeners !== undefined) {
          const listenerIndex = listeners.indexOf(failed);
          if (listenerIndex >= 0) listeners.splice(listenerIndex, 1);
          if (listeners.length === 0) delete state.forceFailureListeners;
        }
      };
      const timeout = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      const done = () => {
        cleanup();
        resolve(true);
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      task.waiters.push(done);
      if (state.forceFailureListeners === undefined) state.forceFailureListeners = [];
      state.forceFailureListeners.push(failed);
    });
  }

  private async awaitWindowsForceBeforeTerminal(task: BgTask): Promise<Error | undefined> {
    const state = this.windowsKillStates.get(task);
    if (state === undefined) return undefined;
    const forcePromise = state.forcePromise;
    if (forcePromise === undefined) return state.forceFailure;
    try {
      await forcePromise;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
    return state.forceFailure;
  }

  private publishTerminal(task: BgTask): void {
    if (task.terminalPublished || task.terminalPublishInFlight) return;
    task.terminalPublishInFlight = true;
    if (task.terminalPublicationGate === undefined) {
      this.tryPublishTerminalNow(task);
      return;
    }
    void this.publishTerminalWhenReady(task);
  }

  private async publishTerminalWhenReady(task: BgTask): Promise<void> {
    try {
      await task.terminalPublicationGate;
    } catch (error) {
      this.handleTerminalPublishFailure(task, error);
      return;
    }
    this.tryPublishTerminalNow(task);
  }

  private tryPublishTerminalNow(task: BgTask): void {
    try {
      if (task.terminalPublished) return;
      this.publishTerminalSnapshot(snapshot(task));
      task.terminalPublished = true;
      if (task.terminalPublishRetryHandle) {
        clearTimeout(task.terminalPublishRetryHandle);
        task.terminalPublishRetryHandle = undefined;
      }
    } catch (error) {
      this.handleTerminalPublishFailure(task, error);
      return;
    } finally {
      task.terminalPublishInFlight = false;
    }
  }

  private handleTerminalPublishFailure(task: BgTask, error: unknown): void {
    this.logger.error(`[background-tasks] terminal publication failed for ${task.id}:`, error);
    task.terminalPublishInFlight = false;
    if (!task.terminalPublished && task.terminalPublishRetryHandle === undefined) {
      task.terminalPublishRetryHandle = setTimeout(() => {
        task.terminalPublishRetryHandle = undefined;
        this.publishTerminal(task);
      }, 100);
      task.terminalPublishRetryHandle.unref();
    }
  }

  private notifyCompletion(task: BgTask): void {
    if (!task.notifyOnCompletion || task.notified || this.shuttingDown) return;
    task.notified = true;
    const exit =
      task.exitCode === undefined ? '' : `\n  <exit-code>${String(task.exitCode)}</exit-code>`;
    const error = task.error ? `\n  <error>${escapeXml(task.error)}</error>` : '';
    const taskName = taskDisplayName(task);
    const guidance =
      task.fusion === undefined
        ? 'Terminal state and output metadata are durable. Do not call bg_status to reconfirm; use bg_logs only if output is needed.'
        : task.status === 'completed'
          ? `Fusion result is durably committed at ${task.fusion.artifactDir}. Call bg_result({taskId:${JSON.stringify(task.id)}}) once to retrieve it; do not poll.`
          : `Fusion ended ${task.status}. Inspect the preserved artifacts at ${task.fusion.artifactDir}; do not poll.`;
    const content = [
      '<background-task-notification>',
      `  <task-id>${task.id}</task-id>`,
      `  <task-name>${escapeXml(taskName)}</task-name>`,
      `  <status>${task.status}</status>`,
      exit,
      error,
      `  <output-file>${escapeXml(task.outputPath)}</output-file>`,
      `  <summary>${escapeXml(`Background task ${JSON.stringify(taskName)} ${task.status}`)}</summary>`,
      `  <guidance>${escapeXml(guidance)}</guidance>`,
      '</background-task-notification>',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      this.sendCompletionNotification(
        {
          customType: 'background-task-notification',
          content,
          display: true,
          details: snapshot(task),
        },
        { deliverAs: 'followUp', triggerTurn: task.triggerOnCompletion },
      );
    } catch (error) {
      task.notified = false;
      throw new Error(
        `Failed to send background task notification for ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async finalizeTask(
    task: BgTask,
    status: TaskStatus,
    exitCode: number | null,
    signal?: string | null,
    error?: string,
  ): Promise<void> {
    if (task.finalized) return;
    task.finalized = true;
    if (task.timeoutHandle) clearTimeout(task.timeoutHandle);
    if (task.killEscalationTimer !== undefined) {
      clearTimeout(task.killEscalationTimer);
      task.killEscalationTimer = undefined;
    }
    let finalStatus = status;
    let finalError = error;
    const forceFailure = await this.awaitWindowsForceBeforeTerminal(task);
    if (forceFailure !== undefined) {
      finalStatus = 'failed';
      finalError = BackgroundTaskRegistry.appendTaskError(finalError, forceFailure.message);
    }
    task.exitCode = exitCode;
    task.signal = signal ?? null;

    // Keep status="running" until the final wrapped-agent fragment has been
    // consumed and the output plus terminal metadata are durable. Publishing a
    // terminal state earlier lets bg_status observe the previous assistant
    // turn's context snapshot and recreates the same false-completion race the
    // attested producer is required to prevent.
    try {
      if (task.telemetryWrapped) {
        // Child-process close can be observed before the wrapper stdout listener has
        // committed its last parsed telemetry batch. Wait for a short quiet window,
        // then flush the trailing partial line, so completed status never races
        // ahead of the final assistant-turn context/token/tool snapshot.
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        this.flushAgentStdout(task);
      }
      if (task.stream && !task.stream.destroyed) await closeAndFsyncOutputStream(task.stream);
    } catch (finalizeError) {
      finalStatus = 'failed';
      const message =
        finalizeError instanceof Error ? finalizeError.message : String(finalizeError);
      finalError = finalError
        ? `${finalError}; final output durability failed: ${message}`
        : `Final output durability failed: ${message}`;
    }

    task.endTime = this.now();
    if (finalError) task.error = finalError;
    try {
      await this.writeMetadataSnapshot(task, { ...snapshot(task), status: finalStatus });
      task.status = finalStatus;
    } catch (metadataError) {
      finalStatus = 'failed';
      task.status = 'failed';
      task.error = `Terminal metadata write failed: ${metadataError instanceof Error ? metadataError.message : String(metadataError)}`;
      this.logger.error(
        `[background-tasks] failed to write metadata for ${task.id}:`,
        metadataError,
      );
      await this.writeMetadata(task).catch((retryError: unknown) => {
        this.logger.error(
          `[background-tasks] failed to write failed terminal metadata for ${task.id}:`,
          retryError,
        );
      });
    }

    for (const waiter of task.waiters.splice(0)) waiter();
    this.onChange();
    this.publishTerminal(task);
    let deliveryGateReady = true;
    if (task.terminalPublicationGate !== undefined) {
      try {
        await task.terminalPublicationGate;
      } catch (error) {
        deliveryGateReady = false;
        this.logger.error(
          `[background-tasks] completion delivery gate failed for ${task.id}:`,
          error,
        );
      }
    }
    if (deliveryGateReady) {
      try {
        this.notifyCompletion(task);
      } catch (notificationError) {
        this.logger.error(
          `[background-tasks] notification failed for ${task.id}:`,
          notificationError,
        );
      }
    }
    try {
      await this.writeMetadata(task);
    } catch (metadataError) {
      this.logger.error(
        `[background-tasks] failed to update notification metadata for ${task.id}:`,
        metadataError,
      );
    }
    this.pruneOldTasks();
  }

  private pruneOldTasks(): void {
    if (this.tasks.size <= this.maxRecentTasks) return;
    const removable = [...this.tasks.values()]
      .filter((task) => task.status !== 'running')
      .sort((a, b) => (a.endTime ?? a.startTime) - (b.endTime ?? b.startTime));
    while (this.tasks.size > this.maxRecentTasks && removable.length > 0) {
      const task = removable.shift();
      if (task) this.tasks.delete(task.id);
    }
  }
}
