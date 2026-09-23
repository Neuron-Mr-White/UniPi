---
title: "TUI crash — child.render is not a function — Debug Report"
type: debug
date: 2026-04-30
severity: high
status: root-caused
---

# TUI Crash — `child.render is not a function` — Debug Report

## Summary

Resuming session 'ralph loop' with the `unipi` alias crashes the TUI because `ToolExecutionComponent.updateDisplay()` does not `await` async `renderResult` functions. The `write`/`edit` tools registered by `@pi-unipi/utility` use `async renderResult()`, which returns a Promise instead of a Component. The Promise is added as a TUI child and later fails when `Container.render()` calls `child.render(width)` on it.

## Expected Behavior

Session resumes normally with diff-rendered write/edit tool results displayed inline.

## Actual Behavior

```
TypeError: child.render is not a function
    at Container.render (tui.js:64:38)
    at ToolExecutionComponent.render (tool-execution.js:181:22)
    at Container.render (tui.js:64:38)
    at TUI.render (tui.js:64:38)
    at TUI.doRender (tui.js:691:29)
    at Timeout._onTimeout (tui.js:350:18)
```

Pi crashes on startup. `pi --no-extensions` works fine.

## Reproduction Steps

1. Start pi with the `unipi` alias (loads all unipi extensions including utility/diff wrapper)
2. Create a session that uses `write` or `edit` tools
3. Start a new session (or restart pi) and resume the previous session
4. TUI crashes trying to render the historical write/edit tool results

## Environment

- Pi with `unipi` alias: `pi --no-extensions --no-skills -e packages/unipi/index.ts -e .../mimo-extension/extensions/index.ts`
- `@pi-unipi/utility` diff wrapper enabled (registers async renderResult for write/edit tools)
- Node.js 24.14.1
- pi-tui bundled at `/home/pi/.local/share/mise/installs/node/24.14.1/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-tui/dist/tui.js`

## Root Cause Analysis

### Failure Chain

1. **Session resume** → TUI renders historical tool call components
2. **ToolExecutionComponent.updateDisplay()** called for a `write` or `edit` tool with a stored result
3. **getResultRenderer()** returns the `renderResult` function from `utility/src/diff/wrapper.ts`
4. **resultRenderer(...)** called **without `await`** → returns `Promise<{render, ...}>` instead of a Component
5. **renderContainer.addChild(Promise)** — Promise object pushed to children array (no runtime validation in Container.addChild)
6. **Container.render()** iterates children: `child.render(width)` → Promise has no `.render()` method → **TypeError**

### Root Cause

**`ToolExecutionComponent.updateDisplay()` does not `await` async `renderCall`/`renderResult` functions.** The renderer contract (`ToolDefinition.renderResult`) returns `Component`, but async functions return `Promise<Component>`. Since there is no `await`, the Promise itself is passed as the component, and Promises don't have a `.render()` method.

Additionally, **`Container.addChild()` has no runtime type validation**, making it trivially easy for non-Component objects to be added as children.

### Evidence

- `tool-execution.js` lines ~190-210 (updateDisplay): `const component = resultRenderer(...)` — no `await`, no type guard
- `tui.js` line 46 (Container.addChild): `this.children.push(component)` — no validation
- `tui.js` line 64 (Container.render): `child.render(width)` — crashes on non-Component children
- `packages/utility/src/diff/wrapper.ts:157`: `async renderResult(result, _options, theme): Promise<any>` — for write tool
- `packages/utility/src/diff/wrapper.ts:265`: `async renderResult(result, _options, theme): Promise<any>` — for edit tool

## Affected Files

- **`pi-coding-agent/dist/modes/interactive/components/tool-execution.js`** — `updateDisplay()` calls async renderers without await
- **`pi-tui/dist/tui.js`** — `Container.render` crashes; `Container.addChild` has no validation
- **`packages/utility/src/diff/wrapper.ts`** — async `renderResult` in `registerEnhancedWriteTool` (line 157) and `registerEnhancedEditTool` (line 265)

## Suggested Fix

### Fix Strategy

**Option A — Fix the renderers (preferred, minimal scope):**

In `packages/utility/src/diff/wrapper.ts`, remove `async` from `renderResult` and make rendering synchronous. Return a proper `Text` component instead of a duck-typed object. The diff rendering functions (`renderSplit`, `renderUnified`) should be callable synchronously.

**Option B — Fix the consumer (pi-coding-agent):**

In `tool-execution.js` `updateDisplay()`, make the method `async` and `await` the renderer calls. Add a guard after:
```javascript
const component = await resultRenderer(...);
if (component && typeof component.render === 'function') {
    renderContainer.addChild(component);
}
```

**Option C — Defensive fix (pi-tui):**

In `Container.addChild()`, add runtime validation to reject non-Component values:
```javascript
addChild(component) {
    if (!component || typeof component.render !== 'function') {
        throw new Error(`addChild: component must have a render() method, got ${typeof component}`);
    }
    this.children.push(component);
}
```

### Recommended Approach

Apply **Option A + Option C**:
1. Fix the immediate cause by making `renderResult` synchronous in the diff wrapper
2. Add defensive validation in `Container.addChild` to prevent similar bugs from extensions in the future

### Risk Assessment

- **Option A**: Minimal risk — the diff renderer functions (`renderSplit`, `renderUnified`) appear to be synchronous already; the `await` was unnecessary
- **Option C**: Low risk — could break extensions that pass non-standard components, but those are already broken (causing crashes)

## Verification Plan

1. Apply the fix to `utility/src/diff/wrapper.ts`
2. Start pi with the `unipi` alias
3. Execute a `write` tool call
4. Restart pi and resume the session
5. Confirm the write tool result renders normally with diff output
6. Confirm no `child.render is not a function` error

## Related Issues

- Compactor `SessionDB` `this.stmts` undefined error (separate bug — see `2026-04-30-compactor-stmts-undefined-debug.md`)

## Notes

- The renderer also returns a duck-typed object `{setText, text, render}` instead of a proper TUI `Text` component. This works superficially but should be fixed to return `new Text(rendered, 0, 0)` for consistency.
- The `async` keyword on `renderResult` was unnecessary — `renderSplit` and `renderUnified` are synchronous functions. The `await` was likely a leftover from an earlier design.
- Only 2 tools are affected: `write` and `edit` from `utility/src/diff/wrapper.ts`. No other unipi package uses async renderCall/renderResult.
