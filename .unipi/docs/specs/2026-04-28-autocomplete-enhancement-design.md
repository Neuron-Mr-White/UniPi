---
title: "Enhanced TUI Autocomplete for /unipi:* Commands"
type: brainstorm
date: 2026-04-28
---

# Enhanced TUI Autocomplete for `/unipi:*` Commands

## Problem Statement

With 50+ `/unipi:*` commands across 8+ packages, the slash command autocomplete is a flat, unsorted list that's hard to navigate. Users can't quickly find the command they need or understand which package a command belongs to.

## Context

- Commands are registered via `pi.registerCommand()` across 9 packages: workflow, ralph, memory, mcp, utility, ask-user, info, web-api, compact
- Pi's autocomplete uses `CombinedAutocompleteProvider` which renders items via `SelectList`
- The `description` field in `AutocompleteItem` supports ANSI escape codes (verified in `truncateToWidth` and `visibleWidth`)
- `ctx.ui.addAutocompleteProvider()` allows stacking custom providers on top of the built-in one
- Providers are chained: each can either delegate to `current` or return its own suggestions

## Chosen Approach

**Self-contained extension with `addAutocompleteProvider`** — one new file that intercepts `/unipi:*` autocomplete and returns enhanced items.

## Why This Approach

- **Zero changes** to existing packages or pi core
- **Self-contained** — single file, easy to understand and maintain
- **Toggleable** — can be enabled/disabled via settings
- **Effective** — directly solves the navigation problem with visual grouping

Rejected alternatives:
- Package-exported metadata: Overkill, requires modifying every package's command registration
- Config-driven: Adds unnecessary indirection for a small command list

## Design

### Architecture

```
User types "/brain"
       ↓
Provider chain: our wrapper → base provider
       ↓
1. Call current.getSuggestions() → get ALL matching commands
2. Filter OUT items where value.startsWith("unipi:")
3. Generate enhanced unipi items (sorted, colored, tagged)
4. Merge non-unipi + enhanced unipi items
       ↓
SelectList renders merged items
```

### Command Registry

Static mapping of command name → package name:

```typescript
const COMMAND_REGISTRY: Record<string, string> = {
  // workflow (14 commands)
  "unipi:brainstorm": "workflow",
  "unipi:plan": "workflow",
  "unipi:work": "workflow",
  "unipi:review-work": "workflow",
  "unipi:consolidate": "workflow",
  "unipi:worktree-create": "workflow",
  "unipi:worktree-list": "workflow",
  "unipi:worktree-merge": "workflow",
  "unipi:consultant": "workflow",
  "unipi:quick-work": "workflow",
  "unipi:gather-context": "workflow",
  "unipi:document": "workflow",
  "unipi:scan-issues": "workflow",
  "unipi:auto": "workflow",

  // ralph (2 commands)
  "unipi:ralph": "ralph",
  "unipi:ralph-stop": "ralph",

  // memory (7 commands)
  "unipi:memory-process": "memory",
  "unipi:memory-search": "memory",
  "unipi:memory-consolidate": "memory",
  "unipi:memory-forget": "memory",
  "unipi:global-memory-search": "memory",
  "unipi:global-memory-list": "memory",
  "unipi:memory-settings": "memory",

  // mcp (5 commands)
  "unipi:mcp-status": "mcp",
  "unipi:mcp-sync": "mcp",
  "unipi:mcp-add": "mcp",
  "unipi:mcp-settings": "mcp",
  "unipi:mcp-reload": "mcp",

  // utility (6 commands)
  "unipi:continue": "utility",
  "unipi:reload": "utility",
  "unipi:status": "utility",
  "unipi:cleanup": "utility",
  "unipi:env": "utility",
  "unipi:doctor": "utility",

  // ask-user (1 command)
  "unipi:ask-user-settings": "ask-user",

  // info (2 commands)
  "unipi:info": "info",
  "unipi:info-settings": "info",

  // web-api (2 commands)
  "unipi:web-settings": "web-api",
  "unipi:web-cache-clear": "web-api",

  // compact (9 commands)
  "unipi:compact": "compact",
  "unipi:compact-recall": "compact",
  "unipi:compact-stats": "compact",
  "unipi:compact-doctor": "compact",
  "unipi:compact-settings": "compact",
  "unipi:compact-preset": "compact",
  "unipi:compact-index": "compact",
  "unipi:compact-search": "compact",
  "unipi:compact-purge": "compact",
};
```

### Package Colors & Order

Rainbow colors using ANSI bright variants for readability on dark backgrounds:

| Order | Package    | ANSI Code | Color         |
|-------|------------|-----------|---------------|
| 1     | workflow   | `\x1b[91m` | Bright Red    |
| 2     | ralph      | `\x1b[33m` | Yellow/Orange |
| 3     | memory     | `\x1b[93m` | Bright Yellow |
| 4     | mcp        | `\x1b[32m` | Green         |
| 5     | utility    | `\x1b[36m` | Cyan          |
| 6     | ask-user   | `\x1b[94m` | Bright Blue   |
| 7     | info       | `\x1b[35m` | Magenta       |
| 8     | web-api    | `\x1b[95m` | Bright Magenta|
| 9     | compact    | `\x1b[37m` | White         |

### Display Format

```
→ /unipi:brainstorm   [workflow] Collaborative discovery — explore problem space...
  /unipi:plan         [workflow] Strategic planning — tasks, dependencies...
  /unipi:ralph        [ralph]    Ralph loop commands (start, stop, resume...)
  /unipi:memory-*     [memory]   ...
```

- `[package]` tag is colored with the package's ANSI color
- Description text after the tag uses terminal default color (reset via `\x1b[0m`)
- Commands are sorted by package order, then alphabetically within each package

### Provider Logic

```typescript
// Pseudocode for the autocomplete provider
async getSuggestions(lines, cursorLine, cursorCol, options) {
  const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);

  // Only intercept slash commands
  if (!beforeCursor.startsWith("/")) {
    return current.getSuggestions(lines, cursorLine, cursorCol, options);
  }

  // Get base suggestions (includes all commands)
  const baseSuggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
  if (!baseSuggestions) return null;

  // Separate: keep non-unipi items, discard unipi items
  const nonUnipiItems = baseSuggestions.items.filter(
    item => !item.value.startsWith("unipi:")
  );

  // Generate enhanced unipi items
  const enhancedUnipiItems = getEnhancedUnipiItems(baseSuggestions.prefix);

  // If no unipi items match, just return non-unipi
  if (enhancedUnipiItems.length === 0) {
    return nonUnipiItems.length > 0
      ? { items: nonUnipiItems, prefix: baseSuggestions.prefix }
      : null;
  }

  // Merge: non-unipi first, then enhanced unipi (sorted by package)
  return {
    items: [...nonUnipiItems, ...enhancedUnipiItems],
    prefix: baseSuggestions.prefix,
  };
}
```

### Fuzzy Matching for Unipi Items

```typescript
function getEnhancedUnipiItems(prefix: string): AutocompleteItem[] {
  const query = prefix.replace(/^unipi:/, "").toLowerCase();

  return Object.entries(COMMAND_REGISTRY)
    .filter(([cmd]) => {
      // Match against the command name (without unipi: prefix)
      const cmdName = cmd.replace("unipi:", "").toLowerCase();
      return fuzzyMatch(cmdName, query);
    })
    .sort((a, b) => {
      // Sort by package order, then alphabetically
      const orderA = PACKAGE_ORDER.indexOf(a[1]);
      const orderB = PACKAGE_ORDER.indexOf(b[1]);
      if (orderA !== orderB) return orderA - orderB;
      return a[0].localeCompare(b[0]);
    })
    .map(([cmd, pkg]) => ({
      value: cmd,
      label: cmd.replace("unipi:", ""),
      description: `${COLORS[pkg]}[${pkg}]\x1b[0m ${getDescription(cmd)}`,
    }));
}
```

### Settings

Single toggle in unipi settings:

```typescript
interface UnipiSettings {
  autocompleteEnhanced: boolean; // default: true
}
```

When disabled, the provider delegates entirely to `current.getSuggestions()` without any interception.

### Additional Provider Methods

```typescript
// Delegate completion application to base provider
applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
  return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
}

// Delegate file completion trigger to base provider
shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
  return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
}
```

### Fuzzy Matching

Use the same `fuzzyFilter` function from `@mariozechner/pi-tui` that the base provider uses. Import it to ensure consistent matching behavior.

### Error Handling

- If `COMMAND_REGISTRY` is missing a command, it falls through to the base provider (no crash)
- If ANSI codes cause rendering issues, the feature can be disabled via settings
- The provider never throws — all errors are caught and fall back to base behavior

### Testing

1. **Manual testing:** Type `/` in pi, verify unipi commands show with colors and package tags
2. **Fuzzy matching:** Type `/brain`, `/mem`, `/mcp` — verify correct filtered results
3. **Non-unipi commands:** Type `/model`, `/quit` — verify they show normally
4. **Empty prefix:** Type `/` — verify merged list with all commands
5. **Settings toggle:** Disable setting, verify plain autocomplete returns
6. **Edge cases:** Type `/unipi:nonexistent` — verify no crash, graceful fallback

## Implementation Checklist

- [ ] Create `packages/autocomplete/index.ts` with provider logic
- [ ] Define `COMMAND_REGISTRY` mapping all 48 commands to packages
- [ ] Define `PACKAGE_ORDER` and `PACKAGE_COLORS` constants
- [ ] Implement fuzzy matching for unipi commands
- [ ] Implement `getEnhancedUnipiItems()` with sorting and formatting
- [ ] Register provider via `ctx.ui.addAutocompleteProvider()` in `session_start`
- [ ] Add `autocompleteEnhanced` setting to unipi settings schema
- [ ] Register the extension in the main unipi index
- [ ] Test with all command categories
- [ ] Test edge cases (empty prefix, no match, non-unipi commands)
- [ ] Verify `applyCompletion` delegates correctly
- [ ] Verify argument completions work (e.g., `/unipi:plan specs:`)

## Open Questions

- Should the package colors be configurable via settings, or is the hardcoded rainbow sufficient?
- Should we validate at startup that all registered unipi commands are in the `COMMAND_REGISTRY` and log warnings for missing ones?

## Out of Scope

- Modifying pi-tui or pi-coding-agent core
- Changing how commands are registered in existing packages
- Adding new commands (this only enhances existing autocomplete)
- Touching the `btw:` namespace commands (separate concern)
