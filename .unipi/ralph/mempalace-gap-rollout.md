# Fix MemPalace migration and complete rollout

## Goals
- Fix the UniPi umbrella-package MemPalace bridge path/package gap without disturbing unrelated dirty work.
- Ensure fresh and existing installed users automatically get a working MemPalace backend or a safe SQLite fallback.
- Ensure migrations are resumable/idempotent and do not mark completion when migration fails.
- Reconcile this PC's `~/.unipi/memory` into the canonical `~/.mempalace/palace` safely, preserving backups and verifying counts/content.
- Add regression tests for source installs, bundled umbrella installs, missing/corrupt backend, and migration behavior.
- Run the repository's full-release chore only after tests and migration verification pass.

## Checklist
- [x] Inspect existing migration design, package/build scripts, tests, and full-release chore.
- [x] Reproduce the installed umbrella bridge-resolution failure in a testable way.
- [x] Implement robust bridge discovery/packaging for standalone and umbrella installs.
- [x] Fix migration completion semantics and automatic catch-up for existing users.
- [x] Add/update tests and documentation.
- [x] Build/package test tarballs and verify bridge presence/runtime.
- [x] Back up this PC's memory stores.
- [x] Run safe local migration/catch-up and verify project/global counts and spot-check recent memories.
- [x] Run full test/build verification.
- [ ] Execute `.unipi/docs/chore/full-release.md` completely and verify rollout.
- [ ] Store final findings in memory.

## Safety constraints
- Do not modify or discard the existing unrelated dirty MCP/milestone changes.
- Do not delete either palace or legacy memory data.
- Back up before local migration.
- Treat migration as successful only with explicit bridge success and post-migration verification.

## Notes

Iteration 1: Root cause confirmed: bundled umbrella resolved a non-shipped bridge and silently fell back to SQLite. Added multi-layout bridge discovery, umbrella tarball inclusion, versioned source-fingerprint migration state, explicit migration verification/failure counts, unchanged-record skipping, regression tests, and docs. Targeted tests/typecheck/build pass. Backed up active palace to `/home/oi/.mempalace.backup.20260814182254` with matching SHA-256. Local catch-up result: 2,653 discovered, 391 imported/updated, 2,262 unchanged skipped, 0 failed, 2,653 verified. Palace now has 2,654 total drawers (2,653 UniPi identities plus one non-UniPi drawer); `unipi` wing has 85 and recent `release_v2_4_2_full_rollout_complete` plus this audit memory resolve with full content. Wrote verified v2 migration state with source fingerprint `c606b256...`. Reviewer caught two edge cases: markdown did not preserve authoritative IDs and migration verification was optimistic. Added `id` frontmatter with legacy fallback plus post-write exact-document reread verification. Final targeted tests (12), root typecheck, command-registry audit, bundle secret scan, tarball bridge runtime ping, and complete root/workspace tests all pass. A final migration pass was fully idempotent: 0 imported, 2,653 skipped, 0 failed, 2,653 verified.
