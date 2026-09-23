---
title: "Agent Settled Notify Support"
type: quick-work
date: 2026-07-22
---

# Agent Settled Notify Support

## Task
Add support for Pi's new `agent_settled` lifecycle event in `@pi-unipi/notify`, keeping it separately configurable from `agent_end` so users can route retry/end-of-run events and final settled completion to different channels.

## Changes
- `packages/notify/settings.ts`: added default `agent_settled` event config, disabled by default.
- `packages/notify/events.ts`: added `agent_settled` as a Pi lifecycle event, refactored shared agent notification handling for both `agent_end` and `agent_settled`, and kept recap support by falling back to the latest assistant session message when the settled payload has no messages.
- `packages/notify/src/__tests__/event-bus.test.ts`: updated lifecycle event expectations.
- `packages/notify/README.md` and `packages/notify/skills/configure-notify/SKILL.md`: documented `agent_settled` and clarified that `agent_end` can fire on retries.
- `CHANGELOG.md`: recorded the feature under Unreleased.

## Verification
- `npm run typecheck` passed.
- `npx tsx --test packages/notify/src/__tests__/*.test.ts` passed.
- `npm test --workspace @pi-unipi/notify` failed because this Node build lacks built-in TypeScript stripping support (`ERR_NO_TYPESCRIPT` from `node --experimental-strip-types`).
- Root `npm test` also failed on pre-existing harness issues: the same TypeScript loader problem for `tests/core-package-root.test.js`, plus `tests/package-manifest.test.js` still expects split packages to have no `pi.skills` even though `@pi-unipi/compactor` intentionally registers `./skills` as of #23.

## Notes
Pi 0.81.1 exposes `agent_settled` as a payload-less lifecycle event. The workspace dev dependency is still Pi 0.80.2, whose runtime accepts arbitrary `pi.on()` strings but type declarations do not include `agent_settled`, so notify continues using the existing `(pi as any).on(...)` lifecycle registration pattern.
