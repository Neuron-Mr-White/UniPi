---
title: "Notify Recap & Agent-End Fix"
type: brainstorm
date: 2026-04-29
---

# Notify Recap & Agent-End Fix

## Problem Statement

The `@packages/notify/` package sends incorrect notifications on agent stop. The `agent_end` event handler currently sends generic "Agent finished responding" text regardless of what actually happened. Additionally, the user wants a "Recap" feature that summarizes the last assistant message before sending the notification.

## Context

**Current state:**
- `events.ts` line for `agent_end`: `case "agent_end": return "Agent finished responding";`
- `settings.ts` has `agent_end: { enabled: false, platforms: [] }` in defaults
- The `agent_end` event payload contains `{ type: "agent_end", messages: AgentMessage[] }` with the full message history
- Session name is available via `pi.getSessionName()`
- Cached model list is at `~/.unipi/config/models-cache.json` (read via `readModelCache()` from `@pi-unipi/core`)
- The default model `openrouter/openai/gpt-oss-20b` exists in the cache
- `modelRegistry.getApiKeyForProvider(provider)` resolves API keys

**Key files:**
- `packages/notify/events.ts` — event registration and message building
- `packages/notify/settings.ts` — config load/save with defaults
- `packages/notify/types.ts` — TypeScript types
- `packages/notify/tui/settings-overlay.ts` — settings TUI
- `packages/notify/index.ts` — extension entry
- `packages/core/model-cache.ts` — `readModelCache()` for cached models

## Chosen Approach

1. **Fix agent_end message**: Update `buildEventMessage` to use session name when available
2. **Add recap config**: New `recap` section in `NotifyConfig` with `enabled` boolean and `model` string
3. **Add recap model selector TUI**: New component that shows cached models for selection
4. **Implement recap summarization**: Call OpenRouter API directly using the model's API key from `modelRegistry`
5. **Wire it up**: In `agent_end` handler, if recap is on → summarize last message → send; if off → send session-name based message

## Why This Approach

- **Direct API call** for summarization: The ExtensionAPI doesn't expose a "call model" method. Using `fetch` with the API key from `modelRegistry.getApiKeyForProvider()` is the simplest reliable approach.
- **Cached model list**: Already exists at `~/.unipi/config/models-cache.json` with `readModelCache()`. Reuses existing infrastructure.
- **Config-driven**: Recap settings stored in the same `notify/config.json` alongside other settings.

## Design

### Config Changes

Add to `NotifyConfig`:
```typescript
recap: {
  enabled: boolean;        // default: false
  model: string;           // default: "openrouter/openai/gpt-oss-20b"
}
```

### Event Flow (agent_end)

```
agent_end fires
  → get session name via pi.getSessionName()
  → if config.recap.enabled:
      → get last assistant message from payload.messages
      → call recap model to summarize
      → send: "{sessionName}: {recap}" or just "{recap}"
  → else:
      → if sessionName: send "{sessionName} - Agent is complete"
      → else: send "Agent is complete"
```

### Model Selector TUI

- Reads cached models via `readModelCache()`
- Filters to only `openrouter` provider models (since default is OpenRouter)
- Interactive list with search/filter
- Default selection: `openrouter/openai/gpt-oss-20b`
- Saves selected model to config

### Summarization

- Extract last assistant message text from `AgentEndEvent.messages`
- Truncate to ~2000 chars if very long
- Call OpenRouter API: `POST https://openrouter.ai/api/v1/chat/completions`
- System prompt: "Summarize this in one concise sentence for a push notification. Reply with ONLY the summary."
- Max tokens: 100
- Timeout: 10s

## Implementation Checklist

- [ ] Update `NotifyConfig` type with `recap` field
- [ ] Update `DEFAULT_CONFIG` with recap defaults
- [ ] Update `mergeWithDefaults` to handle recap
- [ ] Fix `buildEventMessage` for `agent_end` to use session name
- [ ] Create recap model selector TUI component
- [ ] Implement `summarizeLastMessage()` function
- [ ] Update `registerEventListeners` to pass `pi` and handle recap
- [ ] Add recap model selector to settings overlay
- [ ] Add `/unipi:notify-recap-model` command or integrate into settings

## Open Questions

- Should the model selector be a separate command or integrated into the existing settings overlay?
- Should we filter the cached model list to only show models that support chat completions?

## Out of Scope

- Streaming the recap (we wait for full response)
- Recap for events other than agent_end
- Custom recap prompts
