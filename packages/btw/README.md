# @pi-unipi/btw

Side conversations that run in parallel. Ask a question using `/btw` while the main agent keeps working — the answer streams into a modal overlay without interrupting the current task.

BTW opens a real Pi sub-session with coding-tool access. Use it to clarify something, explore an idea, or think through next steps without derailing the main turn. When you're ready, inject the thread back or summarize it.

Based on [pi-btw](https://github.com/Neuron-Mr-White/pi-btw) by Dan Bachelder.

## Commands

| Command | Description |
|---------|-------------|
| `/btw [--save] <question>` | Ask a question in a side thread |
| `/btw:new [question]` | Start a fresh thread with main-session context |
| `/btw:tangent [--save] <question>` | Contextless tangent thread |
| `/btw:clear` | Dismiss modal and clear thread |
| `/btw:inject [instructions]` | Send full thread to main agent |
| `/btw:summarize [instructions]` | Summarize thread and inject into main agent |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Alt+/` | Toggle focus between BTW and main editor |
| `Ctrl+Alt+W` | Fallback focus toggle |
| `Esc` | Dismiss BTW overlay |
| `PgUp`/`PgDn` | Scroll transcript |

### Examples

```text
/btw what file defines this route?
/btw how would you refactor this parser?
/btw --save summarize the last error in one sentence
/btw:new let's start a fresh thread about auth
/btw:tangent brainstorm from first principles without using the current chat context
/btw:inject implement the plan we just discussed
/btw:summarize turn that side thread into a short handoff
```

## Special Triggers

BTW is a standalone package. It doesn't register with other packages or trigger coexists behavior.

The BTW overlay opens top-centered so the main session remains visible underneath. The modal uses Pi's TUI system for consistent styling.

## How It Works

1. `/btw` creates or reuses a BTW sub-session
2. Your question runs in a real Pi session with tool access
3. The answer streams into the BTW modal overlay
4. The thread continues until you clear it or inject it back

`/btw:inject` sends the full thread to the main agent as a user message. If Pi is busy, it queues as a follow-up. `/btw:summarize` does the same but summarizes first.

`/btw:tangent` starts a separate thread that doesn't inherit the main session's conversation context. Use it for unrelated exploration.

The `--save` flag saves that single exchange as a visible session note.

## Configurables

BTW has no configuration. Thread state is session-scoped and clears when you dismiss it.

## License

MIT
