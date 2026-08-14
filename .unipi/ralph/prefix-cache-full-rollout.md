# Complete Prefix-Cache Preservation Rollout

Finish the DeepSeek Harness-inspired prefix-cache discipline across UniPi, validate it, and roll it out as a tested release.

## Governing invariant
Within a cache epoch, every model-visible request must preserve the prior request prefix exactly and add only new tail messages. Dynamic operational state must not rewrite the system prompt, prior messages, tool definitions/order, or cache-relevant request settings. Unavoidable changes must be documented and observable as explicit cache-epoch boundaries.

## Current state
Phase 1 (Ralph, milestone snapshots, workflow sandbox stability, deterministic MCP registration/schema canonicalization) is committed in `e03a2fd` and published in `@pi-unipi/unipi@2.5.0`. Do not redo it; audit and extend it. The tree starts clean on `main`.

## Goals
- Audit all UniPi model-visible mutation paths and close remaining avoidable prefix invalidations.
- Add structural regression coverage for exact prefix extension at the closest reliable Pi/provider boundary available.
- Add cache usage/fingerprint/epoch observability where supported without logging sensitive prompt content.
- Bound oversized model-visible MCP/helper/tool output while retaining full raw output outside provider serialization when technically possible; document any host limitation truthfully.
- Define explicit cache epoch boundaries and compaction behavior.
- Verify bundled and source entrypoints behave consistently.
- Run all quality/release gates and publish/push a new release only after they pass.

## Checklist
- [x] Re-read the DeepSeek Harness architecture and compaction notes; map each invariant to current UniPi/Pi APIs.
- [x] Audit every `before_agent_start`, dynamic system-prompt mutation, tool registration/order mutation, active-tool mutation, hidden context injection, compaction/resume path, workspace/context change, and model-visible nondeterministic value.
- [x] Record a concrete gap matrix: fixed, intentional cache boundary, host-owned limitation, or remaining bug.
- [x] Fix every avoidable UniPi-owned prefix mutation using append-only superseding tail snapshots with compaction-aware deduplication.
- [x] Ensure deterministic tool registration/schema serialization across all UniPi-owned dynamic tools, not only MCP.
- [x] Add stable-prefix regression tests covering ordinary turns and UniPi injections (Ralph, memory, milestone, workflow, compactor resume), at final provider payload level if Pi exposes it; otherwise build the strongest structural harness and document the boundary.
- [x] Add tests for genuine cache boundaries: compaction, provider/model, system prompt, inference settings, and meaningful tool-schema changes where observable.
- [x] Add privacy-safe request-envelope fingerprint/cache-epoch observability and surface provider cache-read/write usage where Pi APIs allow it.
- [x] Add bounded model-visible output for MCP and helper/subagent results with durable/raw spill references where feasible; preserve backward compatibility and test truncation/reference behavior.
- [x] Audit compaction frequency/defaults and keep compaction an explicit, infrequent boundary; do not add LLM summarization merely for this task.
- [x] Update architecture/user documentation with the append-only invariant, snapshot semantics, explicit cache reset events, observability, limitations, and expected DeepSeek behavior.
- [x] Regenerate `packages/unipi/bundled.js`; verify it contains the fixes and no secrets.
- [x] Run focused tests, full workspace tests, typecheck, build, lint if configured, package/tarball checks, and `git diff --check`.
- [x] Review the implementation for security, correctness, cache regressions, sensitive-data leakage, and host-API assumptions; fix all findings.
- [x] Commit coherent changes.
- [x] Execute the full release chore: version/changelog/docs, publish required changed packages and dependents, verify clean npm install/no stale nested copies, push main, and verify published versions.
- [x] Save final project memory with exact implementation, tests, release version, limitations, and follow-ups.

## Constraints
- Do not fabricate final-payload control or cache metrics that Pi does not expose; investigate and document host limitations.
- Never persist or log raw prompts/tool arguments solely for observability; fingerprints must be cryptographic hashes over canonical metadata/envelopes and logs must be opt-in or appropriately scoped.
- Do not run a paid live DeepSeek test unless credentials already exist and the test is explicitly key-gated; never expose credentials.
- Preserve tool-execution security while keeping schemas stable; blocked tools may remain visible only if execution is reliably denied.
- Keep unrelated work out of commits.
- Do not declare completion until release verification succeeds, or a genuinely external blocker is documented with all feasible work completed.

## Notes
Use small iterations, update this checklist, and reflect every five iterations. Emit `COMPLETE` only after all feasible checklist items and rollout verification are done.

### Iteration 1 — architecture/API mapping and complete mutation audit

Re-read both DeepSeek Harness notes in full:

- `2026-07-05-reconstructable-requests.md`: model-visible ⇔ durably referenced; immutable derived history; complete request-header snapshots; frozen requests; append-only request projection; explicit headers for real model/prompt/tool/config changes.
- `2026-07-21-compaction-summary-prefix-cache-reuse.md`: an LLM summarizer must replay the conversation's exact system/tools/leading messages and append its instruction at the tail. UniPi's current compactor is deterministic/zero-LLM, so no summarizer request exists to optimize.

Mapped the design to Pi 0.84.1 APIs:

- `before_agent_start` exposes assembled system prompt and supports tail custom messages, but is not the final payload boundary.
- `before_provider_request` is the closest extension hook to provider-native request bodies; it is untyped, ordered with other extensions, lacks request purpose/ID, and may be followed by later extension rewrites or transport serialization.
- Direct pi-ai `onPayload(payload, model)` is stronger for adapter-level tests; a custom transport/provider is required for exact wire-level correlation.
- `before_provider_headers` and `after_provider_response` expose headers/status separately.
- parsed `cacheRead`/`cacheWrite` are available only on final assistant/compaction usage, not `after_provider_response`.
- model/thinking changes are durable session entries; compaction/tree/session lifecycle events expose explicit host boundaries.
- Pi owns cwd in the base system prompt, global tool registry ordering, tree reconstruction, provider routing, retries, and serialization.

Completed source-wide audits (three independent read-only passes) covering prompt/history/context, tools/schema/order/results, and installed Pi/provider APIs. Current classification:

- **Fixed:** Ralph, milestone, workflow, memory, compactor resume, and utility continuation use append-only tail messages; no UniPi `before_agent_start` handler currently rewrites `systemPrompt`. MCP discovery/order/schema canonicalization is deterministic. BTW's provider-context filter is stable from first serialization.
- **Intentional boundaries:** compaction/tree navigation, new/resume/fork/reload, cwd/resource changes, model/provider/thinking changes, settings-dependent initial tool sets, MCP catalog changes, and separate helper/BTW sessions.
- **Host-owned:** base prompt/cwd construction, extension handler order, global tool ordering, active-tool prompt rebuilds, session-tree projection, routing/cache-control, and final transport serialization.
- **Remaining bugs/gaps:** no privacy-safe envelope/epoch observability; compactor resume includes avoidable wall-clock text; subagent type descriptions depend on unsorted config/filesystem order; MCP/helper outputs are unbounded; CocoIndex and compactor recall limits are unbounded; helper anti-nesting exclusions use stale tool names; some static tools register later than necessary; dynamic schema boundaries are not surfaced explicitly.

The next iteration will turn this audit into a checked-in gap matrix and fix the first deterministic-prefix defects.

### Iteration 2 — checked-in gap matrix and deterministic model-visible state

Added `docs/prefix-cache-architecture.md` with:

- the cache-epoch definition and append-only invariant;
- explicit model-visible snapshot rules;
- a concrete matrix classifying each audited surface as fixed, intentional boundary, host-owned/provider-owned, or in progress;
- explicit epoch boundaries;
- truthful limits of Pi's `before_provider_request`, usage, and wire-level observability APIs;
- deterministic zero-LLM compaction behavior and the required replay-prefix shape if LLM summarization is ever introduced.

Closed the remaining avoidable model-visible nondeterminism found by the audit:

- Removed `generated_at` wall-clock text from `packages/compactor/src/session/snapshot.ts`. A fixed stored event set now produces a byte-identical post-compaction resume snapshot.
- Canonically code-unit sorted subagent types in `AgentManager.getKnownTypes()` before those names enter the `spawn_helper` tool description/schema prose.
- Sorted project/global custom-agent directory entries before loading, making override/insertion behavior reproducible across filesystems.
- Updated helper anti-nesting exclusions to include the actual `spawn_helper` and `get_helper_result` names while retaining legacy names.

The major dynamic operational surfaces already use compaction-aware superseding snapshots from phase 1. The audit found no remaining UniPi-owned same-epoch system-prompt or prior-history rewrite. Work still remains on broader dynamic tool lifecycle determinism, final-payload regression coverage, observability, and bounded results.

Verification:

- `npm test --workspace @pi-unipi/subagents`: 67 passed.
- `npm test --workspace @pi-unipi/compactor`: 96 passed.
- `npx tsc --noEmit --skipLibCheck`: passed.
- `git diff --check`: passed.

### Iteration 3 — deterministic tool lifecycle and real provider-adapter prefix harness

Finished the UniPi-owned dynamic tool determinism pass:

- Ralph now registers its two static tool definitions at extension factory time. Executors resolve the current session manager lazily, so `session_start` no longer appends/re-registers schemas.
- CocoIndex now registers both static tool definitions at extension factory time. Executors resolve `ctx.cwd` per call; asynchronous availability and session initialization no longer determine when schemas enter Pi's tool registry.
- Added `tests/prefix-tool-registration.test.js`, which loads each extension twice, compares provider-visible definitions structurally, verifies canonical registration order, and proves `session_start` performs state/availability work without another registration set.
- Previously completed in this rollout: MCP barriered/sorted registration and canonical schemas; subagent type/schema prose ordering. Remaining settings-dependent tool sets (compactor sandbox, utility built-in overrides, MCP catalog) are explicit startup/restart boundaries rather than same-epoch mutations. Pi owns the final cross-extension registry order.

Started provider-native regression coverage at the strongest keyless boundary Pi exposes:

- Added `tests/prefix-provider-payload.test.js` using the real pi-ai OpenAI-completions adapter.
- The test captures `onPayload` and deliberately aborts before network I/O, so it performs no paid request and uses no credential.
- It proves two ordinary turns retain an identical complete non-message request envelope and that request N+1's provider-native message array begins with request N's complete message array.
- It also proves a representative hidden UniPi superseding snapshot is serialized as a newly appended user message while system/tools/settings stay identical.

This is stronger than comparing internal message objects, but it remains adapter-native rather than exact HTTP-wire serialization. Pi's `before_provider_request` has the same provider-native shape plus extension-order limitations documented in the architecture. Coverage for each concrete UniPi injector and explicit boundary scenarios remains for the next iteration.

Verification:

- New root regression tests: 4 passed.
- Full root `tests/*.test.js`: 26 passed, including npm tarball checks.
- CocoIndex package typecheck: passed.
- Root TypeScript no-emit check: passed.
- `git diff --check`: passed.

### Iteration 4 — concrete injector and cache-boundary provider tests

Completed provider-native regression coverage for every required UniPi injection:

- Exported pure production formatters for Ralph, memory, milestone, and workflow state; compactor already exposed its resume snapshot builder.
- The live hooks now call those same production formatters, so tests cannot drift into representative-but-fake strings.
- Extended `tests/prefix-provider-payload.test.js` to pass exact Ralph reminder, memory reminder, milestone snapshot, active workflow sandbox snapshot, and deterministic compactor resume snapshot through the real pi-ai OpenAI-completions adapter.
- For every injector, the test proves the full non-message provider envelope is unchanged, all preceding provider messages are structurally identical, and only one user-role tail message is added.
- Ordinary multi-turn extension remains covered at the same adapter-native boundary.

Added explicit boundary tests at that boundary:

- changed system prompt diverges at the provider's leading system message;
- changed temperature/output limit changes the provider envelope;
- changed reasoning effort changes `reasoning_effort` for a reasoning-capable model;
- changed model ID changes the routed model field;
- a meaningful tool-schema change changes provider tool definitions;
- simulated compaction replaces the old provider history prefix and is therefore observable as a new epoch.

Provider changes are represented by the model/provider route outside a single adapter payload; model identity is asserted in-payload and the architecture documents provider routing as a boundary. Exact wire bytes remain host/transport-owned, but this is Pi's strongest keyless provider-native payload boundary and performs no network request.

Verification:

- Provider prefix/boundary suite: 3 comprehensive tests passed (ordinary extension, all five concrete injectors, six boundary classes including reasoning settings).
- Root TypeScript no-emit check: passed.
- `git diff --check`: passed.

### Iteration 5 — privacy-safe observability, compaction policy, and reflection

Added session-local provider prefix-cache observability to Utility:

- `PrefixCacheTracker` observes but never mutates `before_provider_request` payloads.
- It canonicalizes provider-native objects transiently and retains only truncated HMAC-SHA-256 request/envelope/item fingerprints keyed by a random 256-bit in-memory secret. The key, payload, prompts, messages, schemas, and arguments are never persisted or logged.
- It classifies first request, identical retry, exact sequence extension, envelope change, provider payload-shape change, and history rewrite; model/thinking, compaction, and tree events mark known boundaries.
- `/unipi:prefix-cache` reports epochs, structural eligibility, boundaries, route, opaque fingerprints, and deduplicated provider-reported `cacheRead`/`cacheWrite` usage. It explicitly distinguishes structural eligibility from an actual provider cache hit.
- Added five focused security/correctness tests covering classification, canonical key order, order-sensitive arrays, usage deduplication, secret non-disclosure, and lifecycle boundaries.
- Updated Utility and architecture documentation with the command, privacy model, API limits, and metric meaning.

Audited compaction frequency/default behavior against Pi 0.84.1 implementation and UniPi:

- Pi core auto-compaction is enabled by default and triggers when estimated tokens exceed `contextWindow - reserveTokens`; documented defaults are 16,384 reserve and about 20,000 recent tokens retained.
- UniPi's extra percentage trigger remains disabled by default. If explicitly enabled, its 80% threshold is an intentional earlier epoch boundary; 60-second cooldown and 4,000-token repeat-growth guards prevent loops.
- UniPi's compaction compiler is deterministic and zero-LLM. No auxiliary summarizer request exists, so adding LLM summarization would increase cost and is out of scope.
- Added a default-policy regression assertion and documented why the extra trigger stays off.

Verification:

- Utility: 111 passed.
- Compactor: 97 passed.
- Root TypeScript no-emit check: passed.
- `git diff --check`: passed.

#### Reflection checkpoint (iteration 5)

1. **Accomplished:** all prompt/tool determinism and provider-native prefix/boundary tests are complete; observability and compaction policy are now implemented and documented.
2. **Working well:** pure production formatters prevent test drift; real adapter capture gives strong confidence without paid calls; keyed fingerprints provide diagnostics without creating a prompt dictionary oracle.
3. **Remaining risk:** large external/helper/search results still make the next cold epoch expensive. Durable spill semantics differ by tool and Pi does not provide a generic raw-result side channel.
4. **Adjustment:** implement one shared bounded-output primitive with path-safe durable spill files, then integrate MCP and helpers first. Treat CocoIndex/recall limits separately because they already expose pagination and should clamp caller-controlled limits instead of spilling arbitrarily large query sets.
5. **Next priorities:** bounded output + retrieval/reference tests, then review all documentation/status claims before bundle and release gates.

### Iteration 6 — bounded MCP/helper output with private raw artifacts

Implemented a common bounded-output policy and integrated the two highest-risk result sources:

- Added `@pi-unipi/core` `boundModelOutput`: 64 KiB default model-visible budget, UTF-8-safe head/tail preview, complete raw text in a random mode-0600 artifact under a checked mode-0700 `~/.unipi/tool-results/` directory, and an explicit `read` offset/limit retrieval hint.
- Artifact creation refuses a symlink result directory and uses exclusive file creation.
- MCP joins text/resource metadata into one bounded result, returns truncation/original-size/artifact metadata, and preserves error semantics. Existing image behavior remains metadata-only; base64 image bytes are not spilled.
- Foreground `spawn_helper` and `get_helper_result` now bound completed text at the same 64 KiB budget. Background repeated retrieval reuses the existing artifact path rather than duplicating raw output.
- Kept Subagents' helper implementation standalone in `core-compat.ts`, preserving its published self-contained dist/tarball contract rather than introducing a runtime dependency that its package intentionally does not declare.

Added tests for unchanged small output, exact raw artifact retention, restrictive permissions, symlink refusal, bounded UTF-8 previews, MCP integration, helper integration, and background artifact reuse. Updated MCP, Subagents, and architecture documentation.

During verification, an existing source-scanning badge test initially rejected Utility's newly valid Pi lifecycle hooks and assumed only one `agent_end` handler. Updated it to recognize Pi 0.84.1 provider/model/thinking/compaction/tree lifecycle hooks and inspect all `agent_end` handlers; behavior was not weakened.

Verification:

- Core bounded-output tests: 3 passed.
- MCP: 10 passed.
- Subagents: 69 passed.
- Root TypeScript no-emit check: passed.
- `git diff --check`: passed.

The overall bounded-output checklist remains open until pagination hard caps are applied to CocoIndex and session recall in the next iteration.

### Iteration 7 — paginated search/recall hard caps and documentation completion

Closed the remaining provider-history output amplification paths:

- CocoIndex `limit` now publishes `maximum: 50` in its provider-visible schema and independently clamps limit/offset during execution because Pi handlers can mutate inputs after validation and custom hosts may skip it.
- CocoIndex no longer duplicates complete search result objects in tool `details`; only count/query/page metadata remains model-visible alongside the existing 300-character excerpts.
- Session recall and its deprecated alias publish the same hard page cap of 50 and clamp internally. Expanded hits are individually bounded to 16 KiB with a narrowing hint, preventing one historical tool result/message from dominating provider history.
- Added CocoIndex schema/normalization tests and recall bypass/expanded-hit tests.
- Updated CocoIndex, Compactor, and architecture docs with page limits and cold-epoch rationale.

This completes bounded model-visible output: MCP/helpers retain exact private raw artifacts where the source returns one indivisible result; paginated search/recall clamp pages and instruct narrower/offset retrieval rather than duplicating a giant artifact.

Verification:

- CocoIndex: 2 passed.
- Compactor: 99 passed.
- Package lock refreshed after adding the CocoIndex test script.
- Root TypeScript no-emit check: passed.
- `git diff --check`: passed.

### Iteration 8 — independent review, blocker fixes, and documentation closure

Ran two independent read-only reviews: a security/correctness/host-API review and a documentation/status-claim audit. They identified real release blockers; this iteration fixed the highest-impact issues rather than proceeding directly to bundling:

- Ralph reminders now explicitly supersede older reminders, deduplicate byte-identical state against retained custom entries, and re-inject once after compaction. This brings Ralph into the same append-only snapshot contract as milestone/workflow.
- Bounded output now enforces the advertised complete 64 KiB model-visible ceiling, including omission markers and MCP error wrappers; tests no longer tolerate marker overflow.
- Raw artifacts now have a 16 MiB per-result safety cap. Results above it are not persisted and include an explicit warning, avoiding unlimited single-result disk writes.
- Existing result directories are permission-checked and tightened to 0700; files remain exclusive mode 0600. Symlink or filesystem failures degrade to a bounded preview plus warning instead of replacing useful MCP/helper output with a tool error.
- Documentation was corrected from unconditional raw retention to the actual capped/failure-safe behavior.

Completed user/architecture documentation across root README, `docs/prefix-cache-architecture.md`, and Utility, Compactor, MCP, Subagents, and CocoIndex READMEs. It now covers append-only snapshots, epoch boundaries, diagnostics/privacy, provider-native versus exact-wire limitations, DeepSeek cache semantics, compaction policy, result bounds, raw-retention caps, and paging.

Review follow-ups still pending before the review checklist can close: add focused Ralph dedup/compaction tests, reconcile observability lifecycle counting/usage identity assumptions, and inspect artifact cleanup/retention plus any remaining lower-severity findings. Documentation rows describe implemented working-tree behavior and will be release-verified before completion.

Verification after fixes:

- Core bounded-output: 3 passed.
- MCP: 10 passed.
- Subagents: 69 passed.
- Root TypeScript no-emit check: passed.
- `git diff --check`: passed.

### Iteration 9 — review follow-ups: lifecycle tests, accurate usage, artifact retention

Closed the focused review follow-ups:

- Extracted Ralph reminder snapshot logic into `packages/ralph/reminder.ts` and added four package tests for deterministic content, explicit supersession, unchanged-state dedup, changed iteration selection, and compaction-boundary reinjection. Added the Ralph package test script so root workspace tests execute them.
- Prefix observability now resets explicitly on `session_start`, covering custom hosts that reuse an extension factory across replacement sessions.
- Changed assistant usage deduplication from content HMAC to object identity. Pi repeatedly supplies the same active message objects to `agent_end`; those are deduplicated, while two genuinely distinct provider responses with identical text/usage now both count. Added a regression test for that distinction.
- Added private tool-result artifacts to Utility's established stale cleanup pipeline. `/unipi:cleanup` now removes recognized artifacts after `tempMaxAgeDays` (7 days by default), supports dry-run, ignores unknown files, and reports reclaimed bytes. Documented retention.

The implementation review is not marked complete yet: one final independent diff review will run after the next bundle/build so it evaluates generated-source parity and all fixes together.

Verification:

- Ralph: 4 passed.
- Utility: 112 passed.
- Root TypeScript no-emit check: passed.
- `git diff --check`: passed.

### Iteration 10 — bundle parity, full test/build gates, final review, reflection

Generated and inspected `packages/unipi/bundled.js`:

- Bundle build completed at ~1.28 MiB and its built-in credential-pattern scan was clean.
- Verified the generated source contains keyed prefix diagnostics, bounded-output safety cap, Ralph supersession, result limits, and no old compactor `generated_at` marker.
- `node --check` passed and an independent reviewer confirmed source/bundle/package parity.

The first full workspace test exposed two integration issues that focused package tests could not see:

1. Autocomplete's audited command catalog was missing `/unipi:prefix-cache`; added its Utility group and description.
2. Cross-workspace Notify typecheck surfaced Ralph custom-message content's union type and Utility's new cleanup category; narrowed Ralph content to strings and extended the cleanup category union.

Rebuilt and reran the full suite after fixes. All workspace/root tests pass. Also ran root typecheck, repeated secret-scanned build, bundle syntax, `git diff --check`, and root `npm pack --dry-run` (356 files, package includes generated bundle and source resources).

A final independent read-only review inspected the complete uncommitted diff, Pi 0.84.1 lifecycle APIs, privacy properties, artifacts, prefix behavior, standalone package sources, generated bundle, and tarball. Result: **no blocker, high, or medium findings; no release blockers remain**. The implementation review checklist is closed.

#### Reflection checkpoint (iteration 10)

1. **Accomplished:** every functional architecture checklist item is implemented; bundle/source parity and final review are complete; full tests/build/typecheck/tarball gates pass.
2. **Working well:** layered gates caught cross-package registry and type-surface problems before release; independent reviews found and then cleared genuine blockers.
3. **Remaining work:** release mechanics only—version/changelog, coherent commit, publish changed packages/dependents, clean-install verification, push, final memory.
4. **Adjustment:** do not add more scope. Use the established full-release chore and treat any version/dependency mismatch or npm stale-copy issue as a release blocker.
5. **Next priorities:** prepare release version/changelog, run final gates on versioned tree, commit, publish, clean-install verify, push.

### Iteration 11 — v2.6.0 release preparation and versioned focused gates

Executed the release chore's preparation phases:

- Verified `main`, upstream push remote, and npm authentication (`neuron-mr-white`).
- Selected **v2.6.0** because the rollout adds a user-facing diagnostics command, architecture contract, and result-retention behavior rather than only patching internals.
- Versioned the root and all 21 workspace packages uniformly to 2.6.0, updated every exact internal dependency edge, and regenerated `package-lock.json`. A machine check found zero package/dependency version mismatches.
- Added a complete v2.6.0 changelog covering provider-native prefix tests, keyed diagnostics, deterministic lifecycle, superseding Ralph reminders, bounded artifacts/search/recall, compaction policy, and fixes.
- Updated the full-release chore inventory/last-run metadata.

Ran focused gates on the versioned tree:

- Secret-scanned production bundle rebuilt successfully.
- Root typecheck passed.
- Autocomplete 38, Ralph 4, Utility 112, MCP 10, Compactor 99, and CocoIndex 2 tests passed.
- `git diff --check` passed.

#### Reflection checkpoint (iteration 11)

1. **Accomplished:** implementation, docs, reviews, bundle, and release metadata are complete; v2.6.0 has a coherent dependency graph.
2. **Working well:** uniform workspace versioning avoids npm resolving stale nested 2.5.0 copies; machine validation confirms every internal exact edge.
3. **Blocking:** nothing external—npm auth and GitHub SSH remote are available. Publishing remains intentionally deferred until the versioned tree is committed and the final all-workspace gate passes.
4. **Adjustment:** follow chore order strictly: full gate, commit/tag-ready tree, publish all packages, clean-install audit, then push/tag.
5. **Next priorities:** run final full workspace/tarball gates, commit coherent v2.6.0 changes, then publish and verify.

### Iteration 12 — final full gates and tarball manifest correction

Ran the final release gate on the fully versioned v2.6.0 tree:

- Entire root/workspace `npm test` passed with no failing package.
- Root typecheck passed.
- Secret-scanned production build and bundle syntax passed.
- `git diff --check` passed.
- All 21 standalone workspace tarballs dry-ran at 2.6.0; Subagents' prepack build/verification passed.

The root tarball manifest check caught one release-documentation defect: root README linked `docs/prefix-cache-architecture.md`, but the npm `files` allowlist excluded it. Added the architecture guide to the root package manifest, refreshed the lockfile, and reran root pack verification. The final umbrella tarball contains 357 files including the generated bundle, architecture guide, keyed tracker source, and bounded-output source.

This closes the complete quality-gate checklist. The release commit is deliberately left for the next iteration so the active Ralph progress file can record this gate result before staging; the commit will include the tracked rollout task/state following the repository's existing Ralph history convention.

### Iteration 13 — coherent commit and npm publication

Created release commit `49e6f71` (`feat: complete provider prefix-cache rollout`) with all source, tests, docs, generated bundle, v2.6.0 manifests/lock, changelog, and Ralph history. The working tree was clean immediately after commit.

Published successfully:

- All **21 standalone `@pi-unipi/*` workspace packages** at 2.6.0 via the workspace publish pipeline; the publish log contains 21 success records and no npm errors.
- Umbrella `@pi-unipi/unipi@2.6.0`; prepublish rebuilt and secret-scanned the generated bundle, and the published tarball included the architecture guide.
- Registry spot checks for umbrella, Core, Utility, and Subagents all return 2.6.0.

Publishing was intentionally completed before GitHub push so registry verification can catch package issues while the release commit remains locally amendable. Remaining release steps: clean external install and nested-copy audit, verify all registry versions, tag/push main, then record final memory/completion.

### Iteration 14 — clean-install audit, complete registry verification, GitHub release

Validated the published distribution outside the monorepo:

- Created a fresh temporary npm project and installed `@pi-unipi/unipi@2.6.0` from the public registry with lifecycle scripts disabled for an install-only audit.
- The install resolved **21 internal standalone copies and every one is 2.6.0**; no stale nested 2.5.x package exists.
- Verified the installed umbrella bundle contains prefix diagnostics, Ralph supersession, and bounded-output code, and that the architecture guide/tracker/bounded-output sources are present.
- npm reported existing transitive audit findings (1 low, 25 moderate, 2 high) and deprecation warnings; none are introduced package-version skew or release-integrity failures. No automatic breaking dependency upgrades were applied during this scoped rollout.
- Queried all **22 public package names** (umbrella + 21 workspaces); every registry `latest` version is 2.6.0.

The release commit is ready to tag and push. The checklist entry is marked complete in this progress snapshot because tag/push follows immediately after this file is amended into the release commit; remote verification will be recorded next.

Release push verification:

- Final release commit: `41d43e4e91ad56a2e00690b1694fdeafc5d0279d`.
- `main` pushed to `upstream`; fetched `upstream/main` resolves to the exact same commit.
- Annotated `v2.6.0` tag pushed; its peeled target resolves to the exact same commit.
- Public npm `latest` for `@pi-unipi/unipi` is 2.6.0.

Only the final project-memory/checklist closure remains.

### Iteration 15 — final memory and closure

Saved the final project memory with exact release identifiers, implementation surfaces, validation results, explicit host/provider limitations, artifact-retention constraints, audit findings, and follow-ups. All checklist items are complete.

Final state:

- Release: `@pi-unipi/unipi@2.6.0` plus all 21 workspaces at 2.6.0.
- Tag target: `41d43e4e91ad56a2e00690b1694fdeafc5d0279d` (`v2.6.0`).
- Main includes follow-up release-verification docs at `07fdd9d`.
- Full tests, typecheck, build, bundle secret scan/syntax, standalone/root tarballs, clean public install, nested-version audit, npm registry versions, GitHub main, and annotated tag all verified.

Known truthful limitations retained in docs:

- Pi's `before_provider_request` is provider-native but not guaranteed to be final HTTP wire bytes; later extension/transport behavior remains host-owned.
- Structural prefix eligibility does not prove a provider cache hit. Cache metrics appear only when Pi/provider usage reports them.
- Final cross-extension tool order, cwd/base prompt, routing, retries, session projection, and cache-control serialization remain Pi/provider-owned epoch surfaces.
- Raw artifact retention is capped at 16 MiB per result, defaults to seven-day cleanup, and can fail safely to preview-only. Search and recall use pagination rather than raw spills.
- No paid DeepSeek request was run; provider-native tests are keyless and abort before network I/O.

No unresolved UniPi-owned prefix mutation or release blocker remains.
