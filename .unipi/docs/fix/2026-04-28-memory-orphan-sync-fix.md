---
title: "Memory Orphan Sync & Duplicate Detection — Quick Fix"
type: quick-fix
date: 2026-04-28
---

# Memory Orphan Sync & Duplicate Detection — Quick Fix

## Bug
Memory system had 7 orphaned markdown files not synced to SQLite database. Files from 2026-04-26/27 existed on disk but were invisible to `memory_search` and `memory_list`. Additionally, no duplicate detection existed when saving memories.

## Root Cause
- Database was recreated on 2026-04-28, but existing markdown files weren't migrated
- No sync mechanism to recover markdown files into a new database
- `store()` method lacked transaction wrapping (partial writes possible)
- No duplicate or similar memory detection

## Fix

### Files Modified

**`packages/memory/storage.ts`:**
- `store()` — wrapped in SQLite transaction for atomicity; markdown written after successful DB commit
- `syncOrphanedFiles()` — new method that reads `.md` files in project dir, parses frontmatter, inserts missing records into DB
- `hasByTitle()` — new method to check if memory exists by title
- `findSimilarByTitle()` — new method using Jaccard similarity for fuzzy title matching

**`packages/memory/tools.ts`:**
- `memory_store` — added duplicate detection: exact title+content match returns gentle error asking to read first
- `memory_store` — added similar memory warning: 60%+ title similarity saves but warns about existing similar memories

**`packages/memory/index.ts`:**
- `session_start` — calls `syncOrphanedFiles()` after storage init to recover any orphaned files

## Verification
- All 7 orphaned files synced successfully (10 → 17 memories)
- WAL file checkpointed (6.7MB → 0)
- Duplicate detection returns gentle error for exact matches
- Similar memory detection works with Jaccard similarity (tested with 40% threshold)
- TypeScript compiles without errors

## Notes
- Transaction wrapping prevents partial writes (DB success + file failure is now handled gracefully)
- `syncOrphanedFiles()` runs automatically on every session start — future orphans will be recovered
- Duplicate detection uses title similarity, not content similarity (content is only checked for exact matches)
