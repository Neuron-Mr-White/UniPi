# pi-subagents Parity (full)

Repo: /home/oi/Projects/Personal/archived/unipi
Task file: .unipi/ralph/pi-subagents-parity.md (read it first; it contains locked decisions + phase checklist)
Reference: /tmp/pi-subagents (re-clone from https://github.com/nicobailon/pi-subagents if missing)

## Non-negotiables
- Conventions follow OURS: spawn_helper/get_helper_result tool names, ~/.unipi config paths, .unipi/config/agents dirs, explore/work builtins stay, AgentWidget + ConversationViewer preserved.
- Foreground = in-process; async/fork/resume/worktree = child pi processes (hybrid, per user decision).
- **NEW conflicts → ASK USER, do not auto-decide.** If a conflict is purely mechanical (no design collision), resolve following our conventions and note it in the task file.
- Their tests are the spec: port/adapt tests per phase.
- After each batch: `npx tsc --noEmit --skipLibCheck` must pass. After each phase: root `npm test` + subagents package tests. Commit per phase.

## This iteration
Work the next ~4 checklist items from the current phase in .unipi/ralph/pi-subagents-parity.md, checking them off as you go.