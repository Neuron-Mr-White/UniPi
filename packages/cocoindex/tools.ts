/**
 * tools.ts — CocoIndex tool registration
 *
 * Exposes cocoindex operations as Pi agent tools:
 * - cocoindex_search: Search indexed content
 * - cocoindex_status: Show indexing status
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { COCOINDEX_PACKAGE_SPEC, COCOINDEX_TOOLS } from "@pi-unipi/core";
import * as bridge from "./bridge.js";

export interface CocoindexToolDeps {
  getProjectDir(ctx: ExtensionContext): string;
}

// ─────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────

export const MAX_SEARCH_RESULTS = 50;

export function normalizeSearchPage(limit?: number, offset?: number): { limit: number; offset: number } {
  const requestedLimit = Number.isFinite(limit) ? Math.floor(limit!) : 10;
  const requestedOffset = Number.isFinite(offset) ? Math.floor(offset!) : 0;
  return {
    limit: Math.min(MAX_SEARCH_RESULTS, Math.max(1, requestedLimit)),
    offset: Math.max(0, requestedOffset),
  };
}

const SearchParams = Type.Object({
  query: Type.String({ description: "Search query against indexed content" }),
  limit: Type.Optional(Type.Number({
    description: `Max results (default 10, hard cap ${MAX_SEARCH_RESULTS})`,
    minimum: 1,
    maximum: MAX_SEARCH_RESULTS,
  })),
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

// ─────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────

export function registerCocoindexTools(pi: ExtensionAPI, deps: CocoindexToolDeps): void {
  // cocoindex_search — search indexed content via LanceDB
  pi.registerTool({
    name: COCOINDEX_TOOLS.SEARCH,
    label: "CocoIndex Search",
    description:
      "Search indexed content using semantic vector search when available, with full-text/lexical fallbacks. " +
      "Diagnostic/search only: this tool never installs CocoIndex. " +
      "Use /unipi:cocoindex-init to set up/install, then /unipi:cocoindex-update to index.",
    parameters: SearchParams,
    async execute(
      _toolCallId: string,
      params: any,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<any> {
      try {
        const available = await bridge.isAvailable();
        if (!available) {
          return textResult(
            "Search Unavailable: CocoIndex CLI is not installed. " +
            "Run /unipi:cocoindex-init for guided install, or manually run " +
            `uv tool install '${COCOINDEX_PACKAGE_SPEC}'.`,
            { cliAvailable: false },
          );
        }

        // Clamp in execution as well as schema validation: Pi extensions may
        // mutate tool inputs after validation and custom hosts may skip it.
        const { limit, offset } = normalizeSearchPage(params.limit, params.offset);
        const results = await bridge.search(deps.getProjectDir(ctx), params.query, {
          limit,
          offset,
        });

        if (results.length === 0) {
          return textResult(
            `No results for "${params.query}" in the current CocoIndex data. ` +
            "If this seems wrong, run /unipi:cocoindex-status to confirm the pipeline has data, then /unipi:cocoindex-update to refresh it.",
          );
        }

        const lines = results.map(
          (r, i) =>
            `[${i + 1}] ${r.title} (${r.matchLayer}, rank: ${r.rank.toFixed(3)})\n${r.content.slice(0, 300)}`,
        );
        return textResult(
          `Found ${results.length} results for "${params.query}":\n\n${lines.join("\n\n")}`,
          // Avoid duplicating full result content in model-visible details.
          { count: results.length, query: params.query, limit, offset },
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
    description: "Check CocoIndex indexing status. Diagnostic only; use commands for interactive install/update.",
    parameters: StatusParams,
    async execute(
      _toolCallId: string,
      _params: Record<string, never>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<any> {
      try {
        const info = await bridge.status(deps.getProjectDir(ctx));
        const lines = [
          `📦 CocoIndex Status`,
          `CLI available: ${info.cliAvailable ? "✅" : "❌"}`,
          `Pipeline configured: ${info.pipelineConfigured ? "✅" : "❌"}`,
          `Target store: ${info.targetStore}`,
          `Indexed: ${info.indexed ? "✅" : "— (no data)"}`,
          `Doc count: ${info.docCount}`,
          `Last run: ${info.lastRun ?? "never"}`,
        ];
        if (!info.cliAvailable) {
          lines.push(
            "",
            "Install guidance:",
            "  • Run /unipi:cocoindex-init for guided install.",
            `  • Manual: uv tool install '${COCOINDEX_PACKAGE_SPEC}'`,
            "  • If uv is missing and mise is available: mise use -g uv@latest",
          );
        }
        return textResult(lines.join("\n"), info as unknown as Record<string, unknown>);
      } catch (err) {
        return textResult(`CocoIndex status error: ${err}`, { error: true });
      }
    },
  } as any);
}
