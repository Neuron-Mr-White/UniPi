---
name: scan-issues
description: "Deep investigation — find bugs, anti-patterns, security issues. Spawns subagents if available."
---

# Scanning for Issues

Deep investigation of codebase to find bugs, anti-patterns, security issues, and technical debt.

## Boundaries

**This skill MAY:** read codebase, run read-only analysis commands, spawn subagents, write findings.
**This skill MAY NOT:** edit code, fix issues, run tests that modify state, deploy.

**This is investigation only — not fixing.**

## Command Format

```
/unipi:scan-issues <string(greedy)>(optional)
```

- `string(greedy)` — optional scope (e.g., "focus on auth", "check for SQL injection", "find dead code")
- If not provided → full codebase scan
- Read-only sandbox
- Spawns subagents if `@unipi/subagents` extension is installed

---

## Process

### Phase 1: Determine Scope

**If scope provided:**
1. Parse the focus area
2. Determine scan type:
   - Security scan
   - Bug hunt
   - Anti-pattern detection
   - Tech debt assessment
   - Performance issues

**If no scope:**
1. Ask user what to focus on, or
2. Run broad scan covering all categories

**Exit:** Scope defined.

### Phase 2: Deep Investigation

If subagents available:
1. Spawn parallel subagents for different scan types
2. Each subagent investigates independently
3. Collect findings from all subagents

If no subagents:
1. Investigate sequentially
2. Use grep, find, read commands
3. Build findings incrementally

**Scan categories:**

**Security:**
- Hardcoded secrets/credentials
- SQL injection vulnerabilities
- XSS vulnerabilities
- Insecure dependencies
- Missing input validation
- Exposed sensitive data

**Bugs:**
- Null/undefined handling
- Race conditions
- Error handling gaps
- Edge cases missed
- Logic errors
- Off-by-one errors

**Anti-patterns:**
- Code duplication
- God objects/functions
- Circular dependencies
- Tight coupling
- Magic numbers/strings
- Inconsistent patterns

**Tech debt:**
- TODO/FIXME comments
- Deprecated API usage
- Outdated dependencies
- Dead code
- Missing tests
- Poor naming

**Performance:**
- N+1 queries
- Unnecessary re-renders
- Large bundle imports
- Missing caching
- Inefficient algorithms

**Exit:** Findings collected.

### Phase 3: Categorize & Prioritize

Organize findings by severity:

**Critical (P0):**
- Security vulnerabilities
- Data loss risks
- Production-breaking bugs

**High (P1):**
- Significant bugs
- Major anti-patterns
- Performance bottlenecks

**Medium (P2):**
- Minor bugs
- Tech debt
- Code smells

**Low (P3):**
- Style issues
- Minor improvements
- Nice-to-haves

### Phase 4: Present Findings

```markdown
## Issue Scan Results

### Critical (P0)
- {Finding} — {file:line} — {description}

### High (P1)
- {Finding} — {file:line} — {description}

### Medium (P2)
- {Finding} — {file:line} — {description}

### Low (P3)
- {Finding} — {file:line} — {description}

### Summary
- Total issues: {count}
- Critical: {count}
- High: {count}
- Medium: {count}
- Low: {count}
```

### Phase 5: Handoff

Based on findings:

**If critical issues found:**
> "Critical issues found. Recommend addressing immediately."
```
/unipi:quick-work "fix critical security issue in auth.ts"
```

**If many issues:**
> "Multiple issues found. Consider planning a cleanup sprint."
```
/unipi:brainstorm "tech debt cleanup plan"
```

**If few/no issues:**
> "Codebase looks healthy. No critical issues found."
```
/unipi:consolidate
```

---

## Notes

- Investigation only — findings are reported, not fixed
- Subagent support enables parallel scanning when available
- Can focus on specific categories or scan broadly
- Prioritized findings help triage what to fix first
- Natural lead-in to quick-work (for critical) or brainstorm (for planned cleanup)
