/**
 * The app bridge: lets the UniPi phone app mirror this pi session live and
 * talk to it (unipi-app docs/m5/PROTOCOL.md).
 *
 * - TUI mode only. Listens on ~/.unipi/bridge/<pid>.sock (0600) and keeps
 *   ~/.unipi/bridge/<pid>.json current so unipi-host can match a herdr pane
 *   (whose pi session file it knows) to this socket.
 * - Every hook body is try/catch: the bridge must never break a turn.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DialogHub, wrapUi } from "./dialogs.js";
import { ENTRIES_BUDGET, HELLO_ENTRIES_BUDGET, LINE_BUDGET, fitLine, historyPage, jsonBytes, phoneSafe, snapshotEntries, clipText, wantedEntry } from "./snapshot.js";
import {
  BRIDGE_PROTOCOL,
  LineSplitter,
  parseIn,
  type CommandInfo,
  type Dialog,
  type InMsg,
  type ModelInfo,
  type OutMsg,
  type Queued,
  type RunState,
  type SessionInfo,
} from "./wire.js";
import { setRemoteDialogs } from "./remote.js";
import { fileSuggestions } from "./files.js";

export const BRIDGE_VERSION = "1.0.0";

/** Commands the app maps to bridge calls (pi's built-ins can't be sent as text). */
const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: "model", description: "Switch the model", source: "builtin" },
  { name: "thinking", description: "Set the thinking level", source: "builtin" },
  { name: "compact", description: "Compact the conversation", source: "builtin" },
];

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

const textOfContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: string; text: string } => !!p && (p as { type?: string }).type === "text" && typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text)
    .join("");
};

export function createBridge(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let server: Server | undefined;
  let socketPath: string | undefined;
  const clients = new Set<Socket>();
  let running = false;
  const queue: Queued[] = [];
  /** The assistant message streaming now (for late joiners). */
  let streaming: { id: string; content: unknown[] } | undefined;
  let streamSeq = 0;
  const tools = new Map<string, { callId: string; name: string; args: unknown; text?: string }>();
  /** Coalesced deltas: key `${kind}:${index}` → text. */
  let pendingDeltas: Array<{ kind: "text" | "thinking" | "toolcall"; index: number; text: string }> = [];
  let deltaTimer: NodeJS.Timeout | undefined;
  const toolTimers = new Map<string, NodeJS.Timeout>();
  let sessionCost = 0;

  const hub = new DialogHub({
    open: (dialog) => send({ t: "dialog", ...dialog }),
    close: (id, by) => send({ t: "dialog_end", id, by }),
  });

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

  const commands = (): CommandInfo[] => {
    let list: CommandInfo[] = [];
    try {
      list = pi.getCommands().map((c) => ({ name: c.name, description: c.description, source: c.source }));
    } catch {
      // ignore
    }
    return [...BUILTIN_COMMANDS, ...list];
  };

  const models = (): ModelInfo[] => {
    try {
      const scoped = (ctx!.scopedModels ?? []).map((s) => s.model);
      const available = ctx!.modelRegistry.getAvailable();
      const seen = new Set<string>();
      const out: ModelInfo[] = [];
      for (const m of [...scoped, ...available]) {
        const key = `${m.provider}/${m.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(modelInfo(m)!);
        if (out.length >= 400) break;
      }
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
      queue: [...queue],
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

  const handle = async (sock: Socket, msg: InMsg) => {
    const c = ctx;
    if (!c) return;
    const ack = () => write(sock, { t: "ack", ref: msg.ref });
    const fail = (message: string) => write(sock, { t: "error", message, ref: msg.ref });
    switch (msg.t) {
      case "prompt": {
        const idle = c.isIdle();
        const deliverAs = idle ? undefined : msg.mode === "followUp" ? "followUp" : "steer";
        const content = msg.images?.length
          ? [{ type: "text" as const, text: msg.text }, ...msg.images.map((i) => ({ type: "image" as const, mimeType: i.mime, data: i.data }))]
          : msg.text;
        try {
          pi.sendUserMessage(content, { deliverAs, expandPromptTemplates: true } as never);
          ack();
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
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
      sock.setEncoding("utf8");
      const lines = new LineSplitter();
      const drop = () => clients.delete(sock);
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
  };

  const close = () => {
    for (const sock of clients) sock.destroy();
    clients.clear();
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
      if (c.hasUI) wrapUi(c.ui, hub);
      computeCost();
      setRemoteDialogs(hub);
      listen();
      writeRecord();
      if (event?.reason && event.reason !== "startup") {
        streaming = undefined;
        tools.clear();
        queue.length = 0;
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

  on("input", (event) => {
    try {
      const mode = event.streamingBehavior === "steer" || event.streamingBehavior === "followUp" ? event.streamingBehavior : "prompt";
      if (mode !== "prompt") {
        queue.push({ text: clipText(event.text ?? "", 4000), mode });
        send({ t: "queue", items: [...queue] });
      }
      send({ t: "input", text: clipText(event.text ?? "", 64 * 1024), source: event.source, mode });
    } catch {
      // ignore
    }
    return { action: "continue" };
  });

  on("agent_start", safe(() => {
    running = true;
    send({ t: "state", running: true });
  }));
  on("agent_settled", safe(() => {
    running = false;
    streaming = undefined;
    tools.clear();
    if (queue.length) {
      queue.length = 0;
      send({ t: "queue", items: [] });
    }
    send({ t: "state", ...runState() });
  }));

  on("message_start", safe((event) => {
    const m = event.message as { role?: string; content?: unknown };
    if (m.role === "user" && queue.length) {
      const text = textOfContent(m.content);
      const i = queue.findIndex((q) => q.text === clipText(text, 4000));
      if (i >= 0) {
        queue.splice(i, 1);
        send({ t: "queue", items: [...queue] });
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
