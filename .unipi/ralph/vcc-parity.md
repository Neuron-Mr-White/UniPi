# VCC Parity Alignment — compactor ↔ pi-vcc

Repo: /home/oi/Projects/Personal/archived/unipi
Reference: /tmp/pi-vcc (clone of https://github.com/sting8k/pi-vcc @ master)

Goal: Bring packages/compactor to feature parity with pi-vcc, following pi-vcc's
implementation as closely as possible while PRESERVING our own interfaces where
changing them is not necessary.

## Interface preservation rules (do NOT break)
- Command names stay: `unipi:compact`, `unipi:lossless-compact`, `unipi:session-recall`, `unipi:compact-recall`, etc.
- Tool names stay: `session_recall` (canonical), `vcc_recall` (alias), `compact`, `context_budget`, etc.
- Config file location/manager stays (packages/compactor/src/config/*). New keys are ADDITIVE with safe defaults.
- Existing section format ([Session Goal] ... --- brief) stays — it already matches pi-vcc.
- Keep our [tool_error] brief sections (pi-vcc omits tool results entirely; ours is a strict superset — keep it).

## Reference map (pi-vcc → ours)
- src/hooks/before-compact.ts → packages/compactor/src/compaction/hooks.ts + src/compaction/cut.ts
- src/core/summarize.ts → packages/compactor/src/compaction/summarize.ts + merge.ts
- src/core/brief.ts → packages/compactor/src/compaction/brief.ts
- src/core/rank.ts → (missing — port)
- src/core/token-estimate.ts → packages/compactor/src/compaction/token-estimate.ts (done)
- src/tools/recall.ts + core/{search-entries,drill-down,recall-scope,format-recall}.ts → packages/compactor/src/tools/vcc-recall.ts + src/compaction/search-entries.ts
- src/core/settings.ts → packages/compactor/src/config/*

## Rules
- After EACH batch: `npx tsc --noEmit --skipLibCheck` must pass.
- After each phase: run compactor tests (`cd packages/compactor && npx bun test tests`).
- Commit after each successful phase: `feat(compactor): <what> (vcc-parity)`.
- Port logic from /tmp/pi-vcc source; adapt imports to our module layout (`.js` suffixes, @pi-unipi/core).
- Do not regress prefix-cache safety: compaction remains a cache boundary; the
  invisible-continue message must be filtered from the LLM payload by customType.

## Phase 1 — Cut & keep parity (core behavior) ✅ COMMITTED
- [x] Port token-estimate.ts (calibrateCharsPerToken from preparation.tokensBefore vs actual chars; heuristic 4 chars/token fallback)
- [x] Extend buildOwnCut with keepUserTurns param (default 1): cut at Nth-from-last user turn; keep > available user turns → compactAll with keepFallbackToCompactAll=true; firstKeptEntryId "" sentinel (already matches ours)
- [x] Parse keep:N + follow-up prompt from customInstructions (port compact-args.ts; keep COMPACTOR_INSTRUCTION as our marker constant)
- [x] Port findBudgetCutIndex + applyTailBudget (no_anchor / oversized_tail rescue, OVERSIZED_TAIL_FACTOR 2.5, snap off toolResult boundaries)
- [x] Port resolveSmartKeepUserTurns (MIN 5k / MAX 25k tokens; explicit keep:N always respected) + config key `smartKeepTail` (default true)
- [x] Stats parity: keptUserTurns/totalUserTurns/requestedKeepUserTurns/smartKeepAdjusted/budgetCut/keptTokensEst; toast format parity (formatCompactionStats)

## Phase 2 — Brief quality parity ✅ COMMITTED
- [x] brief.ts: head/tail assistant truncation via truncateTokensHeadTail (80/120 words; segment-closing assistant 120/120) — port significantWordSpans
- [x] brief.ts: heredoc body compression (HEREDOC_OPEN_RE, heredocCloseIndex, FILEWRITER_HEREDOC_RE, BODY_NOISE_RE, HEREDOC_BODY_CAP 80) + trivial-line filter (TRIVIAL_LINE_RE) + BASH_CAP 120→240
- [x] Port rank.ts (selectRankedBriefBlocks): size-relative token budget 1100 floor / 2000 ceiling / 15 tokens-per-block, calibrated charsPerToken
- [x] summarize.ts: compileRanked path (capFreshBrief=false, preserveFreshBriefOnMerge=true) + mergeBriefTranscriptWithFreshBudget (fresh gets budget, prev fills remainder)
- [x] Wire compileRanked into hooks.ts with fileOps from preparation

## Phase 3 — Recall parity
- [ ] scope:"all" | "lineage" (default lineage) — port recall-scope.ts; lineage = entries after last compaction's firstKeptEntryId (with orphan recovery)
- [ ] Pagination (page param, 5 results/page) + regex mode with keyword fallback
- [ ] mode:"touched" (files worked on + entry indices) + #N:path drill-down (expandEntryFile, anchored parse) — port drill-down.ts
- [ ] expand param: expand entry indices to full untruncated content
- [ ] Update tool descriptions to match pi-vcc's wording (adapted to session_recall/vcc_recall names)
- [ ] unipi:compact-recall: results as collapsible message + auto-fed to agent as context (port /pi-vcc-recall behavior)

## Phase 4 — Auto-continue & polish
- [ ] Invisible auto-continue: AUTO_CONTINUE customType message (content:[], display:false, triggerTurn:true, deliverAs:"followUp") after threshold/overflow compaction; config key `continueAfterThresholdCompact` (default true)
- [ ] context hook filter: remove auto-continue customType messages from LLM payload (match by customType ONLY)
- [ ] before_agent_start clears pending auto-continue timer
- [ ] debug output: config key `debug` → /tmp/compactor-debug.json (message counts, cut boundary, token calibration, summary preview) — done in hooks.ts; verify + wire remaining dbg sites
- [ ] Settings overlay: add smartKeepTail / continueAfterThresholdCompact / debug toggles
- [ ] Full test pass + typecheck + final commit

## Completion marker
Emit "VCC parity alignment complete." when all phases done.
