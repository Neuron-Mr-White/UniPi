# Unreachable and Useless Code Audit — Deep Proof Phase

Read-only audit of the UniPi codebase. Determine what is currently unreachable, dead, inert, redundant, misleading, or no longer useful. Do not delete or refactor production code during this loop.

## Rules for this phase (user directive 2026-08-13)

- Deeper research across multiple iterations; one item per iteration.
- **All findings must be proven first**: runtime execution, repository-wide reference searches, entry-point traces, or failing-test demonstration. No proof → no claim.
- Update `.unipi/docs/research/unreachable-useless-code-audit.md` in **every** iteration as items are proven or disproven (mark confidence: `Proven at runtime` / `Proven by reference` / `Disproven` / `Candidate — needs proof`).
- Keep a per-item evidence log in the Notes section of this task file.

## Goals
- Trace actual package, extension, command, tool, event, and UI entry points.
- Identify code that cannot be reached from shipped/runtime entry points.
- Identify configuration or branches that are accepted but ignored, inert, or effectively no-ops.
- Identify stale wrappers, duplicate implementations, obsolete compatibility paths, unused dependencies/scripts, and tests/docs that target nonexistent behavior.
- Distinguish proven dead code from intentionally public APIs and low-confidence candidates.

## Checklist (one item per iteration)

- [x] **P1a — LLM summarize placeholder**: prove the `web_llm_summarize` path returns the placeholder string at runtime. DONE: executed provider + selection chain via tsx; output `[LLM Summary placeholder for https://example.org/article]`; doc updated with trace.
- [x] **P1b — Compactor inert pipeline flags**: prove `ttlCache`, `proximityReranking`, `timelineSort`, `progressiveThrottling`, `mmapPragma` have zero runtime consumers (enumerate every reference file; check for dynamic/indirect reads; optionally grep the built bundle). DONE: exhaustive rg over packages/compactor/src; all refs confined to types/schema/presets/settings-overlay; bundle hits are schema/preset/UI only; only autoInjection + customNoisePatterns are read at runtime.
- [x] **P1c — Compactor strategy sections unenforced**: prove `sandboxExecution.enabled/mode/allowedLanguages/outputLimit`, `fts5Index.*`, `sessionContinuity.eventCategories` are never read by execution (trace sandbox tool registration and executor defaults; run a demonstration that a disabled/restricted setting still allows execution if feasible read-only). DONE: zero runtime refs outside config/types/UI; sandbox tools register unconditionally at register.ts:192-248; executor hard-codes 100MiB/30s (executor.ts:87,106); bundle hits are schema/merge/preset/UI only, with presets advertising sandbox off while tools remain registered.
- [x] **P1d — Compactor display settings ignored**: prove `showTruncationHints`, `toolDisplay.*` (except `mode`) are not consumed at runtime (trace `packages/compactor/src/index.ts` display path and `tool-overrides.ts`). DONE: only td?.mode consumed at index.ts:544-548; showTruncationHints passed as literal true and never read by applyToolDisplayOverride; enabled/diff*/show* fields confined to config/UI; dead ToolDisplayConfig type (1 hit); bundle consistent.
- [x] **P1e — Subagent per-type disable is display-only**: prove `config.types[name].enabled` and custom-agent `enabled:false` do not block spawning (trace `AgentManager.spawn`/`getAgentConfig`; verify no rejection path). DONE: config.types read only at index.ts:338-367 (info-screen text); agent-manager.ts + agent-runner.ts contain zero `enabled` refs; spawn/spawnAndWait have no gate.
- [x] **P1f — notify_user.priority discarded**: prove the parameter never reaches dispatch (trace `dispatchNotification` signature and each platform's priority handling; check native/gotify/ntfy/telegram). DONE: dispatchNotification signature has no priority param (events.ts:166-173); _priority unused at tools.ts:49-54; platform priority comes only from config.gotify.priority / ntfyConfig.priority; telegram/native/focus have none; enum type only in schema (types.ts:99).
- [x] **P1g — Milestone WORKFLOW_END no-op**: prove no `pi.events.on(WORKFLOW_END)` listener exists and the input listener returns undefined; verify `pi.events.on` is available on ExtensionAPI in the installed SDK. DONE: Milestone input handler is unconditional undefined (hooks.ts:170-176); SDK declares ExtensionAPI.events: EventBus and EventBus.on; Footer/Notify already use it; exact search also proves Workflow never emits WORKFLOW_END.
- [x] **P2a — Module status request/response**: prove `MODULE_STATUS_REQUEST` has no listener and `MODULE_STATUS_RESPONSE` no emitter across the whole repo including the bundle. DONE: exhaustive symbolic/literal source and bundle searches show one request emit only, no request listener and no response emit/listener; synchronous EventBus discards it; command still waits 500ms and never collects responses.
- [x] **P2b — Dormant events**: prove each named constant's emit/listen status with exact file:line evidence; verify Ralph hypothesis. DONE: exhaustive symbolic/literal source matrix + bundle counts. Eight events neither side; Compactor pair and RALPH_ITERATION_DONE listener-only; eight emitter-only; Ralph START/END, ASK_USER_PROMPT, and MCP server lifecycle correctly/conditionally wired. Hypothesis “Ralph emits none” disproven; only iteration event is missing.
- [x] **P2c — Compactor auto-injection computes then discards**: prove the branch at `index.ts:284-297` never injects text; verify resume-inject path. DONE: stronger result—injectResumeSnapshot returns full snapshot+auto-injection, but sole before_agent_start caller discards it and returns no SDK-supported message/systemPrompt; duplicate builder only logs; resume row is marked consumed.
- [x] **P3a — Packaging defects**: prove Subagents entry, shipped tests, and dependency claims via isolated evidence. DONE: actual Subagents tarball lacks dist and fails package-name import after isolated install; root tarball ships 11 tests and Subagents six. Disproved lancedb/better-sqlite3 claims (declared optional). Proven Utility direct `shiki` and pi-tui imports fail strict nested resolution; highlighting silently degrades, eager pi-tui imports can fail.
- [x] **P3b — Dead private symbols + disconnected files**: prove scoped symbols and re-verify graph. DONE: all nine exact declarations receive TS6133 and scoped-reference proof; similarly named functions in other modules were excluded. Fresh production metafile has 249 inputs/1,282,123 bytes; classified no-import modules, unused-import modules, and type-only modules separately.
- [x] **Final — Consolidate**: re-run typecheck/tests/build, mark every item with final confidence, refresh summary ranking and cleanup order. DONE: typecheck, 62 Subagents tests, and build pass; executive summary, cleanup order, methodology, and validation refreshed.

## Constraints
- Investigation only; do not fix or remove candidate code.
- Preserve existing unrelated working-tree changes.
- Use explore subagents in parallel and critically verify their claims; subagent claims are hypotheses until proven here.

## Notes (evidence log)

- 2026-08-13 deep proof phase complete. P3b used TS6133 scope diagnostics plus a fresh production metafile; corrected type-only and unused-import cases instead of labeling whole files dead. Final validation passed: root typecheck, 62 Subagents tests, build/secret scan. Report executive summary and cleanup order now reflect only proven claims.
- Reflection checkpoint (iteration 10): all behavioral/event items now have direct proof, including multiple disproven over-broad hypotheses. The method is working; the only failed helper produced no usable result and was excluded. Three iterations remain for packaging, dead-symbol/graph analysis, and consolidation. Packaging dependency claims must be downgraded or disproven if isolated install evidence is not feasible; do not infer from hoisting alone.
- Initial phase (before deep phase) completed six parallel agents; report created. Only independently supported findings carried forward.
