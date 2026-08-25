# UniPi Trajectory Attribution + Prefix Integrity

Build a UniPi-only tracing layer so `/unipi:trajectory` shows exactly what each UniPi package does and visibly proves whether every provider request remains prefix-cache eligible.

## Goals
- Attribute every UniPi lifecycle hook and relevant `ExtensionAPI` mutation to its package.
- Capture handler input/output/mutation/error/duration without modifying Pi core or tracing unrelated third-party extensions.
- Compare provider requests across turns and classify append-only prefix integrity.
- Show precise prefix violations: first changed index, insertion/removal/reorder, system prompt, tool schema/order, or envelope drift.
- Treat compaction/tree/model/thinking changes as explicit epoch boundaries, then enforce append-only behavior inside each epoch.
- Integrate this with the existing uncommitted full-debug trajectory implementation safely, preserving OOM/redaction bounds.
- Test, document, commit, and prepare a synchronized release only after clean-install verification.

## Checklist
- [x] Iteration 1: design the scoped UniPi tracer contract and preserve current full-debug baseline
- [x] Iteration 2: implement package-scoped ExtensionAPI wrappers in trajectory
- [x] Iteration 3: wire every umbrella UniPi package through a named scope, with trajectory sink last
- [x] Iteration 4: capture lifecycle handler before/after/result/error/duration safely
- [x] Iteration 5: capture package-attributed mutating ExtensionAPI and custom EventBus operations
- [x] Iteration 6: implement exact append-only request comparison with explicit epochs
- [x] Iteration 7: attribute prefix violations to the responsible UniPi package/hook/action
- [x] Iteration 8: project package traces and prefix verdicts into trajectory records
- [x] Iteration 9: add high-signal UI badges/tabs/filtering for package, hook, mutation, and cache verdict
- [x] Iteration 10: add focused unit/integration tests including known middle/prefix injection failures
- [x] Iteration 11: run full verification, performance/OOM review, and fix findings
- [x] Iteration 12: update documentation, commit coherent changes, and prepare release verification

## Invariants
- No Pi core changes.
- Trace only UniPi-owned modules loaded by the umbrella.
- Never mutate hook payloads merely to observe them.
- Never store credentials unredacted.
- Do not reintroduce cumulative context/stream quadratic growth.
- Previous request message sequence must be an exact prefix of the next request inside an epoch.
- System prompt, tools/order, route, and provider envelope changes are independently visible.
- Compaction/tree/model/thinking changes create explicit, explainable boundaries.
- One checklist item per iteration: inspect → implement/prove → test → update task state.

## Current baseline
Committed as `86cabb7`: trajectory captures effective system prompts, system prompt options, observable Pi hooks, provider request/response, message stream deltas, and tool middleware/execution. Typecheck, 10 trajectory tests, and full workspace tests passed.

## Iteration 1 design
- `createUnipiTracer(pi)` is created before any umbrella package. It owns the session-bound sidecar and request/epoch correlation.
- `tracer.scope(packageName)` returns a package-scoped `ExtensionAPI` wrapper. Package source stays unchanged; only umbrella wiring changes.
- Wrapped `pi.on()` records handler enter/exit, returned value, bounded mutation evidence, duration, and errors. Mutable hook surfaces are compared without altering them.
- Wrapped mutating API calls and `pi.events` operations record package/action/result/error. Read-only methods pass through without noise.
- Trajectory remains the final observer and consumes the shared recorder. Standalone `@pi-unipi/trajectory` creates its own recorder automatically.
- Prefix integrity compares final serialized provider requests. Message sequence, system instruction, tools/order, route, and envelope are separate surfaces.
- Compaction/tree/model/thinking events explicitly advance the epoch. Inside an epoch, prior messages must be an exact prefix; violations carry first changed index/path and the contributing UniPi trace operations since the prior request.
- Full payloads remain in canonical request/context records. Package traces store bounded mutation evidence rather than duplicate cumulative context, avoiding the previous quadratic/OOM failure.

## Iteration 2 implementation
- Added `createUnipiTracer(pi)` and `tracer.scope(packageName)` in `packages/trajectory/src/tracer.ts`.
- Scoped APIs attribute lifecycle hooks, mutating ExtensionAPI calls, and EventBus emit/delivery to one UniPi package.
- Mutable hooks store fingerprints plus the first bounded structural difference; they do not duplicate full context histories.
- Async/sync results, errors, and durations are recorded; sidecar redaction and 2MB event cap remain authoritative.
- Trajectory supports an injected shared recorder while standalone usage creates one automatically.
- Added tracer tests; root typecheck and 12/12 trajectory tests pass.

## Iteration 3 implementation
- `packages/unipi/index.ts` now creates one shared tracer and loads all 19 non-trajectory UniPi modules through stable package names.
- Trajectory remains unwrapped and loads last with the shared recorder, so its own observer noise is excluded while all UniPi-owned packages are attributed.
- Extension-load actions are queued until `session_start` binds the sidecar, then flushed in original order.
- Rebinding the same session is idempotent; imports/typecheck pass and trajectory tests are 13/13.

## Iteration 4 implementation
- Expanded mutation surfaces to context, provider payload/headers, system prompt, input transforms, message replacement, tool input, and tool results.
- Correctly applies handler return semantics when deriving each package's effective post-hook state; return-only context/system-prompt changes are no longer missed.
- Trace records use fingerprints and one bounded first-difference path instead of duplicating full prompt/context payloads.
- Results are fingerprinted with bounded previews; synchronous/async errors and duration remain attributed.
- Root typecheck and trajectory tests are 14/14.

## Iteration 5 implementation
- Added attribution for mutating ExtensionAPI calls, command handlers, tool execution, shortcut contexts, and custom EventBus emit/delivery.
- Command/tool contexts are scoped so `ctx.compact()`, abort, shutdown, session switching/tree/fork/reload operations identify the calling UniPi package.
- Tool registration preserves definitions but wraps execution; command registration preserves completion/options but wraps handlers.
- Extension-load registrations remain buffered and redacted until session bind.
- Added command/tool/context integration coverage; root typecheck and trajectory tests are 15/15.

## Iteration 6 implementation
- Added `PrefixIntegrityTracker` over final serialized provider payloads.
- Classifies first request, identical retry, exact prefix extension, explicit boundary, and violation.
- Separately fingerprints message history, provider system instructions, tool definitions/order, and envelope/options.
- Violations report exact first message index/path and changed/inserted/removed/reordered kind without retaining raw message text.
- Compaction/tree/model/thinking changes start explicit epochs; append-only enforcement resumes immediately after each boundary.
- Capture emits one correlated `prefix-integrity` event before every request; root typecheck and trajectory tests are 19/19.

## Iteration 7 implementation
- Recorder cursors now delimit exactly the UniPi operations occurring between provider requests.
- On a violation, the integrity event includes up to 20 contributing package operations: changed hooks, context/session mutations, active-tool/model/thinking/provider changes, and message sends.
- Safe requests omit attribution noise; evidence remains bounded and redacted.
- Added an end-to-end capture test proving a middle injection is attributed to `memory`.
- Root typecheck and trajectory tests are 20/20.

## Iteration 8 implementation
- Added dedicated `unipi` and `prefix` trajectory record kinds.
- Package trace records expose package, surface, phase, action/hook, duration, mutation evidence, and errors.
- Prefix records expose verdict, epoch, first difference path, request correlation, and contributing UniPi operations.
- Violations participate in existing error styling/search and remain ordered with session/model/tool records.
- Added projection coverage; root typecheck and trajectory tests are 21/21.

## Iteration 9 implementation
- Added **UniPi** and **Violations** toolbar filters for one-click trace narrowing.
- Added package/surface/phase/verdict/epoch summaries and dedicated Trace, Integrity, and Attribution inspector tabs.
- Prefix-safe requests render green; violations render red in both ledger and timeline.
- Package/action/hook and exact first changed path are searchable in the existing global search.
- Added served-UI assertions; root typecheck and trajectory tests remain 21/21.

## Iteration 10 implementation
- Added exact tests for middle injection, historical edit plus append, removal, reorder, tool-order drift, system drift, envelope drift, retries, valid append-only growth, and lifecycle epochs.
- Added umbrella coverage that locks all 20 UniPi scopes and guarantees trajectory is the final unwrapped sink.
- Existing redaction, event-size/read caps, system-prompt, hook, attribution, projection, server, and request/tool timing tests remain green.
- Root typecheck and trajectory tests are 24/24.

## Iteration 11 verification and fixes
- Full root typecheck passed; all workspace tests passed (only 3 expected Wigolo availability skips).
- Trajectory suite expanded to 25/25 after adding provider route/thinking fingerprint coverage.
- Removed repeated sidecar reads from attribution cursors: recorder now keeps a bounded 2,000-event in-memory ring, avoiding O(file) work per trace/request.
- Tool result traces now store bounded fingerprints/previews rather than full duplicate outputs.
- Async EventBus handlers are observed without changing EventBus's void delivery contract; shortcut execution now has full timing/error attribution.
- Umbrella import smoke test passed in ~1.3s; esbuild smoke bundle and npm pack dry-runs passed; new source files are included in trajectory tarball.
- Existing 2MB per-event, 20MB read, redaction, no-cumulative-stream-partial, and compact lifecycle-summary safeguards remain enforced.

## Iteration 12 completion
- Updated trajectory README with package attribution, prefix-integrity semantics, filters, boundaries, safety, and standalone/umbrella scope limitations.
- Updated root `[Unreleased]` changelog.
- Preserved full-debug baseline commit `86cabb7`; committed attribution/prefix-integrity/UI/docs as `98919e9`.
- Release was intentionally not published inside the implementation loop. Version synchronization and clean npm install verification are the next release action; cross-package pins must be bumped together to avoid the prior nested-stale-copy trap.
