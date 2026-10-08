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
import { registerPath, resolveMedia } from "./media.js";
import { listWorkItems, stopWorkItem, backgroundWorkItem, workLogPage } from "./work.js";
import { bus, UNIPI_EVENTS } from "@pi-unipi/core";

/** `media_chunk.data` (base64) stays well under the 900 KiB bridge line
 * budget; 700 KB of base64 chars per chunk leaves slack for the envelope. */
const MEDIA_CHUNK_CHARS = 700 * 1024;

/** @pi-unipi/btw's UI-free API, read lazily off globalThis (the bridge never
 * imports @pi-unipi/btw directly: btw may not be installed). See btw.ts
 * publishUiFreeApi()/getBtwApi(). */
type BtwEvent =
  | { type: "delta"; kind: "text" | "thinking" | "tool"; text: string }
  | { type: "end"; answer: string; error?: string; usage?: { input: number; output: number; totalTokens: number } };
interface BtwApi {
  ask(cctx: ExtensionCommandContext, question: string, onEvent: (event: BtwEvent) => void): { id: string; finished: Promise<void> };
  list(): Array<{ question: string; answer: string; error?: string }>;
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
  /** pi's own queue (TUI steer/follow-up, from the `input` event's `streamingBehavior`): read-only to the phone. */
  const tuiQueue: Array<{ text: string; mode: "steer" | "followUp" }> = [];
  /** The bridge's own queue ("after it ends"): phone-only, editable/removable/reorderable/promotable,
   * delivered one at a time on `agent_end`. Survives phone reconnects (sent in `hello`), not a pi restart. */
  const bridgeQueue: Array<{ id: string; text: string; images?: Array<{ mime: string; data: string } | { mime: string; path: string }> }> = [];
  let queueSeq = 0;
  const nextQueueId = () => `q${process.pid}-${++queueSeq}`;
  /** Every queue row the phone sees: TUI items first (oldest-submitted order, read-only), then bridge items (editable, reorderable). */
  const queueView = (): Queued[] => [
    ...tuiQueue.map((q, i) => ({ id: `tui-${i}`, text: q.text, mode: q.mode, source: "tui" as const, editable: false })),
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
  let pendingOp: ((cctx: ExtensionCommandContext) => Promise<void>) | undefined;
  pi.registerCommand(SESSION_COMMAND, {
    description: "Internal: runs a UniPi app session-navigation request. Not for direct use.",
    handler: async (_args: string, cctx: ExtensionCommandContext) => {
      const op = pendingOp;
      pendingOp = undefined;
      if (op) await op(cctx);
    },
  });

  /** Runs `op` with a command-capable context, via the hidden command (the
   * only way to reach newSession/fork/navigateTree/switchSession). Only one
   * can be in flight; callers only run this while pi is idle. */
  const runCommandOp = (op: (cctx: ExtensionCommandContext) => Promise<void>): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      pendingOp = async (cctx) => {
        try {
          await op(cctx);
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      try {
        pi.sendUserMessage(`/${SESSION_COMMAND}`, { expandPromptTemplates: true });
      } catch (error) {
        pendingOp = undefined;
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
    return {
      running,
      model: modelInfo(c.model),
      thinking: pi.getThinkingLevel(),
      thinkingLevels: thinkingLevels(c.model),
      context,
      cost: Math.round(sessionCost * 10000) / 10000,
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

  /** `tree{}`: every branch, previews only, the current branch and leaf marked. */
  const buildTree = (): TreeNode[] => {
    const c = ctx!;
    const sm = c.sessionManager;
    const leafId = sm.getLeafId();
    const onPath = new Set<string>();
    if (leafId) for (const e of sm.getBranch(leafId)) onPath.add(e.id);
    const out: TreeNode[] = [];
    const visit = (node: { entry: unknown; children: unknown[]; label?: string }) => {
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
      for (const child of node.children as Array<{ entry: unknown; children: unknown[]; label?: string }>) visit(child);
    };
    for (const root of sm.getTree()) visit(root as never);
    return out;
  };

  /** Delivers one bridge-queued ("after it ends") item as a fresh prompt
   * (pi is idle: agent_end/now just fired or the force-abort above settled). */
  const deliverQueued = (q: { id: string; text: string; images?: Array<{ mime: string; data: string } | { mime: string; path: string }> }) => {
    const content = q.images?.length ? [{ type: "text" as const, text: q.text }, ...q.images.map(imageContent)] : q.text;
    try {
      pi.sendUserMessage(content, { expandPromptTemplates: true } as never);
    } catch {
      // Nothing we can tell the phone here (no ref): it will notice the item vanished from the queue.
    }
  };

  /** On agent_end: deliver the first "after it ends" item, if any. The rest
   * wait for the NEXT agent_end (one at a time, as the task spec requires). */
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

  /** btw runs in flight, keyed by id, so a `btw_delta`/`btw_end` only reaches the requesting phone. */
  const btwRuns = new Map<string, Socket>();

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
          // Abort the run, wait for idle, then send as a fresh prompt.
          if (!idle) {
            c.abort();
            const deadline = Date.now() + 10_000;
            while (!c.isIdle() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
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
        const item = bridgeQueue.find((q) => q.id === msg.id);
        if (!item) return fail("That queued message is gone.");
        item.text = msg.text;
        send({ t: "queue", items: queueView() });
        ack();
        return;
      }
      case "queue_remove": {
        const i = bridgeQueue.findIndex((q) => q.id === msg.id);
        if (i < 0) return fail("That queued message is gone.");
        bridgeQueue.splice(i, 1);
        send({ t: "queue", items: queueView() });
        ack();
        return;
      }
      case "queue_move": {
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
          c.abort();
          const deadline = Date.now() + 10_000;
          while (!c.isIdle() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
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
        try {
          await runCommandOp(async (cctx) => {
            let runId = "";
            const result = api.ask(cctx, msg.question, (event: BtwEvent) => {
              if (event.type === "delta") write(sock, { t: "btw_delta", id: runId, kind: event.kind, text: event.text, ref: msg.ref });
              else {
                write(sock, { t: "btw_end", id: runId, answer: event.answer, error: event.error, usage: event.usage, ref: msg.ref });
                btwRuns.delete(runId);
              }
            });
            runId = result.id;
            btwRuns.set(runId, sock);
            await result.finished;
          });
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      case "btw_list": {
        const api = getBtwApi();
        write(sock, { t: "btw_list", pages: api ? api.list() : [], ref: msg.ref });
        return;
      }
      case "abort":
        c.abort();
        ack();
        return;
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
          send({ t: "state", ...runState() });
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
    pushTicker = setInterval(() => {
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
      }
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
  });

  on("input", (event) => {
    try {
      const mode = event.streamingBehavior === "steer" || event.streamingBehavior === "followUp" ? event.streamingBehavior : "prompt";
      if (mode !== "prompt") {
        tuiQueue.push({ text: clipText(event.text ?? "", 4000), mode });
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
    running = true;
    idleWaitingSince = undefined;
    writeRecord();
    send({ t: "state", running: true });
  }));
  on("agent_settled", safe(() => {
    running = false;
    streaming = undefined;
    tools.clear();
    if (tuiQueue.length) {
      tuiQueue.length = 0;
      send({ t: "queue", items: queueView() });
    }
    send({ t: "state", ...runState() });
  }));
  // "After it ends" messages (the bridge's own queue): deliver the first one
  // as a fresh prompt, one at a time — the rest wait for the NEXT agent_end.
  // A phone already connected has already seen it live (no "needs you" badge
  // for someone watching); one with no phone open gets the idle-waiting mark.
  on("agent_end", safe(() => {
    deliverNextQueued();
    if (clients.size === 0) {
      idleWaitingSince = Date.now();
      writeRecord();
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

  on("model_select", safe(() => send({ t: "state", ...runState() })));
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
