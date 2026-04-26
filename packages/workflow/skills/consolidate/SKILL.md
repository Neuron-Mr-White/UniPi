---
name: consolidate
description: "Consolidate — save learnings to memory, craft skills if reusable. Use at end of work session or to summarize current state."
---

# Consolidating Learnings

Capture what was learned, update memory, and craft skills when patterns emerge.

## Boundaries

**This skill MAY:** read/write `.unipi/memory/`, read session context, read plans/specs, write skill files if user approves.
**This skill MAY NOT:** edit production code, run tests, deploy.

## Command Format

```
/unipi:consolidate <string(greedy)>(optional)
```

- `string(greedy)` — optional focus (e.g., "focus on auth patterns" or "summarize what we learned about testing")
- Two modes: **end-of-work** (memory + registry hooks) or **start/middle** (read context, consolidate ideas)

---

## Mode 1: End of Work Session

Triggered when run after `/unipi:review-work` marks work as done.

### Phase 1: Gather Learnings

1. Read session context — what was discussed, decided, built
2. Read the plan and spec — what was the goal, what was achieved
3. Identify key learnings:
   - Patterns discovered
   - Decisions made and why
   - Problems encountered and solutions
   - Things that would be done differently
   - Reusable approaches

**Exit:** Learnings identified.

### Phase 2: Update Memory

1. Check if `@unipi/memory` extension is installed
2. If not installed → skip memory, note to user
3. If installed:
   - Read existing `.unipi/memory/` files
   - Find relevant memory files (by topic, date, or tag)
   - **Update in place** — don't always create new files
   - Merge new learnings with existing knowledge
   - Prevent stale data by updating, not appending

**Memory file format:**
```markdown
---
topic: {topic}
updated: YYYY-MM-DD
tags: [tag1, tag2]
---

# {Topic}

## Key Learnings
- {Learning 1}
- {Learning 2}

## Patterns
- {Pattern description}

## Decisions
- {Decision} — {Rationale}
```

**Exit:** Memory updated.

### Phase 3: Skill Crafting

1. Check if `@unipi/registry` extension is installed
2. If not installed → skip, note to user
3. If installed, assess if learnings are reusable:

**Auto-create skill if:**
- Pattern will definitely be used in future runs
- Solution applies to recurring problem
- Workflow could be standardized

**Ask user if uncertain:**
> "I discovered a pattern that might be worth capturing as a skill: {description}. Should I create a skill for this?"

**Skip if:**
- One-off solution, unlikely to recur
- Too specific to current context
- User declines

**Exit:** Skill created or skipped.

### Phase 4: Summary

Report to user:
- What was saved to memory
- What skills were created (if any)
- Suggest next steps if any work remains

---

## Mode 2: Start / Middle of Session

Triggered when run without prior work session context.

### Phase 1: Read Context

1. Read session conversation so far
2. OR read latest brainstorm/spec/plan
3. Understand current state — what's been discussed, what's decided

### Phase 2: Consolidate Ideas

1. Summarize key points from context
2. Identify open questions
3. Identify decisions made
4. Identify next steps

### Phase 3: Write Summary

Write consolidation to `.unipi/memory/` — same format as Mode 1.

### Phase 4: Present

Present summary to user. Ask:
1. **Continue to brainstorm** — if ideas need formalizing
2. **Continue to plan** — if decisions are clear
3. **Done** — summary captured, return later

---

## Notes

- Memory files are living documents — update, don't always create new
- Skill creation is opportunistic — only when pattern is clearly reusable
- Both modes write to `.unipi/memory/` — consistent location
- Respects extension availability — graceful degradation if extensions not installed
