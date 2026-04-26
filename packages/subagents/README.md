# @pi-unipi/subagents

Parallel sub-agent execution for [Pi coding agent](https://github.com/badlogic/pi-mono). Spawn background or foreground agents, track activity, and manage concurrent work.

## Install

```bash
pi install npm:@pi-unipi/subagents
```

Or as part of the full suite:
```bash
pi install npm:unipi
```

## Tools

| Tool | Description |
|------|-------------|
| `spawn_helper` | Launch a sub-agent for parallel work |
| `get_helper_result` | Check status and retrieve results from a background agent |

## Agent Types

| Type | Description |
|------|-------------|
| `explore` | Parallel file reads, research, analysis |
| `work` | Parallel file writes with transparent locking |
| Custom | Define your own in `~/.unipi/config/agents/<name>.md` |

## Usage

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

## Options

| Parameter | Description |
|-----------|-------------|
| `type` | Agent type (`explore`, `work`, or custom) |
| `prompt` | Task for the agent |
| `description` | Short description (3-5 words) |
| `run_in_background` | Return immediately, notify on completion |
| `max_turns` | Max agentic turns before stopping |
| `model` | Model override (e.g. `"haiku"`, `"sonnet"`) |
| `thinking` | Thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`) |

## Custom Agent Types

Create markdown files defining agent behavior:

```bash
# Global agents
~/.unipi/config/agents/reviewer.md

# Project agents
<workspace>/.unipi/config/agents/deployer.md
```

## Configuration

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

## Features

- **Concurrent execution** — run up to N agents simultaneously
- **File locking** — transparent locking for parallel writes
- **ESC propagation** — kill all agents with ESC
- **Activity tracking** — real-time widget showing agent progress
- **Info screen integration** — agent status in dashboard

## Dependencies

- `@pi-unipi/core` — shared utilities
- `@pi-unipi/workflow` — workflow integration
- `@pi-unipi/info-screen` — dashboard registration

## License

MIT
