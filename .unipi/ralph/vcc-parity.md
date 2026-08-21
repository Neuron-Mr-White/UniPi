# VCC Parity Alignment — compactor ↔ pi-vcc

Task file: `.unipi/ralph/vcc-parity.md` (read it first for full phase details and rules).

Repo: /home/oi/Projects/Personal/archived/unipi
Reference source: /tmp/pi-vcc (clone of https://github.com/sting8k/pi-vcc)

Goal: Bring packages/compactor to parity with pi-vcc's compaction behavior —
token-calibrated cuts, keep:N, smart keep, budget cuts, ranked brief, recall
scope/pagination/drill-down, invisible auto-continue — while preserving our own
interfaces (command names, tool names, config manager, section format, [tool_error] briefs).

Process per iteration:
1. Pick the next ~3-4 unchecked items from the phase checklist in `.unipi/ralph/vcc-parity.md`
2. Port logic from /tmp/pi-vcc/src (adapt imports: `.js` suffixes, our config manager)
3. `npx tsc --noEmit --skipLibCheck` must pass
4. Run compactor tests if touched area has them
5. Commit: `feat(compactor): <what> (vcc-parity)`
6. Check off items in the task file
7. Call ralph_done — or emit "VCC parity alignment complete." when ALL phases done

Do NOT break: command names (unipi:compact, unipi:session-recall...), tool names
(session_recall canonical, vcc_recall alias), config file location, section format,
prefix-cache safety (auto-continue message filtered from LLM payload by customType).
