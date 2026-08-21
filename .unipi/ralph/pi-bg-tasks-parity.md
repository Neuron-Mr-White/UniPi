# pi-background-tasks Adoption (full)

Repo: /home/oi/Projects/Personal/archived/unipi
Task file: .unipi/ralph/pi-background-tasks-parity.md (read it first; it contains locked decisions + phase checklist)
Reference: /tmp/pi-background-tasks (re-clone from https://github.com/ismailsaleekh/pi-background-tasks if missing)

## Locked decisions (user)
- Merge the WHOLE repo — shell tasks, delegate, fusion, attested runs, anthropic attribution, infra.
- In OUR style: ~/.unipi paths, <ws>/.unipi/config dirs, /unipi:* command namespace, our panel/slot system, our settings-overlay patterns.
- Master feature toggle: one config key (`enabled`, default true) that completely disables the module — no tools, no commands, no hooks, no UI when off.
- All commands AND settings mounted in our panel style.
- New conflicts → ASK USER. Purely mechanical → follow our conventions and note in the task file.

## Non-negotiables
- Storage: ~/.unipi/background-tasks/ for durable state; runtime artifacts under os.tmpdir()/unipi-bg-tasks-<scope>/. NEVER .pi/tasks/.
- Config: ~/.unipi/config/background-tasks.json + <root>/.unipi/config/background-tasks.json (workspace wins).
- Env prefix: UNIPI_BG_* (replaces PI_BG_*).
- Commands: /unipi:* namespace, registered in autocomplete constants.
- Tools keep reference names (bg_run, bg_delegate, fusion_reason, ...) — no collision with ours.
- UI on our widget/slot patterns (FleetView precedent). Skip their update-check.ts and docs-gate scripts.
- Tests are the spec: port/adapt per phase.
- After each batch: npx tsc --noEmit --skipLibCheck must pass. After each phase: root npm test + package tests. Commit per phase.

## This iteration
Work the next ~4 checklist items from the current phase in .unipi/ralph/pi-background-tasks-parity.md, checking them off as you go. Update the task file with progress (git add -f it when committing). When FULLY COMPLETE, respond with the completion marker from the task file.