/**
 * @unipi/memory — Tool registration
 *
 * memory_store / memory_search / memory_list / memory_delete plus the legacy
 * global_* aliases. The store "peek" stays local to the project's md files;
 * reads go through the session reader so every drawer (pi + foreign) shows up.
 * renderCall/renderResult produce the rail-framed memory cards.
 */

import { Type } from "typebox";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { UNIPI_EVENTS, emitEvent, meter, rail, type KitTheme } from "@pi-unipi/core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionBackend, SearchHit } from "./session.js";
import { findByTitle, findSimilar } from "./files.js";
import { MEMORY_TYPES, type MemoryType } from "./paths.js";

export const MEMORY_TOOLS = {
  STORE: "memory_store",
  SEARCH: "memory_search",
  DELETE: "memory_delete",
  LIST: "memory_list",
  GLOBAL_SEARCH: "global_memory_search",
  GLOBAL_LIST: "global_memory_list",
} as const;

export interface ToolActivity {
  onRecall?: () => void;
  onStore?: () => void;
  /** Fired after every write attempt — used to kick the pending journal. */
  onWriteDone?: () => void;
}

type ThemeLike = KitTheme;

/** Memory's own colour (purple) — the rail that marks every memory surface. */
const MEMORY_COLOR = "customMessageLabel";

export type CardTone = "memory" | "success" | "warning" | "error";

/** One rail row: left text, optional right-aligned text. */
export type RailRow = string | { left: string; right?: string };

/**
 * Rail card (no tinted box):
 *   ▌ Memory "subagent test UX"                     5 hits · 1 project
 *   ▌ ██████▌░ pi_test_kanboard_sanity   pi_test › summary · pi
 * `tone` recolours the rail for warning/error outcomes.
 */
export function memoryCard(theme: ThemeLike, rows: RailRow[], tone: CardTone = "memory"): Component {
  const color = tone === "warning" || tone === "error" ? tone : MEMORY_COLOR;
  return {
    invalidate() {},
    render: (w: number) => rows.map((r) => truncateToWidth(typeof r === "string" ? rail(theme, color, r, "", w) : rail(theme, color, r.left, r.right ?? "", w), w)),
  };
}

const EMPTY: Component = { invalidate() {}, render: () => [] };

/** Pending call line; disappears once the result card takes over. */
function pendingLine(theme: ThemeLike, context: unknown, text: string): Component {
  if ((context as { isPartial?: boolean } | undefined)?.isPartial === false) return EMPTY;
  return memoryCard(theme, [`${theme.bold("Memory")} ${theme.fg("dim", text)}`]);
}

function outcomeTone(outcome: unknown): CardTone {
  return outcome === "filed" ? "success" : outcome === "queued" ? "warning" : outcome ? "error" : "memory";
}

function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case "filed": return "✓ filed";
    case "queued": return "⧗ queued";
    default: return "⚠ markdown only";
  }
}

function outcomeColor(outcome: string): "success" | "warning" | "error" {
  return outcome === "filed" ? "success" : outcome === "queued" ? "warning" : "error";
}

function sourceLabel(raw: string): string {
  switch (raw) {
    case "unipi":
    case "unipi-memory-bridge": return "pi";
    case "devin-cli": return "devin";
    case "zcode": return "zcode";
    default: return raw || "mempalace";
  }
}

const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? "" : "s"}`;

/** `▌ Memory title                      ✓ filed  project › type` (+ similar rows). */
export function storeRows(
  t: ThemeLike,
  d: { action?: string; title?: string; project?: string; type?: string; outcome?: string; similar?: string[] },
): RailRow[] {
  const outcome = d.outcome ?? "filed";
  return [
    {
      left: `${t.bold("Memory")} ${d.action === "updated" ? t.fg("dim", "updated ") : ""}${d.title ?? ""}`,
      right: `${t.fg(outcomeColor(outcome), outcomeLabel(outcome))} ${t.fg("dim", `${d.project ?? ""} › ${d.type ?? ""}`)}`,
    },
    ...(d.similar ?? []).map((s) => t.fg("dim", `~ similar: ${s}`)),
  ];
}

/** Head `Memory "query" … N hits · P projects`, then one meter row per hit. */
export function searchRows(t: ThemeLike, query: string, hits: SearchHit[], shown = hits.length): RailRow[] {
  const projects = new Set(hits.map((h) => h.wing)).size;
  return [
    { left: `${t.bold("Memory")} "${query}"`, right: t.fg("dim", `${plural(hits.length, "hit")} · ${plural(projects, "project")}`) },
    ...hits.slice(0, shown).map((h) => ({
      left: `${meter(t, h.score, 8, MEMORY_COLOR)} ${h.title}`,
      right: t.fg("dim", `${h.wing} › ${h.room} · ${sourceLabel(h.sourceLabel)}`),
    })),
  ];
}

/** Search result card (also used by the global alias). */
function searchCard(t: ThemeLike, details: unknown, expanded: boolean): Component {
  const d = details as { query?: string; hits?: SearchHit[] } | undefined;
  const hits = d?.hits ?? [];
  if (hits.length === 0) return memoryCard(t, [{ left: `${t.bold("Memory")} "${d?.query ?? ""}"`, right: t.fg("dim", "no matches") }]);
  const shown = expanded ? hits.length : Math.min(5, hits.length);
  const rows = searchRows(t, d?.query ?? "", hits, shown);
  if (hits.length > shown) rows.push(t.fg("dim", `… ${String(hits.length - shown)} more`));
  return memoryCard(t, rows);
}

/** `Memory 12 stored` + one row per memory (title … type / project). */
function listCard(t: ThemeLike, details: unknown, expanded: boolean, global: boolean): Component {
  const mems = (details as { memories?: Array<{ title: string; type: string; project?: string }> } | undefined)?.memories ?? [];
  const shown = expanded ? mems : mems.slice(0, 8);
  const rows: RailRow[] = [{ left: `${t.bold("Memory")} ${String(mems.length)} ${mems.length === 1 ? "memory" : "memories"}`, right: t.fg("dim", global ? "all projects" : "this project") }];
  for (const m of shown) rows.push({ left: m.title, right: t.fg("dim", global ? `${m.project ?? ""} › ${m.type}` : m.type) });
  if (mems.length > shown.length) rows.push(t.fg("dim", `… ${String(mems.length - shown.length)} more`));
  return memoryCard(t, rows);
}

/** The real tool bodies, callable outside the main registration — the
 *  background save session mounts these on its stub tools. */
export interface MemoryExecutors {
  store: (
    params: { title: string; content: string; tags?: string[]; type?: string },
    ctx: { cwd: string },
  ) => Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }>;
  search: (params: {
    query: string;
    limit?: number;
    scope?: string;
  }) => Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }>;
  remove: (params: {
    title?: string;
    id?: string;
  }) => Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }>;
  list: () => Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }>;
  globalList: () => Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }>;
}

type EventSink = { events: { emit: (name: string, payload: unknown) => void } };

export function memoryExecutors(
  pi: EventSink,
  backend: () => SessionBackend | null,
  activity?: ToolActivity,
): MemoryExecutors {
  const W = () => backend();
  const localPeek = (title: string) => {
    const b = W();
    if (!b) return { exact: null as ReturnType<typeof findByTitle>, similar: [] as string[] };
    const exact = findByTitle(b.project, title);
    const similar = findSimilar(b.project, title, 0.6)
      .filter((x) => x.record.title !== title && x.record.id !== exact?.id)
      .slice(0, 3)
      .map((x) => `"${x.record.title}" (${Math.round(x.similarity * 100)}%)`);
    return { exact, similar };
  };

  const store = async (
    params: { title: string; content: string; tags?: string[]; type?: string },
    ctx: { cwd: string },
  ) => {
    activity?.onStore?.();
    const b = W();
    if (!b) {
      return {
        content: [{ type: "text" as const, text: `Memory backend unavailable — nothing stored. Keep the important detail in the conversation or a file.` }],
        details: { action: "unavailable" },
      };
    }
    const { exact, similar } = localPeek(params.title);
    const type = (MEMORY_TYPES as readonly string[]).includes(params.type ?? "")
      ? (params.type as MemoryType)
      : exact?.type ?? "summary";

    if (exact && exact.content.trim() === params.content.trim() && (exact.type ?? "") === type) {
      return {
        content: [{ type: "text" as const, text: `⚠️ Memory already exists with this title and content: "${params.title}". Update it with new content instead of duplicating.` }],
        details: { action: "duplicate_detected", id: exact.id },
      };
    }

    const res = await b.store({
      id: exact?.id || "",
      title: params.title,
      content: params.content,
      tags: params.tags ?? exact?.tags ?? [],
      type,
      filePath: undefined,
    });
    activity?.onWriteDone?.();
    const action = exact ? "updated" : "created";
    emitEvent(pi, UNIPI_EVENTS.MEMORY_STORED, {
      id: res.record.id,
      title: res.record.title,
      type,
      project: b.project,
      action,
    });
    const lines = [
      `${exact ? "Updated" : "Stored"} memory: ${params.title}`,
      `${b.project} › ${type} · ${res.outcome === "filed" ? "filed to the palace" : res.outcome === "queued" ? "queued — the palace will pick it up" : "markdown only — daemon unreachable"}`,
    ];
    if (similar.length > 0) lines.push(`Similar memories: ${similar.join(", ")}`);
    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
      details: {
        action,
        id: res.record.id,
        title: res.record.title,
        project: b.project,
        type,
        outcome: res.outcome,
        similar: similar.length ? similar : undefined,
      },
    };
  };

  const search = async (
    params: { query: string; limit?: number; scope?: string },
  ) => {
    activity?.onRecall?.();
    const b = W();
    if (!b) {
      return {
        content: [{ type: "text" as const, text: `Memory search unavailable — the memory backend isn't running.` }],
        details: { results: [] },
      };
    }
    const limit = params.limit || 10;
    const scope = params.scope === "project" ? "project" : "all";
    const hits = await b.search(params.query, limit, scope);
    if (hits.length === 0) {
      return {
        content: [{ type: "text" as const, text: `No memories found for: "${params.query}"` }],
        details: { query: params.query, hits: [] },
      };
    }
    const output = hits
      .map((h, i) => `${i + 1}. [${h.wing}] **${h.title}** (${h.room} · ${sourceLabel(h.sourceLabel)})\n   ${h.snippet}`)
      .join("\n\n");
    return {
      content: [{ type: "text" as const, text: `Found ${hits.length} memories:\n\n${output}` }],
      details: { query: params.query, hits },
    };
  };

  const remove = async (params: { title?: string; id?: string }) => {
    activity?.onStore?.();
    const b = W();
    if (!b) {
      return { content: [{ type: "text" as const, text: `Memory backend unavailable — nothing deleted.` }], details: { deleted: false } };
    }
    const key = params.id || params.title;
    if (!key) {
      return { content: [{ type: "text" as const, text: "Provide a title or id to delete." }], details: { deleted: false } };
    }
    const res = await b.delete(b.project, key);
    activity?.onWriteDone?.();
    if (res.found) {
      emitEvent(pi, UNIPI_EVENTS.MEMORY_DELETED, { id: key, title: key, project: b.project });
    }
    return {
      content: [{ type: "text" as const, text: res.found ? `Deleted memory: ${key} (${res.outcome})` : `Memory not found: ${key}` }],
      details: { deleted: res.found, id: key, title: key, outcome: res.outcome },
    };
  };

  const list = async () => {
    activity?.onRecall?.();
    const b = W();
    const memories = b ? await b.list() : [];
    if (memories.length === 0) {
      return { content: [{ type: "text" as const, text: "No memories stored for this project." }], details: { memories: [] } };
    }
    const output = memories.map((m) => `- ${m.title} (${m.type})`).join("\n");
    return {
      content: [{ type: "text" as const, text: `Project memories (${memories.length}):\n\n${output}` }],
      details: { memories },
    };
  };

  const globalList = async () => {
    activity?.onRecall?.();
    const b = W();
    if (!b) {
      return { content: [{ type: "text" as const, text: "Memory backend unavailable." }], details: { memories: [] } };
    }
    // Pull every project dir's md files for a cross-project list.
    const { listProjectDirs } = await import("./files.js");
    const { sanitizeProjectName } = await import("./paths.js");
    const memories: Array<{ project: string; id: string; title: string; type: string }> = [];
    for (const { name } of listProjectDirs()) {
      for (const m of await b.list(sanitizeProjectName(name))) {
        memories.push(m);
      }
    }
    if (memories.length === 0) {
      return { content: [{ type: "text" as const, text: "No memories stored in any project." }], details: { memories: [] } };
    }
    const grouped = new Map<string, typeof memories>();
    for (const m of memories) {
      grouped.set(m.project, [...(grouped.get(m.project) ?? []), m]);
    }
    let output = "";
    for (const [p, ms] of grouped) {
      output += `\n**${p}** (${ms.length}):\n` + ms.map((m) => `  - ${m.title} (${m.type})`).join("\n") + "\n";
    }
    return {
      content: [{ type: "text" as const, text: `All memories across ${grouped.size} projects (${memories.length} total):${output}` }],
      details: { memories },
    };
  };

  return { store, search, remove, list, globalList };
}

export function registerMemoryTools(
  pi: ExtensionAPI,
  backend: () => SessionBackend | null,
  activity?: ToolActivity,
  options?: { neutral?: boolean },
): void {
  // recallAtStart=off swaps the "call BEFORE work" nudge for neutral wording —
  // the tools stay callable, the agent just isn't ordered to use them first.
  const neutral = options?.neutral === true;
  const ex = memoryExecutors(pi, backend, activity);

  pi.registerTool({
    name: MEMORY_TOOLS.STORE,
    label: "Store Memory",
    description:
      "Store or update a memory for cross-session recall — user preferences, project decisions, " +
      "code patterns, and conversation summaries. Update existing memories instead of creating duplicates.",
    promptSnippet: "Store a memory for cross-session recall.",
    promptGuidelines: neutral
      ? [
          "memory_store saves a memory for future sessions; use it when you learned something worth keeping.",
          "Search for existing similar memories first — update if found, create if not.",
        ]
      : [
          "Save non-obvious findings with memory_store at the end of substantive work.",
          "Search for existing similar memories first — update if found, create if not.",
          "Memory is scoped to the current project. Use for decisions, preferences, patterns, summaries.",
        ],
    parameters: Type.Object({
      title: Type.String({ description: "Memory title in <most_important>_<less_important>_<lesser> format (e.g., 'auth_jwt_prefer_refresh_tokens')" }),
      content: Type.String({ description: "Full memory content (markdown supported)" }),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization" })),
      type: Type.Optional(Type.String({ description: "Memory type", enum: [...MEMORY_TYPES] })),
    }),
    renderShell: "self",
    renderCall: (args, theme, context) => pendingLine(theme, context, `remembering ${String(args.title ?? "").slice(0, 60)}…`),
    renderResult: (result, _o, theme) => {
      const d = result.details as { action?: string; outcome?: string; similar?: string[]; title?: string; project?: string; type?: string } | undefined;
      const text = result.content?.map((c) => ("text" in c ? c.text : "")).join("\n") ?? "";
      if (!d?.outcome) return memoryCard(theme, [`${theme.bold("Memory")} ${theme.fg("warning", text.split("\n")[0] ?? "")}`], "warning");
      return memoryCard(theme, storeRows(theme, d), outcomeTone(d.outcome));
    },
    async execute(_id, params, _s, _o, ctx) {
      return ex.store(params, ctx);
    },
  });

  pi.registerTool({
    name: MEMORY_TOOLS.SEARCH,
    label: "Search Memory",
    description: neutral
      ? "Searches memories by keyword across ALL projects — pi memories plus drawers written by other tools " +
        "(Devin, zcode, diaries). Results show [project] title, score, and snippet. Use scope='project' for current project only."
      : "IMPORTANT: Call BEFORE starting work to check for existing context. " +
        "Searches memories by keyword across ALL projects — pi memories plus drawers written by other tools " +
        "(Devin, zcode, diaries). Results show [project] title, score, and snippet. Use scope='project' for current project only.",
    promptSnippet: neutral
      ? "Search memories when relevant."
      : "Search memories for relevant context before starting work.",
    promptGuidelines: neutral
      ? [
          "memory_search is available when you need past context.",
          "Use scope='project' when you only want this project's memories.",
        ]
      : [
          "IMPORTANT: Always call memory_search before making decisions when you suspect past work exists.",
          "Results include memories from other tools — [project] › room tells you where each came from.",
          "Use scope='project' when you only want this project's memories.",
        ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10)", default: 10 })),
      scope: Type.Optional(Type.String({ description: "'all' (default) or 'project'", enum: ["all", "project"], default: "all" })),
    }),
    renderShell: "self",
    renderCall: (args, theme, context) => pendingLine(theme, context, `searching "${String(args.query).slice(0, 60)}"…`),
    renderResult: (result, options, theme) => searchCard(theme, result.details, options.expanded),
    async execute(_id, params, _s, _o, _ctx) {
      return ex.search(params);
    },
  });

  // Thin aliases — still callable, not advertised.
  pi.registerTool({
    name: MEMORY_TOOLS.GLOBAL_SEARCH,
    label: "Search All Projects",
    description: "Alias for memory_search with scope='all'.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ default: 10 })),
    }),
    renderShell: "self",
    renderCall: (args, theme, context) => pendingLine(theme, context, `searching "${String(args.query).slice(0, 60)}"…`),
    renderResult: (result, options, theme) => searchCard(theme, result.details, options.expanded),
    async execute(_id, params, _s, _o, _ctx) {
      return ex.search({ query: params.query, limit: params.limit, scope: "all" });
    },
  });

  pi.registerTool({
    name: MEMORY_TOOLS.DELETE,
    label: "Delete Memory",
    description: "Delete a memory by title or ID from the current project.",
    promptSnippet: "Delete a memory.",
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "Memory title to delete" })),
      id: Type.Optional(Type.String({ description: "Memory ID to delete" })),
    }),
    renderShell: "self",
    renderCall: (_args, theme, context) => pendingLine(theme, context, "forgetting…"),
    renderResult: (result, _o, theme) => {
      const d = result.details as Record<string, unknown> | undefined;
      const outcome = String(d?.outcome ?? "filed");
      const right = d?.deleted ? theme.fg(outcomeColor(outcome), outcomeLabel(outcome)) : theme.fg("warning", "not found");
      return memoryCard(theme, [{ left: `${theme.bold("Memory")} ${theme.fg("dim", "forgot")} ${String(d?.title ?? d?.id ?? "memory")}`, right }], d?.deleted ? outcomeTone(outcome) : "warning");
    },
    async execute(_id, params, _s, _o, _ctx) {
      return ex.remove(params);
    },
  });

  pi.registerTool({
    name: MEMORY_TOOLS.LIST,
    label: "List Project Memories",
    description: "List all memories for the current project.",
    promptSnippet: "List all project memories.",
    parameters: Type.Object({}),
    renderShell: "self",
    renderCall: (_args, theme, context) => pendingLine(theme, context, "listing…"),
    renderResult: (result, options, theme) => listCard(theme, result.details, options.expanded, false),
    async execute(_id, _p, _s, _o, _ctx) {
      return ex.list();
    },
  });

  pi.registerTool({
    name: MEMORY_TOOLS.GLOBAL_LIST,
    label: "List All Project Memories",
    description: "List all memories across all projects with project names.",
    parameters: Type.Object({}),
    renderShell: "self",
    renderCall: (_args, theme, context) => pendingLine(theme, context, "listing…"),
    renderResult: (result, options, theme) => listCard(theme, result.details, options.expanded, true),
    async execute(_id, _p, _s, _o, _ctx) {
      return ex.globalList();
    },
  });
}
