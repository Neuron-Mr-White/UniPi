# Info Screen

See what your session costs, what fills its context and what compaction saved you.

`@pi-unipi/info-screen` · part of [UniPi](../../README.md)

<p align="center">
  <img src="../../docs/assets/screenshots/info-session.png" alt="The This session page of /unipi:info">
</p>

## What it does

- **Startup splash.** Unicrab says hello when Pi starts. The splash shows how fast Pi got ready, the session you came back to, today's spend and any update. It does not take your keys. It closes after `bootTimeoutMs`.
- **Dashboard.** `/unipi:info` opens a set of pages. The first page is about this session.
- **Scope tags.** A small letter before a number gives its scope: `g` is all projects on this machine, `p` is this project and `s` is this session.
- **Fast open.** The dashboard opens at once on cached numbers. Then it updates the page that you look at.

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
| `/unipi:info` | Opens the dashboard on **This session**. |
| `/unipi:info <page>` | Opens one page, for example `/unipi:info usage`. |

## Dashboard keys

| Key | What it does |
|---|---|
| `←` / `→`, `h` / `l` or `Tab` | Goes to the previous or next page. |
| `1` – `9` | Goes to a page. |
| `↑` / `↓` or `k` / `j` | Scrolls the page. |
| `g` / `G` | Goes to the top or the bottom. |
| `r` | Loads the page again. |
| `R` | Loads every page again. |
| `q` / `Esc` | Closes the dashboard. |

In `auto-close` mode the splash does not take keyboard input. You can type
your first prompt while it shows. If another overlay opens on top of it, the
splash waits for that overlay to close.

## Pages

| Page | What it shows |
|---|---|
| This session | Cost, tokens, replies and time. The context bucket. Billed tokens and the cache hit rate. Tokens per reply. Tools and their failures. Directory, branch, edited files and compactions. |
| Usage | Spend today, this week, this month and all time. A 30-day chart. The share of each model this month. |
| Tools | Each tool, with a colour for its source. Active tools have a full dot. |
| Skills | Each skill, with a colour for where it lives. |
| Modules | What each UniPi module adds: tools, commands, settings and keys. Other extensions. |
| Compactor | Tokens and money that compaction saved, for `g`, `p` and `s`. Each compaction in this session. |
| MCP · Memory · Web · Updates · Keys | The state of each module. MCP servers show `g` or `p` for the config that they come from. |

### The context bucket

The bucket shows what Pi sends with the next request. Each part has its own
colour:

| Part | Source |
|---|---|
| System prompt | `ctx.getSystemPrompt()` |
| Tool schemas | Name, description and parameters of each active tool. |
| Summaries | Compaction and branch summaries. |
| Your prompts, replies, tool results | The messages that Pi keeps in context. |

The page counts characters and divides by 4 to get tokens. Then it scales the
parts to the token count from Pi. Before the first reply, Pi has no count. The
page then shows its own estimate and marks it with `~`.

The bottom edge of the bucket shows how full the window is. It is green up to
70%, amber up to 90% and red after that.

### How the Compactor page counts savings

1. Each compaction makes the context smaller. The page takes the tokens before
   and after.
2. Each reply after a compaction sends the smaller context. The page
   multiplies the removed tokens by the number of these replies.
3. The page prices those tokens at the rate that you paid for context in the
   same replies. This rate includes cache discounts.

A free model saves tokens but no money. The `p` and `g` numbers come from the
session files in `~/.pi/agent/sessions/`. The page counts a compaction one
time, also when a forked session file copies it.

## Settings

Open `/unipi:settings` → **Info Screen**. The file is
`~/.unipi/config/info-screen/config.json`.

| Key | Default | What it does |
|---|---|---|
| `bootMode` | `auto-close` | The Unicrab splash. `auto-close` closes it after `bootTimeoutMs`. `on` keeps it until you press a key. `off` hides it. |
| `bootTimeoutMs` | `2500` | How long the splash stays, in milliseconds. |
| `groups.<id>.show` | `true` | Shows or hides a page. |
| `groups.<id>.stats.<stat>` | `true` | Shows or hides one stat on pages that use the plain stat list. |
| `groupOrder` | `[]` | The page order. Pages that are not in the list follow in their default order. |

The splash opens only when Pi starts. It does not open when you resume or
start a session. The start-screen header from the hints module is a separate
feature.

## Add a page from a package

A package can add its own page. Use the registry on
`globalThis.__unipi_info_registry`, or import `infoRegistry` from
`@pi-unipi/info-screen`.

```typescript
globalThis.__unipi_info_registry?.registerGroup({
  id: "my-module",
  name: "My Module",
  icon: "",
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

A page with no renderer shows its stats as a list. A package that imports
`@pi-unipi/info-screen` can give a `render(pc)` function. It can draw with the
page kit (`tiles`, `section`, `meterRow`, `rankBars`, `legend`, `tag`) and the
core viz kit (`bigText`, `spark`, `columns`, `brailleArea`, `gauge`,
`shareBar`, `grid`).

Keep the data JSON-safe. The registry writes it to disk, so the next session
opens with numbers at once.

To see each page and the splash without Pi:

```bash
npx tsx scripts/info-preview/index.ts all 60,100
INFO_PREVIEW_EXTRA=scripts/info-preview/demo.ts npx tsx scripts/info-preview/index.ts session 112
```

## How it works

Each UniPi module emits `MODULE_READY` on the
[event bus](../../docs/architecture/event-bus.md) when it loads. The Info
Screen collects these events for 150 ms. Then it marks the Tools and Modules
pages as out of date.

The registry keeps data in three places, from fast to slow:

1. **Memory.** Page data stays in memory for 5 seconds. The dashboard keeps
   each drawn page until the data or the size changes.
2. **Snapshot on disk.** `~/.unipi/cache/info-screen.json` holds the pages
   for all projects. `~/.unipi/cache/info-screen/<workspace>.json` holds the
   Memory, MCP and Compactor pages for one project. The registry does not
   write the session page.
3. **The provider.** The page runs its data provider.

The usage parser keeps a cache for each session file. It reads a file again
only when the file changes. It writes the cache to disk at most one time in
30 seconds, and at shutdown.

The session page reads the transcript one time for each new entry. The
splash reads only memory and the snapshot.

The [Footer](../footer/README.md) reads the cached Memory page from this
registry.

## See also

- [Footer](../footer/README.md)
- [Compactor](../compactor/README.md)
- [Event bus](../../docs/architecture/event-bus.md)
- [Settings reference](../../docs/reference/settings.md)
