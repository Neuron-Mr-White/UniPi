/**
 * @unipi/memory — Tool registration
 *
 * Tools for the LLM to store, search, and delete memories.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MemoryStorage, type MemoryRecord } from "./storage.js";
import { generateEmbedding } from "./embedding.js";
import { hybridSearch, extractSnippet } from "./search.js";

/** Tool names */
export const MEMORY_TOOLS = {
  STORE: "memory_store",
  SEARCH: "memory_search",
  DELETE: "memory_delete",
  LIST: "memory_list",
  GLOBAL_STORE: "global_memory_store",
  GLOBAL_SEARCH: "global_memory_search",
  GLOBAL_LIST: "global_memory_list",
} as const;

/**
 * Register memory tools.
 */
export function registerMemoryTools(
  pi: ExtensionAPI,
  getStorage: (global?: boolean) => MemoryStorage
): void {
  // --- memory_store tool ---
  pi.registerTool({
    name: MEMORY_TOOLS.STORE,
    label: "Store Memory",
    description:
      "Store or update a memory for cross-session recall. Use for user preferences, project decisions, code patterns, and conversation summaries.",
    promptSnippet: "Store a memory for cross-session recall.",
    promptGuidelines: [
      "Use memory_store to remember important user preferences, decisions, patterns, or summaries.",
      "Memory is scoped to the current project. Use global_memory_store for cross-project memories.",
      "Update existing memories instead of creating duplicates.",
    ],
    parameters: Type.Object({
      title: Type.String({
        description:
          "Memory title in <most_important>_<less_important>_<lesser> format (e.g., 'auth_jwt_prefer_refresh_tokens')",
      }),
      content: Type.String({ description: "Full memory content (markdown supported)" }),
      tags: Type.Optional(
        Type.Array(Type.String(), { description: "Tags for categorization" })
      ),
      type: Type.Optional(
        Type.String({
          description: "Memory type: preference, decision, pattern, or summary",
          enum: ["preference", "decision", "pattern", "summary"],
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const storage = getStorage(false);

      // Check if similar memory exists
      const existing = storage.getByTitle(params.title);
      if (existing) {
        // Update existing
        const updated: MemoryRecord = {
          ...existing,
          content: params.content,
          tags: params.tags || existing.tags,
          type: (params.type as MemoryRecord["type"]) || existing.type,
        };

        // Generate embedding
        const embedding = await generateEmbedding(
          params.title + " " + params.content,
          pi
        );
        updated.embedding = embedding;

        storage.store(updated);

        return {
          content: [
            {
              type: "text",
              text: `Updated memory: ${params.title}`,
            },
          ],
          details: { action: "updated", id: updated.id },
        };
      }

      // Create new memory
      const record: MemoryRecord = {
        id: "",
        title: params.title,
        content: params.content,
        tags: params.tags || [],
        project: ctx.cwd?.split("/").pop() || "unknown",
        type: (params.type as MemoryRecord["type"]) || "summary",
        created: "",
        updated: "",
      };

      // Generate embedding
      const embedding = await generateEmbedding(
        params.title + " " + params.content,
        pi
      );
      record.embedding = embedding;

      storage.store(record);

      return {
        content: [
          {
            type: "text",
            text: `Stored memory: ${params.title}`,
          },
        ],
        details: { action: "created", id: record.id },
      };
    },
  });

  // --- memory_search tool ---
  pi.registerTool({
    name: MEMORY_TOOLS.SEARCH,
    label: "Search Memory",
    description:
      "Search project memories by keyword. Returns ranked results with snippets.",
    promptSnippet: "Search memories for relevant context.",
    promptGuidelines: [
      "Use memory_search before making decisions when you suspect past work exists.",
      "Search for user preferences when setting up new features.",
      "Search for patterns when implementing similar functionality.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default 10)", default: 10 })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const storage = getStorage(false);

      // Generate embedding for search
      const embedding = await generateEmbedding(params.query, pi);

      const results = hybridSearch(
        storage,
        params.query,
        params.limit || 10,
        embedding
      );

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No memories found for: "${params.query}"`,
            },
          ],
          details: { results: [] },
        };
      }

      const output = results
        .map(
          (r, i) =>
            `${i + 1}. **${r.record.title}** (${r.record.type})\n   ${r.snippet}`
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `Found ${results.length} memories:\n\n${output}`,
          },
        ],
        details: { results: results.map((r) => r.record.id) },
      };
    },
  });

  // --- memory_delete tool ---
  pi.registerTool({
    name: MEMORY_TOOLS.DELETE,
    label: "Delete Memory",
    description: "Delete a memory by title or ID.",
    promptSnippet: "Delete a memory.",
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "Memory title to delete" })),
      id: Type.Optional(Type.String({ description: "Memory ID to delete" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const storage = getStorage(false);

      let deleted = false;
      if (params.id) {
        deleted = storage.delete(params.id);
      } else if (params.title) {
        deleted = storage.deleteByTitle(params.title);
      }

      return {
        content: [
          {
            type: "text",
            text: deleted
              ? `Deleted memory: ${params.title || params.id}`
              : `Memory not found: ${params.title || params.id}`,
          },
        ],
        details: { deleted },
      };
    },
  });

  // --- memory_list tool ---
  pi.registerTool({
    name: MEMORY_TOOLS.LIST,
    label: "List Project Memories",
    description: "List all memories for the current project.",
    promptSnippet: "List all project memories.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const storage = getStorage(false);
      const memories = storage.listAll();

      if (memories.length === 0) {
        return {
          content: [{ type: "text", text: "No memories stored for this project." }],
          details: { memories: [] },
        };
      }

      const output = memories
        .map((m) => `- ${m.title} (${m.type})`)
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `Project memories (${memories.length}):\n\n${output}`,
          },
        ],
        details: { memories },
      };
    },
  });

  // --- global_memory_store tool ---
  pi.registerTool({
    name: MEMORY_TOOLS.GLOBAL_STORE,
    label: "Store Global Memory",
    description:
      "Store or update a global memory (accessible across all projects).",
    promptSnippet: "Store a global memory.",
    parameters: Type.Object({
      title: Type.String({
        description:
          "Memory title in <most_important>_<lesser> format",
      }),
      content: Type.String({ description: "Full memory content" }),
      tags: Type.Optional(
        Type.Array(Type.String(), { description: "Tags for categorization" })
      ),
      type: Type.Optional(
        Type.String({
          description: "Memory type: preference, decision, pattern, or summary",
          enum: ["preference", "decision", "pattern", "summary"],
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const storage = getStorage(true);

      const existing = storage.getByTitle(params.title);
      const record: MemoryRecord = {
        id: existing?.id || "",
        title: params.title,
        content: params.content,
        tags: params.tags || existing?.tags || [],
        project: "global",
        type: (params.type as MemoryRecord["type"]) || existing?.type || "summary",
        created: existing?.created || "",
        updated: "",
      };

      const embedding = await generateEmbedding(
        params.title + " " + params.content,
        pi
      );
      record.embedding = embedding;

      storage.store(record);

      return {
        content: [
          {
            type: "text",
            text: `${existing ? "Updated" : "Stored"} global memory: ${params.title}`,
          },
        ],
        details: { action: existing ? "updated" : "created", id: record.id },
      };
    },
  });

  // --- global_memory_search tool ---
  pi.registerTool({
    name: MEMORY_TOOLS.GLOBAL_SEARCH,
    label: "Search Global Memory",
    description: "Search global memories across all projects.",
    promptSnippet: "Search global memories.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default 10)", default: 10 })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const storage = getStorage(true);
      const embedding = await generateEmbedding(params.query, pi);

      const results = hybridSearch(
        storage,
        params.query,
        params.limit || 10,
        embedding
      );

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No global memories found for: "${params.query}"`,
            },
          ],
          details: { results: [] },
        };
      }

      const output = results
        .map(
          (r, i) =>
            `${i + 1}. **${r.record.title}** (${r.record.type})\n   ${r.snippet}`
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `Found ${results.length} global memories:\n\n${output}`,
          },
        ],
        details: { results: results.map((r) => r.record.id) },
      };
    },
  });

  // --- global_memory_list tool ---
  pi.registerTool({
    name: MEMORY_TOOLS.GLOBAL_LIST,
    label: "List Global Memories",
    description: "List all global memories with project prefixes.",
    promptSnippet: "List all global memories.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const storage = getStorage(true);
      const memories = storage.listAll();

      if (memories.length === 0) {
        return {
          content: [{ type: "text", text: "No global memories stored." }],
          details: { memories: [] },
        };
      }

      const output = memories
        .map((m) => `- [${m.id}] ${m.title} (${m.type})`)
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `Global memories (${memories.length}):\n\n${output}`,
          },
        ],
        details: { memories },
      };
    },
  });
}
