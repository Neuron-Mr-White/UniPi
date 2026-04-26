---
name: memory
description: >
  Persistent cross-session memory management. Store and retrieve user preferences,
  project decisions, code patterns, and conversation summaries across sessions.
  Use when you need to remember something important or recall past context.
allowed-tools:
  - memory_store
  - memory_search
  - memory_delete
  - memory_list
  - global_memory_store
  - global_memory_search
  - global_memory_list
  - read
---

# Memory

Persistent cross-session memory for Pi coding agent. Memories survive session restarts, compaction, and context resets.

## When to Store Memory

Store memory when you encounter:

| Type | Examples | Title Format |
|------|----------|--------------|
| **Preference** | User likes tabs, prefers functional style | `style_typescript_prefer_tabs` |
| **Decision** | Chose PostgreSQL over MySQL, JWT over sessions | `db_postgres_chosen_over_mysql` |
| **Pattern** | How auth is structured, API naming conventions | `api_rest_versioning_v2` |
| **Summary** | Key findings from debugging, research results | `perf_slow_query_root_cause` |

## Naming Convention

**Format:** `<most_important>_<less_important>_<lesser>`

**Rules:**
- Use underscores, not hyphens
- Start with category (style, db, auth, api, arch, etc.)
- Be specific: `auth_jwt_prefer_refresh_tokens` not `auth_tokens`
- Keep under 60 characters

**Good titles:**
- `style_typescript_strict_mode_always`
- `db_postgres_use_connection_pooling`
- `arch_api_versioning_v2_breaking`
- `perf_cache_redis_for_sessions`

**Bad titles:**
- `auth` (too vague)
- `User prefers tabs` (not snake_case)
- `auth-jwt-refresh` (hyphens, not underscores)

## When to Search Memory

Search memory when:

1. **User references past work:** "Remember when we fixed the auth bug?"
2. **Making similar decisions:** "What did we decide about database choice?"
3. **Setting up new features:** "What's the user's coding style?"
4. **Debugging recurring issues:** "Have we seen this error before?"

## How to Use Tools

### Store a memory:
```
memory_store(
  title: "auth_jwt_prefer_refresh_tokens",
  content: "User prefers short-lived access tokens (15min) with long-lived refresh tokens (30d). Always implement token rotation on refresh.",
  tags: ["auth", "jwt", "preferences"],
  type: "preference"
)
```

### Search memories:
```
memory_search(query: "auth tokens")
```

### List all project memories:
```
memory_list()
```

### Delete a memory:
```
memory_delete(title: "auth_jwt_prefer_refresh_tokens")
```

## Project vs Global Scope

| Scope | Use For | Tools |
|-------|---------|-------|
| **Project** | Project-specific decisions, patterns | `memory_store`, `memory_search`, `memory_list` |
| **Global** | User preferences, general patterns | `global_memory_store`, `global_memory_search`, `global_memory_list` |

**Rule of thumb:** If it applies to ALL projects (user prefers tabs), use global. If it's specific to THIS project (chose PostgreSQL), use project scope.

## Update-First Principle

**Always check before creating.** Before storing a new memory:

1. Search for similar memories
2. If found and relevant → UPDATE the existing memory
3. If not found → CREATE new memory

This prevents memory duplication and keeps memory clean.

## Consolidation

When the user runs `/unipi:memory-consolidate` or during compaction:

1. Review the session for memory-worthy items
2. For each item:
   - Search for existing similar memory
   - Update if found, create if not
3. Report what was stored/updated

## Reading Memory Files

Memory files are stored in `~/.unipi/memory/` as markdown with YAML frontmatter:

```markdown
---
title: auth_jwt_prefer_refresh_tokens
tags: [auth, jwt, preferences]
project: my-app
created: 2026-04-26T10:00:00Z
updated: 2026-04-26T15:30:00Z
type: preference
---

# Auth: Prefer Refresh Tokens

User prefers short-lived access tokens (15min) with long-lived refresh tokens (30d).
Always implement token rotation on refresh.
```

You can read these files directly with the `read` tool for full context.

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Store everything | Only store decisions, preferences, patterns, summaries |
| Create duplicate memories | Search first, update existing |
| Use vague titles | Use specific `<category>_<detail>` format |
| Store in wrong scope | Project-specific = project scope, universal = global |
| Forget to update | When context changes, update the memory |
