# @pi-unipi/info-screen

Dashboard overlay that shows what's running. Displays module status, registered tools, custom data groups, and load times in a tabbed interface.

Every Unipi module registers itself via `MODULE_READY` events. Info-screen picks these up and builds a live dashboard. Other packages add their own data groups — ralph shows active loops, memory shows counts, compactor shows token savings.

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:info` | Show info screen dashboard |
| `/unipi:info-settings` | Configure info display (groups, stats, visibility) |

## Special Triggers

Info-screen listens for `MODULE_READY` events from `@pi-unipi/core`. When a module loads, info-screen adds it to the modules group automatically. No registration needed for basic module tracking.

Packages that want custom data groups use the registry API:

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

The footer package reads info-screen data for its extension status segment.

## Registry API

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

The registry is a singleton, also available globally via `globalThis.__unipi_info_registry`.

### Load Tracking

```typescript
import { startLoadTracking, recordLoadTime, finishLoadTracking, recordModuleStart } from "@pi-unipi/info-screen";

startLoadTracking();
recordModuleStart("@pi-unipi/memory");
// ... module loads ...
recordLoadTime("@pi-unipi/memory", "module", 150);
finishLoadTracking();
```

## Configurables

Settings in pi `settings.json`:

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

| Setting | Default | What It Does |
|---------|---------|--------------|
| `showOnBoot` | true | Show dashboard when session starts |
| `bootTimeoutMs` | 8000 | How long to wait for modules before showing |
| `groups.{id}.show` | true | Toggle group visibility |
| `groupOrder` | priority sort | Custom group ordering |

## License

MIT
