---
title: "Name Badge Overlay"
type: brainstorm
date: 2026-04-28
---

# Name Badge Overlay

## Problem Statement

When a user sets a session name via Pi's built-in `/name` command, the name is stored in session metadata and only visible in the session selector (`/resume`). During active work, the name disappears — buried in history. There's no persistent visual indicator of which session the user is in, making it easy to lose context when juggling multiple sessions.

**Root need:** A always-visible viewport overlay showing the current session name, with a quick toggle and an LLM-powered name generator.

## Context

**Existing Pi APIs:**
- `pi.setSessionName(name)` / `pi.getSessionName()` — built-in session naming
- `/name` command — built-in, sets the session display name
- `ctx.ui.custom()` with `{ overlay: true }` — opens TUI overlays with anchor-based positioning
- `overlayOptions.anchor` — supports 9 positions including `"top-right"`
- `onHandle` callback — provides `setHidden(true/false)` for programmatic visibility
- `pi.sendMessage()` with `display: false` — send hidden messages to LLM
- `pi.appendEntry()` / `ctx.sessionManager.getEntries()` — persist extension state

**Existing overlay patterns in codebase:**
- `@pi-unipi/info-screen` — cache-first reactive overlay (info-overlay.ts)
- `@pi-unipi/mcp` — settings overlay with split-pane (settings-overlay.ts)
- `@pi-unipi/notify` — settings/setup overlays with `requestRender` wiring
- All follow the pattern: `(tui, theme, kb, done) => new Component()`, with `overlay.requestRender = () => tui.requestRender()`

**What's new here:**
- First **persistent HUD-style** overlay (not a dismissible dialog)
- First overlay that **cannot be dismissed** by the user — only toggled via command
- Uses polling for reactivity (no event-based name change notification exists)

## Chosen Approach

### Name detection: Polling
Check `pi.getSessionName()` every 1 second. If changed, update the overlay. Rejected: wrapping `setSessionName` (fragile, couples to Pi internals).

### Name generation: LLM via hidden message
Send `pi.sendMessage()` with `display: false` and `triggerTurn: true`, instructing the LLM to call `set_session_name`. The message is invisible to the user; the name appears in the badge once set. Rejected: heuristic extraction (first N words) — produces poor titles for most conversations.

### Placement: `@pi-unipi/utility` package
Small feature (~150 lines) that belongs with other utility commands. Rejected: standalone package (overkill).

## Why This Approach

- **Polling** is robust and requires zero coupling to Pi internals. One function call per second is negligible overhead.
- **LLM generation** produces contextually meaningful names. `display: false` keeps the prompt hidden from the user.
- **Utility package** already has TUI infrastructure, display capabilities, and width utilities. No new dependencies needed.

## Design

### File Structure

```
packages/utility/src/
├── tui/
│   ├── name-badge.ts        # NEW — overlay component (render only)
│   └── name-badge-state.ts  # NEW — state manager, polling, overlay lifecycle
├── commands.ts               # UPDATED — register /unipi:name-badge, /unipi:badge-gen
└── index.ts                  # UPDATED — wire session_start/session_shutdown events
```

### Component: `NameBadgeComponent`

Implements `Component` from `@mariozechner/pi-tui`. Pure render — no input handling.

**Rendered output** (single-line bordered box):

With name set:
```
┌─ Refactor auth module ─┐
```

Without name:
```
┌─ Set a name now ────────┐
```

**Implementation notes:**
- `render(width)` — returns 1 line, truncated to `width` with ellipsis if needed
- Uses `theme.fg("accent", name)` for the session name
- Uses `theme.fg("muted", "Set a name now")` for the placeholder
- Border uses `theme.fg("border", ...)` or `theme.fg("borderMuted", ...)`
- `invalidate()` — clears cached render lines
- `setName(name: string | null)` — updates displayed text, calls `invalidate()`
- `setTheme(theme)` — stores theme reference for reactive theme changes

**No `handleInput`** — the overlay is display-only. It cannot receive focus, cannot be dismissed via keyboard.

### State Manager: `NameBadgeState`

Manages overlay lifecycle, polling, and toggle state.

```typescript
interface NameBadgeState {
  visible: boolean;
  currentName: string | null;
  overlayHandle: OverlayHandle | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  component: NameBadgeComponent | null;
}
```

**Methods:**

| Method | Description |
|--------|-------------|
| `async toggle(pi, ctx)` | Toggle visibility. If hidden → show + start polling. If visible → hide + stop polling. Saves state via `pi.appendEntry()`. |
| `async show(pi, ctx)` | Open overlay via `ctx.ui.custom()` with `overlay: true`, `anchor: "top-right"`. Start polling. |
| `hide()` | Close overlay handle. Stop polling. |
| `startPolling(pi)` | `setInterval` every 1s. Calls `pi.getSessionName()`, updates component if changed. |
| `stopPolling()` | `clearInterval`. |
| `async restore(pi, ctx)` | On `session_start`, check persisted state. If `visible: true`, call `show()`. |
| `async generate(pi, ctx)` | Send hidden LLM prompt to generate name. Enable badge if not visible. |

**Overlay positioning:**

```typescript
async show(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (this.overlayHandle) return; // Already showing

  const name = pi.getSessionName();
  this.currentName = name;
  this.visible = true;

  ctx.ui.custom(
    (tui, theme, kb) => {
      const component = new NameBadgeComponent(name);
      component.setTheme(theme);
      this.component = component;
      // Wire requestRender following existing pattern
      this.overlayHandle!.requestRender = () => tui.requestRender();
      return component;
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-right",
        offsetX: -1,
        offsetY: 1,
        minWidth: 20,
        visible: (termWidth) => termWidth >= 40,
      },
      onHandle: (handle) => {
        this.overlayHandle = handle;
      },
    }
  );

  this.startPolling(pi);
}
```

**Polling implementation:**

```typescript
startPolling(pi: ExtensionAPI): void {
  if (this.pollTimer) return;
  this.pollTimer = setInterval(() => {
    const name = pi.getSessionName();
    if (name !== this.currentName) {
      this.currentName = name;
      this.component?.setName(name);
      this.overlayHandle?.requestRender?.();
    }
  }, 1000);
}
```

**Reactivity to theme changes:**
When the TUI calls `invalidate()` on the component (e.g., theme change), the component clears its cache. The next poll cycle triggers a re-render with updated theme colors.

### Commands

#### `/unipi:name-badge`

Toggle the name badge overlay on/off.

```
/unipi:name-badge
```

**Behavior:**
- If hidden → show overlay + start polling + notify "Name badge enabled"
- If visible → hide overlay + stop polling + notify "Name badge disabled"
- Persist toggle state via `pi.appendEntry("name-badge", { visible: boolean })`

**No arguments.** Simple toggle.

#### `/unipi:badge-gen`

Generate a session name via LLM and enable the badge.

```
/unipi:badge-gen
```

**Behavior:**
1. Enable badge if not already visible (same as toggle ON)
2. Notify: "Generating session name..."
3. Send hidden message to LLM:

```typescript
pi.sendMessage({
  customType: "badge-gen",
  content: [
    "[System Instruction: Analyze this conversation and generate a concise session title.",
    "Call the set_session_name tool with a name that is MAXIMUM 5 WORDS.",
    "The name should capture the main topic or task being worked on.",
    "Do not explain your reasoning. Just call set_session_name.]"
  ].join(" "),
  display: false,
}, { triggerTurn: true });
```

4. Polling detects name change → overlay updates automatically
5. Timeout: set a 30s `setTimeout`. If `pi.getSessionName()` is still null after 30s, notify: "Name generation timed out". Clear timeout on successful name detection.

**No arguments.** Fully automatic.

### Persistence

Toggle state is stored as extension state via `pi.appendEntry()`:

```typescript
// Save on toggle
pi.appendEntry("name-badge", { visible: this.visible });

// Restore on session_start
pi.on("session_start", async (_event, ctx) => {
  const entries = ctx.sessionManager.getEntries();
  const badgeEntry = entries.findLast(
    (e) => e.type === "custom" && e.customType === "name-badge"
  );
  if (badgeEntry?.data?.visible) {
    await nameBadgeState.show(pi, ctx);
  }
});
```

### Error Handling

| Scenario | Behavior |
|----------|----------|
| No name set + badge visible | Show "Set a name now" placeholder |
| LLM fails to generate name | Badge stays with placeholder, no error |
| LLM generates name > 5 words | Name is accepted as-is (LLM instruction is advisory) |
| Other overlay opens | Badge stays visible underneath (overlays stack) |
| Session switch | Polling stops on `session_shutdown`, restores on `session_start` |
| Terminal too narrow | Overlay hides via `visible: (w) => w >= 40` |
| `set_session_name` not available | Graceful fallback — badge shows placeholder |

### Integration with `index.ts`

```typescript
// In extension factory
export default function (pi: ExtensionAPI) {
  const nameBadgeState = new NameBadgeState();

  pi.on("session_start", async (_event, ctx) => {
    await nameBadgeState.restore(pi, ctx);
  });

  pi.on("session_shutdown", () => {
    nameBadgeState.hide();
  });

  // Register commands in commands.ts
  registerNameBadgeCommands(pi, nameBadgeState);
}
```

## Implementation Checklist

- [x] Create `src/tui/name-badge.ts` — `NameBadgeComponent` implementing `Component` — covered in Task 2
- [x] Create `src/tui/name-badge-state.ts` — `NameBadgeState` with toggle, show, hide, polling, restore, generate — covered in Task 3
- [x] Update `src/commands.ts` — register `/unipi:name-badge` and `/unipi:badge-gen` — covered in Task 4
- [x] Update `src/index.ts` — wire `session_start` and `session_shutdown` events to `NameBadgeState` — covered in Task 5
- [x] Update `README.md` — document new commands in the Commands table — covered in Task 6

## Open Questions

- **Overlay stacking**: If another overlay (e.g., info-screen, MCP settings) opens, the badge will be underneath. Should it re-assert itself on top? Current design: no — overlays stack naturally, badge stays in its layer.
- **Theme reactivity**: The component caches themed strings. On theme change, `invalidate()` is called by TUI, but the component needs to re-apply theme colors on next render. Implementation must store theme reference, not pre-bake colors.

## Out of Scope

- **Renaming via overlay interaction** — the badge is display-only. Use `/name` or `/unipi:badge-gen` to change the name.
- **Multiple badges** — one badge per session, no stacking of multiple name badges.
- **Badge customization** — no user-configurable colors, fonts, or positions. Uses theme defaults.
- **Persistent name across sessions** — session names are per-session by design in Pi. The badge shows the current session's name only.
