---
title: "@pi-unipi/notify — Sound Platform & Priority Threshold Model"
type: brainstorm
date: 2026-04-28
---

# @pi-unipi/notify — Sound Platform & Priority Threshold Model

## Problem Statement

Two enhancements to the existing `@pi-unipi/notify` package:

1. **Sound notifications are missing.** When the user steps away, visual toast notifications (native OS) or remote messages (Gotify, Telegram) may be missed if they're not near their screen. An audible MIDI sound — the Tetris theme, 5 seconds — gives an independent, unmissable alert channel.

2. **The enabled/disabled toggle model is too coarse.** Every event is either fully on or fully off per channel, with no way to say "alert me on Telegram only for serious events, but let everything through on native." A priority threshold system gives fine-grained control: each event has a priority (0–10), each channel has a threshold (0–10), and a channel only fires if the event's priority meets or exceeds it.

**Bonus fix:** The Windows native notification currently shows a bear icon and "SnoreToast" text because `appID` is unset. Default it to `"Pi Notifications"`.

## Context

**Existing notify architecture (already implemented):**
- Three platforms: `native` (node-notifier), `gotify`, `telegram`
- Per-event config: `{ enabled: boolean, platforms: string[] }`
- Settings stored at `~/.unipi/config/notify/config.json`
- TUI overlays: `/unipi:notify-settings`, `/unipi:notify-set-gotify`, `/unipi:notify-set-tg`, `/unipi:notify-test`
- Events: `workflow_end`, `ralph_loop_end`, `mcp_server_error`, `agent_end`, `memory_consolidated`, `session_shutdown`

**Original design explicitly excluded:**
- Notification sound customization (Out of Scope in `2026-04-27-notify-design.md`)
- Now being promoted to a first-class platform

**npm package:** `@pi-unipi/notify` v0.1.0 — published as part of `@pi-unipi/unipi` meta-package. User wants to test locally before `npm publish`.

## Chosen Approach

### Sound: `midi-file` parser + `midi` output (System Synth)

Parse MIDI with `midi-file` (pure JS), send events to the OS MIDI synthesizer via `midi` (node-midi, native C++/RtMidi). Windows → Microsoft GS Wavetable Synth. macOS → CoreMIDI. Linux → ALSA.

### Priority: Event priority vs channel threshold

Replace `enabled: boolean` + `platforms: string[]` with a threshold model:
- Each **event** has a `priority` (0–10). 0 = disabled entirely.
- Each **channel** has a `threshold` (0–10). Channel fires if `event.priority >= channel.threshold`.

## Why This Approach

### Sound approach
- `midi-file` is pure JS (no native deps for parsing)
- `midi` (node-midi) is battle-tested (700K+ weekly downloads), precise timing control via direct MIDI message dispatch
- System synthesizer means no soundfont bundling — keeps package size minimal
- Precise 5-second cutoff: stop dispatching events after `durationMs`, close port
- Rejected alternatives:
  - **Shell commands (`afplay`, `start file.mid`):** Less control over duration, harder to kill at exactly 5s, more fallback paths to maintain
  - **JZZ + jzz-midi-smf:** Good library (2025), but two packages vs one established combo; node-midi is more widely used

### Priority model
- More expressive than boolean — "notify me on Telegram only for priority 7+" is common UX pattern
- Uniform model across all channels including new `sound`
- Replaces `platforms: string[]` per-event override (was confusing — now routing is implicit via threshold math)
- 0 = effectively disabled (no channel has threshold 0 by default)

## Design

### File Changes

```
packages/notify/
├── assets/
│   └── default.mid         # NEW — bundled Tetris theme (5 seconds)
├── platforms/
│   ├── native.ts           # UPDATED — default appID "Pi Notifications"
│   ├── gotify.ts           # UPDATED — add threshold to dispatch check
│   ├── telegram.ts         # unchanged
│   └── sound.ts            # NEW — MIDI playback engine
├── types.ts                # UPDATED — priority model, SoundConfig, ChannelConfig
├── settings.ts             # UPDATED — new defaults, mergeWithDefaults
├── events.ts               # UPDATED — priority threshold dispatch logic
├── tui/
│   └── settings-overlay.ts # UPDATED — sliders instead of toggles, sound section
└── package.json            # UPDATED — add midi, midi-file deps; assets/* in files
```

---

### Types (`types.ts`)

**New/changed types:**

```typescript
/** Supported notification platforms — sound added */
export type NotifyPlatform = "native" | "gotify" | "telegram" | "sound";

/** Priority-based event config (replaces EventNotifyConfig) */
export interface EventConfig {
  /**
   * Priority 0–10.
   * 0 = event disabled entirely (no channels fire).
   * Higher = more channels fire (those with threshold ≤ priority).
   */
  priority: number;
}

/** Shared channel base — every platform gets enabled + threshold */
export interface ChannelConfig {
  /** Whether this channel is available at all */
  enabled: boolean;
  /**
   * Threshold 0–10.
   * Channel fires when event.priority >= this value.
   * Set to 11 to effectively mute without disabling.
   */
  threshold: number;
}

/** Native OS platform config */
export interface NativeConfig extends ChannelConfig {
  /** Windows app name shown in toast (replaces "SnoreToast") */
  windowsAppId: string;
}

/** Gotify platform config */
export interface GotifyConfig extends ChannelConfig {
  serverUrl?: string;
  appToken?: string;
  /** Gotify message priority 1–10 */
  priority: number;
}

/** Telegram platform config */
export interface TelegramConfig extends ChannelConfig {
  botToken?: string;
  chatId?: string;
}

/** Sound platform config */
export interface SoundConfig extends ChannelConfig {
  /**
   * Absolute path to MIDI file.
   * If null/undefined, plays bundled default.mid (Tetris theme).
   */
  midiPath?: string;
  /** Playback duration in milliseconds. Default: 5000 */
  durationMs: number;
}

/** Full notification configuration */
export interface NotifyConfig {
  /** Per-event priorities */
  events: Record<string, EventConfig>;
  native: NativeConfig;
  gotify: GotifyConfig;
  telegram: TelegramConfig;
  sound: SoundConfig;
}
```

**Removed:** `EventNotifyConfig`, `defaultPlatforms` (routing is now implicit via threshold).

---

### Default Config (`settings.ts`)

```typescript
export const DEFAULT_CONFIG: NotifyConfig = {
  events: {
    workflow_end:         { priority: 8  },
    ralph_loop_end:       { priority: 7  },
    mcp_server_error:     { priority: 10 },
    agent_end:            { priority: 3  },
    memory_consolidated:  { priority: 0  },
    session_shutdown:     { priority: 0  },
  },
  native: {
    enabled: true,
    threshold: 3,
    windowsAppId: "Pi Notifications",
  },
  gotify: {
    enabled: false,
    threshold: 6,
    priority: 5,
  },
  telegram: {
    enabled: false,
    threshold: 7,
  },
  sound: {
    enabled: false,
    threshold: 5,
    durationMs: 5000,
  },
};
```

**Default behavior at a glance:**

| Event | Priority | native (≥3) | gotify (≥6) | telegram (≥7) | sound (≥5) |
|-------|----------|-------------|-------------|---------------|-----------|
| `mcp_server_error` | 10 | ✓ | ✓ | ✓ | ✓ |
| `workflow_end` | 8 | ✓ | ✓ | ✓ | ✓ |
| `ralph_loop_end` | 7 | ✓ | ✓ | ✓ | ✓ |
| `agent_end` | 3 | ✓ | ✗ | ✗ | ✗ |
| `memory_consolidated` | 0 | ✗ | ✗ | ✗ | ✗ |
| `session_shutdown` | 0 | ✗ | ✗ | ✗ | ✗ |

*(Gotify/Telegram/Sound disabled by default — thresholds are active once user enables the channel)*

---

### Dispatch Logic (`events.ts`)

```typescript
export async function dispatchNotification(
  pi: ExtensionAPI,
  title: string,
  message: string,
  eventPriority: number,    // ← was eventPlatforms: NotifyPlatform[]
  eventType: string,
  config: NotifyConfig
): Promise<NotifyDispatchResult> {
  // Priority 0 = fully disabled
  if (eventPriority === 0) return { results: [], allSuccess: true };

  // Resolve which channels fire: enabled AND priority >= threshold
  const channels: NotifyPlatform[] = [];
  if (config.native.enabled   && eventPriority >= config.native.threshold)   channels.push("native");
  if (config.gotify.enabled   && eventPriority >= config.gotify.threshold)   channels.push("gotify");
  if (config.telegram.enabled && eventPriority >= config.telegram.threshold) channels.push("telegram");
  if (config.sound.enabled    && eventPriority >= config.sound.threshold)    channels.push("sound");

  // Dispatch to resolved channels...
}
```

`buildEventMessage()` and `sendToPlatform()` remain largely unchanged; `sendToPlatform()` gets a new `"sound"` case.

The `registerEventListeners()` function changes from:
```typescript
// OLD: eventConfig.enabled
if (!eventConfig?.enabled) continue;
```
to:
```typescript
// NEW: priority > 0 to bother registering
if (!eventConfig || eventConfig.priority === 0) continue;
```

---

### Sound Platform (`platforms/sound.ts`)

**MIDI playback pipeline:**

```
.mid file  →  midi-file (parse)  →  midi (node-midi output)  →  OS Synth  →  🔊
```

**Key logic:**
1. Resolve MIDI path: use `config.sound.midiPath` if set, else `assets/default.mid`
2. `fs.readFileSync()` + `parseMidi()` → MIDI object with header + tracks
3. Open `new Output()`, `output.openPort(0)` → connects to first OS MIDI synth
4. Walk all tracks, accumulate absolute tick timestamps
5. Convert ticks → milliseconds using header tempo (`ticksPerBeat` + current tempo)
6. `setTimeout` each non-meta event; skip any events beyond `durationMs`
7. After `durationMs + 100ms` grace period: `clearTimeout` all pending timers, `output.closePort()`
8. Send All Notes Off (`[0xB0 + ch, 0x7B, 0x00]`) on all 16 channels before closing port (prevents hanging notes)

**Error handling:**
- No MIDI output port: log warning, skip silently (notification still fires on other channels)
- File not found: log warning, fall back to bundled default; if default also missing, skip
- Parse error: log warning, skip sound (don't crash)
- Concurrent calls: each call gets its own `Output` instance (safe)

**Bundle path resolution:**
```typescript
const DEFAULT_MIDI = new URL("../assets/default.mid", import.meta.url).pathname;
```
Works whether installed from npm (`node_modules/.../assets/default.mid`) or run from source.

---

### User-Configurable MIDI — Copy Flow

When user provides a custom MIDI path:

1. Validate: file exists, readable, filename ends in `.mid` or `.midi`
2. Destination: `~/.unipi/config/notify/sounds/<filename>`
3. `fs.copyFileSync(source, dest)` — simple copy, no symlinks
4. Update `config.sound.midiPath` to destination path
5. Show success in TUI: `"ThemeA.mid copied and set as notification sound"`

**Why copy not symlink:**
- Symlinks break when source file moves or is deleted (user clears Downloads)
- Windows symlinks require Developer Mode or admin
- MIDI files are tiny (~2–20KB), copy cost is negligible

**Managed location:**
```
~/.unipi/config/notify/
├── config.json
└── sounds/
    └── ThemeA.mid   # user's custom MIDI
```

---

### Native AppID Fix (`platforms/native.ts`)

```typescript
notifier.notify({
  title,
  message,
  appID: options?.windowsAppId ?? "Pi Notifications",  // ← replaces undefined
});
```

The `windowsAppId` in config now defaults to `"Pi Notifications"` instead of `undefined`. Toast shows "Pi Notifications" as the app name. No bear, no SnoreToast.

---

### TUI Settings Overlay Updates (`tui/settings-overlay.ts`)

**Events section** — replace toggle with 0–10 cycle:

- Each event row shows: `[event label]  [◀ 0 ▶]` (cyclable 0–10 with ←/→ or space)
- Value 0 renders as `dim("off")`, 1–10 renders as the number
- Pressing ← on an event cycles down (0 → 10), → cycles up (10 → 0)

**Channels section** — replace toggle with threshold + enabled:

Each channel has two controls:
- `Enabled:` toggle (on/off) — completely disables the channel
- `Threshold:` 0–10 cycle — the minimum event priority to trigger this channel

**New Sound section:**

```
╔══ Sound ══════════════════════════════════════╗
║  Enabled:    [ on ]                           ║
║  Threshold:  [◀ 5 ▶]                          ║
║  MIDI File:  ThemeA.mid ✓                     ║
║  Duration:   5 seconds                        ║
║                                               ║
║  [Change MIDI File]   [Test Sound]            ║
╚═══════════════════════════════════════════════╝
```

`[Change MIDI File]` opens a text input overlay for the user to paste an absolute path. On confirm, runs the copy flow above.

`[Test Sound]` calls `playMidiSound()` directly with current config.

---

### npm Packaging

**`package.json` changes:**

```json
{
  "version": "0.2.0",
  "files": [
    "index.ts",
    "tools.ts",
    "commands.ts",
    "settings.ts",
    "events.ts",
    "types.ts",
    "platforms/*",
    "assets/*",
    "tui/*",
    "skills/**/*",
    "README.md"
  ],
  "dependencies": {
    "@pi-unipi/core": "*",
    "midi": "^2.0.0",
    "midi-file": "^1.2.4",
    "node-notifier": "^10.0.1"
  }
}
```

**Key: `"assets/*"` added** so `default.mid` is included in the published package.

**Build requirements for `midi` (node-gyp native):**
- Windows: Visual C++ Build Tools
- macOS: Xcode Command Line Tools
- Linux: `build-essential` + `libasound2-dev`

**Local testing before publish:**
1. `npm pack` → inspect tarball for `assets/default.mid`
2. Test in local Pi install: verify MIDI plays on notification
3. Test all threshold scenarios
4. `npm publish --access public` — only after local testing passes

---

## Implementation Checklist

### Types + Config
- [ ] Update `types.ts` — add `SoundConfig`, `ChannelConfig`, `EventConfig`; replace `EventNotifyConfig`; update all platform configs to extend `ChannelConfig`
- [ ] Update `settings.ts` — new `DEFAULT_CONFIG` with priority/threshold values; update `mergeWithDefaults()`; update `validateConfig()`
- [ ] Update `@pi-unipi/core` constants — add `"sound"` to platform enum if typed there

### Sound Platform
- [ ] Add `assets/default.mid` — Tetris theme trimmed to 5 seconds (copy from `C:\Users\user\Downloads\ThemeA.mid`)
- [ ] Create `platforms/sound.ts` — MIDI playback engine using `midi-file` + `midi`
- [ ] Add `midi` and `midi-file` to `package.json` dependencies
- [ ] Add `"assets/*"` to `package.json` `files` array; bump version to `0.2.0`

### Dispatch Logic
- [ ] Update `events.ts` — `dispatchNotification()` takes `eventPriority: number`; threshold comparison; add `"sound"` case to `sendToPlatform()`
- [ ] Update `registerEventListeners()` — check `priority === 0` instead of `!enabled`
- [ ] Update `tools.ts` — `notify_user` tool: `priority` param maps to numeric 0–10 (or keep low/normal/high mapped to 3/6/9)

### Native AppID Fix
- [ ] Update `platforms/native.ts` — default `appID` to `"Pi Notifications"`
- [ ] Update `settings.ts` default — `native.windowsAppId: "Pi Notifications"`

### TUI
- [ ] Update `tui/settings-overlay.ts` — events section: toggle → 0–10 cycle; channels: add threshold slider; new Sound section with MIDI file picker + test button

### User MIDI Config
- [ ] Add MIDI copy utility in `settings.ts` or `platforms/sound.ts` — validates path, copies to `~/.unipi/config/notify/sounds/`, updates config

### Testing (local, before npm publish)
- [ ] Test MIDI playback on Windows (GS Wavetable synth)
- [ ] Test bundled default.mid plays when no custom path configured
- [ ] Test custom MIDI copy flow (paste `C:\Users\user\Downloads\ThemeA.mid`)
- [ ] Test priority threshold dispatch (event priority vs channel threshold)
- [ ] Test native toast shows "Pi Notifications" instead of "SnoreToast"
- [ ] Test TUI 0–10 cycle for events and channels
- [ ] Run `npm run typecheck` — no errors
- [ ] `npm pack` — verify `assets/default.mid` is in tarball
- [ ] Publish: `npm publish --access public` (after local testing passes)

## Open Questions

1. **`notify_user` tool priority mapping:** The tool currently takes `"low"/"normal"/"high"` string enum. Options:
   - Keep string enum and map: `low→3`, `normal→6`, `high→9` internally
   - Change to numeric 0–10 (breaking change for any agent prompts using the tool)
   - Recommendation: keep string enum, map to numeric internally — less disruption

2. **Linux ALSA on headless servers:** If user runs Pi on a headless Linux server, ALSA may not be configured and `midi` will fail to open a port. Graceful skip (already in error handling) should be sufficient, but worth flagging.

3. **`default.mid` source:** The Tetris theme file is at `C:\Users\user\Downloads\ThemeA.mid`. This needs to be copied into `packages/notify/assets/default.mid` during implementation. The user should provide or confirm this file is the correct one to bundle.

4. **Concurrent notifications:** If two events fire within 5 seconds, two MIDI instances will overlap. For v1 this is acceptable (each gets its own port). A queue could be added later.

## Out of Scope

- Volume control (OS-level MIDI volume only, no programmatic control in v1)
- Non-MIDI audio formats (WAV, MP3, etc.)
- macOS/Linux soundfont bundling (relies on system synth)
- Notification sound via Gotify or Telegram (those platforms handle their own sound)
- Per-event MIDI file selection (one global MIDI file for all sound notifications)
- Batching/deduplication of concurrent sound notifications
- MIDI trimming tool (user provides pre-trimmed file or uses durationMs cutoff)
- npm publish (user tests locally first)
