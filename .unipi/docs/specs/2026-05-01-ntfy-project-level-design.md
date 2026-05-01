---
title: "ntfy Project-Level Config"
type: brainstorm
date: 2026-05-01
---

# ntfy Project-Level Config

## Problem Statement

ntfy configuration is currently global-only (`~/.unipi/config/notify/config.json`). Users working on multiple projects cannot subscribe to different ntfy topics per project. Since ntfy is channel-based (topic subscriptions), it's naturally suited for per-project configuration — different projects should be able to alert on different topics with different priorities.

## Context

- ntfy config lives inside `config.json` alongside gotify, telegram, and native settings
- The `subagents` and `mcp` packages already implement a global→project config hierarchy (`~/.unipi/config/` vs `<project>/.unipi/config/`)
- ntfy is simple: serverUrl, topic, token, priority — making it a good candidate for dedicated config files
- Current ntfy setup wizard (`/unipi:notify-set-ntfy`) has no scope selection

## Chosen Approach

**Dedicated `ntfy.json` at both levels** — separate ntfy config files for global and project scope, with full override semantics.

```
~/.unipi/config/notify/ntfy.json          ← Global ntfy config (fallback)
<project>/.unipi/config/notify/ntfy.json  ← Project ntfy config (override)
```

## Why This Approach

- **Clean separation:** ntfy config is independent from other platforms, no reason to bundle in config.json
- **Full override:** project ntfy.json replaces global entirely — simple mental model
- **Backward compatible:** migration from config.json ntfy section is automatic and one-way
- **Follows codebase patterns:** mirrors the global→project hierarchy in subagents and mcp

**Alternatives rejected:**
- Full config.json at both levels: project config would carry structure for irrelevant platforms
- Ntfy-only override file: asymmetric naming, split source of truth

## Design

### Config Resolution

Resolution order at dispatch time:
1. Project `<cwd>/.unipi/config/notify/ntfy.json` exists → use it (full override)
2. No project config → use global `~/.unipi/config/notify/ntfy.json`
3. Neither exists → ntfy is effectively disabled

### Ntfy JSON Shape

```json
{
  "enabled": true,
  "serverUrl": "https://ntfy.sh",
  "topic": "my-project-alerts",
  "token": null,
  "priority": 3
}
```

### New Module: `ntfy-config.ts`

Location: `packages/notify/ntfy-config.ts`

**Exports:**
- `loadNtfyConfig(cwd: string): NtfyConfig` — resolve ntfy config with project→global priority
- `saveNtfyConfig(scope: "project" | "global", cwd: string, config: NtfyConfig): void` — save to chosen scope
- `getNtfyConfigScope(cwd: string): "project" | "global" | "none"` — detect which level is active
- `migrateFromLegacyConfig(): void` — one-time migration from config.json ntfy section

**Key behaviors:**
- `loadNtfyConfig(cwd)` checks project first, then global, returns defaults if neither exists
- Migration runs once on first call: if global ntfy.json doesn't exist but config.json has ntfy settings, copy them to ntfy.json
- After migration, config.json ntfy section is no longer read
- Invalid JSON in ntfy.json → log warning, fall back to next level

### TUI Wizard Changes (`ntfy-setup.ts`)

**New step: scope selection — inserted after instructions, before server-url**

```
┌──────────────────────────────────────┐
│ 📢 ntfy Setup                        │
├──────────────────────────────────────┤
│ Configure ntfy push notifications:   │
│                                      │
│ Where should this config be saved?   │
│                                      │
│ ▸ Global (all projects)              │
│   Project (this project only)        │
│                                      │
├──────────────────────────────────────┤
│ ↑↓ select · Enter confirm · Esc cancel│
└──────────────────────────────────────┘
```

- Default selection: "Global" (preserves current behavior)
- If "Project" selected, ensure `.unipi/config/notify/` dir exists in cwd
- All subsequent steps save to the chosen scope
- Re-running wizard pre-selects current scope and pre-fills existing config

**Wizard flow:**
1. Instructions (existing)
2. **Scope selection** (new)
3. Server URL (existing, pre-filled from chosen scope)
4. Topic (existing)
5. Token (existing, optional)
6. Priority (existing)
7. Test connection (existing)
8. Success (existing)

### Settings Overlay Changes (`settings-overlay.ts`)

**Enhanced ntfy detail line in Platforms tab:**

```
● ntfy  Topic: my-project-alerts · P3 · [project]
```
or
```
● ntfy  Topic: my-pi-notifications · P3 · [global]
```
or (when not configured):
```
○ ntfy  Not configured
```

- Calls `getNtfyConfigScope(cwd)` on init
- Displays topic, priority, and scope in the detail line
- No toggle or switch — scope is managed by re-running the wizard

### Dispatch Changes (`events.ts`)

`dispatchNotification` receives `cwd` parameter for ntfy resolution:

```typescript
// Signature change
dispatchNotification(pi, title, message, platforms, eventType, config, cwd)
```

ntfy platform case in `sendToPlatform`:
```typescript
case "ntfy":
  const ntfyConfig = loadNtfyConfig(cwd);
  if (!ntfyConfig.enabled) return;
  await sendNtfyNotification(ntfyConfig.serverUrl, ntfyConfig.topic, ...);
```

- gotify, telegram, native continue using `config.json` as before
- `cwd` captured from `process.cwd()` at session start, passed through closures

### Migration Strategy

One-time migration from `config.json` ntfy section to `ntfy.json`:

**Trigger conditions:**
- Global `~/.unipi/config/notify/ntfy.json` does NOT exist
- `config.json` has non-default ntfy section (enabled or has topic/serverUrl set)

**Steps:**
1. Read ntfy settings from config.json
2. Write to `~/.unipi/config/notify/ntfy.json`
3. Leave config.json ntfy section as-is (don't modify existing config)
4. Future reads use ntfy.json exclusively

**No migration for project level** — always explicit via wizard.

**Edge cases:**
- Old code running after migration: still reads config.json, works fine
- Both config.json ntfy and ntfy.json exist: ntfy.json wins
- Downgrade scenario: old code reads config.json (still has ntfy settings), no breakage

## Implementation Checklist

- [x] Create `ntfy-config.ts` module with loadNtfyConfig, saveNtfyConfig, getNtfyConfigScope, migrateFromLegacyConfig — Task 1
- [x] Add scope selection step to `ntfy-setup.ts` wizard — Task 3
- [x] Update wizard to save to chosen scope (project or global) — Task 3
- [x] Update wizard to pre-fill from chosen scope on re-run — Task 3
- [x] Update `settings-overlay.ts` to show topic, priority, and scope for ntfy — Task 4
- [x] Update `events.ts` dispatchNotification to accept cwd and resolve ntfy config — Task 2
- [x] Update `sendToPlatform` ntfy case to use loadNtfyConfig — Task 2
- [x] Wire cwd through registerEventListeners closures — Task 2
- [x] Add validation for ntfy.json (invalid JSON fallback, missing fields) — Task 1
- [x] Update configure-notify skill documentation — Task 5
- [ ] Test: loadNtfyConfig with project, global, both, neither
- [ ] Test: migration from config.json to ntfy.json
- [ ] Test: wizard saves to correct scope
- [ ] Test: settings overlay displays correct scope

## Open Questions

- Should `unipi:notify-test` respect project-level config when testing ntfy?

## Out of Scope

- Project-level config for gotify, telegram, or native platforms
- Scope toggle in settings overlay (managed via wizard re-run only)
- Per-event ntfy topic routing (events share the project/global ntfy config)
