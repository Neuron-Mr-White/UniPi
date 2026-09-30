# UNI-11 — jev vs a normal model as skill judge (coffee, 2026-09-30)

Harness: `.unipi/skill-eval/run.ts` · raw: `results.json` · ground truth: `cases.json` (authored, untouched).

## Setup

- **Catalog**: 59 skills copied into `coffee:~/skill-eval-mock/.agents/skills/` (mock project with `package.json` + `src/*.ts`), deduped by name first-wins over the four sources: the npm unipi suite's bundled skills (39), `~/.agents/skills` (4), `~/.pi/agent/skills` (0), and the rsync'd repo `.agents/skills` (16). The brief estimated ~75; the four fixed sources yield 59.
- **jev judge**: the repo's real code — `judgeRequest()` (`packages/skill-registry/src/judge.ts`) + `askJev` (`@pi-unipi/core`) — with coffee's judge settings (`openrouter`, `typesafe/jev-1.13`, `OPENROUTER_API_KEY`). One full-catalog call per case (59 `noul` questions); every score recorded in `results.json`.
- **Model judge**: coffee's omniroute default model **`omniroute/dva/deepseek-v4-flash-low`** (from `~/.pi/agent/settings.json` `defaultProvider`/`defaultModel`), temperature 0, same info jev gets (prompt + `[project: skill-eval-mock]` + name/description ≤300 chars), verbatim system text from the brief. JSON parsed; retry once on parse failure. **0 parse failures, 0 jev fail-opens.**
- **Revealed sets** per case: `pins` = `pinnedSkills(catalog, prompt)`; `jev0.6`/`jev0.8` = pins ∪ {score ≥ thr}, capped at 5 by score, pins first (the current later-prompt reveal rule); `nopins*` = same without pins.

## Totals

| variant | precision | recall | TP | FP | FN | clean empties |
|---------|-----------|--------|----|----|----|---------------|
| jev0.6 (current rule) | 0.214 | 0.643 | 9 | 33 | 5 | 0/3 |
| jev0.8 | 0.429 | 0.643 | 9 | 12 | 5 | 1/3 |
| nopins0.6 | 0.237 | 0.643 | 9 | 29 | 5 | 0/3 |
| nopins0.8 | 0.529 | 0.643 | 9 | 8 | 5 | 2/3 |
| model | **0.667** | 0.429 | 6 | 3 | 8 | 2/3 |

Latency per call: jev mean 350 ms (269–750); model mean 4.0 s (3.2–6.4).

## Per case

| case | expected | jev0.6 | jev0.8 | model | pins |
|------|----------|--------|--------|-------|------|
| uni11-real | — | image, plan, brainstorm, work, compactor-stats | image | — | image |
| logo | image | coffee-sandbox, image, quick-work | coffee-sandbox, image | image | coffee-sandbox |
| debug-null | debug | debug, fix, research, gather-context, scan-issues | debug, fix, research, gather-context | debug | — |
| scrape | agent-browser | web, work, quick-work, plan | — | web | — |
| mise | mise | mise, work, quick-work, plan | mise, work | declarative-repo-setup | — |
| board | kanboard | memory, quick-work | — | — | — |
| graphql | brainstorm, plan | plan, gather-context, work, research, brainstorm | plan, gather-context, work, research, brainstorm | brainstorm, plan, work, api-contract | — |
| rename | — | quick-work, work | quick-work | quick-fix | — |
| overeng | ponytail-audit | wait-what, ponytail-review, ponytail-audit, gather-context, research | wait-what, ponytail-review, ponytail-audit, gather-context | ponytail-review | wait-what |
| telegram | notify | configure-notify, notify | configure-notify, notify | configure-notify | — |
| readme | document | document, quick-work | document | document | — |
| android | android-device-automation | quick-work | quick-work | — | — |
| recall | mempalace-recall | wait-what, memory, compactor, gather-context, research | wait-what, memory | memory | wait-what |
| worktree | worktree-create | worktree-create, work, quick-work | worktree-create, work | worktree-create | — |
| docs | find-docs | research, web, quick-work, gather-context | research, web | web | — |
| css | — | fix, quick-fix, quick-work, work, debug | fix, quick-fix, quick-work, work | — | fix |

## Reading

- **Every jev miss is a catalog hole, not a judging miss.** All 5 of jev0.6/0.8's FNs are expected skills absent from the 59-skill catalog (`agent-browser`, `kanboard`, `android-device-automation`, `mempalace-recall`, `find-docs` — they live in packages/locations outside the four fixed copy sources). Against the skills that exist, jev recalled 9/9 at both thresholds.
- **The 0.6 threshold is the FP driver, pins are a minor one.** At 0.6 the score tail contributes 29 FPs (quick-work/work/gather-context/research ride along on almost everything); at 0.8 that collapses to 8. Pin-caused FPs are 4 and identical at both thresholds (pins bypass scoring): `image` pinned on uni11-real by the literal text "[Image #1]", `coffee-sandbox` on logo by "coffee shop", `wait-what` on overeng/recall by the word "what", and `fix` on css would be a 5th but also scores ≥0.6. The model is much more precise (3 FPs) and its misses are mostly "picked an acceptable neighbour" (`configure-notify` for notify, `ponytail-review` for ponytail-audit) — only `mise` is a true miss (it picked `declarative-repo-setup`).
- **Clean empties**: uni11-real/rename/css — jev0.6 dirties all three, jev0.8 two, the model two (`rename`→quick-fix).

## Live confirmation

Real pi session on coffee in `~/skill-eval-mock` (script: `live.sh`, suite from the rsync'd repo with the Job 1 changes). Two headless turns of one session (`pi --approve --no-extensions -e …/packages/unipi/index.ts`, **no** `--no-skills`, **with** `--approve`):

- `--no-skills` (the `unipi` alias's default) empties pi's catalog → nothing to judge, no freeze; the alias is unusable for this test as-is.
- The mock project is untrusted and `-p` mode can't show the trust prompt → without `--approve`, project `.agents/skills` are skipped (session only saw the npm-suite + user skills, 43).
- With both fixed: the warm-up froze a **60-skill** catalog (kept 7: compactor, document, gather-context, quick-work, research, utility, wait-what; hidden 53). One more than the harness's 59 — pi loads one skill `listVaultSkills` skips (frontmatter without a description).
- Turn 2 (uni11-real) appended `unipi:skills-revealed` with **`["image", "brainstorm", "compactor-stats", "debug", "plan"]`** (cap 5) and displayed the reveal message.

**vs harness jev0.6 for uni11-real** — `["image", "plan", "brainstorm", "work", "compactor-stats"]`: **4/5 identical**. The pin path matched exactly (`image` pinned by the literal "[Image #1]" text in both — and it revealed from the *hidden* pool, confirming the pin-then-score cap order). The 5th slot differs (`debug` live vs `work` harness): the live turn judges only the hidden candidates with a fresh jev call, so scores near the cap boundary shuffle. Same rule, same shape — a re-run variance, not a rule mismatch.

Odd but irrelevant to the judging: both turns' *replies* were "unable to inspect src" — the answering model (`dva/deepseek-v4-flash-low`) didn't use its read tools in `-p` mode. The judged/reveal pipeline is prompt-driven and worked correctly.

Session file: `coffee:~/.pi/agent/sessions/--home-coffee-skill-eval-mock--/2026-09-29T06-51-11-787Z_5e1a1e11-1111-4a11-b111-uni11eval03.jsonl`.
