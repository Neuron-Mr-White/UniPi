---
title: arch_event_module_discovery
tags: [architecture, events, subagents, integration]
project: unipi
created: 2026-04-27T00:00:00Z
updated: 2026-04-27T00:00:00Z
type: pattern
---

# Architecture: Event-Based Module Discovery

Use events to enable dynamic module discovery and integration, especially for subagent tool injection.

## Pattern

### Module Registration (on session_start)
```typescript
pi.on("session_start", async (_event, ctx) => {
  emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
    name: MODULES.WEB_API,
    version: VERSION,
    commands: ["unipi:web-settings", "unipi:web-cache-clear"],
    tools: ["web_search", "web_read", "web_llm_summarize"],
  });
});
```

### Module Listener (in subagents extension)
```typescript
pi.on(UNIPI_EVENTS.MODULE_READY, async (event, ctx) => {
  const { name, tools, commands } = event.payload;
  // Register tools for subagent spawning
  moduleRegistry.set(name, { tools, commands });
});
```

## Key Events
- `unipi:module:ready` — Module loaded, tools/commands available
- `unipi:memory:stored` — Memory saved
- `unipi:memory:searched` — Memory queried

## Benefits
- Loose coupling between extensions
- Dynamic tool availability based on installed extensions
- Subagents automatically get tools from all loaded modules
- No hard dependencies between extensions

## Use When
- Extension provides tools that subagents should use
- Want dynamic capability discovery
- Extensions should work independently but integrate when present
