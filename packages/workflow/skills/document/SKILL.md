---
name: document
description: "Generate documentation — README, API docs, guides. Use when you need to document code or features."
---

# Generating Documentation

Create documentation for code, features, or the project. Works with gather-context for thorough docs.

## Boundaries

**This skill MAY:** read codebase, run read-only commands, write docs to `.unipi/docs/generated/`.
**This skill MAY NOT:** edit source code, run tests, implement features.

## Command Format

```
/unipi:document <string(greedy)>(optional)
```

- `string(greedy)` — optional scope (e.g., "document the auth module", "write API docs for /api/users")
- If not provided → agent asks what to document
- Output: `.unipi/docs/generated/` in markdown

---

## Process

### Phase 1: Determine Scope

**If scope provided:**
1. Parse what to document
2. Confirm with user: "I'll document {scope}. Sound right?"

**If no scope:**
1. Ask user what to document:
   - "What should I document? (e.g., specific module, feature, or entire project)"
2. Ask doc type:
   - "What type of documentation? (README, API docs, guide, architecture doc)"

**Exit:** Scope and type confirmed.

### Phase 2: Gather Context

1. Read relevant source code
2. Check for existing documentation
3. Identify gaps
4. Use gather-context patterns if needed:
   - Find related files
   - Check git history for context
   - Look for comments and docstrings

**Exit:** Context gathered. Ready to write.

### Phase 3: Generate Documentation

Based on doc type:

**README:**
- Project overview
- Installation
- Usage examples
- Configuration
- Contributing

**API docs:**
- Endpoints/routes
- Request/response formats
- Authentication
- Error codes
- Examples

**Guides:**
- Step-by-step instructions
- Code examples
- Common patterns
- Troubleshooting

**Architecture doc:**
- System overview
- Module responsibilities
- Data flow
- Key decisions

### Phase 4: Write

Write to `.unipi/docs/generated/YYYY-MM-DD-<topic>.md`:

```markdown
---
title: "{Title}"
type: documentation
date: YYYY-MM-DD
scope: {what was documented}
---

# {Title}

{Content based on doc type}
```

### Phase 5: Present

Show summary to user:
> "Documentation written to `.unipi/docs/generated/YYYY-MM-DD-<topic>.md`"
> "Covers: {summary of what's documented}"

Ask:
1. **Review it** — read and suggest changes
2. **Add more** — extend documentation
3. **Done** — documentation complete

---

## Notes

- Output in markdown — portable, readable, diffable
- `.unipi/docs/generated/` keeps docs separate from workflow artifacts
- Can document code, features, architecture, or processes
- Natural extension of gather-context — research then document
