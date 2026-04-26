---
title: "feat: UniPi Subagents Module"
type: plan
date: 2026-04-26
status: approved
confidence: high
---

# UniPi Subagents Module

## Problem Statement

The parent agent cannot parallelize work. Reading multiple files is sequential. Writing multiple files requires waiting for each to complete. No way to delegate exploration while continuing other work.

## Target End State

- Agent can spawn child agents for parallel reads and writes
- ESC kills all child agents immediately
- Write conflicts handled transparently (file-level queuing)
- Widget shows live agent status
- Extensible: custom agent types via `.unipi/config/agents/*.md`
- Integrates with workflow commands (`/unipi:work`)

## Scope and Non-Goals

**In scope:**
- `Agent` tool for spawning
- `get_result` tool for polling
- `explore` and `work` built-in types
- Custom agent types via `.unipi/config/agents/*.md`
- Per-file transparent locking for write agents
- ESC propagation to all children
- Live widget
- Config at `~/.unipi/config/subagents.json` with workspace override
- Workflow context injection

**Non-goals:**
- Mid-run steering (no `steer` tool)
- Conversation viewer
- Git worktree per agent (agents share parent's worktree)
- Group join batching

## Proposed Solution

### Package Structure

```
packages/subagents/
  package.json
  src/
    index.ts           # Extension entry, tool registration, lifecycle
    types.ts           # AgentConfig, AgentRecord, FileLock types
    agent-runner.ts    # Session creation, execution, abort forwarding
    agent-manager.ts   # Lifecycle, concurrency queue, spawn/resume
    file-lock.ts       # Per-file transparent locking
    config.ts          # Config load/validate/repair
    widget.ts          # Live widget above editor
    prompts.ts         # System prompt builder for agents
    skills/
      explore/SKILL.md
      work/SKILL.md
```

### Agent Types

| Type | Tools | Purpose | Prompt Mode |
|------|-------|---------|-------------|
| `explore` | read, bash, grep, find, ls | Parallel reads | replace |
| `work` | read, write, edit, bash, grep, find, ls | Parallel writes | replace |

Custom types defined in `.unipi/config/agents/<name>.md`:
```markdown
---
description: Code quality checker
tools: read, grep, find, bash
thinking: high
---
You are a code quality checker. Review code for...
```

### File Locking

Per-file granularity. Transparent to agents.

```typescript
// file-lock.ts
class FileLock {
  private locks = new Map<string, { agentId: string; promise: Promise<void> }>();

  async acquire(filePath: string, agentId: string): Promise<() => void> {
    // Wait for existing lock on this file
    while (this.locks.has(filePath)) {
      await this.locks.get(filePath)!.promise;
    }
    // Acquire lock
    let release: () => void;
    const promise = new Promise<void>(r => { release = r; });
    this.locks.set(filePath, { agentId, promise });
    // Return release function
    return () => {
      this.locks.delete(filePath);
      release!();
    };
  }
}
```

Write/edit tools wrap file operations with lock acquisition. Agent never sees the wait.

### ESC Propagation

```
Parent Agent (running)
  ├─ Work Agent A (running) ← AbortController A
  └─ Work Agent B (running) ← AbortController B

User presses ESC
  → Parent's signal fires
  → agent-runner detects signal in all children
  → Calls manager.abortAll()
  → All child AbortControllers fire
  → All session.abort() called
  → Parent + children all stop
```

Implementation:
```typescript
// In agent-runner.ts
function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const onAbort = () => session.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}
```

Parent passes its signal to all spawned agents. ESC triggers parent signal → all children abort.

### Config

**Location:** `~/.unipi/config/subagents.json` (global), `<workspace>/.unipi/config/subagents.json` (override)

**Auto-generation on extension start:**
1. Check `~/.unipi/config/subagents.json`
2. If missing → generate with defaults
3. If exists but corrupted (parse error) → rename to `.json.bak`, generate fresh
4. If exists and valid → load

**Defaults:**
```json
{
  "maxConcurrent": 4,
  "enabled": true,
  "types": {
    "explore": { "enabled": true },
    "work": { "enabled": true }
  }
}
```

**Workspace override:** Project-level config overrides global on any field present.

### Widget

Copied from pi-subagents. Shows:
```
● Agents
├─ ⠹ explore  auth module reads  ·  3 tool uses  ·  12.4k token  ·  4.1s
├─ ⠹ work     refactor handler   ·  5 tool uses  ·  33.8k token  ·  12.3s
└─ 1 queued
```

### Workflow Integration

When `/unipi:work` runs with subagent support:

1. **System prompt addition:**
   > "You have access to Explore and Work agents. Use them for parallel file reads and writes. Explore agents are fast for reading multiple files. Work agents can write in parallel with file-level locking."

2. **Task-aware suggestions:**
   > "Tasks to implement: [list]. Suggested distribution: Use explore agent to read auth.ts, login.ts, and user.ts in parallel. Then use work agents to write changes to separate files."

## Implementation Tasks

- [ ] 1. Create `packages/subagents/package.json` with dependencies
- [ ] 2. Create `types.ts` — AgentConfig, AgentRecord, FileLock, AgentType interfaces
- [ ] 3. Create `config.ts` — load/validate/repair config from `~/.unipi/config/subagents.json`
- [ ] 4. Create `file-lock.ts` — per-file transparent locking
- [ ] 5. Create `agent-runner.ts` — session creation, execution, abort signal forwarding
- [ ] 6. Create `agent-manager.ts` — lifecycle, concurrency queue, spawn/resume/abort
- [ ] 7. Create `prompts.ts` — system prompt builder for agent types
- [ ] 8. Create `widget.ts` — live widget (adapt from pi-subagents)
- [ ] 9. Create `index.ts` — extension entry, register Agent/get_result tools
- [ ] 10. Create skill files — `explore/SKILL.md`, `work/SKILL.md`
- [ ] 11. Create custom agent loader — discover `.unipi/config/agents/*.md`
- [ ] 12. Test ESC propagation — all children abort on parent ESC
- [ ] 13. Test file locking — concurrent writes to same file queue correctly
- [ ] 14. Test config auto-generation and corruption recovery
- [ ] 15. Test workflow integration — `/unipi:work` with subagent support

**Dependencies:** Tasks 2-4 → 5-6 → 7-8 → 9-10 → 11 → 12-15

## Acceptance Criteria

- [ ] `Agent({ type: "explore", prompt: "read all auth files" })` spawns and completes
- [ ] `Agent({ type: "work", prompt: "refactor X" })` spawns, writes files, completes
- [ ] Two work agents writing same file → second queues, no conflict
- [ ] Two work agents writing different files → both proceed in parallel
- [ ] ESC during agent run → all agents stop within 500ms
- [ ] Widget shows live agent status (spinner, tool count, tokens)
- [ ] `get_result({ agent_id, wait: true })` blocks until agent completes
- [ ] Custom agent type from `.unipi/config/agents/code-checker.md` can be spawned
- [ ] Missing config → auto-generated with defaults
- [ ] Corrupted config → renamed to `.json.bak`, fresh generated
- [ ] Workspace config overrides global config
- [ ] `/unipi:work` with subagents → system prompt includes agent guidance
- [ ] Concurrency limit respected → excess agents queued

## Decision Rationale

### Why 2 built-in types + extensible (not fixed 2)?

Built-in `explore` and `work` cover 90% of cases. Custom types let users add domain-specific agents (code-checker, test-writer) without modifying the extension.

### Why per-file locking (not per-directory)?

Per-directory is too coarse — blocks independent writes in the same directory. Per-file allows maximum parallelism while preventing conflicts.

### Why no steer tool?

Steering adds complexity. Agents should complete their task or be killed. Mid-run redirection suggests unclear initial prompts. Simpler = fewer bugs.

### Why transparent locking (not error-based)?

Error-based locking requires agents to handle retry logic. Transparent locking means agents never know about conflicts — the write tool just takes slightly longer sometimes.

### Why ESC kills everything (non-configurable)?

Partial ESC (kill some agents) creates confusing state. Which ones stopped? What about their partial writes? Kill everything = clean slate. User can re-spawn with more specific prompts.

## Assumptions

| Assumption | Status | Evidence |
|------------|--------|----------|
| pi's AbortSignal propagates to sub-agent sessions | Verified | agent-runner.ts uses forwardAbortSignal pattern |
| createAgentSession supports in-memory sessions | Verified | SessionManager.inMemory() exists |
| File-level locking sufficient for TypeScript projects | Verified | Most refactors touch distinct files |
| Widget API from pi-subagents is reusable | Unverified | Need to check pi-tui API compatibility |
| Config at ~/.unipi/config/ exists or can be created | Verified | Standard Unix path, writable |

## Risk Analysis

| Risk | Impact | Mitigation |
|------|--------|------------|
| Widget API incompatible with our pi version | Medium | Fall back to simpler text-based status |
| File lock deadlock (A waits B, B waits A) | Low | Per-file granularity prevents this |
| Agent session memory leak on abort | Low | Dispose session on completion/error |
| Config corruption on concurrent writes | Low | Atomic write with write-then-rename |

## Next Steps

- `/unipi:work` to implement this plan
