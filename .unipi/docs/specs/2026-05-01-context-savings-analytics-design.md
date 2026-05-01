---
title: "Context Savings Analytics - Bridge context-mode AnalyticsEngine to info-screen"
type: brainstorm
date: 2026-05-01
---

# Context Savings Analytics - Bridge context-mode AnalyticsEngine to info-screen

## Problem Statement

Compactor stats on the info-screen are unreliable -- they show 0 across sessions. Two root causes:

1. **Compactor never actually compacts** -- `overrideDefaultCompaction: false` (default) means the deterministic compaction pipeline is opt-in. Pi core's LLM compaction fires instead, so the code that records stats never executes.
2. **Stats tracking is primitive** -- The current stats are a flat 7-line list with rough `chars / 4` token estimates and `tokensBefore * 0.85` heuristics. No per-tool breakdown, no byte-level tracking, no cross-session memory.

The user cannot tell whether compaction is working or how much context is being saved.

### User stance: token budget conscious

The target user pays for tokens and watches their budget. They need stats that answer:
- "Am I burning tokens?" -> total token consumption this session
- "Where are they going?" -> which tools consume the most
- "How much am I saving?" -> tokens/cost saved by compaction
- "Is compaction even running?" -> compaction count, automatic triggers

Stats that don't serve this stance are noise and should be excluded.

## Context

### What context-mode does differently

context-mode (`/tmp/context-mode`) has an `AnalyticsEngine` that tracks **per-tool byte consumption** at the server level:

- `runtimeStats.bytesReturned[tool]` -- bytes each tool returns to context
- `runtimeStats.bytesIndexed` -- bytes indexed into FTS5 (never enters context)
- `runtimeStats.bytesSandboxed` -- bytes from sandbox I/O (never enters context)
- `runtimeStats.calls[tool]` -- per-tool call counts
- `runtimeStats.cacheHits` / `cacheBytesSaved` -- TTL cache savings

`AnalyticsEngine.queryAll()` merges runtime stats with SessionDB continuity data into a `FullReport`:
- **Savings**: processed_kb, entered_kb, saved_kb, pct, savings_ratio, by_tool breakdown
- **Session**: id, uptime
- **Continuity**: total_events, by_category (with labels + previews), compact_count, resume_ready
- **Project memory**: total_events across all sessions, by_category

### What pi-vcc does

pi-vcc (`/tmp/pi-vcc`) is simpler -- only tracks `CompactionStats` (summarized/kept/keptTokensEst) at compaction time. No byte-level tracking, no per-tool breakdown, no dashboard.

### Current compactor info-screen

Registers a "Compactor" group with 7 stats: sessionEvents, compactions, tokensSaved, compressionRatio, indexedDocs, sandboxExecutions, searchQueries. All show 0 or N/A because the compaction pipeline rarely fires.

### Existing cost data

The `info-screen` package already has `usage-parser.ts` that parses session JSONL files for real dollar costs per model. This gives us `cost.today`, `cost.allTime`, `byModel`, etc. We can reuse this to estimate dollar savings from compaction.

## Chosen Approach

Port context-mode's `RuntimeStats` + `AnalyticsEngine` byte-tracking engine into compactor. Keep the **Compactor** info-screen group name but redesign its stats to show only what a budget-conscious user needs. Wire byte tracking into Pi's `tool_result` event so every tool call gets measured.

Also fix `overrideDefaultCompaction: true` as the new default so compactor actually runs.

### What stats to show (budget-focused)

| Stat | Why it matters | Source |
|------|----------------|--------|
| Tokens saved | "How much did compaction save me?" | `bytesKeptOut / 4` |
| Cost saved | "How much money did compaction save?" | tokens x model price |
| % reduction | "Is this thing actually working?" | `keptOut / totalProcessed x 100` |
| Top consuming tools | "Where are my tokens going?" | `bytesReturned` per tool, sorted |
| Compactions | "Is compaction happening?" | `compact_count` from SessionDB |
| Tool calls | "How active is this session?" | `total_calls` from RuntimeStats |

### What NOT to show (removed from old group)

| Removed stat | Why |
|-------------|-----|
| `bytesSandboxed` / `bytesIndexed` | Internal implementation details |
| `savingsRatio` | Redundant with % reduction |
| `beforeKb` / `afterKb` | Raw KB means nothing to users |
| `projectMemory` category bars | Cool but not budget-relevant |
| `resume_ready` | Internal state |
| `sessionEvents` raw count | Not actionable |
| `compressionRatio` | Only meaningful at compaction time, not globally |
| `indexedDocs` / `sandboxExecutions` / `searchQueries` | Internal counters |

## Why This Approach

- **Budget-focused** -- Every stat answers a question a paying user actually has. No vanity metrics.
- **Cost visibility** -- By combining RuntimeStats byte tracking with the existing usage-parser's cost data, we can show **dollar savings**, not just token counts. This is the number users care about most.
- **Info-screen is a registry** -- It already aggregates stats from all modules. Adding to the Compactor group is zero overhead.
- **Accuracy** -- Byte-level tracking in `tool_result` works regardless of which compactor runs. We measure what enters context, not just what compactor's pipeline processes.
- **Battle-tested engine** -- context-mode's AnalyticsEngine has 114K+ users. Porting the computation is lower risk than redesigning.
- **Fixes the root cause** -- Changing the default ensures compactor's deterministic compaction actually fires, which also means compaction stats get recorded properly.

**Rejected alternatives:**
- Slim bridge (B) -- Too minimal for the info-screen's capacity. User explicitly said "info screen is a registry that aggregates all of our stats, which it already exists, won't add overhead."
- Hybrid (C) -- Detail views require extending info-screen TUI with a new component concept. Over-engineered for this problem.
- Show ALL context-mode stats -- Most are internal/vanity metrics. User explicitly said "useful stats user wants to know, not all the useless stats."

## Design

### New file: `compactor/src/session/analytics.ts`

Port from context-mode's `src/session/analytics.ts` with adaptations:

```typescript
// Types
export interface RuntimeStats {
  bytesReturned: Record<string, number>;  // per tool
  bytesIndexed: number;                     // FTS5 content (kept out of context)
  bytesSandboxed: number;                   // sandbox I/O (kept out of context)
  calls: Record<string, number>;            // per tool call count
  sessionStart: number;                     // Date.now() at session start
  cacheHits: number;
  cacheBytesSaved: number;
}

export interface ContextSavings {
  rawBytes: number;
  contextBytes: number;
  savedBytes: number;
  savedPercent: number;
}

export interface FullReport {
  savings: {
    processed_kb: number;
    entered_kb: number;
    saved_kb: number;
    pct: number;
    savings_ratio: number;
    by_tool: Array<{ tool: string; calls: number; context_kb: number; tokens: number }>;
    total_calls: number;
    total_bytes_returned: number;
    kept_out: number;
    total_processed: number;
  };
  session: {
    id: string;
    uptime_min: string;
  };
  continuity: {
    total_events: number;
    compact_count: number;
    resume_ready: boolean;
  };
  projectMemory: {
    total_events: number;
    session_count: number;
  };
}
```

**AnalyticsEngine class:**
- Constructor takes a `DatabaseAdapter` (SessionDB's internal db, exposed via getter)
- `queryAll(runtimeStats: RuntimeStats): FullReport` -- merges runtime stats + DB continuity data
- Only compute fields that feed into budget-focused stats (no category labels/bars)

### Modified file: `compactor/src/index.ts`

**Add RuntimeStats accumulation:**

```typescript
const runtimeStats: RuntimeStats = {
  bytesReturned: {},
  bytesIndexed: 0,
  bytesSandboxed: 0,
  calls: {},
  sessionStart: Date.now(),
  cacheHits: 0,
  cacheBytesSaved: 0,
};
```

In `tool_result` event handler:
```typescript
pi.on("tool_result", async (event, _ctx) => {
  // ... existing event extraction code ...
  
  // Track byte consumption per tool
  const toolName = (event as any).toolName ?? "unknown";
  const responseBytes = measureResponseBytes(event);
  runtimeStats.calls[toolName] = (runtimeStats.calls[toolName] || 0) + 1;
  runtimeStats.bytesReturned[toolName] = (runtimeStats.bytesReturned[toolName] || 0) + responseBytes;
  
  // Track sandbox/indexed bytes for tools that keep data out of context
  if (isSandboxTool(toolName)) {
    runtimeStats.bytesSandboxed += responseBytes;
  }
  if (isIndexTool(toolName)) {
    runtimeStats.bytesIndexed += responseBytes;
  }
});
```

**Update session_compact handler:**
- Always record `addCompactionStats` with actual `runtimeStats` data, not just when compactor's pipeline ran
- This ensures the info-screen reflects all compactions, not just compactor-processed ones

**Update info-screen registration:**
- Replace current Compactor group stats with budget-focused stats
- Data provider uses `AnalyticsEngine.queryAll(runtimeStats)` to build `FullReport`
- Map `FullReport` fields to info-screen `StatData` format

### Modified file: `compactor/src/info-screen.ts`

Replace the current `InfoScreenData` interface and `getInfoScreenData()` function.
Group name stays **"Compactor"** but stats are redesigned for budget-conscious users:

```typescript
export interface CompactorInfoData {
  tokensSaved: StatData;       // "12.4k" -- tokens kept out of context
  costSaved: StatData;         // "$0.34" -- estimated dollar savings
  pctReduction: StatData;      // "67.2%" -- context savings percentage
  topTools: StatData;          // "bash: 8.2k" -- top token-consuming tool
  compactions: StatData;      // "3" -- compactions this session
  toolCalls: StatData;         // "42" -- total tool calls this session
}
```

**Stat details (shown on selection):**
- `tokensSaved` detail: full per-tool breakdown table (tool name, calls, tokens)
- `costSaved` detail: estimated cost breakdown per tool, based on model pricing from usage-parser
- `topTools` detail: top 5 tools sorted by token consumption with call counts
- `compactions` detail: last compaction stats (summarized msgs, kept msgs, ratio)
- Other stats: minimal detail text

**Cost estimation:** Use `usage-parser.ts`'s `parseUsageStats()` to get the current model's cost-per-token rate. Multiply `tokensSaved` by that rate for `costSaved`. This connects compaction savings directly to the user's wallet.

### Modified file: `compactor/src/config/schema.ts`

```typescript
overrideDefaultCompaction: true,  // was: false
```

This is the critical fix -- compactor's deterministic pipeline now runs by default for all compactions.

### Modified file: `compactor/src/session/db.ts`

Add `getDb()` method to expose internal db for AnalyticsEngine:

```typescript
/** Expose the underlying db for AnalyticsEngine (read-only queries) */
getDb(): any { return this.db; }
```

### Data Flow

```
Every tool call (tool_result event)
  -> runtimeStats.bytesReturned[toolName] += responseBytes
  -> runtimeStats.calls[toolName] += 1
  -> sessionDB.insertEvent(sessionId, event)

Compaction (session_compact event)
  -> sessionDB.incrementCompactCount(sessionId)
  -> sessionDB.addCompactionStats(sessionId, charsBefore, charsKept, msgs)
  -> counters.compactions++

Info-screen data provider (called by registry on demand)
  -> new AnalyticsEngine(sessionDB.getDb()).queryAll(runtimeStats)
  -> returns FullReport { savings, session, continuity, projectMemory }
  -> map to CompactorInfoData stat format (6 budget-focused stats)
```

### Error Handling

- `AnalyticsEngine.queryAll()` wraps all DB queries in try/catch -- returns zeroed stats on failure
- `runtimeStats` accumulation is additive and non-blocking -- byte measurement errors are silently skipped
- `sessionDB.getDb()` may return null if init failed -- AnalyticsEngine uses a minimal in-memory DB fallback
- Info-screen dataProvider never throws -- catches and returns empty object
- Cost estimation: if usage-parser fails or no model data, `costSaved` shows "N/A"

### Testing

- Unit: `AnalyticsEngine.queryAll()` with mock runtime stats + in-memory SessionDB
- Unit: Cost estimation calculation using usage-parser data
- Integration: verify `tool_result` handler accumulates `runtimeStats` correctly
- Integration: verify info-screen "Compactor" group renders with real data after tool calls

## Implementation Checklist

- [ ] Port `AnalyticsEngine` (queryAll computation) from context-mode into `compactor/src/session/analytics.ts`
- [ ] Add `RuntimeStats` tracking to `compactor/src/index.ts` (tool_result handler)
- [ ] Add `measureResponseBytes()` helper for Pi event format
- [ ] Add `sessionDB.getDb()` method to expose internal db for AnalyticsEngine
- [ ] Replace `compactor/src/info-screen.ts` with budget-focused `CompactorInfoData` + data provider
- [ ] Update info-screen group registration in `compactor/src/index.ts` (keep "Compactor" name, new stats)
- [ ] Add cost estimation: wire `usage-parser.ts` cost-per-token to `costSaved` stat
- [ ] Change `overrideDefaultCompaction: true` in `compactor/src/config/schema.ts`
- [ ] Update `session_compact` handler to always record stats (not just when compactor pipeline ran)
- [ ] Add per-tool breakdown as `detail` text for `tokensSaved` and `topTools` stats
- [ ] Port `createMinimalDb()` fallback for AnalyticsEngine when SessionDB unavailable
- [ ] Type-check passes: `npx tsc --noEmit --skipLibCheck` in packages/compactor
- [ ] Existing tests pass: `bun test packages/compactor/tests/`

## Open Questions

- Should `overrideDefaultCompaction: true` apply to existing configs or only new ones? (Assumption: new configs only -- existing `config.json` on disk keeps its value)
- For `costSaved`, should we use the current session's model pricing or a weighted average across all models used? (Assumption: current session's model -- simpler, more accurate for this session)

## Out of Scope

- `ctx_insight` web dashboard (context-mode's React web UI on port 4747)
- `formatReport()` visual bars (block chars) -- not needed for info-screen stat grid
- `ctx_upgrade` auto-upgrade functionality
- Project memory category bars -- not budget-relevant
- Progressive throttling changes (already bridged in prior work)
- Auto-injection changes (already bridged in prior work)
- TTL cache changes (already bridged in prior work)
- Footer compactor segment (separate from info-screen, tracks different data)
- Session continuity `by_category` display -- internal, not user-facing budget info
