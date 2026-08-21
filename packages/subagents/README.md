# @pi-unipi/subagents

Delegate work to focused child agents — in parallel, in the background, or as scripted multi-agent workflows. Feature parity with [pi-subagents](https://github.com/nicobailon/pi-subagents), built on unipi conventions: foreground children run in-process (live widget streaming), background/fork/resume/worktree runs use child `pi` processes.

## Agents

Built-in agents (lowest discovery priority — user/project definitions override):

| Agent | Use it for |
|-------|------------|
| `explore` | Read-only file research and parallel reads |
| `work` | File modifications with transparent locking |
| `scout` | Fast codebase recon: entry points, data flow, risks |
| `researcher` | Web research with sources (`web_search`, `multi_web_content_read`) |
| `worker` | Implementation: narrow edits, validation, escalation |
| `reviewer` | Code review of diffs, plans, solutions |
| `oracle` | Second opinion; challenges assumptions without editing |
| `delegate` | Lightweight general delegate close to the parent session |

Custom agents are markdown files with YAML frontmatter:

```markdown
---
name: security-reviewer
description: Security-focused review
tools: read, grep, find
thinking: high
memory: { scope: "project", path: "security-reviewer" }
---

Review changes for unsafe input handling...
```

Discovery: project `.unipi/config/agents/` > global `~/.unipi/config/agents/` > builtins. Aliases resolve (`developer` → `worker`, `advisor` → `oracle`). Per-agent overrides live in `subagents.json`.

## Tools

| Tool | Description |
|------|-------------|
| `spawn_helper` | Launch agents: single child, `workflowScript` orchestration, or management `action`s |
| `get_helper_result` | Wait on / inspect background runs; `nonBlocking` wake subscriptions |

### Single child

```
spawn_helper({ agent: "scout", task: "Analyze the auth flow" })
spawn_helper({ agent: "worker", task: "Implement it", run_in_background: true })
spawn_helper({ agent: "reviewer", task: "Review", gate: "npm test" })
```

Legacy aliases (`type`, `prompt`, `max_turns`) still work.

### Scripted workflows

```js
spawn_helper({ workflowScript: `
  const scan = await runs.run("scan", { agent: "scout", task: "Analyze auth" });
  const reviews = await runs.all([
    { key: "correctness", agent: "reviewer", task: "Review correctness: " + scan.output },
    { key: "tests", agent: "reviewer", task: "Review tests: " + scan.output }
  ]);
  return reviews.map(r => r.output);
`, async: false })
```

`runs.run` / `runs.all` / `runs.steer` inside a sandboxed VM. Budgets (`turnBudget`, `toolBudget`, `usageBudget`), worktree isolation, fork context, and acceptance gates available per child.

### Management actions

```
spawn_helper({ action: "list" | "get" | "status" | "children.list" })
spawn_helper({ action: "resume", id: "<run>", message: "Reconsider X" })
spawn_helper({ action: "doctor" | "guide", topic: "workflows" })
spawn_helper({ action: "mission.create", mission: { title, objective } })
spawn_helper({ action: "schedule.create", name, agent, task, every: "30m" })
```

## Observability

- **FleetView** panel: active work from both transports. `↓` to inspect, `j/k` navigate, `enter` opens transcripts, `esc` closes.
- **`/unipi:subagents-fleet`** · **`/unipi:subagents-doctor`** · **`/unipi:subagents-guide [topic]`**
- Background completions arrive as `<task-notification>` follow-ups automatically.
- Supervisor channel: blocked children can `contact_supervisor` for decisions.

## Configuration

`~/.unipi/config/subagents.json` (global) + `<workspace>/.unipi/config/subagents.json`:

```json
{
  "subagents": {
    "defaultModel": "ds/deepseek-v4-flash",
    "asyncByDefault": true,
    "maxSubagentSpawnsPerRun": 64,
    "fleetViewPlacement": "belowEditor"
  }
}
```

Full key reference: `spawn_helper({ action: "guide", topic: "configuration" })`. Env overrides use the `UNIPI_SUBAGENT_*` prefix.

## Storage

| Path | Contents |
|------|----------|
| `~/.unipi/missions/<project-hash>/` | Durable mission records |
| `~/.unipi/schedules/<project-hash>/` | Scheduled runs |
| `~/.unipi/agent-memory/` | Per-agent persistent memory |
| temp root (`unipi-subagents-*`) | Run artifacts, results, channels (auto-cleaned) |

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:subagents-fleet` | Show active fleet |
| `/unipi:subagents-doctor` | Config + capacity diagnosis |
| `/unipi:subagents-guide [topic]` | Bundled guide |

## Prompt shortcuts

`/council`, `/parallel-review`, `/review-loop`, `/parallel-research`, `/gather-context-and-clarify`, `/parallel-cleanup` — packaged prompt templates for common orchestration patterns.
