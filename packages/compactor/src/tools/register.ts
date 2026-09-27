/**
 * Tool registration — the compactor's agent-facing tools:
 *   session_recall  search the full session history, including compacted-away parts
 *   context_budget  how full the context is and what happens next
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { vccRecall } from "./vcc-recall.js";
import { contextBudgetTool } from "./context-budget.js";
import { recallBlocksFromContext } from "../session/recall-blocks.js";
import { filterNoise } from "../compaction/filter-noise.js";
import { loadConfig } from "../config/manager.js";
import type { RuntimeCounters } from "../types.js";

const RecallParams = Type.Object({
  query: Type.Optional(Type.String({ description: "What to recall, in plain keywords (e.g. 'redis cache decision'). Multi-word queries are ranked by relevance. A regex pattern also works. #N:path drills into a file's content from an entry." })),
  expand: Type.Optional(Type.Array(Type.Number(), { description: "Entry indices to return full untruncated content for" })),
  page: Type.Optional(Type.Number({ description: "Page number (1-based) for paginated search results. Default: 1.", minimum: 1 })),
  scope: Type.Optional(Type.Union([Type.Literal("lineage"), Type.Literal("all")], {
    description: "Default 'lineage' covers the active conversation path. Use 'all' to also reach messages from other branches, such as turns that were edited or retried.",
  })),
  mode: Type.Optional(Type.Union([Type.Literal("hybrid"), Type.Literal("touched")], {
    description: "What to show. hybrid (default) = normal search; touched = aggregated files-by-path with entry indices.",
  })),
});

export interface CompactorToolDeps {
  counters: RuntimeCounters;
}

const textResult = (text: string, details?: Record<string, unknown>): any => ({
  content: [{ type: "text", text }],
  details,
});

/** Register the compactor's tools (once, at extension load). */
export function registerCompactorTools(pi: ExtensionAPI, deps: CompactorToolDeps): void {
  pi.registerTool({
    name: "session_recall",
    label: "Session Recall",
    description:
      "Search session history using keyword or regex search. Find previous goals, files, commits, decisions, and context — " +
      "including anything dropped by compaction. Reach for this before telling the user you no longer have the context. " +
      "Plain keywords work best; a regex pattern is also accepted. Results are paged (page); pass expand with entry indices " +
      "to read full untruncated content. Use mode:'touched' to list files worked on in this session with their entry indices, " +
      "and #N:path to drill into a file's content from an entry (#N:path:full for all lines). Only the current session is " +
      "searchable — earlier sessions are not.",
    parameters: RecallParams,
    async execute(_toolCallId: string, params: any, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: ExtensionContext) {
      deps.counters.recallQueries++;
      const blocks = ctx ? filterNoise(recallBlocksFromContext(ctx)) : [];
      const result = vccRecall(blocks, {
        query: params.query,
        scope: params.scope,
        mode: params.mode,
        page: params.page,
        expand: params.expand,
      });
      return textResult(result.text, { query: params.query ?? null });
    },
  } as any);

  pi.registerTool({
    name: "context_budget",
    label: "Context Budget",
    description: "Estimate how full the context window is (% full, tokens left). Compaction is automatic; this never needs to be acted on.",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: any, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: ExtensionContext) {
      const config = loadConfig(ctx?.cwd ?? process.cwd());
      const usage = ctx?.getContextUsage?.();
      return textResult(contextBudgetTool(usage?.tokens ?? undefined, usage?.contextWindow, config));
    },
  } as any);
}
