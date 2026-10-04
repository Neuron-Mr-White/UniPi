/**
 * Page 1 — "This session": what the user actually wants to know right now.
 *
 *   cost · tokens · replies · time        (big gradient numbers)
 *   context window meter                  (green → amber → red)
 *   token mix share bar + cache hit       (where the tokens went)
 *   tokens per reply                      (braille area chart)
 *   tools used                            (ranked bars, errors in red)
 *   footer facts                          (files touched, compactions, branch)
 *
 * Collection walks the session branch once and is memoised by
 * (leaf id, branch length), so redraws and repeated opens are free.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { brailleArea, compact, CRAB, duration, fitTo, money, shareBar, sideBySide, splitWidth, type RGB } from "@pi-unipi/core";
import type { GroupData, PageContext } from "../types.js";
import { GOOD_BAD, dim, empty, kvColumns, legend, meterRow, muted, rankBars, section, tiles } from "../tui/page-kit.js";

import { contextBreakdown, renderContext, type ContextBreakdown } from "./context.js";

export interface SessionRaw {
  model: string;
  provider: string;
  thinking: string;
  ctxTokens: number | null;
  ctxWindow: number;
  ctxPct: number | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  prompts: number;
  replies: number;
  toolCalls: number;
  toolErrors: number;
  tools: Array<[string, number, number]>; // name, calls, errors
  files: number;
  compactions: number;
  startedAt: number;
  perReply: number[];
  cwd: string;
  branch: string | null;
  name: string | null;
  context?: ContextBreakdown;
}

/** Minimal slice of ExtensionContext the collector reads. */
export interface SessionCtxLike {
  cwd?: string;
  model?: { id?: string; name?: string; provider?: string; contextWindow?: number } | undefined;
  getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  sessionManager?: {
    getBranch?: () => unknown[];
    getLeafId?: () => string | null;
    getHeader?: () => { timestamp?: string } | null;
    getSessionName?: () => string | undefined;
    getSessionDir?: () => string;
    buildSessionProjection?: () => { messages: unknown[] };
  };
  getSystemPrompt?: () => string;
}

const branchCache = new Map<string, { head: string | null; at: number }>();

/** Current git branch by reading .git/HEAD upward (no subprocess). Cached 10s. */
export function gitBranch(cwd: string): string | null {
  const hit = branchCache.get(cwd);
  if (hit && Date.now() - hit.at < 10_000) return hit.head;
  let head: string | null = null;
  let dir = cwd;
  for (let i = 0; i < 40 && head === null; i++) {
    const git = join(dir, ".git");
    if (existsSync(git)) {
      try {
        let headPath = join(git, "HEAD");
        if (statSync(git).isFile()) {
          const txt = readFileSync(git, "utf-8").trim();
          if (txt.startsWith("gitdir:")) headPath = join(resolve(dir, txt.slice(7).trim()), "HEAD");
        }
        const ref = readFileSync(headPath, "utf-8").trim();
        head = ref.startsWith("ref: refs/heads/") ? ref.slice(16) : ref.slice(0, 7);
      } catch {
        head = null;
      }
      break;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  branchCache.set(cwd, { head, at: Date.now() });
  return head;
}

let ctxMemo: { key: string; value: ContextBreakdown } | null = null;
let memo: { key: string; raw: Omit<SessionRaw, "ctxTokens" | "ctxWindow" | "ctxPct" | "model" | "provider" | "thinking" | "branch"> } | null = null;

/** Walk the branch once; memoised on leaf id + length. */
export function collectSession(ctx: SessionCtxLike, thinking: string, toolSchemaChars = 0): SessionRaw {
  const sm = ctx.sessionManager;
  let branch: unknown[] = [];
  try {
    branch = sm?.getBranch?.() ?? [];
  } catch {
    branch = [];
  }
  const leaf = (() => {
    try {
      return sm?.getLeafId?.() ?? "";
    } catch {
      return "";
    }
  })();
  const key = `${leaf}|${branch.length}`;
  if (!memo || memo.key !== key) {
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
    let prompts = 0, replies = 0, toolCalls = 0, toolErrors = 0, compactions = 0;
    let startedAt = 0;
    const tools = new Map<string, [number, number]>();
    const callName = new Map<string, string>();
    const files = new Set<string>();
    const perReply: number[] = [];
    for (const raw of branch) {
      const e = raw as { type?: string; timestamp?: string; message?: any };
      if (!startedAt && e.timestamp) {
        const t = Date.parse(e.timestamp);
        if (Number.isFinite(t)) startedAt = t;
      }
      if (e.type === "compaction") compactions++;
      if (e.type !== "message" || !e.message) continue;
      const m = e.message;
      if (m.role === "user") prompts++;
      else if (m.role === "assistant") {
        if (m.stopReason === "error" || m.stopReason === "aborted") continue;
        replies++;
        const u = m.usage ?? {};
        input += u.input ?? 0;
        output += u.output ?? 0;
        cacheRead += u.cacheRead ?? 0;
        cacheWrite += u.cacheWrite ?? 0;
        cost += u.cost?.total ?? 0;
        perReply.push((u.input ?? 0) + (u.output ?? 0) + (u.cacheWrite ?? 0) + (u.cacheRead ?? 0));
        for (const c of Array.isArray(m.content) ? m.content : []) {
          if (c?.type !== "toolCall" || typeof c.name !== "string") continue;
          toolCalls++;
          callName.set(c.id, c.name);
          const t = tools.get(c.name) ?? [0, 0];
          t[0]++;
          tools.set(c.name, t);
          const path = c.arguments?.path ?? c.arguments?.file_path;
          if (typeof path === "string" && /^(edit|write|multi_edit)$/i.test(c.name)) files.add(path);
        }
      } else if (m.role === "toolResult" && m.isError) {
        toolErrors++;
        const name = m.toolName ?? callName.get(m.toolCallId);
        const t = name ? tools.get(name) : undefined;
        if (t) t[1]++;
      }
    }
    let name: string | null = null;
    try {
      name = sm?.getSessionName?.() ?? null;
    } catch {
      name = null;
    }
    if (!startedAt) {
      try {
        const h = sm?.getHeader?.();
        if (h?.timestamp) startedAt = Date.parse(h.timestamp) || 0;
      } catch {
        /* ignore */
      }
    }
    memo = {
      key,
      raw: {
        input, output, cacheRead, cacheWrite, cost, prompts, replies, toolCalls, toolErrors, compactions,
        startedAt: startedAt || Date.now(),
        tools: [...tools.entries()].map(([n, [c, er]]) => [n, c, er] as [string, number, number]).sort((a, b) => b[1] - a[1]),
        files: files.size,
        perReply: perReply.slice(-160),
        cwd: ctx.cwd ?? process.cwd(),
        name,
      },
    };
  }
  let usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  try {
    usage = ctx.getContextUsage?.();
  } catch {
    usage = undefined;
  }
  const cwd = memo.raw.cwd;
  // Context breakdown: memoised with the branch walk (same key) + tool chars.
  const ctxKey = `${key}|${toolSchemaChars}|${usage?.tokens ?? "?"}`;
  if (!ctxMemo || ctxMemo.key !== ctxKey) {
    let messages: unknown[] = [];
    let systemPrompt = "";
    try {
      messages = sm?.buildSessionProjection?.().messages ?? [];
    } catch {
      messages = [];
    }
    try {
      systemPrompt = ctx.getSystemPrompt?.() ?? "";
    } catch {
      systemPrompt = "";
    }
    ctxMemo = {
      key: ctxKey,
      value: contextBreakdown({
        systemPrompt,
        toolSchemas: toolSchemaChars,
        messages,
        used: usage?.tokens ?? null,
        window: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
      }),
    };
  }
  return {
    context: ctxMemo.value,
    ...memo.raw,
    model: ctx.model?.name ?? ctx.model?.id ?? "no model",
    provider: ctx.model?.provider ?? "",
    thinking,
    ctxTokens: usage?.tokens ?? null,
    ctxWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
    ctxPct: usage?.percent ?? null,
    branch: gitBranch(cwd),
  };
}

export function sessionData(raw: SessionRaw): GroupData {
  return {
    cost: { value: money(raw.cost) },
    tokens: { value: compact(raw.input + raw.output + raw.cacheRead + raw.cacheWrite) },
    replies: { value: String(raw.replies) },
    raw: { value: "", raw },
  };
}

function shortHome(p: string): string {
  const h = homedir();
  return p.startsWith(h) ? `~${p.slice(h.length)}` : p;
}

const MIX: Record<string, RGB> = {
  input: [0, 200, 240],
  output: CRAB.orange,
  cacheRead: [120, 200, 120],
  cacheWrite: [190, 150, 240],
};

export function renderSession(pc: PageContext): string[] {
  const raw = pc.data.raw?.raw as SessionRaw | undefined;
  if (!raw) return empty(pc, "No session yet", "send a prompt and come back");
  const p = pc.paint;
  const out: string[] = [];
  const thinking = raw.thinking && raw.thinking !== "off" ? `${raw.thinking}` : "";
  const modelLine = `${p.bold(p.rgb(pc.accent, raw.model))}${thinking ? p.fg("dim", ` · ${thinking}`) : ""}`;
  out.push(section(pc, raw.name ? `session  ${raw.name}`.slice(0, 24) : "this session", modelLine));

  const total = raw.input + raw.output + raw.cacheRead + raw.cacheWrite;
  const elapsed = pc.now - raw.startedAt;
  out.push(
    ...tiles(pc, [
      { scope: "s", label: "cost", value: money(raw.cost), sub: raw.replies > 0 ? `${money(raw.cost / raw.replies)} / reply` : "nothing spent", stops: [CRAB.gold, CRAB.orange, CRAB.red] },
      { scope: "s", label: "tokens", value: compact(total), sub: `${compact(raw.output)} written`, stops: [[0, 200, 240], [120, 160, 255], [190, 150, 240]] },
      { scope: "s", label: "replies", value: String(raw.replies), sub: `${raw.prompts} prompt${raw.prompts === 1 ? "" : "s"}`, stops: [[120, 200, 120], [78, 201, 176], [0, 200, 240]] },
      { scope: "s", label: "time", value: duration(elapsed).replace(/ /g, ""), sub: `since ${new Date(raw.startedAt).toTimeString().slice(0, 5)}`, stops: [[190, 150, 240], [230, 120, 200], CRAB.orange] },
    ]),
  );

  // Context window — what fills it.
  out.push("");
  if (raw.context && raw.ctxWindow > 0) {
    out.push(...renderContext(pc, { ...raw.context, used: raw.ctxTokens && raw.ctxTokens > 0 ? raw.ctxTokens : raw.context.used, window: raw.ctxWindow }));
  } else {
    out.push(section(pc, "context", dim(p, "no model selected"), "s"));
  }

  // Token mix.
  if (total > 0) {
    out.push("");
    const hit = raw.cacheRead + raw.input > 0 ? raw.cacheRead / (raw.cacheRead + raw.input) : 0;
    out.push(section(pc, "billed tokens", `${dim(p, "cache hit")} ${p.bold(p.rgb(MIX.cacheRead!, `${Math.round(hit * 100)}%`))}`));
    out.push(
      fitTo(
        shareBar(p, [
          { value: raw.input, color: MIX.input! },
          { value: raw.output, color: MIX.output! },
          { value: raw.cacheRead, color: MIX.cacheRead! },
          { value: raw.cacheWrite, color: MIX.cacheWrite! },
        ], pc.width, "▆"),
        pc.width,
      ),
    );
    const pctOf = (n: number): string => `${Math.round((n / total) * 100)}%`;
    out.push(...legend(pc, [
        { label: `input ${compact(raw.input)} ${pctOf(raw.input)}`, color: MIX.input! },
        { label: `output ${compact(raw.output)} ${pctOf(raw.output)}`, color: MIX.output! },
        { label: `cache read ${compact(raw.cacheRead)}`, color: MIX.cacheRead! },
        { label: `cache write ${compact(raw.cacheWrite)}`, color: MIX.cacheWrite! },
      ]),
    );
  }

  // Activity + tools: side by side when wide, stacked otherwise.
  const activity: string[] = [];
  const toolsBlock: string[] = [];
  const wide = pc.width >= 96;
  const [lw, rw] = wide ? splitWidth(pc.width, 2, 4) : [pc.width, pc.width];
  if (raw.perReply.length > 1) {
    const sub = { ...pc, width: lw! };
    const peak = Math.max(...raw.perReply);
    activity.push(section(sub, "per reply", dim(p, `peak ${compact(peak)}`)));
    activity.push(...brailleArea(p, raw.perReply, lw!, wide ? 5 : 3, [[0, 160, 200], [120, 160, 255], CRAB.orange]));
    activity.push(fitTo(dim(p, `${raw.perReply.length} replies · last ${compact(raw.perReply[raw.perReply.length - 1] ?? 0)}`), lw!));
  }
  if (raw.toolCalls > 0) {
    const sub = { ...pc, width: rw! };
    const err = raw.toolErrors > 0 ? p.rgb([230, 90, 80], `${raw.toolErrors} failed`) : p.rgb([120, 200, 120], "0 failed");
    toolsBlock.push(section(sub, "tools", `${muted(p, `${raw.toolCalls}`)} ${p.fg("borderMuted", "·")} ${err}`));
    const rows = raw.tools.map(([n, c, e]) => ({ name: n, value: c, label: e > 0 ? `${c} ${p.rgb([230, 90, 80], `✗${e}`)}` : String(c) }));
    const shown = wide ? 6 : 5;
    toolsBlock.push(...rankBars(sub, rows, shown, { nameW: Math.min(16, Math.max(...raw.tools.map((t) => t[0].length)) + 1) }));
    if (raw.tools.length > shown) toolsBlock.push(fitTo(dim(p, `   + ${raw.tools.length - shown} more`), rw!));
  }
  if (activity.length || toolsBlock.length) out.push("");
  if (wide && activity.length && toolsBlock.length) {
    out.push(...sideBySide([{ lines: activity, width: lw! }, { lines: toolsBlock, width: rw! }], 4));
  } else {
    out.push(...activity);
    if (activity.length && toolsBlock.length) out.push("");
    out.push(...toolsBlock);
  }

  // Facts.
  out.push("");
  out.push(section(pc, "where"));
  out.push(
    ...kvColumns(pc, [
      ["directory", shortHome(raw.cwd)],
      ["branch", raw.branch ?? "—"],
      ["files edited", String(raw.files)],
      ["compactions", String(raw.compactions)],
      ["provider", raw.provider || "—"],
      ["prompts", String(raw.prompts)],
    ]),
  );
  return out;
}
