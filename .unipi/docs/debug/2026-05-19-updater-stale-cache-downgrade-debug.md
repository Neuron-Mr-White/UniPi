---
title: "Updater stale cache downgrade prompt — Debug Report"
type: debug
date: 2026-05-19
severity: medium
status: root-caused
---

# Updater stale cache downgrade prompt — Debug Report

## Summary
After releasing `v2.0.5`, the updater prompted to update from `2.0.5` to older `2.0.4` because a stale updater cache entry was treated as an available update.

## Expected Behavior
The updater should only prompt when the npm/latest version is greater than the installed version. Older cached or registry versions must not be treated as updates.

## Actual Behavior
The updater considered any version mismatch an update, so cached `latestVersion: 2.0.4` with installed `2.0.5` displayed as `2.0.5 → 2.0.4`.

## Reproduction Steps
1. Install/run local `@pi-unipi/unipi@2.0.5`.
2. Keep updater cache at `~/.unipi/cache/updater/last-check.json` with `latestVersion: 2.0.4` inside the configured check interval.
3. Start Pi with updater enabled.
4. Updater shows a downgrade prompt.

## Environment
- Repo version: `2.0.5`
- Cached updater file observed: `/home/pi/.unipi/cache/updater/last-check.json`
- Cache contents before local correction: `latestVersion: 2.0.4`, `skippedVersion: 2.0.4`

## Root Cause Analysis

### Failure Chain
1. The full-release flow bumped local package versions to `2.0.5`.
2. The updater cache still contained `latestVersion: 2.0.4` from a previous npm check.
3. `packages/updater/src/checker.ts` skipped fetching because the check interval had not elapsed.
4. Cached result returned `updateAvailable: cache.latestVersion !== currentVersion`.
5. `2.0.4 !== 2.0.5` evaluated true, so the update overlay rendered a downgrade.

### Root Cause
The updater used string inequality instead of semver ordering for update detection. The release step did not explicitly clear/refresh `~/.unipi/cache/updater/last-check.json`, but the code should be robust to stale or older cache values.

### Evidence
- `packages/updater/src/checker.ts` used `latestVersion !== currentVersion` and `cache.latestVersion !== currentVersion`.
- `/home/pi/.unipi/cache/updater/last-check.json` contained `latestVersion: "2.0.4"` while local packages were `2.0.5`.

## Affected Files
- `packages/updater/src/checker.ts` — update detection and stale cache handling.
- `packages/updater/src/version.ts` — new version comparison helper.
- `packages/updater/tests/checker.test.ts` — regression coverage for no-downgrade comparisons.

## Suggested Fix
Compare versions by numeric semver ordering and ignore stale older cache entries when current installed version is newer.

### Fix Strategy
1. Add `compareVersions()` / `isNewerVersion()` helper.
2. Use it for cached and fetched update results.
3. If cached latest is older than current, bypass interval and fetch npm again.
4. On fetch errors, never mark an older cached version as update-available.
5. Refresh local cache to `2.0.5` so current sessions stop seeing the stale prompt.

## Verification Plan
1. Unit test: `isNewerVersion("2.0.4", "2.0.5") === false`.
2. Unit test: `isNewerVersion("2.0.6", "2.0.5") === true`.
3. Typecheck passes.
4. Confirm local updater cache no longer contains `2.0.4`.

## Notes
The missed release-process step was not publishing; npm had `2.0.5`. The immediate trigger was the local updater cache still saying `2.0.4`, plus checker logic treating any mismatch as an update.
