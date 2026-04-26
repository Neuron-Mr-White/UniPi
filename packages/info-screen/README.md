# @pi-unipi/info-screen

Dashboard and module registry for [Unipi](https://github.com/Neuron-Mr-White/unipi). Shows a configurable info overlay on boot with tabbed groups from all registered modules.

## Install

```bash
pi install npm:@pi-unipi/info-screen
```

Or as part of the full suite:
```bash
pi install npm:unipi
```

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:info` | Show info screen dashboard |
| `/unipi:info-settings` | Configure info display (groups, stats, visibility) |

## Features

- **Module discovery** — listens for `MODULE_READY` events, tracks all registered modules
- **Tabbed groups** — each module registers info groups with custom data providers
- **Configurable** — per-group and per-stat visibility via settings
- **Boot overlay** — shows dashboard on session start (configurable)
- **Styled dialog chrome** — uses pi-tui theme API for consistent borders, scrollable content, and navigation hints (matching the overlay style used by @pi-unipi/btw)
- **Core groups** — modules, tools, load time, session info out of the box

## Registering a Group

Other modules register info groups via the global registry:

```typescript
import { infoRegistry } from "@pi-unipi/info-screen";

infoRegistry.registerGroup({
  id: "my-module",
  name: "My Module",
  icon: "📦",
  priority: 60,
  config: {
    showByDefault: true,
    stats: [
      { id: "status", label: "Status", show: true },
      { id: "count", label: "Count", show: true },
    ],
  },
  dataProvider: async () => ({
    status: { value: "running" },
    count: { value: "42", detail: "items processed" },
  }),
});
```

## API

### `infoRegistry`

Singleton registry instance. Also available globally via `globalThis.__unipi_info_registry`.

| Method | Description |
|--------|-------------|
| `registerGroup(group)` | Register an info group |
| `unregisterGroup(id)` | Remove a group |
| `getGroups()` | Get visible groups (sorted by priority) |
| `getAllGroups()` | Get all groups (including hidden) |
| `getGroupData(id)` | Get data for a group (cached) |
| `updateGroupData(id, data)` | Manually update group data |
| `getVisibleStats(id)` | Get enabled stats for a group |
| `invalidateCache(id)` | Invalidate cached data |

### Load Tracking

```typescript
import { startLoadTracking, recordLoadTime, finishLoadTracking, recordModuleStart } from "@pi-unipi/info-screen";

// Track module load times
startLoadTracking();
recordModuleStart("@pi-unipi/memory");
// ... module loads ...
recordLoadTime("@pi-unipi/memory", "module", 150);
finishLoadTracking();
```

## Settings

Configure in pi `settings.json`:

```json
{
  "unipi": {
    "infoScreen": {
      "showOnBoot": true,
      "bootTimeoutMs": 8000,
      "groups": {
        "modules": { "show": true },
        "ralph": { "show": true },
        "memory": { "show": false }
      },
      "groupOrder": ["modules", "ralph", "subagents"]
    }
  }
}
```

## Dependencies

- `@pi-unipi/core` — shared constants and events

## License

MIT
