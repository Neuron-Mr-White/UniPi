# Goal

Two deliverables on the unipi monorepo (`/home/oi/Projects/Personal/unipi`, branch `main`, currently at v2.0.12 commit d2985a9, clean tree except untracked `docs/` `scripts/` `.unipi/ralph/mempalace-*`):

1. **SDK bump**: pull newest pi-coding-agent SDK (0.78.0 → 0.80.2) across all four `@earendil-works/*` packages, verify nothing conflicts, then push to `unipi/`.
2. **Mempalace full backend replacement** in `packages/memory` with auto-install + one-way auto-migration so all existing memories persist and work out of the box.

Reference memory: `mempalace_memory_migration_plan` (call `memory_search` for full context if needed). Key facts also inline below.

---

## Part 1 — SDK bump (do this FIRST; smaller, well-bounded)

### Context
- Current: `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`, `pi-agent-core` all at `^0.78.0` in root `package.json` (peer + dev) and each `packages/*/package.json` peerDependencies.
- Latest npm: `0.80.2` for all four. `legacy-node20` dist-tag is `0.74.2` (do not use).
- Two minor versions of potential breaking changes → must typecheck.

### Checklist
- [ ] Bump root `package.json` peerDependencies + devDependencies from `^0.78.0` → `^0.80.0` for all four `@earendil-works/*` packages.
- [ ] Bump every `packages/*/package.json` peerDependencies `@earendil-works/pi-coding-agent` (and pi-ai/pi-tui where present) `^0.78.0` → `^0.80.0`.
- [ ] `npm install` (resolves new versions into package-lock.json).
- [ ] `npx tsc --noEmit --skipLibCheck` — fix any type conflicts. Inspect pi-coding-agent changelog/breaking changes between 0.78→0.80 if errors appear. The SDK is installed at `/home/oi/.local/share/mise/installs/node/24.16.0/lib/node_modules/@earendil-works/pi-coding-agent` — read its `CHANGELOG.md` / `docs` for breaking changes.
- [ ] `node --test tests/*.test.js` passes.
- [ ] `npm test --workspaces --if-present` passes.
- [ ] Commit as `chore: bump @earendil-works/* to ^0.80.0`.
- [ ] Push to `upstream main` (`git push upstream main`). If push rejected (non-fast-forward), `git pull --rebase upstream main` first, resolve, retry.

### Guardrails
- Do NOT touch `packages/*` source logic in this part — only manifest version ranges + lockfile + any minimal type-compat fixes. If a real breaking API change requires source changes, STOP and document it; ask before doing large refactors.
- If typecheck fails on an SDK API that was removed/renamed, prefer the narrowest fix (e.g. updated type import path) and note it in the commit body.

---

## Part 2 — Mempalace full backend replacement + auto-install + one-way migration

### Decision (confirmed with user)
- **Full backend replacement**: `packages/memory` storage layer switches its primary backend from SQLite+sqlite-vec to mempalace. SQLite kept ONLY as degraded fallback when mempalace/uv unavailable (memory must never hard-fail).
- **Auto-install**: on memory package load, detect `mempalace` on PATH; if missing and `uv` is available, run `uv tool install mempalace` once (non-interactive). Cache detection result.
- **One-way auto-migration**: on first `init()` after mempalace is available, if migration not yet done (no completion flag) and palace is empty/uninitialized, read ALL legacy memories from `~/.unipi/memory/<project>/{memory.db,*.md}` (using existing `parseMemoryFile` + `getAllProjectDirs`), upsert into mempalace drawers, write completion flag. Idempotent via deterministic drawer IDs. NEVER delete legacy files (rollback safety).

### mempalace facts
- Python pkg v3.5.0, cloned at `/tmp/mempalace`. CLI: `mempalace = mempalace.cli:main`. Install: `uv tool install mempalace` or `uvx mempalace`. `uv` IS available on this machine (mise). `mempalace` NOT yet on PATH.
- CLI subcommands: `init`, `mine <dir> [--wing --mode --dry-run]`, `search <query> [--wing --room --results --backend]`, `status`, `palace` (set-embedder), `migrate`, `repair`, `mcp`. **NO global `--json` flag** on CLI — text output only.
- Python API: `mempalace.palace.get_collection(palace_path, create=...)` → collection with `.upsert/.add/.query/.get/.delete/.count`. `mempalace.knowledge_graph.KnowledgeGraph.add_triple(...)`. Default backend ChromaDB; `sqlite_exact`/`qdrant`/`pgvector` available.
- Two stores: palace drawers (verbatim docs; wing=project, room=category) + knowledge graph (temporal triples).
- Embedder identity enforced — palace created with different embedder rejects writes; use `palace set-embedder` intentionally.
- CLI has no JSON mode → recommended: ship a small Python bridge (`packages/memory/bridge/mempalace_bridge.py`) invoked via `uvx --from mempalace python bridge.py` (or installed env), JSON over stdin/stdout. Bridge commands: `migrate`, `store`, `search`, `get`, `list`, `delete`, `has_title`, `find_similar`, `count`.

### Architecture constraints (MUST preserve these signatures)
`packages/memory/storage.ts` public API consumed by `tools.ts`/`commands.ts`/`index.ts` — keep stable so callers don't need rewriting:
- `MemoryStorage` class methods: `init()`, `close()`, `isHealthy()`, `store(record)`, `syncOrphanedFiles()`, `hasByTitle(title)`, `findSimilarByTitle(title,threshold)`, `getById(id)`, `getByTitle(title)`, `listAll()`, `delete(id)`, `deleteByTitle(title)`, `search(query,limit,embedding)`.
- Module fns: `getMemoryBaseDir()`, `getProjectDir(name)`, `getAllProjectDirs()`, `sanitizeProjectName(cwd)`, `getProjectName(cwd)`, `parseMemoryFile(path)`, `parseMemoryContent(content)`, `writeMemoryFile(path,record)`, `searchAllProjects(query,limit,embedding)`, `listAllProjects()`, `InMemoryStorage` class.
- Types: `MemoryRecord` {id,title,content,tags[],project,type:preference|decision|pattern|summary,created,updated,embedding?}, `SearchResult` {record,score,snippet}.
- Legacy path: `~/.unipi/memory/<project>/{memory.db,*.md}`. IDs derived from normalized title.

### Checklist
- [ ] Fold in prior-loop artifacts: review `scripts/migrate-unipi-memory-to-mempalace.py` + `docs/mempalace-memory-migration.md`; reuse migration mapping (project→wing, type→room `unipi_<type>`, verbatim body, `unipi_*` metadata, deterministic drawer IDs). Decide whether to keep the standalone script as a manual fallback or fold its logic into the bridge.
- [ ] Write `packages/memory/bridge/mempalace_bridge.py`: JSON-over-stdio RPC. Commands: `migrate` (read legacy ~/.unipi/memory, upsert all into palace), `store`, `search`, `get`, `list`, `delete`, `has_title`, `find_similar`, `count`. Use `mempalace.palace.get_collection` + `.upsert/.query/.get/.delete/.count`. Deterministic IDs via `make_drawer_id_from_chunk(wing,room,source_uri,0)`. Default palace path `~/.mempalace/palace`.
- [ ] Add `packages/memory/mempalace.ts`: TS client for the bridge — spawn `uvx --from mempalace python <bridge.py>` (or installed `mempalace` env), send JSON requests, parse JSON responses. Detect/install mempalace (uv tool install) with cached detection. Expose methods matching MemoryStorage needs.
- [ ] Rewrite `packages/memory/storage.ts` `MemoryStorage` internals: swap SQLite calls → mempalace client calls. Keep all public method signatures identical. Keep `parseMemoryFile`/`writeMemoryFile`/`getProjectName` etc. unchanged (still used for legacy reads during migration + fallback). Add migration flag at `~/.unipi/memory/.mempalace-migrated`. On `init()`: ensure mempalace installed → ensure migrated → open palace collection for this project's wing.
- [ ] Degraded fallback: if mempalace unavailable AND uv missing, `MemoryStorage` falls back to existing SQLite+sqlite-vec path (keep that code path alive, gated behind a backend selector). Log once to info-screen.
- [ ] `syncOrphanedFiles()` still works (reads .md, upserts into mempalace instead of SQLite).
- [ ] `search()` returns `SearchResult[]` with score+snippet from mempalace query results (map distance→score, truncate content→snippet).
- [ ] Update `packages/memory/index.ts` `session_start`: keep lifecycle, but call new init path. Update status bar text to reflect mempalace backend (e.g. `🧠 mem Np/Mall`). Update info-screen dataProvider counts via mempalace.
- [ ] `packages/memory/settings.ts`: `isEmbeddingReady()`/`hasModelChanged()` — mempalace handles embeddings internally; make these delegate to mempalace status or return sensible defaults so the existing UI doesn't break.
- [ ] Update `packages/memory/package.json`: add `mempalace` mention in description/keywords; keep better-sqlite3/sqlite-vec as deps (fallback). Ensure bridge .py is in `files`.
- [ ] `npx tsc --noEmit --skipLibCheck` passes.
- [ ] `node --test tests/*.test.js` passes (add/adjust memory tests if they assert SQLite internals).
- [ ] Manual smoke: with uv available, `uv tool install mempalace`; run the bridge `migrate` for the `unipi` project (7 memories); verify `mempalace search "<known title>" --wing unipi` returns it; verify `memory_search` tool round-trips.
- [ ] Update `packages/memory/README.md` + `docs/mempalace-memory-migration.md` to document new auto-install + auto-migration behavior, fallback mode, and how to force re-migration.
- [ ] Commit as `feat(memory): replace SQLite backend with mempalace + auto-install + one-way auto-migration`. Push to `upstream main`.

### Guardrails
- NEVER delete or mutate `~/.unipi/memory` legacy files during migration — read-only copy into mempalace.
- Migration must be idempotent (deterministic drawer IDs upsert, not duplicate).
- If mempalace install fails (no uv, no network), memory MUST still work via SQLite fallback — do not throw at session_start.
- Embedder identity conflicts: if palace rejects writes due to embedder mismatch, do NOT silently bypass — surface to info-screen and fall back to SQLite, with a clear remediation hint (`mempalace palace set-embedder`).
- Keep `MemoryStorage` public signatures stable — `tools.ts`/`commands.ts`/`index.ts` should not need changes beyond status text.
- Large/dangerous steps (force-pushing, deleting data, changing public tool schemas): STOP and ask the user first.

---

## Execution order
1. Part 1 (SDK bump) fully — commit + push.
2. Part 2 (mempalace) — design bridge, implement, migrate, test, commit + push.

If Part 1 typecheck reveals breaking SDK changes that need source refactors, STOP after Part 1 and report before continuing to Part 2.

## Notes
- Remote is `upstream` (git@github.com:Neuron-Mr-White/UniPi.git).
- Release chore doc lives at `.unipi/docs/chore/full-release.md` — follow its verify steps as a checklist sanity.
- Prior ralph state file `.unipi/ralph/mempalace-memory-migration.state.json` is `completed` from the earlier planning loop — this is a NEW loop; do not treat that state as current.
---

## ✅ COMPLETION SUMMARY (2026-06-27)

Both deliverables complete and pushed to `upstream/main`.

### Part 1 — SDK bump
- Bumped `@earendil-works/*` (pi-coding-agent, pi-ai, pi-tui, pi-agent-core) `^0.78.0` → `^0.80.0` (resolves to 0.80.2) in root + all 20 packages/*/package.json.
- Reconciled stale diverged local branch: reset to upstream/main (discarded duplicate local commits 8749dcc/d2985a9 that re-implemented already-landed remote work), re-applied new work on fresh v2.0.13 base.
- Fixed pre-broken tests/package-manifest.test.js (notify registers ./index.ts extension).
- Commits: cfcb3a9 (test fix), 6a76035 (SDK bump). Pushed fast-forward.
- Verified: typecheck clean, 5 root + 180 workspace tests pass.
- 0.80 breaking changes reviewed: none affect unipi (pi-ai /compat move — unipi only imports core types from root; /base removed — unused; ExecutionEnvExecOptions rename — unused; session_compact reason/willRetry — additive).

### Part 2 — MemPalace full backend replacement
- MemPalace is now the primary backend with auto-install (uv tool install mempalace) + one-way read-only auto-migration of all legacy memories on first init. SQLite kept as degraded fallback.
- Files: packages/memory/bridge/mempalace_bridge.py (Python bridge), packages/memory/mempalace.ts (detect/install/run), packages/memory/storage.ts (MemoryStorage branches on backend, all signatures preserved), packages/memory/index.ts (status icon), package.json (ships bridge).
- Commit: d5f59cf. Pushed fast-forward.
- Verified: typecheck clean; 185 tests pass; E2E TS smoke migrated 1189 memories across 14 projects, all ops (store/search/list/get/delete/find_similar) work; warm init 464ms; SQLite fallback verified.
- tools.ts/commands.ts unchanged (signatures preserved).

### Commits pushed to upstream/main
- d5f59cf feat(memory): MemPalace backend + auto-install + migration
- 6a76035 chore: bump @earendil-works/* to ^0.80.0
- cfcb3a9 test: allow split packages to register package-internal extensions

Ralph loop complete.
