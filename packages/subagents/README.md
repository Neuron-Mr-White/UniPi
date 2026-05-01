# @pi-unipi/subagents

Parallel execution with file locking. Spawn background or foreground agents to work on tasks concurrently — research files, fix lint errors, run tests — while the main agent keeps going.

Two built-in agent types: `explore` for read-only research, `work` for file modifications with transparent locking. Define your own types as markdown files.

## Commands

Subagents has no user commands. It's an agent tool package — the agent calls it directly.

## Special Triggers

Workflow skills detect subagents and inject parallel strategies. When `@pi-unipi/subagents` is installed, these skills get enhanced:

| Skill | What Changes |
|-------|--------------|
| `brainstorm` | Parallel research for different approaches |
| `document` | Parallel documentation of different modules |
| `gather-context` | Parallel codebase exploration |
| `review-work` | Parallel task verification |
| `scan-issues` | Parallel scanning by category |
| `work` | Parallel task execution (with file locking) |

Subagents registers with the info-screen dashboard, showing active agents and their status. The footer displays agent activity in its extension status segment.

## Agent Tools

| Tool | Description |
|------|-------------|
| `spawn_helper` | Launch a sub-agent for parallel work |
| `get_helper_result` | Check status and retrieve results from a background agent |

### spawn_helper Parameters

| Parameter | Description |
|-----------|-------------|
| `type` | Agent type (`explore`, `work`, or custom) |
| `prompt` | Task for the agent |
| `description` | Short description (3-5 words) |
| `run_in_background` | Return immediately, notify on completion |
| `max_turns` | Max agentic turns before stopping |
| `model` | Model override (e.g. `"haiku"`, `"sonnet"`) |
| `thinking` | Thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`) |

### Foreground (blocks until done)

```
spawn_helper(
  type: "explore",
  prompt: "Find all auth-related files",
  description: "Research auth files"
)
```

### Background (returns immediately)

```
spawn_helper(
  type: "work",
  prompt: "Fix all lint errors in src/",
  description: "Fix lint errors",
  run_in_background: true
)
```

### Check Background Result

```
get_helper_result(agent_id: "helper_abc123")
```

## Custom Agent Types

Create markdown files defining agent behavior:

```bash
# Global agents
~/.unipi/config/agents/reviewer.md

# Project agents
<workspace>/.unipi/config/agents/deployer.md
```

## Configurables

```json
// ~/.unipi/config/subagents.json
{
  "enabled": true,
  "maxConcurrent": 3,
  "types": {
    "explore": { "enabled": true },
    "work": { "enabled": true }
  }
}
```

| Setting | Default | What It Does |
|---------|---------|--------------|
| `enabled` | true | Enable/disable subagents |
| `maxConcurrent` | 3 | Max agents running at once |
| `types.{name}.enabled` | true | Toggle agent types |

## License

MIT
