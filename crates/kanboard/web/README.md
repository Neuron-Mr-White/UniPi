# kanboard web UI — DEPRECATED

The daemon now serves the **UniPi app's web build** (`unipi-app/apps/mobile`, `npm run build:web`) at `/`: one frontend for the phone app, the desktop app and the browser (UNI-117). See `../README.md` ("Where the web UI comes from") and `unipi-app/docs/m7/KANBOARD-MIGRATION.md` for the parity table.

This Solid UI is kept only as the last fallback of `../scripts/build-ui.mjs` (used when no unipi-app checkout or pinned published build is available) and for `../tests/ui.mjs`. Do not add features here. It will be deleted once the user confirms the migration.
