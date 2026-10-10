/**
 * The app bridge: lets the UniPi phone app mirror this pi session live and
 * talk to it (unipi-app docs/m5/PROTOCOL.md).
 *
 * - TUI mode only. Listens on ~/.unipi/bridge/<pid>.sock (0600) and keeps
 *   ~/.unipi/bridge/<pid>.json current so unipi-host can match a herdr pane
 *   (whose pi session file it knows) to this socket.
 * - Every hook body is try/catch: the bridge must never break a turn.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve as resolvePath } from "node:path";
import { DialogHub, wrapUi } from "./dialogs.js";
import { ENTRIES_BUDGET, HELLO_ENTRIES_BUDGET, LINE_BUDGET, fitLine, historyPage, jsonBytes, phoneSafe, snapshotEntries, clipText, wantedEntry } from "./snapshot.js";
import {
  BRIDGE_PROTOCOL,
  LineSplitter,
  parseIn,
  type CommandInfo,
  type Dialog,
  type FusionPresetInfo,
  type FusionStatusInfo,
  type InMsg,
  type InfoGroupInfo,
  type ModelInfo,
  type OutMsg,
  type Queued,
  type RunState,
  type SessionInfo,
  type SessionsItem,
  type StatsInfo,
  type TreeNode,
  type WorkItemInfo,
} from "./wire.js";
import { setRemoteDialogs } from "./remote.js";
import { fileSuggestions } from "./files.js";
import { statPaths } from "./paths.js";
import { registerPath, resolveMedia } from "./media.js";
import { listWorkItems, stopWorkItem, backgroundWorkItem, workLogPage } from "./work.js";
import { bus, pendingWorkLabel, subscribePendingWork, UNIPI_EVENTS } from "@pi-unipi/core";
import type { BtwListPage } from "./wire.js";

/** `media_chunk.data` (base64) stays well under the 900 KiB bridge line
 * budget; 700 KB of base64 chars per chunk leaves slack for the envelope. */
const MEDIA_CHUNK_CHARS = 700 * 1024;

/** @pi-unipi/btw's UI-free API, read lazily off globalThis (the bridge never
 * imports @pi-unipi/btw directly: btw may not be installed). See btw.ts
 * publishUiFreeApi()/getBtwApi(). */
type BtwEvent =
  | { type: "delta"; kind: "text" | "thinking" | "tool"; text: string; index?: number }
  | { type: "end"; answer: string; error?: string; usage?: { input: number; output: number; totalTokens: number } };
interface BtwApi {
  ask(cctx: ExtensionCommandContext, question: string, onEvent: (event: BtwEvent) => void): { id: string; finished: Promise<void> };
  /** Newer btw also sends `id`, `done`/`running`, `toolLines`, `thinking` (UNI-219). */
  list(): BtwListPage[];
}
const BTW_API_KEY = Symbol.for("unipi.btw.api");
const getBtwApi = (): BtwApi | undefined => (globalThis as unknown as Record<symbol, unknown>)[BTW_API_KEY] as BtwApi | undefined;

/** @pi-unipi/fusion's UI-free API (UNI-160 §1 Model), read lazily off
 * globalThis the same way — see fusion/src/api.ts publishFusionApi(). */
interface FusionApiModel {
  key: string;
  name: string;
}
interface FusionApiPicker {
  leads: FusionApiModel[];
  sidekicks: FusionApiModel[];
  curated?: FusionApiModel[];
  default: { lead?: string; sidekick?: string };
  effort: Record<string, string>;
  active:
    | { kind: "single"; model: string }
    | { kind: "fusion"; lead: string; sidekick: string; leadEffort?: string; sidekickEffort?: string }
    | undefined;
}
type FusionPickerResult =
  | { type: "single"; model: string; effort: string; effortMap: Record<string, string> }
  | { type: "fusion"; lead: string; sidekick: string; leadEffort: string; sidekickEffort: string; effortMap: Record<string, string> }
  | { type: "cancelled" };
interface FusionApi {
  getPicker(): FusionApiPicker | undefined;
  apply(result: FusionPickerResult): Promise<{ ok: true } | { ok: false; message: string }>;
}
const FUSION_API_KEY = Symbol.for("unipi.fusion.api");
const getFusionApi = (): FusionApi | undefined => (globalThis as unknown as Record<symbol, unknown>)[FUSION_API_KEY] as FusionApi | undefined;

/** `globalThis.__unipi_info_registry` (@pi-unipi/info-screen's registry.ts),
 * read lazily the same way — info-screen may not be installed. */
interface InfoRegistryLike {
  getAllGroups(): Array<{ id: string; name: string; config?: { stats: Array<{ id: string; label: string; show: boolean }> } }>;
  getGroupData(groupId: string): Promise<Record<string, { value: string; detail?: string }>>;
  getVisibleStats(groupId: string): Array<{ id: string; label: string }>;
}
const getInfoRegistry = (): InfoRegistryLike | undefined =>
  (globalThis as unknown as { __unipi_info_registry?: InfoRegistryLike }).__unipi_info_registry;

/** @pi-unipi/footer's shared TpsTracker (see footer/src/tps-shared.ts), read
 * lazily the same way — footer may not be installed. */
interface TpsTrackerLike {
  getSessionAvgTps(): number;
}
const FOOTER_TPS_KEY = Symbol.for("unipi.footer.shared-tps");
const getSharedTps = (): TpsTrackerLike | undefined => (globalThis as unknown as Record<symbol, unknown>)[FOOTER_TPS_KEY] as TpsTrackerLike | undefined;

export const BRIDGE_VERSION = "1.0.0";

/** The hidden extension command the bridge uses to get a command-capable
 * context (newSession/fork/navigateTree/switchSession only exist there). */
export const SESSION_COMMAND = "unipi-app-session";

/** UNI-221: after pending work clears while idle, how long the bridge waits
 * for the wake turn before marking the session "needs you" (finished). */
export const PENDING_CLEAR_GRACE_MS = Number(process.env.UNIPI_BRIDGE_PENDING_GRACE_MS) || 3000;

/** Commands the app maps to bridge calls (pi's built-ins can't be sent as text). */
const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: "model", description: "Switch the model", source: "builtin" },
  { name: "thinking", description: "Set the thinking level", source: "builtin" },
  { name: "compact", description: "Compact the conversation", source: "builtin" },
  { name: "new", description: "Start a new session", source: "builtin" },
  { name: "resume", description: "Resume a session", source: "builtin" },
  { name: "fork", description: "Fork the session from a message", source: "builtin" },
  { name: "tree", description: "Browse the session tree", source: "builtin" },
];

/** A short, phone-sized preview of a session entry (tree / resume rows). */
function entryPreview(entry: unknown, max = 120): string {
  const e = entry as { type?: string; message?: { role?: string; content?: unknown }; summary?: string; customType?: string; content?: unknown; provider?: string; modelId?: string } | null;
  if (!e) return "";
  let text = "";
  if (e.type === "message") text = textOfContent(e.message?.content);
  else if (e.type === "compaction" || e.type === "branch_summary") text = e.summary ?? "";
  else if (e.type === "custom_message") text = textOfContent(e.content);
  else if (e.type === "model_change") text = `model → ${e.provider ?? ""}/${e.modelId ?? ""}`;
  else text = e.customType ?? e.type ?? "";
  text = text.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function bridgeDir(): string {
  return process.env.UNIPI_BRIDGE_DIR || join(homedir(), ".unipi", "bridge");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Removes records/sockets of dead pids (crashes leave them behind). */
export function sweepDead(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const m = /^(\d+)\.(json|sock)$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid !== process.pid && !alive(pid)) rmSync(join(dir, name), { force: true });
  }
}

/** Whether `path` is inside `cwd` (or equal to it), after resolving both
 * to absolute paths (so a relative `path`, or one with `.`/`..` segments,
 * is judged by where it actually points — not its spelling). No symlink
 * resolution; good enough to stop the phone naming arbitrary host files
 * via `file_share` (it only ever offers paths it already saw in-session). */
export function isInsideCwd(path: string, cwd: string): boolean {
  const root = resolvePath(cwd);
  const target = resolvePath(root, path);
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

const textOfContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: string; text: string } => !!p && (p as { type?: string }).type === "text" && typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text)
    .join("");
};

/** Test seam: SessionManager.list/listAll do real disk IO; fakes inject their own. */
export interface BridgeDeps {
  listSessions: typeof SessionManager.list;
  listAllSessions: typeof SessionManager.listAll;
}
const defaultDeps: BridgeDeps = { listSessions: SessionManager.list, listAllSessions: SessionManager.listAll as typeof SessionManager.listAll };

export function createBridge(pi: ExtensionAPI, deps: BridgeDeps = defaultDeps) {
  let ctx: ExtensionContext | undefined;
  let server: Server | undefined;
  let socketPath: string | undefined;
  const clients = new Set<Socket>();
  let running = false;
  /** pi's own queue (steer/follow-up from ANY source — TUI keybindings, the
   * harness, an extension's `pi.sendUserMessage({deliverAs})`), mirrored from
   * the `input` event's `streamingBehavior`. UNI-202: editable/removable/
   * promotable from the phone too, even though the bridge can't reach pi's
   * live queue array directly — an edit/remove/promote on one of these
   * aborts the run (same effect as the TUI's Stop) and re-sends what's left
   * via `pi.sendUserMessage`, same as the TUI's own dequeue-and-resend. */
  const tuiQueue: Array<{ id: string; text: string; mode: "steer" | "followUp"; images?: Array<{ mime: string; data: string } | { mime: string; path: string }> }> = [];
  /** The bridge's own queue ("after it ends"): phone-only, editable/removable/reorderable/promotable,
   * delivered one at a time on `agent_end`. Survives phone reconnects (sent in `hello`), not a pi restart. */
  type BridgeQueued = { id: string; text: string; images?: Array<{ mime: string; data: string } | { mime: string; path: string }>; retry?: boolean };
  const bridgeQueue: BridgeQueued[] = [];
  let queueSeq = 0;
  const nextQueueId = () => `q${process.pid}-${++queueSeq}`;
  /** Every queue row the phone sees: TUI items first (oldest-submitted order), then bridge items —
   * every row editable/removable/promotable now (UNI-202). */
  const queueView = (): Queued[] => [
    ...tuiQueue.map((q) => ({ id: q.id, text: q.text, mode: q.mode, source: "tui" as const, editable: true })),
    ...bridgeQueue.map((q) => ({ id: q.id, text: q.text, mode: "after" as const, source: "phone" as const, editable: true })),
  ];
  /** Phone prompts handed to pi, waiting for their `input` event (matched by the exact text pi saw). */
  const phoneInputs: Array<{ ref?: string; text: string; at: number }> = [];
  /** The assistant message streaming now (for late joiners). */
  let streaming: { id: string; content: unknown[] } | undefined;
  let streamSeq = 0;
  const tools = new Map<string, { callId: string; name: string; args: unknown; text?: string }>();
  /** Coalesced deltas: key `${kind}:${index}` → text. */
  let pendingDeltas: Array<{ kind: "text" | "thinking" | "toolcall"; index: number; text: string }> = [];
  let deltaTimer: NodeJS.Timeout | undefined;
  const toolTimers = new Map<string, NodeJS.Timeout>();
  let sessionCost = 0;
  /** "Needs you" (UNI-161): an open dialog, or idle right after an
   * `agent_end` no phone has seen yet. Written into the discovery record so
   * the host's `chat_list` (crates/host/src/chat.rs) can float it to the top
   * without a live socket connection. A dialog takes priority over a bare
   * idle-since-agent_end (it's the more specific, answerable thing). Cleared
   * once every open dialog closes / a phone client connects (it's seen the end). */
  let dialogWaiting: { kind: string; title?: string; since: number } | undefined;
  let idleWaitingSince: number | undefined;
  const effectiveWaiting = () => dialogWaiting ?? (idleWaitingSince ? { kind: "agent_end", since: idleWaitingSince } : undefined);
  /** Sockets that asked `watch{stats:true}` / `watch{info:true}` (UNI-160 §3/§5):
   * stats/info pushes only run while at least one client wants them, ≤1/s. */
  const statsWatchers = new Set<Socket>();
  const infoWatchers = new Set<Socket>();
  let lastWorkJson = "";
  let workTimer: NodeJS.Timeout | undefined;
  let pushTicker: NodeJS.Timeout | undefined;

  /** A dialog's "waiting" title: the ask_user header/question, or the
   * select/confirm/input/editor title — whatever the phone shows first. */
  const dialogWaitingTitle = (dialog: Dialog): string | undefined => {
    if (dialog.kind === "ask_user") {
      const qs = (dialog.questions ?? []) as Array<{ header?: string; question?: string }>;
      return qs[0]?.header || qs[0]?.question || dialog.title;
    }
    return dialog.title;
  };

  const hub = new DialogHub({
    open: (dialog) => {
      dialogWaiting = { kind: dialog.kind, title: dialogWaitingTitle(dialog), since: Date.now() };
      writeRecord();
      send({ t: "dialog", ...dialog });
    },
    close: (id, by) => {
      // DialogHub deletes the closing entry from `pending` before calling
      // this, so an empty list here means no dialog is left open.
      if (hub.list().length === 0) dialogWaiting = undefined;
      writeRecord();
      send({ t: "dialog_end", id, by });
    },
  });

  /** The hidden `unipi-app-session` command runs this once, with a real
   * ExtensionCommandContext, then clears it. See runCommandOp(). */
  // A FIFO, not a single slot: two requests in the same tick (e.g. two
  // `btw` lines in one chunk) each send the hidden command once, and each
  // handler run takes the oldest op. A single slot let the second request
  // overwrite the first, whose promise then never settled (UNI-219).
  const pendingOps: Array<(cctx: ExtensionCommandContext) => Promise<void>> = [];
  pi.registerCommand(SESSION_COMMAND, {
    description: "Internal: runs a UniPi app session-navigation request. Not for direct use.",
    handler: async (_args: string, cctx: ExtensionCommandContext) => {
      const op = pendingOps.shift();
      if (op) await op(cctx);
    },
  });

  /** Runs `op` with a command-capable context, via the hidden command (the
   * only way to reach newSession/fork/navigateTree/switchSession). Only one
   * can be in flight; callers only run this while pi is idle. */
  const runCommandOp = (op: (cctx: ExtensionCommandContext) => Promise<void>): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const entry = async (cctx: ExtensionCommandContext) => {
        try {
          await op(cctx);
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      pendingOps.push(entry);
      try {
        pi.sendUserMessage(`/${SESSION_COMMAND}`, { expandPromptTemplates: true });
      } catch (error) {
        const i = pendingOps.indexOf(entry);
        if (i >= 0) pendingOps.splice(i, 1);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

  /** new/resume/fork/tree_go while pi is busy: `force` aborts and waits for idle first. */
  const ensureIdle = async (force: boolean | undefined): Promise<boolean> => {
    if (!ctx) return false;
    if (ctx.isIdle()) return true;
    if (!force) return false;
    ctx.abort();
    const deadline = Date.now() + 10_000;
    while (!ctx.isIdle() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    return ctx.isIdle();
  };

  const write = (sock: Socket, msg: OutMsg | object) => {
    try {
      if (!sock.destroyed) sock.write(fitLine(msg) + "\n");
    } catch {
      // A broken client never matters to pi.
    }
  };
  function send(msg: OutMsg) {
    if (clients.size === 0) return;
    if (msg.t !== "delta") flushDeltas();
    const line = fitLine(msg) + "\n";
    for (const sock of clients) {
      try {
        if (!sock.destroyed) sock.write(line);
      } catch {
        // ignore
      }
    }
  }

  function flushDeltas() {
    if (deltaTimer) {
      clearTimeout(deltaTimer);
      deltaTimer = undefined;
    }
    if (!pendingDeltas.length || !streaming) {
      pendingDeltas = [];
      return;
    }
    const batch = pendingDeltas;
    pendingDeltas = [];
    const id = streaming.id;
    for (const d of batch) {
      const line = fitLine({ t: "delta", id, kind: d.kind, index: d.index, text: d.text }) + "\n";
      for (const sock of clients) if (!sock.destroyed) sock.write(line);
    }
  }

  function pushDelta(kind: "text" | "thinking" | "toolcall", index: number, text: string) {
    if (clients.size === 0 || !text) return;
    const last = pendingDeltas[pendingDeltas.length - 1];
    if (last && last.kind === kind && last.index === index) last.text += text;
    else pendingDeltas.push({ kind, index, text });
    if (!deltaTimer) deltaTimer = setTimeout(flushDeltas, 50);
  }

  const sessionInfo = (): SessionInfo => {
    const sm = ctx!.sessionManager;
    return { file: sm.getSessionFile(), id: sm.getSessionId(), name: pi.getSessionName() ?? undefined, cwd: ctx!.cwd };
  };

  const modelInfo = (m: { provider: string; id: string; name?: string; reasoning?: boolean } | undefined): ModelInfo | undefined =>
    m ? { provider: m.provider, id: m.id, name: m.name, reasoning: !!m.reasoning } : undefined;

  const thinkingLevels = (m: { reasoning?: boolean } | undefined): string[] =>
    m?.reasoning ? ["off", "minimal", "low", "medium", "high", "xhigh"] : ["off"];

  const runState = (): RunState => {
    const c = ctx!;
    let context: RunState["context"];
    try {
      const u = c.getContextUsage();
      if (u) context = { tokens: u.tokens ?? null, window: u.contextWindow, percent: u.percent ?? null };
    } catch {
      // ignore
    }
    // UNI-162: while pi looks idle but a wait source still has a reason (a
    // background subagent, a bg wake, a fusion handoff), say so instead of
    // reporting a plain idle state — same label the footer's "waiting on
    // …" line shows.
    let waiting: string | undefined;
    if (!running) {
      try {
        waiting = pendingWorkLabel() ?? undefined;
      } catch {
        // ignore — waiting is cosmetic
      }
    }
    return {
      running,
      model: modelInfo(c.model),
      thinking: pi.getThinkingLevel(),
      thinkingLevels: thinkingLevels(c.model),
      context,
      cost: Math.round(sessionCost * 10000) / 10000,
      ...(waiting !== undefined ? { waiting } : {}),
    };
  };

  const computeCost = () => {
    sessionCost = 0;
    try {
      for (const e of ctx!.sessionManager.getEntries() as Array<{ type?: string; message?: { role?: string; usage?: { cost?: { total?: number } } } }>) {
        if (e.type === "message" && e.message?.role === "assistant") sessionCost += e.message.usage?.cost?.total ?? 0;
      }
    } catch {
      // ignore
    }
  };

  /** Context + cost + tps snapshot (UNI-160 §3): tokens in/out and cache hit
   * summed over the branch's assistant usage; tps read off the shared
   * footer tracker when the module is installed (0 otherwise). */
  const buildStats = (): StatsInfo => {
    let tokensIn = 0;
    let tokensOut = 0;
    let cacheHit = 0;
    try {
      for (const e of ctx!.sessionManager.getEntries() as Array<{ type?: string; message?: { role?: string; usage?: { input?: number; output?: number; cacheRead?: number } } }>) {
        if (e.type !== "message" || e.message?.role !== "assistant") continue;
        const u = e.message.usage;
        tokensIn += u?.input ?? 0;
        tokensOut += u?.output ?? 0;
        cacheHit += u?.cacheRead ?? 0;
      }
    } catch {
      // ignore
    }
    const state = runState();
    let tps = 0;
    try {
      tps = getSharedTps()?.getSessionAvgTps() ?? 0;
    } catch {
      // footer not installed
    }
    return { context: state.context, tokensIn, tokensOut, cacheHit, cost: state.cost ?? 0, tps: Math.round(tps * 10) / 10 };
  };

  /** Fusion's preset, phone-shaped (hello.fusion / future set_fusion replies).
   * `undefined` when the Fusion package isn't installed. */
  const fusionPreset = (): FusionPresetInfo | undefined => {
    const picker = getFusionApi()?.getPicker();
    if (!picker) return undefined;
    return { leads: picker.leads, sidekicks: picker.sidekicks, curated: picker.curated, default: picker.default, effort: picker.effort, active: picker.active };
  };

  /** A `state` push carrying the Fusion preset (its `active` selection)
   * when Fusion is installed; no `fusion` key otherwise (the phone reads a
   * missing key as "unchanged"). */
  const stateWithFusion = () => {
    const fusion = fusionPreset();
    send({ t: "state", ...runState(), ...(fusion ? { fusion } : {}) } as OutMsg);
  };

  const workItems = (): WorkItemInfo[] => {
    try {
      return listWorkItems();
    } catch {
      return [];
    }
  };

  /** /unipi:info groups, phone-shaped (UNI-160 §5): a card's title + its
   * visible stat rows (label/value), no TUI rendering. Capped so an info
   * module with a huge raw payload can't blow the line budget. */
  const infoGroups = async (): Promise<InfoGroupInfo[]> => {
    const registry = getInfoRegistry();
    if (!registry) return [];
    const groups = registry.getAllGroups();
    const out: InfoGroupInfo[] = [];
    for (const g of groups.slice(0, 40)) {
      try {
        const data = await registry.getGroupData(g.id);
        const visible = registry.getVisibleStats(g.id);
        const stats = (visible.length ? visible : Object.keys(data).map((id) => ({ id, label: id })))
          .map((s) => ({ label: s.label, value: clipText(data[s.id]?.value ?? "", 200) }))
          .filter((s) => s.value)
          .slice(0, 24);
        if (stats.length) out.push({ id: g.id, label: g.name, stats });
      } catch {
        // One group's provider failing never blocks the others.
      }
    }
    return out;
  };

  /** Schedules a throttled push (≤1/s) to every socket in `watchers`, de-duped
   * by a JSON snapshot of the last sent payload. */
  const schedulePush = (
    watchers: Set<Socket>,
    timerRef: { current: NodeJS.Timeout | undefined },
    build: () => Promise<OutMsg> | OutMsg,
    lastRef: { current: string },
  ) => {
    if (watchers.size === 0 || timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      void (async () => {
        if (watchers.size === 0) return;
        try {
          const msg = await build();
          const json = JSON.stringify(msg);
          if (json === lastRef.current) return;
          lastRef.current = json;
          for (const sock of watchers) write(sock, msg);
        } catch {
          // A push failing once never breaks the connection.
        }
      })();
    }, 1000);
  };

  const statsTimerRef = { current: undefined as NodeJS.Timeout | undefined };
  const infoTimerRef = { current: undefined as NodeJS.Timeout | undefined };
  const lastStatsJson = { current: "" };
  const lastInfoJson = { current: "" };
  const pushStats = () => schedulePush(statsWatchers, statsTimerRef, () => ({ t: "stats" as const, stats: buildStats() }), lastStatsJson);
  const pushInfo = () => schedulePush(infoWatchers, infoTimerRef, async () => ({ t: "info" as const, groups: await infoGroups() }), lastInfoJson);

  /** The Running section changed (UNI-160 §4): pushed to every client,
   * throttled to ≤1/s and only when the list actually changed. */
  const pushWork = () => {
    if (clients.size === 0 || workTimer) return;
    workTimer = setTimeout(() => {
      workTimer = undefined;
      const items = workItems();
      const json = JSON.stringify(items);
      if (json === lastWorkJson) return;
      lastWorkJson = json;
      send({ t: "work", items });
    }, 1000);
  };

  const commands = (): CommandInfo[] => {
    let list: CommandInfo[] = [];
    try {
      list = pi.getCommands()
        .filter((c) => c.name !== SESSION_COMMAND)
        .map((c) => ({ name: c.name, description: c.description, source: c.source }));
    } catch {
      // ignore
    }
    return [...BUILTIN_COMMANDS, ...list];
  };

  /**
   * The phone's model list, in the order the terminal picker uses: scoped
   * models (pi's enabledModels), Fusion's recent + curated preset, the
   * current model, the configured default, then the rest of the catalogue
   * grouped so a big provider (openrouter: 400+ models from an env key)
   * can't push the ones the user actually uses out of the cap.
   */
  const models = (): ModelInfo[] => {
    try {
      const reg = ctx!.modelRegistry;
      const available = reg.getAvailable();
      const byKey = new Map(available.map((m) => [`${m.provider}/${m.id}`, m]));
      const out: ModelInfo[] = [];
      const seen = new Set<string>();
      const add = (m: (typeof available)[number] | undefined) => {
        if (!m) return;
        const key = `${m.provider}/${m.id}`;
        if (seen.has(key) || out.length >= 400) return;
        seen.add(key);
        const info = modelInfo(m);
        if (info) out.push(info);
      };
      for (const s of ctx!.scopedModels ?? []) add(s.model);
      for (const f of getFusionApi()?.getPicker()?.curated ?? []) add(byKey.get(f.key));
      if (ctx!.model) add(byKey.get(`${ctx!.model.provider}/${ctx!.model.id}`));
      // Providers with stored credentials or a models.json entry first; huge
      // env-key catalogues (openrouter) last.
      const counts = new Map<string, number>();
      for (const m of available) counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
      const rest = [...available].sort((a, b) => (counts.get(a.provider)! > 150 ? 1 : 0) - (counts.get(b.provider)! > 150 ? 1 : 0));
      for (const m of rest) add(m);
      return out;
    } catch {
      return [];
    }
  };

  const hello = (): OutMsg => {
    const c = ctx!;
    const rest = {
      t: "hello" as const,
      v: BRIDGE_PROTOCOL,
      pid: process.pid,
      piVersion: process.env.PI_VERSION,
      session: sessionInfo(),
      state: runState(),
      streaming: streaming ? { id: streaming.id, role: "assistant" as const, content: phoneSafe(streaming.content) as unknown[] } : undefined,
      tools: [...tools.values()].map((t) => ({ ...t, text: t.text ? clipText(t.text, 8 * 1024) : t.text })),
      commands: commands().map((x) => ({ ...x, description: x.description ? clipText(x.description, 160) : x.description })),
      models: models(),
      dialogs: hub.list(),
      queue: queueView(),
      fusion: fusionPreset(),
      work: workItems(),
    };
    // Entries get whatever the rest of the hello leaves of the line budget.
    const spare = LINE_BUDGET - jsonBytes(rest) - 64 * 1024;
    const { entries, truncated } = snapshotEntries(c.sessionManager.getBranch(), Math.max(64 * 1024, Math.min(HELLO_ENTRIES_BUDGET, spare)));
    return { ...rest, entries, truncated };
  };

  const currentPendingWork = (): string | null => {
    try {
      return pendingWorkLabel();
    } catch {
      return null;
    }
  };
  /** UNI-221: grace between "pending work cleared while idle" and treating
   * the session as really finished (the needs-you mark) — the cleared work
   * normally wakes pi in a fresh turn whose own agent_end decides. */
  let pendingClearTimer: NodeJS.Timeout | undefined;
  let unsubPending: (() => void) | undefined;
  const stopPendingWatch = () => {
    unsubPending?.();
    unsubPending = undefined;
    if (pendingClearTimer) clearTimeout(pendingClearTimer);
    pendingClearTimer = undefined;
    awaitingFinalSettle = false;
  };
  /** Set by an agent_end that skipped the needs-you mark because work was
   * pending; the final clear (with no wake turn) marks it instead. */
  let awaitingFinalSettle = false;
  const checkFinalSettle = () => {
    if (!awaitingFinalSettle || pendingClearTimer || running) return;
    if (currentPendingWork() !== null) return;
    pendingClearTimer = setTimeout(() => {
      pendingClearTimer = undefined;
      // Still idle, nothing pending again, no wake turn started: this was
      // the final settle — mark "needs you" for a phone that isn't watching.
      if (!awaitingFinalSettle || running || currentPendingWork() !== null) return;
      try {
        if (ctx && !ctx.isIdle()) return;
      } catch {
        // ignore
      }
      awaitingFinalSettle = false;
      if (clients.size > 0) return; // a phone is watching: it saw the end live
      idleWaitingSince = Date.now();
      writeRecord();
    }, PENDING_CLEAR_GRACE_MS);
    pendingClearTimer.unref?.();
  };
  const onPendingWorkChange = (label: string | null) => {
    writeRecord();
    if (!running) send({ t: "state", ...runState() });
    if (label !== null && pendingClearTimer) {
      clearTimeout(pendingClearTimer);
      pendingClearTimer = undefined;
    }
    checkFinalSettle();
  };

  const writeRecord = () => {
    if (!ctx || !socketPath) return;
    const dir = bridgeDir();
    const info = sessionInfo();
    const record = {
      v: BRIDGE_PROTOCOL,
      pid: process.pid,
      socket: socketPath,
      sessionFile: info.file ?? null,
      sessionId: info.id,
      sessionName: info.name ?? null,
      cwd: info.cwd,
      herdrPaneId: process.env.HERDR_PANE_ID ?? null,
      herdrSocket: process.env.HERDR_SOCKET_PATH ?? null,
      bridgeVersion: BRIDGE_VERSION,
      startedAt: startedAt,
      waiting: effectiveWaiting() ?? null,
      // UNI-212: pi's own run state for the host's chat_list — herdr's
      // pane agent_status lags/misses runs, the list showed busy pis "Idle".
      running,
      // UNI-221: wake-capable work still pending (bg task with a wake, a
      // background subagent, a fusion handoff) — the host passes it into
      // chat_list so lists show "Working…" instead of idle/finished.
      pendingWork: currentPendingWork(),
    };
    try {
      const file = join(dir, `${process.pid}.json`);
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      // ignore
    }
  };
  const startedAt = Date.now();

  /** `sessions{scope, query?}`: this project's or every project's sessions, newest first, capped. */
  const listSessions = async (scope: "cwd" | "all", query: string | undefined): Promise<{ items: SessionsItem[]; more: boolean }> => {
    const c = ctx!;
    const current = c.sessionManager.getSessionFile();
    const raw = scope === "all" ? await deps.listAllSessions() : await deps.listSessions(c.cwd);
    const sorted = [...raw].sort((a, b) => b.modified.getTime() - a.modified.getTime());
    const q = query?.trim().toLowerCase();
    const matches = (s: (typeof sorted)[number]) =>
      !q || (s.name ?? "").toLowerCase().includes(q) || s.firstMessage.toLowerCase().includes(q) || s.allMessagesText.toLowerCase().includes(q);
    const filtered = sorted.filter(matches);
    const cap = 200;
    const items: SessionsItem[] = filtered.slice(0, cap).map((s) => ({
      path: s.path,
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      firstMessage: clipText(s.firstMessage, 200),
      modified: s.modified.getTime(),
      messageCount: s.messageCount,
      current: s.path === current,
    }));
    return { items, more: filtered.length > cap };
  };

  /**
   * Keeps a `tree` reply under one socket line (LINE_BUDGET; the host drops
   * longer lines and the phone saw an empty tree on a 16k-entry session).
   * 1. Drop rows no phone filter ever shows (pi's /tree hides them too):
   *    `custom`/`usage`/`label` bookkeeping and text-less assistant rows,
   *    unless current or a fork point; their children re-attach upward.
   * 2. Still too big: shorter previews (tool results first).
   * 3. Still too big: keep the newest rows plus the current path.
   */
  const fitTree = (nodes: TreeNode[]): TreeNode[] => {
    const budget = LINE_BUDGET - 16 * 1024;
    const childCount = new Map<string, number>();
    for (const n of nodes) if (n.parentId) childCount.set(n.parentId, (childCount.get(n.parentId) ?? 0) + 1);
    const hidden = (n: TreeNode) =>
      !n.current &&
      (childCount.get(n.id) ?? 0) < 2 &&
      !n.label &&
      (n.kind === "custom" || n.kind === "usage" || n.kind === "label" || (n.kind === "assistant" && !n.preview.trim()));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const lift = (parentId: string | null): string | null => {
      let id = parentId;
      const seen = new Set<string>();
      while (id && !seen.has(id)) {
        seen.add(id);
        const p = byId.get(id);
        if (!p || !hidden(p)) return id;
        id = p.parentId;
      }
      return null;
    };
    let out = nodes.filter((n) => !hidden(n)).map((n) => ({ ...n, parentId: lift(n.parentId) }));
    if (jsonBytes(out) <= budget) return out;
    for (const max of [60, 30]) {
      out = out.map((n) => ({ ...n, preview: n.kind === "toolResult" ? n.preview.slice(0, Math.min(max, 24)) : n.preview.slice(0, max), timestamp: undefined }));
      if (jsonBytes(out) <= budget) return out;
    }
    // Newest rows win; the current path always stays.
    const keep = new Set<string>();
    let bytes = 0;
    for (const n of out) if (n.onPath) { keep.add(n.id); bytes += jsonBytes(n) + 1; }
    for (let i = out.length - 1; i >= 0 && bytes < budget; i--) {
      const n = out[i]!;
      if (keep.has(n.id)) continue;
      bytes += jsonBytes(n) + 1;
      if (bytes < budget) keep.add(n.id);
    }
    const kept = out.filter((n) => keep.has(n.id));
    const keptIds = new Set(kept.map((n) => n.id));
    const outById = new Map(out.map((n) => [n.id, n]));
    return kept.map((n) => {
      let id = n.parentId;
      const seen = new Set<string>();
      while (id && !keptIds.has(id) && !seen.has(id)) { seen.add(id); id = outById.get(id)?.parentId ?? null; }
      return { ...n, parentId: id && keptIds.has(id) ? id : null };
    });
  };

  /** `tree{}`: every branch, previews only, the current branch and leaf marked. */
  const buildTree = (): TreeNode[] => {
    const c = ctx!;
    const sm = c.sessionManager;
    const leafId = sm.getLeafId();
    const onPath = new Set<string>();
    if (leafId) for (const e of sm.getBranch(leafId)) onPath.add(e.id);
    const out: TreeNode[] = [];
    type Node = { entry: unknown; children: unknown[]; label?: string };
    // Iterative pre-order: a long session is a chain thousands deep, and a
    // recursive walk overflowed the stack (the phone showed an empty tree).
    const stack: Node[] = [...(sm.getTree() as Node[])].reverse();
    while (stack.length > 0) {
      const node = stack.pop()!;
      const e = node.entry as { id: string; parentId: string | null; type: string; timestamp?: string; message?: { role?: string } };
      out.push({
        id: e.id,
        parentId: e.parentId,
        kind: e.type === "message" ? (e.message?.role ?? "message") : e.type,
        preview: entryPreview(e),
        timestamp: e.timestamp,
        label: node.label,
        onPath: onPath.has(e.id),
        current: e.id === leafId,
      });
      const children = node.children as Node[];
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
    }
    return fitTree(out);
  };

  /** UNI-212: a bridge-queued item handed to pi but not yet seen in an
   * `input` event. pi's `sendUserMessage` is fire-and-forget (a rejected
   * prompt only reaches pi's own error log), so an item is never trusted as
   * delivered until pi echoes it; otherwise it goes back to the queue. */
  let inflight: { item: BridgeQueued; timer: NodeJS.Timeout } | undefined;
  const INFLIGHT_MS = 8_000;
  const restoreInflight = () => {
    const pending = inflight;
    inflight = undefined;
    if (!pending) return;
    clearTimeout(pending.timer);
    // Back at the front: delivered again on the next settle (or by hand from
    // the phone's queue strip). `retry` marks it so a late `input` echo of
    // the first attempt removes it instead of sending it twice.
    bridgeQueue.unshift({ ...pending.item, retry: true });
    send({ t: "queue", items: queueView() });
  };

  /** Delivers one bridge-queued ("after it ends") item. `followUp`, not a
   * bare prompt: pi ignores `deliverAs` while idle (it starts a run), and if
   * something else started a run in the meantime the item waits behind it
   * instead of being rejected ("Agent is already processing") and lost. */
  const deliverQueued = (q: BridgeQueued) => {
    const content = q.images?.length ? [{ type: "text" as const, text: q.text }, ...q.images.map(imageContent)] : q.text;
    if (inflight) restoreInflight();
    const { retry: _retry, ...item } = q;
    inflight = { item, timer: setTimeout(restoreInflight, INFLIGHT_MS) };
    inflight.timer.unref?.();
    try {
      pi.sendUserMessage(content, { deliverAs: "followUp", expandPromptTemplates: true } as never);
    } catch {
      restoreInflight();
    }
  };

  /** On agent_settled (UNI-212 — was agent_end, where pi is still
   * streaming and a bare prompt was rejected): deliver the first "after it
   * ends" item. The rest wait for the NEXT settle (one at a time, as the
   * task spec requires). */
  const deliverNextQueued = () => {
    const next = bridgeQueue.shift();
    if (!next) return;
    send({ t: "queue", items: queueView() });
    deliverQueued(next);
  };

  // `path` images were uploaded via the host's blob channel (same machine as
  // this bridge): read the bytes straight off disk.
  const imageContent = (i: { mime: string; data: string } | { mime: string; path: string }) => {
    if ("data" in i) return { type: "image" as const, mimeType: i.mime, data: i.data };
    try {
      return { type: "image" as const, mimeType: i.mime, data: readFileSync(i.path).toString("base64") };
    } catch {
      return { type: "text" as const, text: `[image unavailable: ${i.path}]` };
    }
  };

  /** btw runs this bridge started, keyed by a run key (the phone's `ref`, or
   * a generated one). They outlive the requesting socket (UNI-219): a phone
   * whose connection drops mid-answer reconnects on a NEW socket, sends
   * `btw_list{watch:true}`, gets the page so far (id + ref + running) and
   * every later `btw_delta`/`btw_end`. Before, they went only to the socket
   * captured at request time — dead after a reconnect — so the page sat on
   * "Thinking…" forever. */
  interface BridgeBtwRun {
    key: string;
    ref?: string;
    question: string;
    /** btw's page id, once `ask()` returned. */
    id?: string;
    owner: Socket;
  }
  const btwRuns = new Map<string, BridgeBtwRun>();
  /** Sockets that asked `btw_list{watch:true}`: they get every bridge btw run's deltas/end too. */
  const btwWatchers = new Set<Socket>();
  /** btw page id → the phone's ref, so `btw_list` can tag finished pages too (bounded). */
  const btwRefById = new Map<string, string>();
  let btwKeySeq = 0;
  const btwSend = (run: BridgeBtwRun, msg: OutMsg) => {
    const targets = new Set<Socket>([run.owner, ...btwWatchers]);
    for (const t of targets) if (clients.has(t)) write(t, msg);
  };
  const btwListPages = (): BtwListPage[] => {
    const api = getBtwApi();
    const pages = (api ? api.list() : []).map((p) => {
      const ref = p.id ? btwRefById.get(p.id) : undefined;
      return ref ? { ...p, ref } : p;
    });
    // Runs whose hidden command hasn't started yet: no btw page exists, but
    // the phone must not think its question was lost.
    for (const run of btwRuns.values()) {
      if (run.id) continue;
      pages.push({ id: `pending-${run.key}`, question: run.question, answer: "", done: false, running: true, ...(run.ref ? { ref: run.ref } : {}) });
    }
    return pages;
  };

  /** UNI-202: edit/remove/promote a single `tui-*` queued item (pi's own
   * steer/followUp queue, mirrored from ANY source). There's no extension
   * API to mutate pi's live queue array in place, so this aborts the run
   * (same effect as the TUI's own Stop — pi hands every queued message
   * back), then re-sends every OTHER item in its original mode/order via
   * `pi.sendUserMessage`, same as the TUI's own dequeue-and-resend. The
   * target item is dropped (`queue_remove`/`queue_promote`) or edited and
   * re-sent with its new text (`queue_edit`). Images ride along for an
   * edit/re-send; `queue_promote` sends the edited item right away instead
   * of re-queuing it. */
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Set by a phone-initiated abort so that abort's own agent_end doesn't
   * auto-deliver the next "after it ends" item (a Stop isn't an ending). */
  let skipNextDelivery = false;
  /** ctx.abort() in the TUI runs pi's own restoreQueuedMessagesToEditor,
   * which dumps every queued message into the TUI editor. The phone owns
   * this abort (it re-sends or gets `restored`), so put the editor back. */
  const abortKeepingEditor = async (c: NonNullable<typeof ctx>) => {
    let before: string | undefined;
    try {
      before = c.hasUI ? c.ui.getEditorText() : undefined;
    } catch {
      before = undefined;
    }
    skipNextDelivery = true;
    c.abort();
    if (before !== undefined) {
      try {
        c.ui.setEditorText(before);
      } catch {
        // no editor: nothing to restore
      }
    }
  };

  const editPiQueued = async (sock: Socket, id: string, ref: string | undefined, apply: (item: (typeof tuiQueue)[number]) => "drop" | "promote" | void) => {
    const c = ctx;
    const ack = () => write(sock, { t: "ack", ref });
    const fail = (message: string) => write(sock, { t: "error", message, ref });
    if (!c) return fail("pi is gone.");
    const i = tuiQueue.findIndex((q) => q.id === id);
    if (i < 0) return fail("That queued message is gone.");
    const [target] = tuiQueue.splice(i, 1);
    const action = apply(target!) ?? undefined;
    // Keep the edited/kept target in its original slot (promote: first).
    const rest = tuiQueue.splice(0, tuiQueue.length);
    if (action === "promote") rest.unshift(target!);
    else if (action !== "drop") rest.splice(i, 0, target!);
    if (!c.isIdle()) {
      await abortKeepingEditor(c);
      const deadline = Date.now() + 10_000;
      while (!c.isIdle() && Date.now() < deadline) await sleep(50);
    }
    send({ t: "queue", items: queueView() });
    const contentOf = (q: (typeof tuiQueue)[number]) => (q.images?.length ? [{ type: "text" as const, text: q.text }, ...q.images.map(imageContent)] : q.text);
    try {
      // pi is idle now, so a deliverAs message would be rejected ("Specify
      // streamingBehavior"/"already processing"). The first item starts a
      // fresh run; wait until pi is streaming, then queue the rest in pi's
      // own order (steer drains before followUp).
      const order = [...rest].sort((a, b) => (a === rest[0] ? -1 : b === rest[0] ? 1 : a.mode === b.mode ? 0 : a.mode === "steer" ? -1 : 1));
      for (const q of order) {
        if (c.isIdle()) {
          pi.sendUserMessage(contentOf(q), { expandPromptTemplates: true } as never);
          const until = Date.now() + 5_000;
          while (c.isIdle() && Date.now() < until) await sleep(20);
        } else {
          pi.sendUserMessage(contentOf(q), { deliverAs: q.mode, expandPromptTemplates: true } as never);
        }
      }
      ack();
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  };

  const handle = async (sock: Socket, msg: InMsg) => {
    const c = ctx;
    if (!c) return;
    const ack = () => write(sock, { t: "ack", ref: msg.ref });
    const fail = (message: string) => write(sock, { t: "error", message, ref: msg.ref });
    switch (msg.t) {
      case "prompt": {
        const idle = c.isIdle();
        if (msg.mode === "after") {
          // Waits in the BRIDGE's own queue (not pi's): editable, removable,
          // reorderable, promotable — delivered one at a time on agent_end.
          // Idle right now: nothing to wait for, deliver immediately.
          if (idle && bridgeQueue.length === 0) {
            const content = msg.images?.length ? [{ type: "text" as const, text: msg.text }, ...msg.images.map(imageContent)] : msg.text;
            const name = /^\/(\S+)/.exec(msg.text)?.[1];
            const isCommand = !!name && commands().some((x) => x.name === name && x.source === "extension");
            const now = Date.now();
            if (!isCommand) phoneInputs.push({ ref: msg.ref, text: msg.text, at: now });
            try {
              pi.sendUserMessage(content, { expandPromptTemplates: true } as never);
              write(sock, { t: "ack", ref: msg.ref, ...(isCommand ? { as: "command" as const } : {}) });
            } catch (error) {
              fail(error instanceof Error ? error.message : String(error));
            }
            return;
          }
          const id = nextQueueId();
          bridgeQueue.push({ id, text: msg.text, images: msg.images });
          send({ t: "queue", items: queueView() });
          ack();
          return;
        }
        if (msg.mode === "now") {
          // Abort the run, wait for idle, then send as a fresh prompt. A
          // Stop isn't an ending: the abort's settle must not deliver an
          // "after it ends" item ahead of this one (UNI-212).
          if (!idle) {
            skipNextDelivery = true;
            c.abort();
            const deadline = Date.now() + 10_000;
            while (!c.isIdle() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
            // The abort has settled: the next settle is this prompt's own.
            skipNextDelivery = false;
          }
          const content = msg.images?.length ? [{ type: "text" as const, text: msg.text }, ...msg.images.map(imageContent)] : msg.text;
          const name = /^\/(\S+)/.exec(msg.text)?.[1];
          const isCommand = !!name && commands().some((x) => x.name === name && x.source === "extension");
          const now = Date.now();
          if (!isCommand) phoneInputs.push({ ref: msg.ref, text: msg.text, at: now });
          try {
            pi.sendUserMessage(content, { expandPromptTemplates: true } as never);
            write(sock, { t: "ack", ref: msg.ref, ...(isCommand ? { as: "command" as const } : {}) });
          } catch (error) {
            fail(error instanceof Error ? error.message : String(error));
          }
          return;
        }
        const deliverAs = idle ? undefined : msg.mode === "followUp" ? "followUp" : "steer";
        const content = msg.images?.length ? [{ type: "text" as const, text: msg.text }, ...msg.images.map(imageContent)] : msg.text;
        // An extension command runs right away and saves no chat message:
        // tell the phone so its "Sending…" bubble goes.
        const name = /^\/(\S+)/.exec(msg.text)?.[1];
        const isCommand = !!name && commands().some((x) => x.name === name && x.source === "extension");
        const now = Date.now();
        while (phoneInputs.length && (phoneInputs.length > 32 || now - phoneInputs[0]!.at > 120_000)) phoneInputs.shift();
        if (!isCommand) phoneInputs.push({ ref: msg.ref, text: msg.text, at: now });
        try {
          pi.sendUserMessage(content, { deliverAs, expandPromptTemplates: true } as never);
          write(sock, { t: "ack", ref: msg.ref, ...(isCommand ? { as: "command" as const } : {}) });
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      case "queue_edit": {
        if (msg.id.startsWith("tui-")) return void (await editPiQueued(sock, msg.id, msg.ref, (item) => void (item.text = msg.text)));
        const item = bridgeQueue.find((q) => q.id === msg.id);
        if (!item) return fail("That queued message is gone.");
        item.text = msg.text;
        send({ t: "queue", items: queueView() });
        ack();
        return;
      }
      case "queue_remove": {
        if (msg.id.startsWith("tui-")) return void (await editPiQueued(sock, msg.id, msg.ref, () => "drop"));
        const i = bridgeQueue.findIndex((q) => q.id === msg.id);
        if (i < 0) return fail("That queued message is gone.");
        bridgeQueue.splice(i, 1);
        send({ t: "queue", items: queueView() });
        ack();
        return;
      }
      case "queue_move": {
        // pi-owned rows aren't reorderable (their relative order is pi's own
        // steering/follow-up semantics, not ours to rearrange) — only bridge items are.
        if (msg.id.startsWith("tui-")) return fail("That message isn't reorderable.");
        const i = bridgeQueue.findIndex((q) => q.id === msg.id);
        if (i < 0) return fail("That queued message is gone.");
        const [item] = bridgeQueue.splice(i, 1);
        const at = Math.max(0, Math.min(bridgeQueue.length, msg.index));
        bridgeQueue.splice(at, 0, item!);
        send({ t: "queue", items: queueView() });
        ack();
        return;
      }
      case "queue_promote": {
        if (msg.id.startsWith("tui-")) return void (await editPiQueued(sock, msg.id, msg.ref, () => "promote"));
        const i = bridgeQueue.findIndex((q) => q.id === msg.id);
        if (i < 0) return fail("That queued message is gone.");
        const [item] = bridgeQueue.splice(i, 1);
        send({ t: "queue", items: queueView() });
        const content = item!.images?.length ? [{ type: "text" as const, text: item!.text }, ...item!.images.map(imageContent)] : item!.text;
        if (msg.to === "steer") {
          try {
            pi.sendUserMessage(content, { deliverAs: c.isIdle() ? undefined : "steer", expandPromptTemplates: true } as never);
            ack();
          } catch (error) {
            fail(error instanceof Error ? error.message : String(error));
          }
          return;
        }
        // to === "now": abort, wait for idle, then send as a fresh prompt.
        if (!c.isIdle()) {
          skipNextDelivery = true;
          c.abort();
          const deadline = Date.now() + 10_000;
          while (!c.isIdle() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
          skipNextDelivery = false;
        }
        try {
          pi.sendUserMessage(content, { expandPromptTemplates: true } as never);
          ack();
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      case "btw": {
        const api = getBtwApi();
        if (!api) return fail("btw is not installed on this pi.");
        // Registered BEFORE the hidden command runs, so a `btw_list` right
        // behind this request already lists it (as `pending-<key>`).
        const key = msg.ref && !btwRuns.has(msg.ref) ? msg.ref : `b${++btwKeySeq}`;
        const run: BridgeBtwRun = { key, ref: msg.ref, question: msg.question, owner: sock };
        btwRuns.set(key, run);
        const end = (answer: string, error?: string, usage?: { input: number; output: number; totalTokens: number }) => {
          if (!btwRuns.has(key)) return;
          btwRuns.delete(key);
          btwSend(run, { t: "btw_end", id: run.id ?? `pending-${key}`, answer, error, usage, ref: msg.ref });
        };
        try {
          // The op only STARTS the question (btw needs a command context to
          // seed its side session); it doesn't hold the hidden command for
          // the whole answer.
          await runCommandOp(async (cctx) => {
            const result = api.ask(cctx, msg.question, (event: BtwEvent) => {
              if (event.type === "delta") {
                btwSend(run, { t: "btw_delta", id: run.id ?? `pending-${key}`, kind: event.kind, text: event.text, ...(event.index !== undefined ? { index: event.index } : {}), ref: msg.ref });
              } else end(event.answer, event.error, event.usage);
            });
            run.id = result.id;
            if (msg.ref) {
              btwRefById.set(result.id, msg.ref);
              if (btwRefById.size > 200) btwRefById.delete(btwRefById.keys().next().value!);
            }
            void result.finished.then(
              () => end("", undefined),
              (error: unknown) => end("", error instanceof Error ? error.message : String(error)),
            );
          });
        } catch (error) {
          // Never leave the phone's page on "Thinking…": end it with the error.
          end("", error instanceof Error ? error.message : String(error));
        }
        return;
      }
      case "btw_list": {
        if (msg.watch) btwWatchers.add(sock);
        write(sock, { t: "btw_list", pages: btwListPages(), complete: true, ref: msg.ref });
        return;
      }
      case "abort": {
        // UNI-202/211: match the TUI's own Stop (`app.interrupt` →
        // restoreQueuedMessagesToEditor({abort:true})): pi's own queued
        // steer/followUp messages (mirrored in tuiQueue, from ANY source)
        // don't just vanish — they're handed back. The TUI puts them in
        // ITS editor; the phone has no such editor to read, so the bridge
        // sends the same texts back as `restored` for the app to fold into
        // the composer draft. The bridge's OWN "after it ends" queue is
        // left alone (explicitly "after", not lost to this abort).
        const texts = tuiQueue.map((q) => q.text);
        tuiQueue.length = 0;
        if (c.isIdle()) skipNextDelivery = false;
        else await abortKeepingEditor(c);
        ack();
        if (texts.length) send({ t: "restored", texts });
        send({ t: "queue", items: queueView() });
        return;
      }
      case "answer":
        if (hub.answer(msg.id, msg.value)) ack();
        else fail("That question was already answered.");
        return;
      case "set_model": {
        const model = c.modelRegistry.find(msg.provider, msg.model);
        if (!model) return fail(`Unknown model ${msg.provider}/${msg.model}`);
        try {
          const ok = await pi.setModel(model);
          if (!ok) return fail(`No API key for ${msg.provider}`);
          ack();
          send({ t: "state", ...runState() });
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      case "set_thinking":
        try {
          pi.setThinkingLevel(msg.level as never);
          ack();
          send({ t: "state", ...runState() });
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
        return;
      case "compact":
        c.compact({
          customInstructions: msg.instructions,
          onComplete: () => send({ t: "state", ...runState() }),
          onError: (error) => send({ t: "error", message: error.message, ref: msg.ref }),
        });
        ack();
        return;
      case "resync":
        write(sock, hello());
        return;
      case "history": {
        const page = historyPage(c.sessionManager.getBranch(), msg.before, Math.min(ENTRIES_BUDGET, LINE_BUDGET - 32 * 1024));
        write(sock, { t: "history", before: msg.before, entries: page.entries, more: page.more, ref: msg.ref });
        return;
      }
      case "files": {
        const items = await fileSuggestions(c.cwd, msg.query);
        write(sock, { t: "files", query: msg.query, items, ref: msg.ref });
        return;
      }
      case "paths_stat": {
        write(sock, { t: "paths_stat", items: await statPaths(msg.paths, c.cwd), ref: msg.ref });
        return;
      }
      case "sessions": {
        try {
          const { items, more } = await listSessions(msg.scope, msg.query);
          write(sock, { t: "sessions", items, more, ref: msg.ref });
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      case "tree": {
        try {
          write(sock, { t: "tree", nodes: buildTree(), ref: msg.ref });
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      case "session_rename":
        try {
          pi.setSessionName(msg.name);
          ack();
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
        return;
      case "session_new": {
        if (!(await ensureIdle(msg.force))) return write(sock, { t: "error", message: "pi is busy. Stop the current run first.", code: "busy", ref: msg.ref });
        try {
          await runCommandOp(async (cctx) => {
            const result = await cctx.newSession();
            if (result.cancelled) throw new Error("Cancelled");
          });
          ack();
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      case "session_resume": {
        if (!(await ensureIdle(msg.force))) return write(sock, { t: "error", message: "pi is busy. Stop the current run first.", code: "busy", ref: msg.ref });
        try {
          await runCommandOp(async (cctx) => {
            const result = await cctx.switchSession(msg.path);
            if (result.cancelled) throw new Error("Cancelled");
          });
          ack();
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      case "session_fork": {
        if (!(await ensureIdle(msg.force))) return write(sock, { t: "error", message: "pi is busy. Stop the current run first.", code: "busy", ref: msg.ref });
        try {
          await runCommandOp(async (cctx) => {
            const result = await cctx.fork(msg.entryId);
            if (result.cancelled) throw new Error("Cancelled");
          });
          ack();
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      case "tree_go": {
        if (!(await ensureIdle(msg.force))) return write(sock, { t: "error", message: "pi is busy. Stop the current run first.", code: "busy", ref: msg.ref });
        try {
          await runCommandOp(async (cctx) => {
            const result = await cctx.navigateTree(msg.id, { summarize: msg.summarize });
            if (result.cancelled) throw new Error("Cancelled");
          });
          ack();
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      case "media": {
        const entry = resolveMedia(msg.mediaRef);
        if (!entry) return write(sock, { t: "media_error", mediaRef: msg.mediaRef, message: "That image is no longer available. Re-open the message." });
        try {
          const data = entry.kind === "base64" ? entry.data : readFileSync(entry.path).toString("base64");
          for (let i = 0; i < data.length || i === 0; i += MEDIA_CHUNK_CHARS) {
            const piece = data.slice(i, i + MEDIA_CHUNK_CHARS);
            const done = i + MEDIA_CHUNK_CHARS >= data.length;
            write(sock, { t: "media_chunk", mediaRef: msg.mediaRef, mime: entry.mime, data: piece, done });
            if (done) break;
          }
        } catch (error) {
          write(sock, { t: "media_error", mediaRef: msg.mediaRef, message: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      case "file_share": {
        if (!isInsideCwd(msg.path, c.cwd)) return fail("That path is outside this session's directory.");
        if (!existsSync(msg.path)) return fail("That file doesn't exist on the host.");
        registerPath(msg.path);
        ack();
        return;
      }
      case "set_fusion": {
        const api = getFusionApi();
        if (!api) return fail("Fusion is not installed on this pi.");
        const result: FusionPickerResult =
          "single" in msg
            ? { type: "single", model: msg.single, effort: msg.effort, effortMap: {} }
            : { type: "fusion", lead: msg.lead, sidekick: msg.sidekick, leadEffort: msg.leadEffort, sidekickEffort: msg.sidekickEffort, effortMap: {} };
        try {
          const applied = await api.apply(result);
          if (!applied.ok) return fail(applied.message);
          ack();
          // Push the fresh preset too: runState() alone doesn't carry
          // `fusion`, so the phone's Lead/Sidekick highlight would stay
          // on the old pair after set_fusion (UNI-176).
          stateWithFusion();
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      case "watch": {
        if (msg.stats !== undefined) {
          if (msg.stats) statsWatchers.add(sock);
          else statsWatchers.delete(sock);
        }
        if (msg.info !== undefined) {
          if (msg.info) infoWatchers.add(sock);
          else infoWatchers.delete(sock);
        }
        ack();
        // An immediate snapshot, not just the next throttled tick.
        if (msg.stats) write(sock, { t: "stats", stats: buildStats() });
        if (msg.info) void infoGroups().then((groups) => write(sock, { t: "info", groups }));
        return;
      }
      case "work_log": {
        const page = await workLogPage(msg.id, { maxBytes: 256 * 1024 });
        if ("error" in page) return fail(page.error);
        write(sock, { t: "work_log", id: msg.id, text: page.text, more: page.more, ref: msg.ref });
        return;
      }
      case "work_transcript": {
        // Subagent mini-transcripts need @pi-unipi/subagents' transcript
        // builder (TUI-flavoured); UNI-160 ships the live-log half (bg tasks)
        // first and reports this a known gap (see the task report).
        fail("Subagent transcripts aren't available yet.");
        return;
      }
      case "work_stop": {
        const result = await stopWorkItem(msg.id);
        if (!result.ok) return fail(result.message);
        ack();
        pushWork();
        return;
      }
      case "work_rerun": {
        fail("Re-running a finished task isn't available yet.");
        return;
      }
      case "work_background": {
        const result = backgroundWorkItem(msg.id);
        if (!result.ok) return fail(result.message);
        ack();
        pushWork();
        return;
      }
    }
  };

  const listen = () => {
    if (server || !ctx) return;
    const dir = bridgeDir();
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
    } catch {
      return;
    }
    sweepDead(dir);
    socketPath = join(dir, `${process.pid}.sock`);
    rmSync(socketPath, { force: true });
    const srv = createServer((sock) => {
      clients.add(sock);
      // A phone connecting has now seen the state (it's in `hello`): the
      // idle-since-agent_end "needs you" mark no longer applies (an open
      // dialog is a separate thing — dialogWaiting only clears on close).
      if (idleWaitingSince !== undefined) {
        idleWaitingSince = undefined;
        writeRecord();
      }
      sock.setEncoding("utf8");
      const lines = new LineSplitter();
      const drop = () => {
        clients.delete(sock);
        btwWatchers.delete(sock);
        statsWatchers.delete(sock);
        infoWatchers.delete(sock);
      };
      sock.on("close", drop);
      sock.on("error", drop);
      sock.on("data", (chunk: string) => {
        for (const line of lines.push(chunk)) {
          const parsed = parseIn(line);
          if (!parsed) continue;
          if ("bad" in parsed) {
            write(sock, { t: "error", message: parsed.bad, ref: parsed.ref });
            continue;
          }
          handle(sock, parsed).catch((error) => write(sock, { t: "error", message: String(error), ref: parsed.ref }));
        }
      });
      try {
        write(sock, hello());
      } catch (error) {
        write(sock, { t: "error", message: `snapshot failed: ${String(error)}` });
      }
    });
    srv.on("error", () => {
      // Socket trouble (dir removed…) never matters to pi.
    });
    srv.listen(socketPath, () => {
      try {
        chmodSync(socketPath!, 0o600);
      } catch {
        // ignore
      }
      writeRecord();
    });
    srv.unref();
    server = srv;
    // One tick drives all three low-frequency pushes (work/stats/info): bg
    // tasks and subagents change without an extension event reaching this
    // bridge, so a 1 s poll is cheaper than wiring every producer's onChange.
    // Each push is itself de-duped (schedulePush/pushWork skip an unchanged
    // snapshot), so an idle session with no watchers costs one JSON diff/s.
    // UNI-221: push a `state` (and rewrite the record) the moment pending
    // work starts/ends while pi is idle, so phones flip "Working…" live.
    unsubPending?.();
    unsubPending = subscribePendingWork(onPendingWorkChange);
    pushTicker = setInterval(() => {
      // A pending start→end shorter than one poll is never seen as a
      // change; the ticker still finds the final clear.
      checkFinalSettle();
      if (clients.size > 0) pushWork();
      if (statsWatchers.size > 0) pushStats();
      if (infoWatchers.size > 0) pushInfo();
    }, 1000);
    pushTicker.unref?.();
  };

  const close = () => {
    for (const sock of clients) sock.destroy();
    clients.clear();
    statsWatchers.clear();
    infoWatchers.clear();
    if (pushTicker) clearInterval(pushTicker);
    pushTicker = undefined;
    stopPendingWatch();
    server?.close();
    server = undefined;
    const dir = bridgeDir();
    rmSync(join(dir, `${process.pid}.json`), { force: true });
    if (socketPath) rmSync(socketPath, { force: true });
    socketPath = undefined;
  };

  const safe =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A) => {
      try {
        fn(...args);
      } catch {
        // never break pi
      }
    };

  const on = pi.on.bind(pi) as unknown as (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => void;

  on("session_start", (event, c) => {
    try {
      ctx = c;
      if (c.mode !== "tui" || process.env.UNIPI_SUBAGENT_CHILD === "1" || process.env.UNIPI_APP_BRIDGE === "0") return;
      if (c.hasUI) wrapUi(c.ui, hub, (text, level) => send({ t: "notify", text: clipText(text, 4000), level }));
      computeCost();
      setRemoteDialogs(hub);
      listen();
      writeRecord();
      if (event?.reason && event.reason !== "startup") {
        streaming = undefined;
        tools.clear();
        tuiQueue.length = 0;
        bridgeQueue.length = 0;
        for (const sock of clients) write(sock, hello());
      }
    } catch {
      // never break pi
    }
  });

  on("session_shutdown", (event) => {
    try {
      hub.cancelAll();
      if (event?.reason === "quit" || event?.reason === undefined) {
        setRemoteDialogs(undefined);
        close();
        return;
      }
      // new / resume / fork / reload: pi tears this runtime down and loads
      // every extension again — a NEW bridge instance takes over the same
      // socket path. Hand over cleanly: stop listening and tell connected
      // phones to reconnect (they get the new session's hello from the new
      // instance). Leaving this server up kept phones on a dead instance
      // that never sent the new session.
      for (const sock of clients) write(sock, { t: "reconnect", reason: String(event?.reason ?? "switch") });
      for (const sock of clients) sock.end();
      clients.clear();
      statsWatchers.clear();
      infoWatchers.clear();
      if (pushTicker) clearInterval(pushTicker);
      pushTicker = undefined;
      stopPendingWatch();
      server?.close();
      server = undefined;
    } catch {
      // ignore
    }
  });

  on("session_info_changed", safe(() => {
    writeRecord();
    send({ t: "session", reason: "rename", ...sessionInfo() });
  }));

  // Fusion lead/sidekick live status (UNI-160 §1): pushed on every change
  // (busy, savings, tool counts), not throttled — FUSION_STATUS already
  // fires at a human pace (turn boundaries), never per-token.
  bus.on(pi, UNIPI_EVENTS.FUSION_STATUS, (status) => {
    send({ t: "fusion", status: status as FusionStatusInfo | undefined });
    // UNI-212: FUSION_STATUS fires on every active-selection change
    // (picker, set_fusion, a /model switch leaving Fusion): push the fresh
    // preset too, so the phone's picker never marks a stale Fusion pair as
    // current after a single model was picked.
    if (ctx) stateWithFusion();
  });

  on("input", (event) => {
    try {
      const mode = event.streamingBehavior === "steer" || event.streamingBehavior === "followUp" ? event.streamingBehavior : "prompt";
      // UNI-212: pi took a bridge-queued item we handed it — it's delivered
      // (a late echo of a first attempt also drops its retry copy).
      if (event.source === "extension") {
        if (inflight && inflight.item.text === event.text) {
          clearTimeout(inflight.timer);
          inflight = undefined;
        } else {
          const r = bridgeQueue.findIndex((q) => q.retry && q.text === event.text);
          if (r >= 0) {
            bridgeQueue.splice(r, 1);
            send({ t: "queue", items: queueView() });
          }
        }
      }
      if (mode !== "prompt") {
        tuiQueue.push({
          id: `tui-${process.pid}-${++queueSeq}`,
          text: clipText(event.text ?? "", 4000),
          mode,
          images: event.images?.length ? event.images.map((i: { data: string; mimeType: string }) => ({ mime: i.mimeType, data: i.data })) : undefined,
        });
        send({ t: "queue", items: queueView() });
      } else if (event.source !== "extension" && bridgeQueue.length) {
        // The user started something new before the queued items could be
        // delivered on the next agent_end: stop auto-delivering them (the
        // phone can still edit/remove/promote what remains by hand).
        bridgeQueue.length = 0;
        send({ t: "queue", items: queueView() });
      }
      const i = phoneInputs.findIndex((p) => p.text === event.text);
      const ref = i >= 0 ? phoneInputs.splice(i, 1)[0]!.ref : undefined;
      send({ t: "input", text: clipText(event.text ?? "", 64 * 1024), source: event.source, mode, ...(ref ? { ref } : {}) });
    } catch {
      // ignore
    }
    return { action: "continue" };
  });

  on("agent_start", safe(() => {
    // the aborted run's agent_end already passed (abort waits for idle)
    skipNextDelivery = false;
    running = true;
    idleWaitingSince = undefined;
    // The wake turn (or any new turn) owns the finish now.
    awaitingFinalSettle = false;
    if (pendingClearTimer) clearTimeout(pendingClearTimer);
    pendingClearTimer = undefined;
    writeRecord();
    send({ t: "state", running: true });
  }));
  on("agent_settled", safe((_event: unknown, c?: ExtensionContext) => {
    running = false;
    streaming = undefined;
    tools.clear();
    // UNI-211: no longer unconditionally clearing tuiQueue here. A phone
    // abort already cleared it and told the phone via `restored` (the
    // "abort" case above). The TUI's own Stop (app.interrupt) clears pi's
    // real queues and restores them to ITS editor WITHOUT firing any
    // extension event the bridge can see, so if any mirrored rows remain
    // here they're either stale (TUI just stopped: drop them — the TUI's
    // own restore means nothing is left running to deliver them) or really
    // were delivered without an `input` removal (shouldn't happen, but
    // dropping here is the TUI's own behavior too: queues don't survive an
    // agent that settled with nothing left streaming).
    if (tuiQueue.length) {
      tuiQueue.length = 0;
      send({ t: "queue", items: queueView() });
    }
    writeRecord();
    send({ t: "state", ...runState() });
    // "After it ends" messages (the bridge's own queue): deliver the first
    // one, one at a time — the rest wait for the NEXT settle. UNI-212: here,
    // not on agent_end: pi emits agent_end while its run is still active, so
    // a prompt sent there was rejected ("Agent is already processing") and
    // the item silently lost. During agent_settled pi defers a prompt until
    // the settle finishes, then starts it as a fresh run.
    if (skipNextDelivery) skipNextDelivery = false;
    else if (!c || c.isIdle()) deliverNextQueued();
  }));
  // A phone already connected has already seen the end live (no "needs
  // you" badge for someone watching); one with no phone open gets the
  // idle-waiting mark.
  on("agent_end", safe(() => {
    // UNI-162: a settled turn with no phone open is only truly "needs you"
    // idle if nothing is still pending (a background subagent, a bg wake, a
    // fusion handoff) — those will re-invoke pi themselves; marking idle now
    // would tell a notification-watching user the session is done when it
    // isn't.
    let pending = false;
    try {
      pending = pendingWorkLabel() !== null;
    } catch {
      pending = false;
    }
    if (clients.size === 0 && !pending) {
      idleWaitingSince = Date.now();
      writeRecord();
    } else if (pending) {
      // UNI-221: not finished yet — the final clear decides (checkFinalSettle).
      awaitingFinalSettle = true;
    }
  }));

  on("message_start", safe((event) => {
    const m = event.message as { role?: string; content?: unknown };
    if (m.role === "user" && tuiQueue.length) {
      const text = textOfContent(m.content);
      const i = tuiQueue.findIndex((q) => q.text === clipText(text, 4000));
      if (i >= 0) {
        tuiQueue.splice(i, 1);
        send({ t: "queue", items: queueView() });
      }
    }
    if (m.role === "assistant") {
      streaming = { id: `s${process.pid}-${++streamSeq}`, content: [] };
      send({ t: "msg_start", id: streaming.id, role: "assistant" });
    }
  }));

  on("message_update", safe((event) => {
    const a = event.assistantMessageEvent as { type: string; contentIndex?: number; delta?: string; partial?: { content?: unknown[] } };
    if (streaming && a.partial?.content) streaming.content = a.partial.content;
    const index = a.contentIndex ?? 0;
    if (a.type === "text_delta") pushDelta("text", index, a.delta ?? "");
    else if (a.type === "thinking_delta") pushDelta("thinking", index, a.delta ?? "");
    else if (a.type === "toolcall_delta") pushDelta("toolcall", index, a.delta ?? "");
  }));

  on("message_end", safe((event) => {
    const m = event.message as { role?: string; usage?: { cost?: { total?: number } } };
    if (m.role === "assistant" && streaming) {
      flushDeltas();
      send({ t: "msg_end", id: streaming.id });
      streaming = undefined;
      sessionCost += m.usage?.cost?.total ?? 0;
    }
    // pi persists the entry right after the extension event; send it next tick.
    setImmediate(() => {
      try {
        if (!ctx || clients.size === 0) return;
        const leaf = ctx.sessionManager.getLeafEntry?.() ?? ctx.sessionManager.getBranch().at(-1);
        const l = leaf as { type?: string; message?: unknown; customType?: string } | undefined;
        const msg = event.message as { customType?: string; content?: unknown; display?: boolean; details?: unknown };
        // pi stores custom messages flat ({type:"custom_message", customType, content, …}).
        const entry =
          m.role === "custom"
            ? l?.type === "custom_message" && l.customType === msg.customType
              ? l
              : { type: "custom_message", id: `live-${Date.now()}`, timestamp: new Date().toISOString(), customType: msg.customType, content: msg.content, display: msg.display, details: msg.details }
            : l && l.message === event.message
              ? l
              : { type: "message", id: `live-${Date.now()}`, timestamp: new Date().toISOString(), message: event.message };
        if (wantedEntry(entry)) send({ t: "entry", entry: phoneSafe(entry) });
        if (m.role === "assistant") send({ t: "state", ...runState() });
      } catch {
        // ignore
      }
    });
  }));

  on("tool_execution_start", safe((event) => {
    const t = { callId: event.toolCallId, name: event.toolName, args: phoneSafe(event.args, 8 * 1024) };
    tools.set(event.toolCallId, t);
    send({ t: "tool_start", ...t });
  }));
  on("tool_execution_update", safe((event) => {
    const tool = tools.get(event.toolCallId);
    const text = textOfContent((event.partialResult as { content?: unknown })?.content);
    if (!tool || !text) return;
    tool.text = text.length > 8192 ? text.slice(-8192) : text;
    if (toolTimers.has(event.toolCallId)) return;
    toolTimers.set(
      event.toolCallId,
      setTimeout(() => {
        toolTimers.delete(event.toolCallId);
        const latest = tools.get(event.toolCallId);
        if (latest?.text) send({ t: "tool_update", callId: event.toolCallId, text: latest.text });
      }, 250),
    );
  }));
  on("tool_execution_end", safe((event) => {
    const timer = toolTimers.get(event.toolCallId);
    if (timer) clearTimeout(timer);
    toolTimers.delete(event.toolCallId);
    tools.delete(event.toolCallId);
    send({ t: "tool_end", callId: event.toolCallId, isError: !!event.isError });
  }));

  // The preset's `active` changes with the model (Fusion leaves fusion mode
  // on a /model switch), so it rides along (UNI-212).
  on("model_select", safe(() => stateWithFusion()));
  on("thinking_level_select", safe(() => send({ t: "state", ...runState() })));
  on("session_compact", safe(() => {
    if (!ctx) return;
    for (const sock of clients) write(sock, hello());
  }));
  on("session_tree", safe(() => {
    if (!ctx) return;
    for (const sock of clients) write(sock, hello());
  }));

  // Custom entries (pi.appendEntry) fire no extension event: pick them up at turn ends.
  let lastLeaf: string | undefined;
  const syncCustom = () => {
    if (!ctx || clients.size === 0) return;
    const branch = ctx.sessionManager.getBranch() as Array<{ id: string; type: string }>;
    const leafId = branch.at(-1)?.id;
    if (!leafId || leafId === lastLeaf) return;
    const from = lastLeaf ? branch.findIndex((e) => e.id === lastLeaf) + 1 : branch.length;
    lastLeaf = leafId;
    if (from <= 0) return;
    for (const e of branch.slice(from)) {
      if ((e.type === "custom" || e.type === "compaction" || e.type === "model_change") && wantedEntry(e)) send({ t: "entry", entry: phoneSafe(e) });
    }
  };
  on("turn_end", safe(syncCustom));
  on("agent_settled", safe(syncCustom));

  return {
    /** Test seam. */
    _debug: { hub, hello: () => (ctx ? hello() : undefined), socketPath: () => socketPath, close },
  };
}

export type Bridge = ReturnType<typeof createBridge>;
export { textOfContent, existsSync, readFileSync };
export type { Dialog };
