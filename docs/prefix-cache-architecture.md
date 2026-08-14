# Provider Prefix-Cache Architecture

UniPi treats provider prefix caching as a request-shape invariant, not as a local cache. Within one **cache epoch**, each provider request must preserve the preceding request's model-visible prefix and add only new tail messages.

```text
stable system prompt
+ stable ordered tool definitions
+ immutable prior messages
+ newly appended messages
```

A cache epoch is the period in which the provider, model, inference settings, system prompt, tool definitions and ordering, and already-serialized messages remain unchanged. UniPi cannot force a provider to retain or reuse its server-side cache, but it can avoid needlessly invalidating that cache.

## Rules

1. Dynamic operational state is appended as a persisted custom message. It does not rewrite the system prompt or an earlier message.
2. A newer state snapshot explicitly supersedes older snapshots. Older snapshots stay immutable until compaction.
3. Unchanged snapshots are not appended repeatedly.
4. Tool definitions and registration order are deterministic for a fixed configuration.
5. Execution policy is enforced when a tool is called rather than by changing the visible tool list mid-session.
6. Model-visible content excludes avoidable clocks, random identifiers, and unstable filesystem or locale ordering unless they are genuine new results.
7. Compaction is an explicit cache boundary. Post-compaction continuity extends the new compacted context; it does not pretend the old provider prefix survived.
8. Large external results must have a bounded model-visible representation. Full output may be retained outside provider serialization when the host offers a safe durable channel.

`display: false` only hides a custom message in Pi's transcript UI. It does **not** hide it from the model. Prefix safety comes from append-only placement, not display state.

## Gap matrix

This matrix reflects UniPi source and Pi 0.84.1 APIs as audited for the v2.5.x rollout.

| Surface | Status | Ownership and behavior |
|---|---|---|
| Ralph iteration state | Fixed | Hidden `unipi-ralph-loop-reminder` tail snapshots; no system-prompt mutation. |
| Milestone state | Fixed | Workspace-qualified, compaction-aware `unipi-milestone-snapshot` messages append only when state changes. |
| Workflow sandbox | Fixed | Stable tool schemas; `tool_call` blocks disallowed execution; active/inactive snapshots supersede prior state. |
| Memory reminders | Fixed | First-turn and retrospective reminders are tail messages. |
| Compactor resume | Fixed | One-shot hidden resume context extends the post-compaction epoch. Snapshot rendering is deterministic for fixed stored events. |
| Utility continuation | Fixed | `/continue` sends a hidden tail message. |
| BTW visible notes | Fixed | The `context` filter excludes the custom note type from its first provider projection onward; side threads use independent sessions. |
| MCP discovery and tool order | Fixed | Discovery is barriered and final names are sorted with locale-independent code-unit ordering before registration. |
| MCP JSON schemas | Fixed | Object keys and semantically unordered `required` members are canonicalized; order-sensitive literal arrays are preserved. |
| Subagent type descriptions | Fixed | Built-in, configured, and filesystem-discovered type names are code-unit sorted before entering tool descriptions. |
| Dynamic tool catalogs | Intentional boundary | MCP catalog changes and tool-enable settings require a new/restarted session when definitions change. Runtime removal is refused when Pi cannot unregister truthfully. |
| Compaction and branch summarization | Intentional boundary | History is replaced by a summary and retained tail. Pi uses separate one-shot routing behavior for summarization. |
| New/resume/fork/tree/reload | Intentional boundary | Session branch, resources, tools, or prompt inputs can change. A resumed process may reuse cache only if the provider still has an identical prefix; UniPi does not assume that. |
| Provider/model/thinking/sampling changes | Intentional boundary | These alter the request envelope and start a new epoch. Model and thinking changes are persisted by Pi. |
| Workspace/cwd and project instructions | Intentional boundary | Pi includes cwd and loaded resources in its base prompt. Switching or reloading them changes the epoch. |
| Helper and BTW sessions | Intentional boundary | Each is an independent model session with its own system prompt, tools, and cache lineage. |
| Base system prompt and cwd footer | Host-owned | Pi constructs these. UniPi avoids adding changing per-turn text to them. |
| Global extension/tool ordering | Host-owned | Pi owns extension loading and the combined registry. UniPi makes its own dynamic registration deterministic. |
| Session tree projection | Host-owned | Pi reconstructs the selected branch and compaction surface. |
| Provider-native conversion and wire serialization | Host-owned | `before_provider_request` exposes an untyped provider-native object before transport; later extensions and SDK serialization may still transform it. |
| Provider cache retention/hits | Provider-owned | Prefix identity is necessary, not sufficient. TTL, routing, load, and provider policy still determine reuse. |
| Request envelope observability | Fixed | Utility observes provider-native payloads without mutation, retains only session-local keyed HMAC fingerprints/counters, classifies structural transitions, and exposes provider-reported cache usage through `/unipi:prefix-cache`. |
| Oversized MCP/helper output | Fixed | MCP and helper results have a hard 64 KiB model-visible ceiling. Raw text up to 16 MiB is retained in random mode-0600 artifacts under an enforced mode-0700 directory and retrieved selectively with `read`; larger or failed spills return a non-retention warning. |
| Oversized paginated search/recall output | Fixed | CocoIndex and session recall default to 10 and hard-cap pages at 50 even when host validation is bypassed. CocoIndex renders 300-character excerpts; expanded recall hits are capped at 16 KiB and direct the model to narrow its query. |

## Explicit cache boundaries

The following events are expected to lose all or part of prefix reuse:

- compaction or branch summarization;
- provider or model selection changes;
- thinking level, sampling parameters, stop sequences, or output-limit changes;
- a real system-prompt/resource/skill/project-instruction change;
- a meaningful tool definition, tool order, or active-tool change;
- workspace/cwd changes represented in Pi's base prompt;
- new, resumed, forked, or navigated session branches;
- independent helper, BTW, or other one-shot model sessions.

A boundary is not necessarily a defect. An unrecorded or avoidable boundary is.

## Pi API boundary

The closest extension hook to a provider-native request body is `before_provider_request`. It is useful for structural tests and opt-in diagnostics, but it has important limits:

- `event.payload` is `unknown` and provider-specific;
- the event has no request ID, retry index, or purpose classification;
- later-loaded extensions can replace the payload afterward;
- final HTTP headers and transport serialization are separate;
- compaction and normal requests are not intrinsically distinguished.

Direct pi-ai `onPayload(payload, model)` is stronger for adapter-level tests. Exact wire correlation requires a custom provider, transport, or proxy. Parsed `cacheRead` and `cacheWrite` counters are available on final assistant or compaction usage when the provider reports them; a zero may also mean that the provider does not expose the metric.

UniPi's `/unipi:prefix-cache` diagnostic observes this provider-native boundary without replacing payloads. It classifies first request, identical retry, exact sequence extension, envelope change, payload-shape change, and history rewrite. Request and envelope fingerprints are HMAC-SHA-256 values truncated for display and keyed with a random process-memory secret. No raw payload is retained, persisted, or logged, and fingerprints intentionally cannot be correlated after reload. Model/thinking, compaction, and tree events mark explicit boundaries; subsequent payloads supply the canonical structural classification. Provider-reported cache read/write totals are deduplicated from successful assistant messages.

## Compaction

UniPi currently performs deterministic, zero-LLM compaction. Therefore it does not issue a second summarizer request whose prefix needs warming. UniPi's additional percentage trigger is disabled by default; Pi core's reserve-token safety trigger remains active unless the user changes Pi settings. With Pi 0.84.1 defaults, core compaction triggers above `contextWindow - 16,384` estimated tokens and retains approximately 20,000 recent tokens. Enabling UniPi's optional 80% trigger intentionally trades earlier epoch resets for more headroom, with cooldown and minimum-growth guards against repeat compaction. If LLM summarization is introduced, the summarization call must replay the current conversation's exact system prompt, ordered tools, and leading messages, then append the compaction instruction as the final user message. Replacing the system prompt with a special summarizer prompt would throw away the warm prefix at the most expensive point in the session.
