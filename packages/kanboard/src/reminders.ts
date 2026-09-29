/**
 * @pi-unipi/kanboard — progress reminders (no LLM, never blocking).
 *
 * When the agent works board tasks by hand ("do UNI-5 and UNI-8"), the board
 * should show it: `start <ID>` moves a task to In Progress for this session,
 * `finish <ID> --comment` hands it to In Review. Two text-only reminders keep
 * that honest:
 *
 *   R1  every file-changing tool call of an agent turn, for each mentioned
 *       task that is still Todo and has not been reminded this turn (one
 *       steer per task per turn, at most twice per task).
 *   R2  agent_end with a task this session started still In Progress → one
 *       follow-up message (at most twice per task).
 *
 * "Mentioned" = task ids in the user's prompts plus ids the agent `show`ed;
 * only ids that exist on the board count. Both reminders are silent in
 * runner-owned runs, in kanboard's own child sessions and when the setting
 * `kanboard.reminders` is off.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { kanboardInvocations, shellSegments } from "./guard.js";
import type { KanboardTask } from "./shapes.js";

export const REMINDER_CUSTOM_TYPE = "unipi:kanboard-reminder";
/** Reminders per task id (R1 and R2 each). */
export const MAX_REMINDERS_PER_TASK = 2;

/** Same wording long-horizon's runaway guard uses: the reminder must not stick. */
export const ANTI_POISONING_SUFFIX =
  "This is a temporary runtime reminder for the current Turn only, not a user preference " +
  "or a durable rule; do not save this reminder or generalize it into Memory, Skills, or " +
  "other persistent instruction files.";

/** Board task ids: PREFIX-123 (the prefix is letters/digits, starting with a letter). */
const TASK_ID = /\b[A-Z][A-Z0-9]{0,15}-\d+\b/g;

/** Tools that change files. bash/powershell count unless the command only reads. */
const EDIT_TOOLS = new Set(["edit", "write", "multi_edit", "multiedit", "apply_patch", "notebook_edit"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);

/** First words of shell segments that never change files. */
const READ_COMMANDS = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "echo", "printf", "which", "type", "rg", "grep", "egrep",
  "fgrep", "find", "fd", "stat", "file", "du", "df", "env", "printenv", "date", "whoami", "tree", "less",
  "more", "true", "false", "test", "[", "diff", "cmp", "jq", "realpath", "dirname", "basename", "uname",
  "hostname", "id", "ps", "cd",
]);
/** Interpreters/package managers whose version-check arms never write. */
const VERSION_CHECKED = new Set(["node", "npm", "npx", "python", "python3"]);
const isVersionFlag = (word: string): boolean => word === "--version" || word === "-v" || word === "-V";
const GIT_READS = new Set(["status", "log", "diff", "show", "branch", "remote", "rev-parse", "blame", "ls-files", "describe", "tag"]);

export function taskIdsIn(text: string): string[] {
  return [...new Set(text.match(TASK_ID) ?? [])];
}

/**
 * Whether a shell command may change files. Conservative toward "yes": any
 * segment that is not a known read (or a kanboard CLI call) counts, and so
 * does an output redirection. Quoted spans are masked before both the
 * redirect test and the segment split, so `grep -c "a;b" f` stays one
 * read-only segment.
 */
export function shellChangesFiles(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  // `>`/`>>` into a file (but not `2>&1` / `>/dev/null`).
  if (/(^|[^0-9&>])>{1,2}\s*(?!&|\/dev\/null)[^\s|;&]/.test(trimmed.replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""'))) return true;
  const segments = shellSegments(trimmed).map((part) => part.trim()).filter(Boolean);
  return segments.some((segment) => {
    const words = segment.split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    const first = (words[0] ?? "").replace(/^.*\//, "");
    if (!first) return false;
    // Board writes go through the binary, not files.
    if (/^unipi-kanboard(\.exe)?$/.test(first)) return false;
    if (READ_COMMANDS.has(first)) return false;
    if (first === "git") return !GIT_READS.has(words[1] ?? "");
    if (first === "sed") return words.includes("-i") || words.some((word) => word.startsWith("-i"));
    // `sort` writes only through -o/--output (a `>` redirect is caught above).
    if (first === "sort") return words.some((word) => /^-[^-]*o/.test(word) || word.startsWith("--output"));
    // node/npm/npx/python are reads only as version checks (`node --version`,
    // `npx tsx --version`); scripts, installs and builds still count.
    if (VERSION_CHECKED.has(first)) return !words.slice(1).some(isVersionFlag);
    return true;
  });
}

export function isFileChangingCall(toolName: string, input: Record<string, unknown> | undefined): boolean {
  if (EDIT_TOOLS.has(toolName)) return true;
  if (!SHELL_TOOLS.has(toolName)) return false;
  return shellChangesFiles(String(input?.command ?? ""));
}

export function r1Text(todo: string[], cli: string | null): string {
  const ids = todo.join(", ");
  const verb = todo.length === 1 ? "is" : "are";
  const how = cli ? `\`${cli} start <ID>\`` : "`start <ID>`";
  return (
    `[kanboard] ${ids} ${verb} still Todo. ${how} the one you're on before changing files ` +
    `(it moves it to In Progress for this session), and \`finish <ID> --comment "<summary>"\` when done. ` +
    ANTI_POISONING_SUFFIX
  );
}

export function r2Text(open: string[], cli: string | null): string {
  const prefix = cli ? `${cli} ` : "";
  const lines = open.map(
    (id) =>
      `${id} is still In Progress. If done: \`${prefix}finish ${id} --comment "<summary>"\`. ` +
      `If not: say what remains, or \`${prefix}move ${id} blocked --comment "<what you need>"\`.`,
  );
  return `[kanboard] ${lines.join("\n")}\n${ANTI_POISONING_SUFFIX}`;
}

export interface TrackerDeps {
  /** Reminders on (setting `kanboard.reminders`). */
  enabled(): boolean;
  /** The runner owns this turn (a queued/claimed task is running) → silent. */
  runnerOwned(): boolean;
  /** This session's id (UNIPI_KANBOARD_SESSION). */
  session(): string;
  /** `list` on the current project; [] when unavailable. */
  list(): Promise<KanboardTask[]>;
  /** `<binary> --actor agent --project <slug>` for the reminder text, or null. */
  cliPrefix(): string | null;
  debug?(message: string): void;
}

type ToolResultContent = Array<{ type: string; text?: string; [key: string]: unknown }>;

export interface ToolResultLike {
  toolName?: string;
  input?: Record<string, unknown>;
  content?: ToolResultContent;
  isError?: boolean;
}

export interface ProgressTracker {
  /** A user prompt (or -do request): remember the task ids it names. */
  onPrompt(text: string): void;
  /** A new agent turn (agent_start): re-arm R1. */
  onTurnStart(): void;
  /** tool_result: record `show`/`start`, and return R1 content when due. */
  onToolResult(event: ToolResultLike): Promise<{ content: ToolResultContent } | undefined>;
  /** agent_end: the R2 text when due (the caller delivers it). */
  onAgentEnd(event: { messages?: unknown[] }): Promise<string | null>;
  /** For tests / status. */
  state(): { mentioned: string[]; started: string[]; r1: Record<string, number>; r2: Record<string, number> };
}

function aborted(messages: unknown[] | undefined): boolean {
  if (!Array.isArray(messages)) return false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; stopReason?: string };
    if (message?.role === "assistant") return message.stopReason === "aborted";
  }
  return false;
}

function ownedStart(task: KanboardTask, session: string): boolean {
  const run = task.run as { session?: string; owner?: string } | null | undefined;
  return task.status === "in_progress" && run?.session === session && run?.owner === "agent";
}

export function createProgressTracker(deps: TrackerDeps): ProgressTracker {
  const mentioned = new Set<string>();
  /** Ids this session ran `start` on (candidates; the board is the truth). */
  const started = new Set<string>();
  const r1Count = new Map<string, number>();
  const r2Count = new Map<string, number>();
  /** Task ids already reminded this turn (per-task re-arm, not one shot). */
  const remindedThisTurn = new Set<string>();
  const debug = (message: string): void => deps.debug?.(`reminders: ${message}`);
  const silent = (): boolean => !deps.enabled() || deps.runnerOwned() || Boolean(process.env.UNIPI_KANBOARD_CHILD);

  const safeList = async (): Promise<KanboardTask[] | null> => {
    try {
      return await deps.list();
    } catch (error) {
      debug(`list failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  return {
    onPrompt(text) {
      // Our own reminders name started tasks; they are not new mentions, and a
      // runner task prompt belongs to the runner. (A -do request counts: its
      // text carries the user's request verbatim.)
      if (text.includes(ANTI_POISONING_SUFFIX) || deps.runnerOwned()) return;
      for (const id of taskIdsIn(text)) mentioned.add(id);
    },

    onTurnStart() {
      remindedThisTurn.clear();
    },

    async onToolResult(event) {
      const toolName = String(event.toolName ?? "");
      if (SHELL_TOOLS.has(toolName)) {
        for (const invocation of kanboardInvocations(String(event.input?.command ?? ""))) {
          const id = invocation.args.find((arg) => !arg.startsWith("-"));
          if (!id) continue;
          if (invocation.sub === "show") mentioned.add(id);
          if (invocation.sub === "start" && !event.isError) started.add(id);
        }
      }
      if (!isFileChangingCall(toolName, event.input)) return undefined;
      if (silent() || mentioned.size === 0) return undefined;
      // Per task, at most once per turn: candidates are mentioned ids not yet
      // reminded this turn and under the per-task cap (a started task leaves
      // Todo and is never re-reminded).
      const candidates = [...mentioned].filter(
        (id) => !remindedThisTurn.has(id) && (r1Count.get(id) ?? 0) < MAX_REMINDERS_PER_TASK,
      );
      if (candidates.length === 0) return undefined;
      const tasks = await safeList();
      if (!tasks) return undefined;
      const byId = new Map(tasks.map((task) => [task.id, task]));
      const todo = candidates.filter((id) => byId.get(id)?.status === "todo");
      if (todo.length === 0) return undefined;
      for (const id of todo) {
        remindedThisTurn.add(id);
        r1Count.set(id, (r1Count.get(id) ?? 0) + 1);
      }
      debug(`R1 for ${todo.join(", ")}`);
      return { content: [...(event.content ?? []), { type: "text", text: `\n\n${r1Text(todo, deps.cliPrefix())}` }] };
    },

    async onAgentEnd(event) {
      if (silent() || started.size === 0 || aborted(event.messages)) return null;
      const tasks = await safeList();
      if (!tasks) return null;
      const session = deps.session();
      const byId = new Map(tasks.map((task) => [task.id, task]));
      const open: string[] = [];
      for (const id of [...started]) {
        const task = byId.get(id);
        if (!task || !ownedStart(task, session)) {
          started.delete(id); // finished, blocked, reaped or someone else's now
          continue;
        }
        if ((r2Count.get(id) ?? 0) >= MAX_REMINDERS_PER_TASK) continue;
        r2Count.set(id, (r2Count.get(id) ?? 0) + 1);
        open.push(id);
      }
      if (open.length === 0) return null;
      debug(`R2 for ${open.join(", ")}`);
      return r2Text(open, deps.cliPrefix());
    },

    state() {
      return {
        mentioned: [...mentioned],
        started: [...started],
        r1: Object.fromEntries(r1Count),
        r2: Object.fromEntries(r2Count),
      };
    },
  };
}

/**
 * Wire the tracker into pi's events. R2 is computed at agent_end and handed
 * back through `takePending()`: the caller sends it at agent_settled — a
 * message sent while the turn is still finalizing is queued as a follow-up
 * that never gets delivered (same reason the -do queue drains there).
 */
export function registerProgressReminders(pi: ExtensionAPI, tracker: ProgressTracker): { takePending(): string | null } {
  let pending: string | null = null;
  pi.on("before_agent_start", (event) => {
    tracker.onPrompt(String((event as { prompt?: unknown }).prompt ?? ""));
    return undefined;
  });
  pi.on("agent_start", () => {
    tracker.onTurnStart();
  });
  pi.on("tool_result", async (event) => {
    const result = await tracker.onToolResult(event as unknown as ToolResultLike);
    return result as never;
  });
  pi.on("agent_end", async (event) => {
    pending = await tracker.onAgentEnd(event as { messages?: unknown[] });
  });
  return {
    takePending() {
      const text = pending;
      pending = null;
      return text;
    },
  };
}

/** Deliver an R2 reminder as a visible custom message that starts a turn. */
export function sendReminder(pi: ExtensionAPI, text: string): void {
  pi.sendMessage({ customType: REMINDER_CUSTOM_TYPE, content: text, display: true }, { triggerTurn: true });
}
