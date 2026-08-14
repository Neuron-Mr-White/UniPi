# Research: Why our DeepSeek cache rate is 94.3% (not 99%+) and how to fix it

Context: OmniRoute dashboard shows for our pi runtime (unipi extension + process extension):
- 8,019 requests total, 7,560 cache hits → **94.3% request-level cache rate**
- Token-level cache rate **97.3%** (1,033,300,096 / 1,062,059,895 cached)
- Market average cache rate is 99%+; DeepSeek-Reasonix hits 99.82%

DeepSeek prefix cache is server-side; the CLIENT controls hit rate by keeping the prompt PREFIX byte-stable across requests. Any byte change in the prefix (system prompt, tool schemas, message history, ordering) invalidates the cache from that point onward.

## Goals (research only — DO NOT change any code)

1. [x] Research how https://github.com/esengine/deepseek-reasonix achieves 99.82% cache rate — document the concrete techniques.

2. [x] Diagnose WHY our pi runtime (unipi + process extensions) only gets 94.3% request-level / 97.3% token-level cache rate. Identify the specific things that mutate the prompt prefix between requests.

3. [x] Produce a concrete, point-by-point list of changes to implement (in pi core, unipi extension, process extension, and/or config) to raise cache rate toward 99%+.

## Constraints
- Research only. Read files, run diagnostics, do NOT edit/modify anything.
- Final output = a written research report with (a) reasonix techniques, (b) root causes of our misses, (c) ordered improvement recommendations.

## Deliverable

Full report written to `docs/deepseek-cache-rate-research.md`.

### Summary of findings
- **Signature:** 459 misses × ~62.7K uncached tokens/miss = ~28.7M wasted input tokens → full-prefix invalidation (not normal tail growth).
- **Mechanism:** pi rebuilds the system prompt every turn; unipi `before_agent_start` hooks append *changing* content to it.
- **Top root causes (bundled.js):** (A) Ralph loop hook ~7746 injects `Iteration N/M` into systemPrompt every turn; (B) milestone hook ~26304 re-reads MILESTONES.md every turn; (C) workflow sandbox ~7140 mutates active tools; (D) memory recall ~8923 re-injects after compact; (E) auto-compaction cache reset; (F) cold starts; (G) huge `<available_skills>` block in prefix; (H) per-turn prompt rebuild.
- **Top fixes:** (1) move Ralph iteration to user turn; (2) cache-stable milestones; (3) don't setActiveTools mid-session; (4) append-only memory; (5) 85% single-reset compaction; (6) build system prompt once per session.
