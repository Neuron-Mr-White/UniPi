/**
 * @pi-unipi/background-tasks — Shared types & helpers
 *
 * Ported from pi-background-tasks src/core/common.ts. Conventions changed to
 * ours: storage under ~/.unipi/background-tasks/ + os.tmpdir()/unipi-bg-tasks-*,
 * env prefix UNIPI_BG_* (their PI_BG_*). Their update-check surface is dropped
 * (our updater module owns updates).
 *
 * ISC-licensed reference: Copyright Ismail <ismailsalikhodjaev@gmail.com>.
 */

import { statSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { BackgroundTaskChildProcess } from "./registry.js";
import type { FusionResultDetails, FusionUsage, FusionWorkflowId } from "./fusion/types.js";

export const TASK_STATUS_VALUES = ["running", "completed", "failed", "killed"] as const;
export const TERMINAL_TASK_STATUS_VALUES = ["completed", "failed", "killed"] as const;

export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];
export type TerminalTaskStatus = (typeof TERMINAL_TASK_STATUS_VALUES)[number];
export type KillKind = "user" | "timeout" | "output_cap" | "shutdown";

export type JsonObject = Readonly<Record<PropertyKey, unknown>>;

export interface TaskContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface TaskTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costTotal?: number;
}

export interface TaskToolUsage {
  total: number;
  failed: number;
  byName: Record<string, number>;
}

export interface BgTaskSnapshot {
  id: string;
  name?: string | undefined;
  command: string;
  description?: string | undefined;
  status: TaskStatus;
  outputPath: string;
  cwd: string;
  startTime: number;
  endTime?: number | undefined;
  exitCode?: number | null | undefined;
  signal?: string | null | undefined;
  pid?: number | undefined;
  bytesWritten: number;
  isAgent: boolean;
  error?: string | undefined;
  notified: boolean;
  notifyOnCompletion: boolean;
  triggerOnCompletion: boolean;
  timeoutSeconds?: number | undefined;
  contextUsage?: TaskContextUsage | undefined;
  tokenUsage?: TaskTokenUsage | undefined;
  toolUsage?: TaskToolUsage | undefined;
  model?: string | undefined;
  telemetryUnavailableReason?: string | undefined;
  attestationPath?: string | undefined;
  delegate?: DelegateTaskFacts | undefined;
  fusion?: FusionTaskFacts | undefined;
}

export interface AttestedPiTaskFiles {
  eventsPath: string;
  stderrPath: string;
  wrapperPath: string;
  attestationPath: string;
}

export interface AttestedPiTaskSnapshot extends BgTaskSnapshot {
  attestedPi?: AttestedPiTaskFiles | undefined;
}

/** Delegate-specific task facts surfaced through snapshots and `bg_result`. */
export interface DelegateTaskFacts {
  taskId: string;
  launchNonce: string;
  artifactDir: string;
  artifactDirAbs: string;
  seedSha256: string;
  childSessionId: string;
  route: { provider: string; model: string; qualifiedId: string };
  budget: DelegateBudgetRouteSource;
  extensionMode: DelegateExtensionMode;
  autoDeliver: "never" | "when_small" | "always";
  /** Set once the run reaches a terminal state and its result has been evaluated. */
  outcome?: DelegateTaskOutcome | undefined;
}

export interface DelegateTaskOutcome {
  status: "committed" | "failed" | "cancelled";
  errorCode?: string | undefined;
  answerBytes?: number | undefined;
  answerSha256?: number | string | undefined;
  turns?: number | undefined;
  toolCalls?: number | undefined;
}

/** Forward declarations satisfied by ./delegate/types.js (kept here to avoid cycles). */
export type DelegateBudgetRouteSource = import("./delegate/types.js").DelegateBudgetRouteSource;
export type DelegateExtensionMode = import("./delegate/types.js").DelegateExtensionMode;

/** Fusion-specific task facts surfaced through snapshots and `bg_result`. */
export interface FusionTaskFacts {
  runId: string;
  workflow: FusionWorkflowId;
  artifactDir: string;
  artifactDirAbs: string;
  state: string;
  outcome?: FusionTaskOutcome | undefined;
  /** Durable once-only accounting claim made by the first successful bg_result retrieval. */
  usageDelivered: boolean;
}

export interface FusionTaskOutcome {
  status: "committed" | "failed" | "cancelled";
  resultDetails?: FusionResultDetails | undefined;
  usage?: FusionUsage | undefined;
  error?: string | undefined;
}

export interface BgTask extends Omit<BgTaskSnapshot, "name"> {
  name: string;
  outputAbsPath: string;
  metadataAbsPath: string;
  eventsAbsPath?: string | undefined;
  stderrAbsPath?: string | undefined;
  wrapperAbsPath?: string | undefined;
  attestationAbsPath?: string | undefined;
  child?: BackgroundTaskChildProcess | undefined;
  stream?: WriteStream | undefined;
  timeoutHandle?: NodeJS.Timeout | undefined;
  killKind?: KillKind | undefined;
  killSignalSent?: boolean | undefined;
  killEscalationTimer?: NodeJS.Timeout | undefined;
  capExceeded?: boolean | undefined;
  finalized?: boolean | undefined;
  terminalPublished?: boolean | undefined;
  terminalPublishInFlight?: boolean | undefined;
  terminalPublishRetryHandle?: NodeJS.Timeout | undefined;
  /** Optional protocol barrier used by EventBus run requests so early child exits cannot publish before the run response is observable. */
  terminalPublicationGate?: Promise<void> | undefined;
  contextUsageBuffer?: string | undefined;
  /** True when this task launched a telemetry-wrapped Pi agent; its stdout carries control lines, not raw output. */
  telemetryWrapped?: boolean | undefined;
  /** Partial trailing stdout line held between chunks while reconstructing wrapped-agent control lines. */
  agentStdoutBuffer?: string | undefined;
  telemetryUnavailableReason?: string | undefined;
  attestationPath?: string | undefined;
  attestedPi?: AttestedPiTaskFiles | undefined;
  delegate?: DelegateTaskFacts | undefined;
  fusion?: FusionTaskFacts | undefined;
  /** Cancellation hook for an in-process managed task such as Fusion. */
  managedCancel?: (() => void) | undefined;
  managedCancelRequested?: boolean | undefined;
  managedStopWaitMs?: number | undefined;
  metadataWriteChain?: Promise<void> | undefined;
  waiters: Array<() => void>;
}

export type CompletionDeliveryMode =
  | "notification-and-wake"
  | "notification-only"
  | "manual-monitoring";

export interface CompletionDeliveryGuidance {
  readonly mode: CompletionDeliveryMode;
  readonly notificationEnabled: boolean;
  readonly automaticWakeEnabled: boolean;
  readonly text: string;
}

/**
 * Describe the actual parent-agent completion path for one bg_run launch.
 * A wake request cannot take effect without the notification that carries it.
 */
export function deriveCompletionDeliveryGuidance(
  notifyOnCompletion: boolean,
  triggerOnCompletion: boolean,
): CompletionDeliveryGuidance {
  if (notifyOnCompletion && triggerOnCompletion) {
    return {
      mode: "notification-and-wake",
      notificationEnabled: true,
      automaticWakeEnabled: true,
      text: [
        "Terminal notification: enabled.",
        "Automatic follow-up turn: enabled.",
        "Next action: do not poll or sleep merely to wait; continue only independent useful work, otherwise end this turn and wait for <background-task-notification>.",
      ].join("\n"),
    };
  }

  if (notifyOnCompletion) {
    return {
      mode: "notification-only",
      notificationEnabled: true,
      automaticWakeEnabled: false,
      text: [
        "Terminal notification: enabled.",
        "Automatic follow-up turn: disabled. The terminal notification will be delivered, but it will not start an agent turn.",
        "Next action: automatic wake-up was explicitly disabled; use bg_status/bg_logs only when deliberate monitoring is required, without tight polling.",
      ].join("\n"),
    };
  }

  return {
    mode: "manual-monitoring",
    notificationEnabled: false,
    automaticWakeEnabled: false,
    text: [
      "Terminal notification: disabled.",
      triggerOnCompletion
        ? "Automatic follow-up turn: disabled because terminal notifications are disabled. triggerOnCompletion has no effect while notifyOnCompletion is false."
        : "Automatic follow-up turn: disabled.",
      "Next action: completion delivery was explicitly disabled; use bg_status/bg_logs only for deliberate manual monitoring, without tight polling.",
    ].join("\n"),
  };
}

export interface BgRunDetails {
  task: BgTaskSnapshot;
}

export interface BgStatusDetails {
  tasks: BgTaskSnapshot[];
}

export interface BgLogsDetails {
  task: BgTaskSnapshot;
  path: string;
  bytesRead: number;
  truncated: boolean;
  tail: boolean;
}

export interface BgKillDetails {
  task: BgTaskSnapshot;
  message: string;
}

export interface StartTaskOptions {
  name?: string | undefined;
  description?: string | undefined;
  isAgent?: boolean | undefined;
  timeoutSeconds?: number | undefined;
  notifyOnCompletion?: boolean | undefined;
  triggerOnCompletion?: boolean | undefined;
  /** @internal EventBus protocol barrier; callers should not set this outside the extension service. */
  terminalPublicationGate?: Promise<void> | undefined;
}

/** Prepared managed launch handed to the registry after preflight has succeeded. */
export interface StartManagedTaskOptions {
  id: string;
  name: string;
  command: string;
  description?: string | undefined;
  isAgent: boolean;
  completion: Promise<void>;
  cancel: () => void;
  notifyOnCompletion: boolean;
  triggerOnCompletion: boolean;
  fusion: FusionTaskFacts;
  stopWaitMs?: number | undefined;
  /** Prevent terminal publication until the launch receipt handoff is observable. */
  terminalPublicationGate?: Promise<void> | undefined;
}

export interface StartDelegateTaskOptions {
  name: string;
  argv: readonly string[];
  /** Prompt bytes delivered over stdin, never as a shell or positional argument. */
  stdinBytes: Buffer;
  env: NodeJS.ProcessEnv;
  facts: DelegateTaskFacts;
  notifyOnCompletion: boolean;
  triggerOnCompletion: boolean;
  timeoutSeconds?: number | undefined;
}

export interface StartAttestedPiTaskOptions {
  name: string;
  provider: string;
  model: string;
  prompt: string;
  reportPath: string;
  extraPiArgs?: string[] | undefined;
  thinking?: string | undefined;
  timeoutSeconds?: number | undefined;
}

/** Default tool-output byte cap (mirrors pi's DEFAULT_MAX_BYTES). */
export const DEFAULT_MAX_BYTES = 30 * 1024;

export const DEFAULT_LOG_BYTES = Math.min(DEFAULT_MAX_BYTES, 50 * 1024);
export const MAX_LOG_BYTES = Math.min(DEFAULT_MAX_BYTES, 50 * 1024);
export const COMMAND_PREVIEW_CHARS = 90;

// ── Our storage roots (convention: ~/.unipi + os.tmpdir, never .pi/) ────────

/** Durable state root: ~/.unipi/background-tasks/<project-hash>/<session-id>-<pid>/ */
export function bgStateRoot(projectHash: string): string {
  return join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".unipi", "background-tasks", projectHash);
}

/** Runtime artifact root under our temp dir: os.tmpdir()/unipi-bg-tasks-<scope>/ */
export function bgTempRoot(scope: string): string {
  return join(process.env.UNIPI_BG_TMP_DIR ?? (process.env.TMPDIR ?? "/tmp"), `unipi-bg-tasks-${scope}`);
}

const parseJsonValue: (text: string) => unknown = globalThis.JSON.parse;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

export function parseJsonText(text: string): unknown {
  return parseJsonValue(text);
}

export function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "session";
}

export function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function truncateChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function normalizeTaskName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = compactWhitespace(stripMatchingQuotes(value));
  if (!normalized) return undefined;
  return truncateChars(normalized, 80);
}

export function deriveTaskNameFromCommand(command: string): string {
  const normalized = compactWhitespace(stripMatchingQuotes(command));
  if (!normalized) return "Background task";

  const packageScript = /^(npm|pnpm|yarn|bun)\s+(?:(run)\s+)?([^\s;&|]+)/.exec(normalized);
  if (packageScript) {
    const runner = packageScript[1] ?? "npm";
    const run = packageScript[2] !== undefined ? " run" : "";
    const script = packageScript[3] ?? "";
    return truncateChars(`${runner}${run} ${script}`, 48);
  }

  const words = normalized.split(/\s+/).slice(0, 5).join(" ");
  return truncateChars(words.length > 0 ? words : normalized, 48);
}

export function taskDisplayName(task: {
  name?: string | undefined;
  description?: string | undefined;
  command?: string | undefined;
  id?: string | undefined;
}): string {
  const commandName =
    task.command && task.command.length > 0 ? deriveTaskNameFromCommand(task.command) : undefined;
  return (
    normalizeTaskName(task.name) ??
    normalizeTaskName(task.description) ??
    commandName ??
    task.id ??
    "Background task"
  );
}

function parseNameValueAndRest(valueAndRest: string): { value: string; rest: string } | undefined {
  const input = valueAndRest.trimStart();
  if (!input) return undefined;
  const quote = input[0];
  if (quote === '"' || quote === "'") {
    let escaped = false;
    let value = "";
    for (let i = 1; i < input.length; i++) {
      const char = input.charAt(i);
      if (escaped) {
        value += char;
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        return { value, rest: input.slice(i + 1).trimStart() };
      }
      value += char;
    }
    return undefined;
  }
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(input);
  if (!match) return undefined;
  const parsedValue = match[1];
  if (parsedValue === undefined) return undefined;
  return { value: parsedValue, rest: match[2]?.trimStart() ?? "" };
}

export function parseBgCommandArgs(args: string): {
  name?: string;
  command: string;
  isAgent: boolean;
} {
  let input = args.trim();
  let name: string | undefined;
  let isAgent = false;

  while (input) {
    let consumed = false;
    for (const prefix of ["--name=", "-n="]) {
      if (input.startsWith(prefix)) {
        const parsed = parseNameValueAndRest(input.slice(prefix.length));
        if (!parsed) throw new Error(`${prefix.slice(0, -1)} requires a task name`);
        name = normalizeTaskName(parsed.value);
        input = parsed.rest;
        consumed = true;
        break;
      }
    }
    if (consumed) continue;

    for (const prefix of ["--name", "-n"]) {
      if (input === prefix || input.startsWith(`${prefix} `) || input.startsWith(`${prefix}\t`)) {
        const parsed = parseNameValueAndRest(input.slice(prefix.length));
        if (!parsed) throw new Error(`${prefix} requires a task name`);
        name = normalizeTaskName(parsed.value);
        input = parsed.rest;
        consumed = true;
        break;
      }
    }
    if (consumed) continue;

    for (const flag of ["--agent", "--llm-agent"]) {
      if (input === flag || input.startsWith(`${flag} `) || input.startsWith(`${flag}\t`)) {
        isAgent = true;
        input = input.slice(flag.length).trimStart();
        consumed = true;
        break;
      }
    }
    if (consumed) continue;

    for (const flag of ["--script", "--no-agent"]) {
      if (input === flag || input.startsWith(`${flag} `) || input.startsWith(`${flag}\t`)) {
        isAgent = false;
        input = input.slice(flag.length).trimStart();
        consumed = true;
        break;
      }
    }
    if (consumed) continue;

    if (input === "--") {
      input = "";
      break;
    }
    if (input.startsWith("-- ")) {
      input = input.slice(3).trimStart();
      break;
    }
    break;
  }

  return name ? { name, command: input, isAgent } : { command: input, isAgent };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return `${String(minutes)}m${remSeconds > 0 ? `${String(remSeconds)}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${String(hours)}h${remMinutes > 0 ? `${String(remMinutes)}m` : ""}`;
}

export function formatCompactNumber(count: number): string {
  const normalized = Math.max(0, Math.floor(count));
  if (normalized < 1000) return normalized.toString();
  if (normalized < 10000) return `${(normalized / 1000).toFixed(1)}k`;
  if (normalized < 1000000) return `${String(Math.round(normalized / 1000))}k`;
  if (normalized < 10000000) return `${(normalized / 1000000).toFixed(1)}M`;
  return `${String(Math.round(normalized / 1000000))}M`;
}

export function formatContextUsageSummary(usage?: TaskContextUsage): string | undefined {
  if (usage?.contextWindow === undefined || usage.contextWindow <= 0) return undefined;
  const window = formatCompactNumber(usage.contextWindow);
  if (usage.percent === null || usage.tokens === null) return `ctx=?/${window}`;
  return `ctx=${usage.percent.toFixed(1)}%/${window}`;
}

export function formatTokenUsageSummary(usage?: TaskTokenUsage): string | undefined {
  if (!usage || usage.totalTokens <= 0) return undefined;
  return `tokens=${formatCompactNumber(usage.totalTokens)}`;
}

export function formatToolUsageSummary(usage?: TaskToolUsage): string | undefined {
  if (!usage || (usage.total <= 0 && usage.failed <= 0)) return undefined;
  const failed = usage.failed > 0 ? ` failed=${String(usage.failed)}` : "";
  return `tools=${String(usage.total)}${failed}`;
}

export function formatModelSummary(model?: string): string | undefined {
  if (!model) return undefined;
  return `model=${model}`;
}

/**
 * Human-readable activity transcript for telemetry-wrapped Pi agents.
 *
 * The wrapper emits one `background-task-activity` control line per meaningful
 * child-agent event (assistant text, reasoning, tool start, tool end) so the
 * registry can render "what the agent is actually doing" into the task output
 * file instead of leaking raw telemetry JSON. Both the parser and the formatter
 * are pure so the visible transcript is fully unit-testable.
 */
export const AGENT_ACTIVITY_TYPE = "background-task-activity";
const AGENT_ACTIVITY_DETAIL_MAX = 80;

export type AgentActivity =
  | { kind: "assistant_text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_start"; tool: string; argsSummary: string }
  | { kind: "tool_end"; tool: string; isError: boolean; error?: string };

interface AgentActivityPayload extends JsonObject {
  readonly type?: unknown;
  readonly kind?: unknown;
  readonly text?: unknown;
  readonly tool?: unknown;
  readonly argsSummary?: unknown;
  readonly isError?: unknown;
  readonly error?: unknown;
}

function readActivityString(
  record: AgentActivityPayload,
  key: "text" | "tool" | "argsSummary" | "error",
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/** Narrow a parsed `background-task-activity` control payload into a typed {@link AgentActivity}. */
export function parseAgentActivity(payload: unknown): AgentActivity | undefined {
  if (!isJsonObject(payload)) return undefined;
  const record: AgentActivityPayload = payload;
  if (record.type !== AGENT_ACTIVITY_TYPE) return undefined;
  const kind = record.kind;
  if (kind === "assistant_text" || kind === "reasoning") {
    const text = readActivityString(record, "text");
    if (typeof text !== "string") return undefined;
    return { kind, text: truncateChars(text, AGENT_ACTIVITY_DETAIL_MAX) };
  }
  if (kind === "tool_start") {
    const tool = readActivityString(record, "tool");
    if (typeof tool !== "string") return undefined;
    return {
      kind,
      tool,
      argsSummary: truncateChars(readActivityString(record, "argsSummary") ?? "", AGENT_ACTIVITY_DETAIL_MAX),
    };
  }
  if (kind === "tool_end") {
    const tool = readActivityString(record, "tool");
    if (typeof tool !== "string") return undefined;
    const isError = record.isError === true;
    const error = readActivityString(record, "error");
    return {
      kind,
      tool,
      isError,
      error: isError && error !== undefined ? truncateChars(error, AGENT_ACTIVITY_DETAIL_MAX) : undefined,
    };
  }
  return undefined;
}

/** Format one activity event into its human transcript line. */
export function formatAgentActivity(activity: AgentActivity): string {
  switch (activity.kind) {
    case "assistant_text":
      return `assistant: ${activity.text}`;
    case "reasoning":
      return `reasoning: ${activity.text}`;
    case "tool_start":
      return `tool ${activity.tool}: ${activity.argsSummary}`;
    case "tool_end":
      return activity.isError ? `tool ${activity.tool}: error${activity.error ? ` — ${activity.error}` : ""}` : `tool ${activity.tool}: done`;
  }
}

/** statSync-based file size probe; undefined when the file does not exist. */
export function fileSizeOrNull(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}
