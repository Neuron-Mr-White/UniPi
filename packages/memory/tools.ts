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
  GLOBAL_LIST: "global_memory_list",
} as const;

// Keep old name as alias for backward compat
export const GLOBAL_SEARCH_ALIAS = "global_memory_search";

/**
 * Register memory tools.
 * @param onActivity - called when recall/store happens (marks lifecycle state)
 */
export function registerMemoryTools(
  pi: ExtensionAPI,
  getStorage: () => MemoryStorage,
  onActivity?: () => void
): void {
  // --- memory_store tool ---
  pi.registerTool({
    name: MEMORY_TOOLS.STORE,
    label: "Store Memory",
    description:
      "IMPORTANT: Call at the END of every non-trivial task to save what you learned. " +
      "Store or update a memory for cross-session recall — user preferences, project decisions, " +
      "code patterns, and conversation summaries. Update existing memories instead of creating duplicates.",
    promptSnippet: "Store a memory for cross-session recall.",
    promptGuidelines: [
      "IMPORTANT: Always call memory_store when you learn something non-obvious.",
      "Search for existing similar memories first — update if found, create if not.",
      "Memory is scoped to the current project. Use for decisions, preferences, patterns, summaries.",
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
      onActivity?.(); // Mark store as done for lifecycle

      // Step 1: Check for exact duplicate
      const existing = storage.getByTitle(params.title);
      if (existing) {
        // Exact match found — check if content is also the same
        const isSameContent = existing.content.trim() === params.content.trim();
        
        if (isSameContent) {
          // Duplicate with same content — gentle error asking to read first
          return {
            content: [
              {
                type: "text",
                text: `⚠️ Memory already exists with this title and content: "${params.title}"\n\n` +
                      `Please read the existing memory first using memory_search before saving.\n` +
                      `If you want to update it, provide new or modified content.`,
              },
            ],
            details: { action: "duplicate_detected", id: existing.id },
          };
        }

        // Same title but different content — update existing
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

      // Step 2: Check for similar memories
      const similarMemories = storage.findSimilarByTitle(params.title, 0.6);
      
      if (similarMemories.length > 0) {
        // Found similar memories — save but notify
        const similarList = similarMemories
          .slice(0, 3)
          .map(s => `  - "${s.record.title}" (${Math.round(s.similarity * 100)}% similar)`)
          .join("\n");

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
              text: `Stored memory: ${params.title}\n\n` +
                    `⚠️ Similar memories found:\n${similarList}\n\n` +
                    `Consider reviewing these to avoid redundancy.`,
            },
          ],
          details: { action: "created_with_similar", id: record.id, similar: similarMemories.map(s => s.record.id) },
        };
      }

      // Step 3: No duplicates or similar — create new memory
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

  // --- memory_search tool (unified: searches all projects by default) ---
  pi.registerTool({
    name: MEMORY_TOOLS.SEARCH,
    label: "Search Memory",
    description:
      "IMPORTANT: Call BEFORE starting work to check for existing context. " +
      "Searches memories by keyword. Searches ALL projects by default — returns results with " +
      "[project_name] prefix. Use scope='project' to limit to current project only.",
    promptSnippet: "Search memories for relevant context before starting work.",
    promptGuidelines: [
      "IMPORTANT: Always call memory_search before making decisions when you suspect past work exists.",
      "Searches all projects by default — no need to call a separate global search.",
      "Search for user preferences when setting up new features.",
      "Search for patterns when implementing similar functionality.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default 10)", default: 10 })
      ),
      scope: Type.Optional(
        Type.String({
          description: "Search scope: 'all' (default, searches all projects) or 'project' (current project only)",
          enum: ["all", "project"],
          default: "all",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      onActivity?.(); // Mark recall as done for lifecycle
      const limit = params.limit || 10;
      const scope = (params as any).scope || "all";

      if (scope === "project") {
        // Project-only search (original behavior)
        const storage = getStorage();
        const results = storage.search(params.query, limit);

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `No memories found for: "${params.query}"` }],
            details: { results: [] },
          };
        }

        const output = results
          .map((r, i) => `${i + 1}. **${r.record.title}** (${r.record.type})\n   ${r.snippet}`)
          .join("\n\n");

        return {
          content: [{ type: "text", text: `Found ${results.length} memories:\n\n${output}` }],
          details: { results: results.map((r) => r.record.id) },
        };
      }

      // Default: search ALL projects
      const results = searchAllProjects(params.query, limit);

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No memories found across projects for: "${params.query}"` }],
          details: { results: [] },
        };
      }

      const output = results
        .map((r, i) => `${i + 1}. [${r.record.project}] **${r.record.title}** (${r.record.type})\n   ${r.snippet}`)
        .join("\n\n");

      return {
        content: [{ type: "text", text: `Found ${results.length} memories across projects:\n\n${output}` }],
        details: { results: results.map((r) => r.record.id) },
      };
    },
  });

  // --- global_memory_search alias (backward compat, delegates to memory_search) ---
  pi.registerTool({
    name: GLOBAL_SEARCH_ALIAS,
    label: "Search All Projects",
    description:
      "Alias for memory_search with scope='all'. Searches memories across ALL projects.",
    promptSnippet: "Search memories across all projects.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default 10)", default: 10 })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate) {
      onActivity?.();
      const results = searchAllProjects(params.query, params.limit || 10);

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No memories found across projects for: "${params.query}"` }],
          details: { results: [] },
        };
      }

      const output = results
        .map((r, i) => `${i + 1}. [${r.record.project}] **${r.record.title}** (${r.record.type})\n   ${r.snippet}`)
        .join("\n\n");

      return {
        content: [{ type: "text", text: `Found ${results.length} memories across projects:\n\n${output}` }],
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
