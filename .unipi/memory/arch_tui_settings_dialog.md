---
title: arch_tui_settings_dialog
tags: [architecture, tui, settings, ux]
project: unipi
created: 2026-04-27T00:00:00Z
updated: 2026-04-27T00:00:00Z
type: pattern
---

# Architecture: TUI Settings Dialog Pattern

Build interactive settings UIs using pi's TUI components for API key management and configuration.

## Pattern

```
src/tui/
├── settings-dialog.ts    # Main dialog flow
└── provider-selector.ts  # List formatting + status
```

## Key Design

### Settings Dialog Flow
```
[Provider List] → [Select Provider] → [Configure] → [Back to List]
                        ↑
                        └──────────────────┘
```

### Provider List with Status
```typescript
interface ProviderStatus {
  provider: WebProvider;
  configured: boolean;    // Has API key + enabled
  enabled: boolean;       // Toggle state
  hasApiKey: boolean;     // Key present
}

function formatProviderStatus(status: ProviderStatus): string {
  const icon = status.configured ? "✓" : "✗";
  const name = status.provider.name.padEnd(20);
  const capabilities = status.provider.capabilities.join(", ");
  return `${icon} ${name} ${capabilities}`;
}
```

### Configuration Options
```typescript
// Toggle enable/disable
{ label: enabled ? "✓ Enabled" : "✗ Disabled", value: "__toggle__" }

// API key management
{ label: "🔑 Add API Key", value: "__add_key__" }
{ label: "🔑 Update API Key", value: "__update_key__" }
{ label: "🗑️ Remove API Key", value: "__remove_key__" }
```

### TUI Components Used
- `pi.ui.select()` — Provider selection, config options
- `pi.ui.input()` — API key entry with validation
- `pi.ui.notify()` — Success/error feedback

## Benefits
- Interactive, user-friendly configuration
- Visual status indicators (✓/✗)
- Input validation on save
- No manual JSON editing required

## Use When
- Extension has API keys or credentials
- Configuration has multiple options/toggles
- Want to provide good UX for setup
