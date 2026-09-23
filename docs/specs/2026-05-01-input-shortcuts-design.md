---
title: "Input Shortcuts"
type: brainstorm
date: 2026-05-01
---

# Input Shortcuts

## Problem Statement

Users working in Pi's input box need quick keyboard shortcuts to save, restore, and manipulate text without leaving the keyboard or losing context. Common scenarios include: temporarily clearing the input to switch models, preserving half-written prompts while checking something, cycling through draft snippets, and quickly toggling thinking mode. Currently there is no way to stash input text, undo input changes, or interact with a clipboard from the input box.

## Context

- Pi's extension API provides `registerShortcut()` for keybinding registration
- `ctx.ui.onTerminalInput()` provides raw keypress interception
- `ctx.ui.setStatus(key, text)` displays status messages in the footer/status bar area
- `ctx.ui.getEditorText()` / `ctx.ui.setEditorText()` read/write the input box content
- `pi.getThinkingLevel()` / `pi.setThinkingLevel()` control thinking mode
- The `@mariozechner/pi-tui` library provides `Key`, `matchesKey()` for key identification
- BTW extension uses `Key.alt("/")` and `Key.ctrlAlt("w")` as precedent for ALT-based shortcuts
- The utility package uses `ctx.ui.setWidget()` for above-editor content (badge overlay)
- No existing stash/clipboard/undo functionality exists in the codebase

## Chosen Approach

**Approach B: Shortcut + Terminal Input Hybrid**

Register `ALT+S` and `ALT+E` as pi keyboard shortcuts. When `ALT+S` fires, enter a "chord mode" state machine that uses `ctx.ui.onTerminalInput()` to capture the next keypress within a 300ms timeout window. Display chord state in the status bar using vim-style labels (e.g., `-- STASH --`). The state machine handles single-key actions (S, R, U, Y, D, T) and a two-level sub-chord for register access (A → [0-9/S]).

## Why This Approach

- **Non-invasive**: Uses pi's built-in shortcut system, doesn't replace the editor component
- **Vim-familiar UX**: Status bar chord display matches vim's `-- INSERT --` pattern
- **Clean separation**: Chord handler is a pure state machine, register storage is a simple JSON file
- **Low conflict risk**: Only intercepts ALT+S and ALT+E, doesn't interfere with normal typing

**Alternatives rejected:**
- **Approach A (Terminal Input Interceptor)**: More control but requires handling raw escape sequences; unnecessary complexity when `registerShortcut` handles ALT detection
- **Approach C (Custom Editor)**: Overkill; replaces the entire editor and risks conflicts with other extensions

## Design

### Shortcut Map

| Shortcut | Action | Behavior |
|---|---|---|
| `ALT+S → S` | Stash/Restore | If input non-empty: save to stash register, clear input. If input empty: restore from stash. |
| `ALT+S → R` | Redo | Restore next text snapshot from redo buffer |
| `ALT+S → U` | Undo | Restore previous text snapshot (1s throttle between undos) |
| `ALT+S → A → [0-9]` | Append from register | Append register N's contents to end of current input |
| `ALT+S → A → S` | Append from stash | Append stash contents to end of current input |
| `ALT+S → Y` | Copy to clipboard | Copy entire input text to system clipboard |
| `ALT+S → D` | Cut to clipboard | Copy input text to clipboard, then clear input |
| `ALT+S → T` | Toggle thinking | Cycle thinking level: off → low → medium → high → xhigh → off |
| `ALT+E` | Insert tab | Insert a literal tab character (`\t`) into the input at cursor position |

### State Machine

```
IDLE ──[ALT+S fires]──→ CHORD_ROOT ──[300ms timeout]──→ IDLE (clear status)
                             │
                 ┌───────────┼───────────┬──────────┬──────────┐
                 ↓           ↓           ↓          ↓          ↓
                [S]         [R]         [U]        [A]        [Y/D/T]
              stash       redo        undo     CHORD_REG   copy/cut/
              /restore                                  toggle think
                                                           │
                                                           ↓
                                                       IDLE (after action)

CHORD_ROOT ──[A]──→ CHORD_REG ──[300ms timeout]──→ IDLE (clear status)
                         │
                   ┌─────┼─────┐
                   ↓           ↓
                 [0-9]        [S]
              register N    stash register
```

**State transitions:**
1. `ALT+S` shortcut fires → enter `CHORD_ROOT`, set status `-- STASH --`, start 300ms timeout
2. If key received within 300ms:
   - `S/R/U/Y/D/T` → execute action, show feedback, return to IDLE
   - `A` → enter `CHORD_REG`, set status `-- STASH (append) --`, start 300ms timeout
   - Any other key → clear status, return to IDLE (silent)
3. If `A` was pressed and key received within 300ms:
   - `0-9` or `S` → execute append action, show feedback, return to IDLE
   - Any other key → clear status, return to IDLE (silent)
4. If timeout fires at any stage → clear status, return to IDLE

### Status Bar Display (Vim-style)

Uses `ctx.ui.setStatus("input-shortcuts", text)`:

| State | Status Text | Duration |
|---|---|---|
| Chord mode entered | `-- STASH --` | Until key or timeout |
| A sub-chord | `-- STASH (append) --` | Until key or timeout |
| Stash saved | `✓ stash saved` | 2 seconds |
| Stash restored | `✓ stash restored` | 2 seconds |
| Register appended | `✓ register 3 appended` | 2 seconds |
| Thinking toggled | `thinking: medium` | 2 seconds |
| Copied to clipboard | `✓ copied` | 2 seconds |
| Cut to clipboard | `✓ cut` | 2 seconds |
| Tab inserted | *(no status)* | — |
| Stash empty (on restore) | `stash empty` | 3 seconds |
| Register N empty | `register 5 empty` | 3 seconds |
| Clipboard unavailable | `clipboard unavailable` | 3 seconds |
| Undo buffer empty | `nothing to undo` | 3 seconds |
| Redo buffer empty | `nothing to redo` | 3 seconds |

### Register Storage

**File**: `.unipi/config/input-shortcuts.json`

```json
{
  "stash": "",
  "registers": ["", "", "", "", "", "", "", "", "", ""]
}
```

- 10 numbered registers (0-9) + 1 stash register (S)
- Stash is register S internally but has special toggle semantics (save-if-full / restore-if-empty)
- All registers are strings — they hold whatever text was in the input box at the time of saving
- File is created on first write, loaded lazily on first read
- Atomic writes (write to `.tmp` then rename)

### Undo/Redo Buffer

**Storage**: In-memory only (not persisted across sessions)

**Structure**: Ring buffer of up to 50 snapshots
```typescript
interface TextSnapshot {
  text: string;
  timestamp: number;
}
```

**Snapshot creation rules:**
- A snapshot is taken BEFORE the input text changes (i.e., the "before" state is saved)
- Snapshots are taken when: stash saves text, register appends text, cut clears text
- Snapshots are NOT taken for: undo/redo itself, tab insertion, clipboard copy (no text change)
- Debounce: if a snapshot was taken within 500ms, skip (prevents noise from rapid actions)

**Undo behavior:**
- Pops the most recent snapshot from the undo buffer, pushes current text to redo buffer
- Sets the editor text to the snapshot's text
- 1-second throttle: if undo was called less than 1 second ago, ignore (prevents rapid-fire undo)

**Redo behavior:**
- Pops the most recent snapshot from the redo buffer, pushes current text to undo buffer
- Sets the editor text to the snapshot's text
- No throttle (redo is always available if redo buffer has entries)

**Buffer reset:**
- Redo buffer is cleared when a new snapshot is created (i.e., any non-undo/redo text change)
- Undo buffer is cleared on session shutdown

### Clipboard Integration

Uses Node.js `child_process.execSync()` to call platform clipboard commands:

| Platform | Copy Command | Paste Command |
|---|---|---|
| Linux | `xclip -selection clipboard` or `xsel --clipboard --input` | `xclip -selection clipboard -o` or `xsel --clipboard --output` |
| macOS | `pbcopy` | `pbpaste` |
| Windows | `clip` | `powershell Get-Clipboard` |

**Detection order**: Try `xclip` first, then `xsel`, then `pbcopy`/`pbpaste` (macOS), then `clip`/`powershell` (Windows). Cache the detected command on first use. If none available, show `clipboard unavailable` in status bar.

### Thinking Toggle

Cycle order: `off → low → medium → high → xhigh → off`

Uses:
- `pi.getThinkingLevel()` — read current level
- `pi.setThinkingLevel(level)` — set new level

Status bar shows: `thinking: medium` (the new level after toggle)

### Package Structure

```
packages/input-shortcuts/
├── package.json
├── README.md
├── index.ts                  # Extension entry — registers shortcuts, lifecycle
├── src/
│   ├── chord-handler.ts      # State machine for ALT+S chord mode
│   ├── registers.ts          # Register storage (load/save JSON)
│   ├── undo-redo.ts          # Undo/redo ring buffer with throttle
│   ├── clipboard.ts          # Cross-platform clipboard read/write
│   ├── status.ts             # Status bar feedback helper (show + auto-clear)
│   └── types.ts              # Shared types
├── tests/
│   ├── chord-handler.test.ts
│   ├── registers.test.ts
│   ├── undo-redo.test.ts
│   └── clipboard.test.ts
└── skills/                   # (empty for now)
```

### Extension Entry Point (`index.ts`)

```typescript
export default function inputShortcutsExtension(pi: ExtensionAPI): void {
  // Initialize state
  const chordHandler = new ChordHandler();
  const registers = new RegisterStore();  // lazy-loads from JSON
  const undoRedo = new UndoRedoBuffer();

  let ctxRef: ExtensionContext | null = null;

  // Register ALT+S shortcut
  pi.registerShortcut(Key.alt("s"), {
    description: "Input shortcuts — stash, undo, redo, copy, cut, toggle thinking",
    handler: async (ctx: ExtensionContext) => {
      ctxRef = ctx;
      chordHandler.enterChordMode(ctx, registers, undoRedo);
    },
  });

  // Register ALT+E shortcut
  pi.registerShortcut(Key.alt("e"), {
    description: "Insert tab character into input",
    handler: async (ctx: ExtensionContext) => {
      const text = ctx.ui.getEditorText();
      ctx.ui.setEditorText(text + "\t");
    },
  });

  // Session lifecycle
  pi.on("session_shutdown", async () => {
    chordHandler.cancel();
    undoRedo.clear();
    ctxRef = null;
  });
}
```

### Chord Handler (`chord-handler.ts`)

```typescript
class ChordHandler {
  private state: "idle" | "chord_root" | "chord_reg" = "idle";
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private ctx: ExtensionContext | null = null;
  private registers: RegisterStore | null = null;
  private undoRedo: UndoRedoBuffer | null = null;
  private lastUndoAt = 0;

  enterChordMode(ctx, registers, undoRedo) {
    if (this.state !== "idle") return;
    this.ctx = ctx;
    this.registers = registers;
    this.undoRedo = undoRedo;
    this.state = "chord_root";
    ctx.ui.setStatus("input-shortcuts", "-- STASH --");

    // Subscribe to terminal input for next key
    this.unsubscribe = ctx.ui.onTerminalInput((data) => {
      this.handleKey(data);
      return { consume: true }; // consume the key
    });

    // 300ms timeout
    this.timeout = setTimeout(() => this.cancel(), 300);
  }

  private handleKey(data: string) {
    this.clearTimeout();
    const key = data.toLowerCase();

    if (this.state === "chord_root") {
      this.handleRootKey(key);
    } else if (this.state === "chord_reg") {
      this.handleRegKey(key);
    }
  }

  private handleRootKey(key: string) {
    switch (key) {
      case "s": this.actionStash(); break;
      case "r": this.actionRedo(); break;
      case "u": this.actionUndo(); break;
      case "a": this.enterRegChord(); break;
      case "y": this.actionCopy(); break;
      case "d": this.actionCut(); break;
      case "t": this.actionToggleThinking(); break;
      default: this.cancel(); break; // silent cancel
    }
  }

  // ... action implementations, status feedback, cleanup
}
```

### Register Store (`registers.ts`)

```typescript
class RegisterStore {
  private data: { stash: string; registers: string[] };
  private loaded = false;

  getStash(): string { ... }
  setStash(text: string): void { ... }
  getRegister(index: number): string { ... }
  setRegister(index: number, text: string): void { ... }

  private load() { /* read JSON, create if missing */ }
  private save() { /* atomic write to JSON */ }
}
```

### Undo/Redo Buffer (`undo-redo.ts`)

```typescript
class UndoRedoBuffer {
  private undoStack: TextSnapshot[] = [];
  private redoStack: TextSnapshot[] = [];
  private maxSize = 50;
  private lastSnapshotAt = 0;
  private debounceMs = 500;

  /** Take a snapshot of current text BEFORE it changes */
  snapshot(text: string): void {
    const now = Date.now();
    if (now - this.lastSnapshotAt < this.debounceMs) return;
    this.undoStack.push({ text, timestamp: now });
    if (this.undoStack.length > this.maxSize) this.undoStack.shift();
    this.redoStack = []; // clear redo on new change
    this.lastSnapshotAt = now;
  }

  /** Undo: restore previous text, push current to redo */
  undo(currentText: string, throttleMs = 1000): { text: string; ok: boolean; reason?: string } {
    // 1s throttle check
    if (this.undoStack.length === 0) return { text: currentText, ok: false, reason: "nothing to undo" };
    const snapshot = this.undoStack.pop()!;
    this.redoStack.push({ text: currentText, timestamp: Date.now() });
    return { text: snapshot.text, ok: true };
  }

  /** Redo: restore next text, push current to undo */
  redo(currentText: string): { text: string; ok: boolean; reason?: string } {
    if (this.redoStack.length === 0) return { text: currentText, ok: false, reason: "nothing to redo" };
    const snapshot = this.redoStack.pop()!;
    this.undoStack.push({ text: currentText, timestamp: Date.now() });
    return { text: snapshot.text, ok: true };
  }

  clear(): void { this.undoStack = []; this.redoStack = []; }
}
```

### Status Helper (`status.ts`)

```typescript
function showStatus(ctx: ExtensionContext, text: string, durationMs: number): void {
  ctx.ui.setStatus("input-shortcuts", text);
  setTimeout(() => {
    ctx.ui.setStatus("input-shortcuts", undefined); // clear
  }, durationMs);
}
```

### Constants

```typescript
const CHORD_TIMEOUT_MS = 300;
const UNDO_THROTTLE_MS = 1000;
const UNDO_DEBOUNCE_MS = 500;
const MAX_UNDO_SNAPSHOTS = 50;
const STATUS_SUCCESS_MS = 2000;
const STATUS_ERROR_MS = 3000;
const CONFIG_FILE = ".unipi/config/input-shortcuts.json";
```

## Implementation Checklist

- [x] Create `@packages/input-shortcuts` package skeleton (package.json, tsconfig, index.ts) — covered in Task 1
- [x] Implement `types.ts` — shared type definitions — covered in Task 2
- [x] Implement `registers.ts` — register store with JSON persistence — covered in Task 3
- [x] Implement `undo-redo.ts` — ring buffer with throttle and debounce — covered in Task 4
- [x] Implement `clipboard.ts` — cross-platform clipboard detection and read/write — covered in Task 5
- [x] Implement `status.ts` — status bar feedback helper with auto-clear — covered in Task 6
- [x] Implement `chord-overlay.ts` — TUI overlay for ALT+S chord mode (revised from state machine) — covered in Task 7
- [x] Implement `settings-overlay.ts` + `/unipi:stash-settings` command — covered in Task 8
- [x] Implement `index.ts` — extension entry point wiring shortcuts to chord overlay — covered in Task 9
- [x] Register package in root workspace and add to pi extensions config — covered in Task 1
- [ ] Write unit tests for chord-overlay component
- [x] Write unit tests for registers load/save/roundtrip — covered in Task 3
- [x] Write unit tests for undo-redo buffer operations and throttle — covered in Task 4
- [x] Write unit tests for clipboard detection fallback — covered in Task 5
- [x] Integration test: manual verification of all shortcut actions in Pi TUI — covered in Task 10

## Open Questions

1. **Register persistence scope**: Should registers be global (`~/.unipi/config/`) or per-project (`.unipi/config/`)? Current design uses per-project. Global might be more useful if users switch projects frequently.

2. **Undo snapshot on manual typing**: Should the undo buffer also capture snapshots as the user types (e.g., every 2 seconds of continuous typing), or only on explicit stash/register/cut actions? Current design only captures on explicit actions to keep the buffer meaningful.

3. **ALT+E tab insertion**: Should this insert at the cursor position within the input, or always append to the end? `ctx.ui.setEditorText()` replaces the entire text, so cursor-position insertion would require a custom editor component. Current design appends to end.

4. **Clipboard fallback**: If neither `xclip`, `xsel`, `pbcopy`, nor `clip` is available, should we fall back to an in-memory-only "clipboard" (not synced with system), or just report the error? Current design reports error only.

## Out of Scope

- Multi-register paste (e.g., paste from multiple registers at once)
- Register naming or labeling
- Visual register contents display (e.g., a TUI overlay showing all register contents)
- Persisting undo/redo buffer across sessions
- Macro recording/replay
- Custom keybinding configuration (hardcoded ALT+S / ALT+E for now)
