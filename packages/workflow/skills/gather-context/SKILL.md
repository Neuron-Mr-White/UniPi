---
name: gather-context
description: "Research codebase — surface patterns, find prior art, prepare for brainstorm. Spawns subagents if available."
---

# Gathering Context

Research the codebase thoroughly to prepare for brainstorming. Find patterns, prior art, and relevant context.

## Boundaries

**This skill MAY:** read codebase, run read-only commands (find, grep, ls), spawn subagents, write findings.
**This skill MAY NOT:** edit code, implement features, run tests that modify state.

## Command Format

```
/unipi:gather-context <string(greedy)>
```

- `string(greedy)` — what to research (e.g., "authentication patterns", "how we handle errors", "database layer")
- Read-only sandbox
- Spawns subagents if `@unipi/subagents` extension is installed

---

## Process

### Phase 1: Parse Research Request

1. Read the research topic
2. Break into sub-topics if needed
3. Determine research strategy:
   - File search (find files related to topic)
   - Pattern search (grep for patterns, conventions)
   - Structure analysis (directory layout, module organization)
   - History analysis (git log for related changes)

**Exit:** Research plan ready.

### Phase 2: Gather Context

If subagents available:
1. Spawn parallel subagents for different sub-topics
2. Each subagent researches independently
3. Collect findings from all subagents

If no subagents:
1. Research sequentially
2. Use find, grep, read commands
3. Build context incrementally

**Research areas:**

**Code structure:**
- Directory layout
- Module organization
- Key files and their purposes
- Entry points

**Patterns & conventions:**
- Naming conventions
- Import patterns
- Error handling patterns
- Testing patterns

**Prior art:**
- Similar features that exist
- Past approaches (from git history)
- Reusable components
- Known issues or tech debt

**Dependencies:**
- External libraries used
- Internal module dependencies
- Configuration files

**Exit:** Context gathered from all areas.

### Phase 3: Synthesize

Organize findings into clear categories:

```markdown
## Key Findings

### Structure
- {Finding about project structure}

### Patterns
- {Finding about patterns used}

### Prior Art
- {Finding about existing similar work}

### Gaps
- {Finding about what's missing}

### Recommendations
- {Suggestion for brainstorm based on findings}
```

### Phase 4: Present & Handoff

Present findings to user.

#### Save Gate

If the user already specified whether to save (e.g., "save findings to memory" or "just show me"), skip this gate and follow their preference. Otherwise, ask:

```
ask_user({
  question: "Save this context?",
  context: "Context gathered from {N} files across {areas}. Summary includes structure, patterns, prior art, and recommendations.",
  options: [
    { label: "Save to memory", description: "Store findings in .unipi/memory/ for future sessions", value: "save" },
    { label: "Save to file", description: "Write findings to .unipi/docs/research/<topic>.md", value: "file" },
    { label: "Don't save", description: "Discard — context was just for this session", value: "discard" }
  ],
  allowFreeform: false
})
```

- **Save to memory:** Write findings to `.unipi/memory/` following the consolidate skill's memory file format.
- **Save to file:** Write findings to `.unipi/docs/research/<topic>.md` using the synthesis output format from Phase 3.
- **Don't save:** Skip — findings stay in conversation only.

After the save decision, hand off:

> "Context gathered. Ready to brainstorm solutions?"
```
/unipi:brainstorm <topic>
```

The brainstorm will start with this context already available — no need to re-research.

---

## Notes

- This is a research skill — read-only, no changes
- Subagent support enables parallel research when available
- Findings feed directly into brainstorm — natural workflow
- Can be run standalone for exploration, or as pre-brainstorm step
- Output is ephemeral (in conversation) unless user requests saving — save gate at end of Phase 4 offers explicit save-to-memory or save-to-file
