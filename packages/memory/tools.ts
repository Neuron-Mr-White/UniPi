/**
 * @unipi/memory — Tool registration
 *
 * Tools for the LLM to store, search, and delete memories.
 * All storage is project-scoped. "Global" tools search across all projects.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  MemoryStorage,
  searchAllProjects,
  listAllProjects,
  getProjectName,
  type MemoryRecord,
} from "./storage.js";
import { generateEmbedding } from "./embedding.js";
import { hybridSearch } from "./search.js";

/** Tool names */
export const MEMORY_TOOLS = {
  STORE: "memory_store",
  SEARCH: "memory_search",
  DELETE: "memory_delete",
  LIST: "memory_list",
  GLOBAL_SEARCH: "global_memory_search",
  GLOBAL_LIST: "global_memory_list",
} as const;

/**
 * Register memory tools.
 */
export function registerMemoryTools(
  pi: ExtensionAPI,
  getStorage: () => MemoryStorage
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
      "Memory is scoped to the current project.",
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
      const storage = getStorage();

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
        project: getProjectName(ctx.cwd),
        type: (params.type as MemoryRecord["type"]) || "summary",
        created: "",
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
      "Search current project memories by keyword. Returns ranked results with snippets.",
    promptSnippet: "Search project memories for relevant context.",
    promptGuidelines: [
      "Use memory_search before making decisions when you suspect past work exists.",
      "Search for user preferences when setting up new features.",
      "Search for patterns when implementing similar functionality.",
      "Use global_memory_search to search across ALL projects.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default 10)", default: 10 })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const storage = getStorage();

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
    description: "Delete a memory by title or ID from the current project.",
    promptSnippet: "Delete a memory.",
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "Memory title to delete" })),
      id: Type.Optional(Type.String({ description: "Memory ID to delete" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const storage = getStorage();

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
      const storage = getStorage();
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

  // --- global_memory_search tool ---
  pi.registerTool({
    name: MEMORY_TOOLS.GLOBAL_SEARCH,
    label: "Search All Projects",
    description: "Search memories across ALL projects. Returns results with project names.",
    promptSnippet: "Search memories across all projects.",
    promptGuidelines: [
      "Use global_memory_search when looking for memories from other projects.",
      "Returns results with [project_name] prefix to identify source.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default 10)", default: 10 })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const results = searchAllProjects(params.query, params.limit || 10);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No memories found across projects for: "${params.query}"`,
            },
          ],
          details: { results: [] },
        };
      }

      const output = results
        .map(
          (r, i) =>
            `${i + 1}. [${r.record.project}] **${r.record.title}** (${r.record.type})\n   ${r.snippet}`
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `Found ${results.length} memories across projects:\n\n${output}`,
          },
        ],
        details: { results: results.map((r) => r.record.id) },
      };
    },
  });

  // --- global_memory_list tool ---
  pi.registerTool({
    name: MEMORY_TOOLS.GLOBAL_LIST,
    label: "List All Project Memories",
    description: "List all memories across all projects with project names.",
    promptSnippet: "List all memories across projects.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const memories = listAllProjects();

      if (memories.length === 0) {
        return {
          content: [{ type: "text", text: "No memories stored in any project." }],
          details: { memories: [] },
        };
      }

      // Group by project
      const grouped = new Map<string, typeof memories>();
      for (const m of memories) {
        const list = grouped.get(m.project) || [];
        list.push(m);
        grouped.set(m.project, list);
      }

      let output = "";
      for (const [project, projectMemories] of grouped) {
        output += `\n**${project}** (${projectMemories.length}):\n`;
        for (const m of projectMemories) {
          output += `  - ${m.title} (${m.type})\n`;
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `All memories across ${grouped.size} projects (${memories.length} total):${output}`,
          },
        ],
        details: { memories },
      };
    },
  });
}
