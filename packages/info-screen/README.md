# Info Screen

See the modules, tools and extensions that Pi loads, and your token use, in one dashboard.

`@pi-unipi/info-screen` · part of [UniPi](../../README.md)

## What it does

- Opens a dashboard overlay with one tab for each data group.
- Shows five core groups: **Overview**, **Usage**, **Tools**, **Extensions** and **Skills**.
- Shows groups from other packages, for example MCP, Memory, Compactor, Web API, Updater and Input Shortcuts.
- Opens at startup and closes after 2 seconds by default.
- Opens at once with cached data. Each group then loads its new data in the background.

## Quick start

UniPi installs this package:

```bash
pi install npm:@pi-unipi/unipi
```

To install this package alone:

```bash
pi install npm:@pi-unipi/info-screen
```

Run `/unipi:info` to open the dashboard.

## Commands

| Command | What it does |
|---|---|
| `/unipi:info` | Opens the dashboard. |

## Dashboard keys

| Key | What it does |
|---|---|
| `←` / `→` or `h` / `l` | Goes to the previous or next tab. |
| `↑` / `↓` or `k` / `j` | Scrolls the tab. |
| `g` / `G` | Goes to the top or the bottom. |
| `r` | Loads the active group again. |
| `R` | Loads all groups again. |
| `q` / `Esc` | Closes the dashboard. |

The startup dashboard does not take keyboard input. You can type your first prompt while it shows. It closes after `bootTimeoutMs`. If another overlay opens on top of it, it waits for that overlay to close.

## Core groups

| Group | What it shows |
|---|---|
| Overview | Pi version, working directory, active modules, session uptime and total load time. |
| Usage | Tokens today, this week and this month. Cost today and for all time. Top model for each period. Session count. |
| Tools | Total tools, built-in tools and registered tools. |
| Extensions | Loaded Pi extensions. |
| Skills | Loaded skills. |

The Usage group reads the session files in `~/.pi/agent/sessions/`.

## Settings

Open `/unipi:settings` → **Info Screen**. The file is `~/.unipi/config/info-screen/config.json`.

| Key | Default | What it does |
|---|---|---|
| `bootMode` | `auto-close` | `on` shows the dashboard at startup until you close it. `auto-close` closes it after `bootTimeoutMs`. `off` does not show it. |
| `bootTimeoutMs` | `2000` | Time before the startup dashboard closes, in milliseconds. |
| `groups.<id>.show` | `true` | Shows or hides a group. |
| `groups.<id>.stats.<stat>` | `true` | Shows or hides one stat in a group. |

The startup dashboard opens only when Pi starts. It does not open when you resume or start a session.

The hub also has a **Group order** page that writes `groupOrder`. In this version, the dashboard does not read `groupOrder`. The groups use their `priority` order.

## Add a group from a package

A package can add its own tab. Use the registry on `globalThis.__unipi_info_registry`, or import `infoRegistry` from `@pi-unipi/info-screen`.

```typescript
globalThis.__unipi_info_registry?.registerGroup({
  id: "my-module",
  name: "My Module",
  icon: "📦",
  priority: 60,          // lower numbers come first
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

The registry has these methods: `registerGroup`, `getAllGroups`, `getGroup`, `getCachedData`, `getGroupData`, `refreshGroup`, `refreshAll`, `subscribeAll`, `getVisibleStats` and `invalidateCache`.

## How it works

Each UniPi module emits `MODULE_READY` on the [event bus](../../docs/architecture/event-bus.md) when it loads. The Info Screen collects these events for 150 ms and then updates the Overview and Tools groups one time. It loads data only while the dashboard shows.

The [Footer](../footer/README.md) reads the cached Memory group data from this registry.

## See also

- [Footer](../footer/README.md)
- [Event bus](../../docs/architecture/event-bus.md)
- [Settings reference](../../docs/reference/settings.md)
