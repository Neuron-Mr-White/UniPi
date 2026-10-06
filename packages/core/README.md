# UniPi Core

Core gives every UniPi package one set of constants, event names, settings and
file helpers, so packages work together without direct imports.

`@pi-unipi/core` · part of [UniPi](../../README.md)

![Unicrab, the UniPi mascot](../../docs/assets/unicrab-pixel.png)

## What it does

- Defines the shared event names in `UNIPI_EVENTS` and module names in `MODULES`.
- Gives the settings engine. Each module registers a namespace. The
  `/unipi:settings` hub shows all namespaces.
- Gives the state layout under `~/.unipi/`. Each module gets `global`, `config`,
  `state` and `session` folders.
- Gives the turn arbiter, harness message metadata and the shared TUI kit.
- Gives the Unicrab hints engine. The `@pi-unipi/utility` package installs it.

Core is a library. Its `pi` field registers no extensions. You get it when you
install UniPi:

```bash
pi install npm:@pi-unipi/unipi
```

## Developer API

Import from `@pi-unipi/core`. Use the bus to share state and events between
packages. `bus.emit` publishes. `bus.get` reads the last sticky value.
`bus.on` subscribes; it auto-unsubscribes on the pi's session shutdown.
Emit and subscribe never throw.

```typescript
import { UNIPI_EVENTS, MODULES, bus, sanitize } from "@pi-unipi/core";

// Publish a one-shot event:
bus.emit(UNIPI_EVENTS.MODULE_READY, {
  name: MODULES.WORKFLOW,
  version: "3.0.0",
  commands: ["unipi:plan"],
  tools: [],
});

// Subscribe (sticky keys replay their last value here):
bus.on(pi, UNIPI_EVENTS.MODULE_READY, (payload) => {
  console.log(payload.name);
});

const safeName = sanitize("my/feature: branch");
```

| Area | Main exports |
|---|---|
| Constants | `UNIPI_PREFIX`, `MODULES`, `WORKFLOW_COMMANDS`, `MEMORY_TOOLS`, `COMPACTOR_TOOLS`, other `*_COMMANDS` and `*_DEFAULTS` |
| Events | `UNIPI_EVENTS` and payload types such as `UnipiModuleEvent`, `UnipiCompactionEvent`, `UnipiMemoryStoredEvent` |
| Settings | `registerSettings`, `getSettings`, `setSettings`, `unsetSettings`, `openSettingsHub` |
| State paths | `unipiRoot`, `workspaceRoot`, `stateDir`, `statePath`, `sessionId` |
| Turn arbiter | `installArbiter`, `registerNudgeProvider`, `registerWaitSource`, `onSettleDecision` |
| Harness messages | `sendHarnessUserMessage`, `readHarnessMeta`, `harnessToolResultDetails` |
| Command runners | `registerCommandRunner`, `runCommandByName` |
| File helpers | `sanitize`, `ensureDir`, `tryRead`, `tryDelete`, `readJson`, `writeJson`, `fileExists`, `resolvePath` |
| Other helpers | `randomId`, `now`, `parseArgs`, `getPackageVersion`, `formatTokens`, `compareVersions` |

Settings files use this layout. The project file wins over the global file.

| Scope | Path |
|---|---|
| Global settings | `~/.unipi/config/<namespace>/config.json` |
| Project settings | `<project>/.unipi/config/<namespace>/config.json` |
| Cross-project state | `~/.unipi/global/<module>/` |
| Workspace state | `~/.unipi/workspace/<id>/state/<module>/` |
| Session state | `~/.unipi/workspace/<id>/sessions/<sid>/<module>/` |

## Unicrab hints

Unicrab is the UniPi mascot. The hints engine shows one short tip above the
editor.

- At startup, the engine shows the tip with the lowest show count. After a
  version upgrade, it shows a "what's new" tip first. Each release adds its
  own "what's new" tips, so you learn about a feature when it arrives.
- The engine has 127 tips in 9 categories: commands, shortcuts, settings,
  capabilities, explanations, troubleshooting, what's new, workflows and lore.
- Some tips react to a moment, one time per session. Examples are a late-night
  turn, 50 tool calls with no error, an `rm -rf`, a force push, a hot prompt
  cache and a finished goal.
- The start screen shows the Unicrab pixel art, the version and a random lore
  line. It needs 40 columns or more. At 72 columns or more, it shows the large crab.
- Some events show a tip. Examples are context use of 70% or more, a `bash`
  run of 30 seconds or more, and 3 tool errors in a row.
- The engine shows 4 event tips or fewer per session. It does not replace a tip
  in the same turn.
- The engine keeps show counts in `~/.unipi/global/hints/hints.json`.

| Command or key | What it does |
|---|---|
| `/unipi:hint` | Opens a hint browser with a search filter. |
| `/unipi:hint next` | Shows the next startup tip. |
| `/unipi:hint reset` | Clears show counts and learned state. |
| `Alt+H` | Shows the next startup tip. |
| `Alt+Shift+H` | Goes back in the tip history of this session. |

| Key | Default | What it does |
|---|---|---|
| `hints.enabled` | `true` | Shows tips above the editor. |
| `hints.header` | `true` | Shows the Unicrab start screen. |
| `hints.crab` | `auto` | Sets the mascot style: `auto`, `blocks` or `image`. `image` uses Kitty graphics and is experimental. |
| `hints.reset` | action | Clears the hint history. |

Each hint text is in `src/hints/lines.ts`. Before you add a hint, find each
command, key, setting and tool name in the source.

## How it works

Packages find each other through events on the Pi event bus. They do not import
each other. Read the [architecture overview](../../docs/architecture/README.md),
the [event bus](../../docs/architecture/event-bus.md) and the
[turn arbiter](../../docs/architecture/turn-arbiter.md).

## See also

- [Harness messages](../../docs/architecture/harness-messages.md)
- [Settings reference](../../docs/reference/settings.md)
- [Shortcuts reference](../../docs/reference/shortcuts.md)
- [Glossary](../../docs/reference/glossary.md)
