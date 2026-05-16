# @pi-unipi/btw

Side conversations that run in parallel. Ask a question using `/unipi:btw` while the main agent keeps working — the answer streams into a modal overlay without interrupting the current task.

BTW opens a real Pi sub-session with coding-tool access. Use it to clarify something, explore an idea, or think through next steps without derailing the main turn. When you're ready, inject the thread back or summarize it.

Based on [pi-btw](https://github.com/Neuron-Mr-White/pi-btw) by Dan Bachelder.

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:btw [--save] <question>` | Ask a question in a side thread |
| `/unipi:btw-new [question]` | Start a fresh thread with main-session context |
| `/unipi:btw-tangent [--save] <question>` | Contextless tangent thread |
| `/unipi:btw-clear` | Dismiss modal and clear thread |
| `/unipi:btw-inject [instructions]` | Send full thread to main agent |
| `/unipi:btw-summarize [instructions]` | Summarize thread and inject into main agent |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Alt+/` | Toggle focus between BTW and main editor |
| `Ctrl+Alt+W` | Fallback focus toggle |
| `Esc` | Dismiss BTW overlay |
| `PgUp`/`PgDn` | Scroll transcript |

### Examples

```text
/unipi:btw what file defines this route?
/unipi:btw how would you refactor this parser?
/unipi:btw --save summarize the last error in one sentence
/unipi:btw-new let's start a fresh thread about auth
/unipi:btw-tangent brainstorm from first principles without using the current chat context
/unipi:btw-inject implement the plan we just discussed
/unipi:btw-summarize turn that side thread into a short handoff
```

## Special Triggers

BTW is a standalone package. It doesn't register with other packages or trigger coexists behavior.

The BTW overlay opens top-centered so the main session remains visible underneath. The modal uses Pi's TUI system for consistent styling.

## How It Works

1. `/unipi:btw` creates or reuses a BTW sub-session
2. Your question runs in a real Pi session with tool access
3. The answer streams into the BTW modal overlay
4. The thread continues until you clear it or inject it back

`/unipi:btw-inject` sends the full thread to the main agent as a user message. If Pi is busy, it queues as a follow-up. `/unipi:btw-summarize` does the same but summarizes first.

`/unipi:btw-tangent` starts a separate thread that doesn't inherit the main session's conversation context. Use it for unrelated exploration.

The `--save` flag saves that single exchange as a visible session note.

## Configurables

BTW has no configuration. Thread state is session-scoped and clears when you dismiss it.

## License

MIT
