/**
 * @unipi/memory — Tool registration
 *
 * memory_store / memory_search / memory_list / memory_delete plus the legacy
 * global_* aliases. The store "peek" stays local to the project's md files;
 * reads go through the session reader so every drawer (pi + foreign) shows up.
 * renderCall/renderResult produce the rail-framed memory cards.
 */

import { Type } from "typebox";
import { Box, Text, type Component } from "@earendil-works/pi-tui";
import { UNIPI_EVENTS, emitEvent } from "@pi-unipi/core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionBackend, SearchHit, StoreResult } from "./session.js";
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

interface ThemeLike {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
  bg?: (color: string, text: string) => string;
}

/** Memory's own colour: sidekick owns accent/success/error for its rail. */
const MEMORY_COLOR = "syntaxKeyword";
const MEMORY_GLYPH = "◈";

export type CardTone = "memory" | "success" | "warning" | "error";

class RailComponent implements Component {
  constructor(private readonly inner: Component, private readonly rail: string) {}
  render(width: number): string[] {
    return this.inner.render(Math.max(1, width - 2)).map((line) => `${this.rail} ${line}`);
  }
  invalidate(): void {
    this.inner.invalidate?.();
  }
}

/** Shaded card with a memory-coloured rail (same shape as the sidekick frame).
 *  The first line is the header; `tone` recolours the rail for outcomes. */
export function memoryCard(theme: ThemeLike, lines: string[], tone: CardTone = "memory"): Component {
  const [head = "", ...rest] = lines;
  const body = [theme.fg(MEMORY_COLOR, theme.bold(head)), ...rest.map((l) => theme.fg("muted", l))].join("\n");
  const rail = theme.fg(tone === "memory" ? MEMORY_COLOR : tone, "▍");
  const box = new Box(1, 0, (text: string) => (theme.bg ? theme.bg("customMessageBg", text) : text));
  box.addChild(new RailComponent(new Text(body, 0, 0), rail));
  return box;
}

function frame(theme: ThemeLike, lines: string[], tone: CardTone = "memory"): Component {
  return memoryCard(theme, lines, tone);
}

function outcomeTone(outcome: unknown): CardTone {
  return outcome === "filed" ? "success" : outcome === "queued" ? "warning" : outcome ? "error" : "memory";
}

function scoreBar(score: number): string {
  const filled = Math.max(0, Math.min(5, Math.round(score * 5)));
  return "▰".repeat(filled) + "▱".repeat(5 - filled);
}

function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case "filed": return "filed ✓";
    case "queued": return "queued ⧗";
    default: return "markdown only ⚠";
  }
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

/** Text-only mirror of the renderers, for tests + headless output. */
export function renderStoreLine(res: StoreResult, similar: string[] = []): string {
  const lines = [
    `${MEMORY_GLYPH} remembered ${res.record.title}`,
    `${res.record.project} › ${res.record.type} · ${outcomeLabel(res.outcome)}`,
  ];
  for (const s of similar) lines.push(`~ similar: ${s}`);
  return lines.join("\n");
}

export function renderSearchLines(query: string, hits: SearchHit[], shown = hits.length): string[] {
  const projects = new Set(hits.map((h) => h.wing)).size;
  const lines = [`${MEMORY_GLYPH} recalled "${query}" · ${hits.length} memories · ${projects} projects`];
  for (const h of hits.slice(0, shown)) {
    lines.push(`${scoreBar(h.score)} ${h.title}  ${h.wing} › ${h.room} · ${sourceLabel(h.sourceLabel)}`);
  }
  return lines;
}

export function registerMemoryTools(
  pi: ExtensionAPI,
  backend: () => SessionBackend | null,
  activity?: ToolActivity,
  options?: { neutral?: boolean },
): void {
  const W = () => backend();
  // recallAtStart=off swaps the "call BEFORE work" nudge for neutral wording —
  // the tools stay callable, the agent just isn't ordered to use them first.
  const neutral = options?.neutral === true;
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

  const storeExecute = async (
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
    renderCall: (args, theme) => new Text(`${theme.fg(MEMORY_COLOR, theme.bold(`${MEMORY_GLYPH} memory`))} ${theme.fg("dim", `remembering ${String(args.title ?? "").slice(0, 60)}…`)}`, 0, 0),
    renderResult: (result, _o, theme) => {
      const d = result.details as { action?: string; outcome?: string; similar?: string[]; title?: string; project?: string; type?: string } | undefined;
      const text = result.content?.map((c) => ("text" in c ? c.text : "")).join("\n") ?? "";
      if (!d?.outcome) return frame(theme as ThemeLike, [`${MEMORY_GLYPH} ${text.split("\n")[0] ?? "memory"}`]);
      const lines = [
        `${MEMORY_GLYPH} ${d.action === "updated" ? "updated" : "remembered"} ${d.title ?? ""}`,
        `${d.project ?? ""} › ${d.type ?? ""} · ${outcomeLabel(d.outcome)}`,
        ...(d.similar ?? []).map((s) => `~ similar: ${s}`),
      ];
      return frame(theme as ThemeLike, lines, outcomeTone(d.outcome));
    },
    async execute(_id, params, _s, _o, ctx) {
      return storeExecute(params, ctx);
    },
  });

  const searchExecute = async (
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
        details: { results: [] },
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
    renderCall: (args, theme) => new Text(`${theme.fg(MEMORY_COLOR, theme.bold(`${MEMORY_GLYPH} memory`))} ${theme.fg("dim", `searching "${String(args.query).slice(0, 60)}"`)}`, 0, 0),
    renderResult: (result, options, theme) => {
      const d = result.details as { query?: string; hits?: SearchHit[] } | undefined;
      const hits = d?.hits ?? [];
      const shown = options.expanded ? hits.length : Math.min(5, hits.length);
      const lines = renderSearchLines(d?.query ?? "", hits, shown);
      if (hits.length > shown) lines.push(`… ${hits.length - shown} more`);
      return frame(theme as ThemeLike, lines);
    },
    async execute(_id, params, _s, _o, _ctx) {
      return searchExecute(params);
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
    renderCall: (args, theme) => new Text(`${theme.fg(MEMORY_COLOR, theme.bold(`${MEMORY_GLYPH} memory`))} ${theme.fg("dim", `searching "${String(args.query).slice(0, 60)}"`)}`, 0, 0),
    renderResult: (result, options, theme) => {
      const d = result.details as { query?: string; hits?: SearchHit[] } | undefined;
      const hits = d?.hits ?? [];
      const shown = options.expanded ? hits.length : Math.min(5, hits.length);
      const lines = renderSearchLines(d?.query ?? "", hits, shown);
      if (hits.length > shown) lines.push(`… ${hits.length - shown} more`);
      return frame(theme as ThemeLike, lines);
    },
    async execute(_id, params, _s, _o, _ctx) {
      activity?.onRecall?.();
      return searchExecute({ query: params.query, limit: params.limit, scope: "all" });
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
    renderCall: (_args, theme) => new Text(`${theme.fg(MEMORY_COLOR, theme.bold(`${MEMORY_GLYPH} memory`))} ${theme.fg("dim", "forgetting…")}`, 0, 0),
    renderResult: (result, _o, theme) => {
      const d = result.details as Record<string, unknown> | undefined;
      const lines = [
        `${MEMORY_GLYPH} forgot ${String(d?.title ?? d?.id ?? "memory")}`,
        String(d?.deleted ? outcomeLabel(String(d.outcome ?? "filed")) : "not found"),
      ];
      return frame(theme as ThemeLike, lines, d?.deleted ? outcomeTone(d.outcome ?? "filed") : "warning");
    },
    async execute(_id, params, _s, _o, _ctx) {
      activity?.onStore?.();
      const b = W();
      if (!b) {
        return { content: [{ type: "text" as const, text: "Memory backend unavailable — nothing deleted." }], details: { deleted: false } };
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
    },
  });

  pi.registerTool({
    name: MEMORY_TOOLS.LIST,
    label: "List Project Memories",
    description: "List all memories for the current project.",
    promptSnippet: "List all project memories.",
    parameters: Type.Object({}),
    renderCall: (_args, theme) => new Text(`${theme.fg(MEMORY_COLOR, theme.bold(`${MEMORY_GLYPH} memory`))} ${theme.fg("dim", "listing")}`, 0, 0),
    renderResult: (result, options, theme) => {
      const d = result.details as { memories?: Array<{ title: string; type: string }> } | undefined;
      const mems = d?.memories ?? [];
      const shown = options.expanded ? mems : mems.slice(0, 8);
      const lines = [`${MEMORY_GLYPH} memories · ${mems.length} stored`];
      for (const m of shown) lines.push(`${m.title} · ${m.type}`);
      if (!options.expanded && mems.length > shown.length) lines.push(`… ${mems.length - shown.length} more`);
      return frame(theme as ThemeLike, lines);
    },
    async execute(_id, _p, _s, _o, _ctx) {
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
    },
  });

  pi.registerTool({
    name: MEMORY_TOOLS.GLOBAL_LIST,
    label: "List All Project Memories",
    description: "List all memories across all projects with project names.",
    parameters: Type.Object({}),
    renderCall: (_args, theme) => new Text(`${theme.fg(MEMORY_COLOR, theme.bold(`${MEMORY_GLYPH} memory`))} ${theme.fg("dim", "listing")}`, 0, 0),
    renderResult: (result, options, theme) => {
      const d = result.details as { memories?: Array<{ title: string; project: string; type: string }> } | undefined;
      const mems = d?.memories ?? [];
      const shown = options.expanded ? mems : mems.slice(0, 8);
      const lines = [`${MEMORY_GLYPH} memories · ${mems.length} stored across projects`];
      for (const m of shown) lines.push(`[${m.project}] ${m.title} · ${m.type}`);
      if (!options.expanded && mems.length > shown.length) lines.push(`… ${mems.length - shown.length} more`);
      return frame(theme as ThemeLike, lines);
    },
    async execute(_id, _p, _s, _o, _ctx) {
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
    },
  });
}
