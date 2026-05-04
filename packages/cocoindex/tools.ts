/**
 * tools.ts — CocoIndex tool registration
 *
 * Exposes cocoindex operations as Pi agent tools:
 * - cocoindex_search: Search indexed content
 * - cocoindex_status: Show indexing status
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { COCOINDEX_TOOLS } from "@pi-unipi/core";
import * as bridge from "./bridge.js";
import type { CocoindexDeps } from "./bridge.js";

// ─────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────

const SearchParams = Type.Object({
  query: Type.String({ description: "Search query against indexed content" }),
  limit: Type.Optional(Type.Number({ description: "Max results (default 10)", minimum: 1 })),
  offset: Type.Optional(Type.Number({ description: "Pagination offset", minimum: 0 })),
});

const StatusParams = Type.Object({});

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function textResult(text: string, details?: Record<string, unknown>): any {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function jsonResult(data: unknown, label?: string): any {
  const text = label ? `${label}:\n${JSON.stringify(data, null, 2)}` : JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text", text }],
    details: data as Record<string, unknown>,
  };
}

// ─────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────

export function registerCocoindexTools(pi: ExtensionAPI, deps: CocoindexDeps): void {
  // cocoindex_search — search indexed content via LanceDB
  pi.registerTool({
    name: COCOINDEX_TOOLS.SEARCH,
    label: "CocoIndex Search",
    description:
      "Search indexed content using semantic vector search. " +
      "Requires CocoIndex pipeline to be initialized and content indexed. " +
      "Use /unipi:cocoindex-init to set up, then /unipi:cocoindex-update to index.",
    parameters: SearchParams,
    async execute(_toolCallId: string, params: any): Promise<any> {
      try {
        const results = await bridge.search(deps.projectDir, params.query, {
          limit: params.limit,
          offset: params.offset,
        });

        if (results.length === 0) {
          return textResult(
            `No results for "${params.query}". ` +
            "Make sure the project is indexed with /unipi:cocoindex-update.",
          );
        }

        const lines = results.map(
          (r, i) =>
            `[${i + 1}] ${r.title} (${r.matchLayer}, rank: ${r.rank.toFixed(3)})\n${r.content.slice(0, 300)}`,
        );
        return textResult(
          `Found ${results.length} results for "${params.query}":\n\n${lines.join("\n\n")}`,
          { results } as unknown as Record<string, unknown>,
        );
      } catch (err) {
        return textResult(`CocoIndex search error: ${err}`, { error: true });
      }
    },
  } as any);

  // cocoindex_status — show indexing status
  pi.registerTool({
    name: COCOINDEX_TOOLS.STATUS,
    label: "CocoIndex Status",
    description: "Check CocoIndex indexing status — pipeline configuration, last run, doc count.",
    parameters: StatusParams,
    async execute(): Promise<any> {
      try {
        const info = await bridge.status(deps.projectDir);
        const lines = [
          `📦 CocoIndex Status`,
          `CLI available: ${info.cliAvailable ? "✅" : "❌"}`,
          `Pipeline configured: ${info.pipelineConfigured ? "✅" : "❌"}`,
          `Target store: ${info.targetStore}`,
          `Indexed: ${info.indexed ? "✅" : "— (no data)"}`,
          `Doc count: ${info.docCount}`,
          `Last run: ${info.lastRun ?? "never"}`,
        ];
        return textResult(lines.join("\n"), info as unknown as Record<string, unknown>);
      } catch (err) {
        return textResult(`CocoIndex status error: ${err}`, { error: true });
      }
    },
  } as any);
}
