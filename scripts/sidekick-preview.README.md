# UNI-2 design mockup — sidekick cyan-rail preview

`sidekick-preview.ts` is a standalone, deterministic gallery of the UNI-2 rail
design for fusion sidekick steps: every panel line (blank rows included) sits
on ONE outer dark-cyan fill `#12363b` behind a bright cyan `▏` rail `#22d3ee`,
instead of today's nested per-card backgrounds (the purple strips + unpainted
gaps from the screenshot).

**This is a DESIGN MOCKUP, not the current live renderer.** No pi session, no
LLM, no commands executed, no settings writes. Frozen fixtures are rendered
through the production functions (`styledToolCallLines`, `styledTextLines`,
`nativeToolComponent` for regular-style raw-args fidelity), nested background
SGR is stripped, then the single outer fill is applied via `paintLine`.

## Run

```sh
scripts/uni-2-preview.sh                    # static print, all styles × states (default)
scripts/uni-2-preview.sh --interactive      # TUI browser
scripts/uni-2-preview.sh --plain            # no ANSI, for files/diffs
scripts/uni-2-preview.sh --style simple --state background --width 80
scripts/uni-2-mixed-preview.sh              # UNI-47 mixed scenario (lead + delegated sidekick)
npx tsx --test scripts/sidekick-preview.test.ts   # focused tests
```

On coffee: `~/uni-2-preview.sh` and `~/uni-2-mixed-preview.sh` (same flags;
set `UNIPI_REPO` if the repo lives elsewhere). The mixed launcher defaults to
`--interactive --scenario mixed --style simple` with no flags.

## Mixed scenario (UNI-47/48 — delegated steps now stream live)

`--scenario mixed` is the fixture gallery of the approved layout: user prompt →
**LEAD** (demo thinking, own read/bash, prose, `run_subagent` delegation row) →
a continuous cyan **SUBAGENT** panel (demo thinking, read/bash, demo result) →
lead `npm test` → lead summary. Since UNI-48 this layout is no longer just a
proposal: completed steps of the fusion sidekick and of generic subagents
stream into the transcript as these delegated panels (`sidekick-step` /
`subagent-step` entries through `renderDelegatedStep`), while invocation
cards, the dock and completion notices stay as they were.

Use `--production` for host-level evidence: it renders the same frozen
fixtures through the REAL renderer path — `renderDelegatedStep`, pi's actual
`CustomEntryComponent` and the production spacing patch — static print only.
Scope of that evidence: the delegated renderer, custom-entry wrappers and
spacing grouping; the LEAD rows are synthetic stand-ins, not pi's live
lead-card path, and all “thinking” text is invented demo placeholder, never
recorded reasoning. `--expand` shows the collapsed/expanded thinking and
output states. Interactive keys: `m` toggles sidekick/mixed, `t` toggles demo
thinking, `e` expands output.

## What it shows

- **Styles** — `regular` (pi's native tool cards, raw args; steps without raw
  args fall back to `◆` lines), `advanced` (◆ + `│` gutter), `simple` (mcode
  rows with `├/└` tree across consecutive tools).
- **States** — `attached` (lead waiting, no wake widget), `background`
  (detached: same recorded transcript + the one-line wake widget; a fixture,
  not live streaming), `completed`, `legacy` (resumed without raw args →
  regular fallback), `failed`. Per fusion's onStep, steps render in both
  attach modes — only the chrome differs.
- **Fixtures** — bash `pwd && ls` (15 lines · 140ms), `git log -3 --oneline`
  (3 · 12ms), `git status --short --branch` (1 · 13ms), read `package.json`
  (22 · 13ms), prose, a failing `npm run build`, and a long/CJK grep to
  exercise width truncation. Identical across every style/state.

Keys in `--interactive`: `1/2/3` style · `b`/`←→` state · `e` expand ·
`↑↓`/`pgup/pgdn` scroll · `q`/`esc` quit. The native collapsed cards' empty
key hint is reworded for the mockup to `(N earlier lines; press e to expand in
the browser, or --expand)` — the native renderer itself is untouched.
