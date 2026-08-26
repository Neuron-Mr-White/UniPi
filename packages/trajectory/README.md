# @pi-unipi/trajectory

Live, localhost-only UniPi trajectory inspector for the current Pi session.

## Usage

```text
/unipi:trajectory             # open or reuse the server
/unipi:trajectory stop        # stop this session's server
/unipi:trajectory off         # alias of stop
/unipi:trajectory toggle      # open when stopped, stop when running
```

Typing `/unipi:trajectory` followed by a space auto-completes the available
actions (`stop`, `off`, `toggle`), so the options are discoverable without
reading the docs. Running it with no argument opens or reuses the server.

The command starts or reuses an in-process server on `127.0.0.1:8176-8186` and opens it in the default browser. The page follows the active session every 1.5 seconds, skips unchanged snapshots, and reuses an in-memory telemetry tail instead of rereading the JSONL file. The server is owned by the current Pi process and is stopped on any Pi session shutdown/reload/resume/new/fork event.

## What it shows

- The exact provider-context path: user/assistant/tool messages, effective system prompt, serialized provider request, and prefix-integrity verdict
- UniPi package operations only when they mutate context or cross an explicit context epoch boundary; UI-only hooks, registrations, notifications, command bookkeeping, and unrelated EventBus traffic are intentionally excluded from the ledger
- A per-request prefix-integrity verdict: first request, identical retry, append-only extension, explicit lifecycle boundary, or violation
- Exact prefix-break evidence: first changed message index/path plus independent system-prompt, tool-schema/order, route, thinking-level, and provider-envelope drift
- Contributing UniPi package operations between the previous request and a violation
- One-click **UniPi** and **Violations** filters, plus Trace, Integrity, and Attribution detail tabs
- The fully assembled effective system prompt for each agent run
- Turn-aware User, Assistant, Tool, Compaction, and Branch ledger
- Effective context messages before each model request and the final provider payload after serialization/extension rewrites
- Assistant reasoning and final output, including streamed assistant events
- Tool payloads, final results, errors, and measured call duration
- Provider, model, stop reason, token usage, cache reads/writes, and cost
- Provider, model, thinking level, serialized request payload, and tool schemas
- Exact TTFT, decoding/total request timing, and tool execution timing
- Input/Model/Tools overview timeline with drag-to-focus
- Search, turn folding, call folding, and a local record inspector

## Privacy and model behavior

The server binds only to `127.0.0.1`. It reads `SessionManager.getBranch()` and never appends or changes session entries, prompts, provider requests, or model context. It therefore has no prefix-cache effect.

Detailed telemetry is appended to `~/.unipi/trajectory/<session-id>.jsonl` with a private directory/file mode. Authorization, API-key, token, cookie, secret, password, and credential fields and credential-shaped values are recursively redacted before persistence.

Context-relevant prompt, request, package mutation, and prefix-integrity fields appear when captured by the trajectory telemetry sidecar. Stream deltas, response headers, inert hooks, and other activity that cannot affect model context are not persisted. Secret-shaped headers and values are redacted before persistence, and pathological events/read volume are bounded so debug capture cannot exhaust the Pi process.

## Prefix integrity

Inside one cache epoch, the previous serialized message sequence must be an exact prefix of the next request. An identical retry is also safe. Any earlier edit, removal, reorder, or middle insertion is a violation. System instructions, tool definitions/order, provider route, thinking level, and request envelope are checked independently because changes there also invalidate provider prefix caches.

Compaction, tree navigation, model changes, and thinking-level changes create explicit epoch boundaries. The first request after a boundary is labeled as such; append-only enforcement resumes on the following request.

Package attribution is intentionally limited to UniPi modules loaded through the all-in-one `@pi-unipi/unipi` umbrella. Standalone trajectory still captures Pi's observable hooks and requests, but cannot attribute calls made by independently loaded packages.

## Lifecycle

Each Pi process owns its own trajectory server. A second Pi process running `/unipi:trajectory` picks the next free localhost port in `8176-8186`; it never attaches to or controls another Pi process's server. When the owning Pi session exits, reloads, resumes another session, starts a new session, or forks, its server is closed.

## Limitations

- Live transport uses conditional 1.5-second polling rather than a push stream.
- Very large active branches are rendered in one table; unchanged snapshots are not rebuilt or rerendered.
- Tool duration uses exact executor telemetry when captured and session timestamps otherwise.
