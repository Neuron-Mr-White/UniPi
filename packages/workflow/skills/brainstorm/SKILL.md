---
name: brainstorm
description: "Collaborative discovery — explore problem space, evaluate approaches, write design spec. Use before any creative work."
---

# Brainstorming Ideas Into Designs

Turn ideas into fully formed designs through collaborative dialogue.

## Boundaries

**This skill MAY:** research (read-only), discuss, ask questions, write the brainstorm document.
**This skill MAY NOT:** edit code, create files beyond the brainstorm document, run tests, deploy, implement anything.

**NEVER write code during this skill. This is a discussion, not implementation.**

## Command Format

```
/unipi:brainstorm <string(greedy)>
```

- `string(greedy)` — the topic or problem to brainstorm about
- No worktree args — brainstorm runs in current session on current branch
- No visual companion — text-only brainstorming

## Hard Gate

Do NOT write any code, scaffold any project, or take any implementation action until design is presented and user approved. This applies to EVERY project regardless of perceived simplicity.

## Anti-Pattern: "Too Simple For Design"

Every project goes through this process. A todo list, a utility, a config change — all of them. "Simple" projects are where unexamined assumptions cause wasted work. Design can be short, but MUST present and get approval.

## Output Path

```
.unipi/docs/specs/YYYY-MM-DD-<topic>-design.md
```

Committed to current branch. Accessible across worktrees via git.

---

## Phase 1: Explore Project Context

1. Check files, docs, recent commits to understand current state
2. Assess scope: if request describes multiple independent subsystems, flag immediately
3. If too large for single spec, help decompose into sub-projects

**Exit:** Context gathered. Ready to ask questions.

---

## Phase 2: Ask Clarifying Questions

Ask **one question at a time**. Don't dump a questionnaire.

Start with:
1. "What problem are we actually solving?" — strip assumptions, get root need
2. "Who has this problem and when?" — context changes solutions
3. "What does success look like?" — outcomes, not features

Prefer multiple choice when natural options exist. Validate assumptions explicitly.

**Exit:** Problem statement clear and reframed. Both agree on what solving.

---

## Phase 3: Propose Approaches

Propose 2-3 different approaches with trade-offs:
- What each optimizes for (speed, flexibility, simplicity)
- What each costs (complexity, maintenance, time, risk)
- Prior art in codebase or industry

Present conversationally with recommendation and reasoning.

**If open questions emerge:** MUST ask user about each one. Don't assume.

**Exit:** Approach chosen. User signals decision.

---

## Phase 4: Present Design

Once approach chosen, present design in sections:
- Scale each section to complexity (few sentences if straightforward, 200-300 words if nuanced)
- Ask after each section whether it looks right
- Cover: architecture, components, data flow, error handling, testing
- Be ready to go back and clarify

**Design for isolation and clarity:**
- Break into smaller units with one clear purpose
- Each unit communicates through well-defined interfaces
- Can someone understand unit without reading internals?

**Exit:** Design approved by user.

---

## Phase 5: Write Design Document

Write to `.unipi/docs/specs/YYYY-MM-DD-<topic>-design.md`:

```markdown
---
title: "{Topic}"
type: brainstorm
date: YYYY-MM-DD
---

# {Topic}

## Problem Statement
{The actual problem, reframed}

## Context
{Key findings — what exists, what's been tried}

## Chosen Approach
{High-level description}

## Why This Approach
{Decision rationale, alternatives rejected}

## Design
{Architecture, components, data flow}

## Implementation Checklist
- [ ] Task 1 — description
- [ ] Task 2 — description
- [ ] Task 3 — description

## Open Questions
{Questions for planning phase}

## Out of Scope
{Explicitly excluded}
```

### Checklist Items

The `## Implementation Checklist` section uses `- [ ]` markdown checkboxes. These are critical:

- **`[ ]` = unplanned** — not yet covered by a plan
- **`[x]` = planned** — marked when `/unipi:plan` covers this item
- Agent MUST fill in checklist items based on the design
- Each item should be a discrete, implementable task
- Items should be ordered by dependency (earlier items don't depend on later ones)

---

## Phase 6: Spec Self-Review

After writing, review with fresh eyes:

1. **Placeholder scan:** Any "TBD", "TODO", incomplete sections? Fix them.
2. **Internal consistency:** Do sections contradict each other?
3. **Scope check:** Focused enough for single implementation plan?
4. **Ambiguity check:** Could any requirement be interpreted two ways? Pick one.

Fix issues inline. No need to re-review — fix and move on.

---

## Phase 7: User Review Gate

After self-review passes:

> "Spec written and committed to `.unipi/docs/specs/YYYY-MM-DD-<topic>-design.md`. Please review and let me know if you want changes before we plan."

Wait for user response. If changes requested, make them and re-run self-review.

---

## Phase 8: Handoff

Ask user what to do next:

1. **Proceed to /unipi:plan** — Turn decisions into implementation plan
2. **Keep exploring** — More questions or refine decisions
3. **Done for now** — Return later

If user selects "Proceed to /unipi:plan", suggest:
```
/unipi:plan specs:YYYY-MM-DD-<topic>-design
```

---

## Validate

Before delivering, verify:

- [ ] Problem was reframed — not accepted at face value
- [ ] At least 2 approaches explored with tradeoffs
- [ ] Every decision has rationale and rejected alternatives documented
- [ ] Implementation checklist has concrete, discrete tasks with `[ ]` markers
- [ ] Open questions listed — nothing swept under rug
- [ ] No code was written — only brainstorm document created
- [ ] `/unipi:plan` can start from this document without asking "what did you decide about X?"
