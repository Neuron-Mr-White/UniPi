---
title: "Compactor Pipeline Presets and README"
type: quick-work
date: 2026-05-18
---

# Compactor Pipeline Presets and README

## Task

Understand the issue report "whatever profile I choose, the settings are always off" from the `/unipi:compact-settings` Pipeline tab, fix the underlying preset behavior, and generate a more detailed compactor README covering commands, settings, agent tools/skills, benchmarks, and chronological Pi hook flow.

## Changes

- `packages/compactor/src/config/presets.ts`
  - Fixed preset pipeline application. Presets now set pipeline switches according to the original UX spec:
    - `precise`: `ttlCache` + `mmapPragma` on.
    - `balanced`: all six pipeline switches on.
    - `thorough`: all six pipeline switches on.
    - `lean`: all pipeline switches off.
  - Added safe pipeline merging so partial pipeline overrides do not drop `customNoisePatterns`.
  - Aligned legacy aliases (`opencode`, `verbose`, `minimal`) with their new preset equivalents.
  - Set `precise`/`opencode` sandbox mode to `safe-only`, matching the preset description.
- `packages/compactor/tests/config.test.ts`
  - Added regression coverage for preset pipeline values and legacy alias parity.
- `packages/compactor/README.md`
  - Expanded documentation for slash commands, settings tabs, presets, auto-compaction, pipeline switches, agent tools, skills, hook flow, zero-LLM pipeline stages, benchmarks, and troubleshooting.
  - Clarified that content/project indexing lives in `@pi-unipi/cocoindex`, not compactor.
  - Added a troubleshooting section for the Pipeline tab always showing `off`.
- `packages/compactor/skills/*.md`
  - Updated compactor skill docs to match the current tool surface and CocoIndex separation.

## Verification

- `npm run typecheck` — passed.
- `npm test --workspace @pi-unipi/compactor` — passed, 88 tests.
- `npm test` — passed across workspaces.
- `node --import tsx -e "import('./packages/compactor/src/index.ts').then(()=>console.log('compactor extension import ok'))"` — passed.
- `git diff --check` — passed.

## Notes

The issue report is valid: preset previews/docs claimed Pipeline values changed per profile, but `PRESET_CONFIGS` did not actually set `pipeline`, so every preset inherited the all-off defaults. The Pipeline tab therefore stayed off no matter which profile the user chose.
