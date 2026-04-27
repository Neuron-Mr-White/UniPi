---
name: research
description: "Read-only research with bash access. Deep codebase investigation, documentation review, external research."
---

# Research

Deep read-only investigation with bash access. For thorough codebase analysis, documentation review, and external research.

## Boundaries

**This skill MAY:** read codebase, run read-only bash commands, spawn subagents, write findings, use web tools if available.
**This skill MAY NOT:** edit code, create files (except findings), run tests that modify state, deploy.

**This is research only — not implementation.**

## Command Format

```
/unipi:research <string(greedy)>
```

- `string(greedy)` — research topic or question
- Read-only sandbox + bash access
- Spawns subagents if `@unipi/subagents` extension is installed
- Uses web tools if `@unipi/web-api` extension is installed

## Output

Findings presented in conversation. Can be saved to `.unipi/docs/generated/` if user requests.

---

## Process

### Phase 1: Define Research Scope

1. Read the research topic/question
2. If ambiguous, ask clarifying questions (one at a time)
3. Determine research type:
   - **Codebase research** — patterns, architecture, dependencies
   - **Documentation research** — existing docs, READMEs, comments
   - **External research** — libraries, APIs, best practices
   - **Historical research** — git history, past decisions
   - **Comparative research** — evaluate options/approaches

**Exit:** Research scope defined.

### Phase 2: Codebase Research

Use bash and read tools for deep investigation:

**Structure Analysis:**
```bash
find . -type f -name "*.ts" | head -50
ls -la src/
tree src/ -L 2
```

**Pattern Search:**
```bash
grep -r "pattern" --include="*.ts" .
grep -rn "TODO\|FIXME\|HACK" --include="*.ts" .
```

**Dependency Analysis:**
```bash
cat package.json
grep -r "import.*from" --include="*.ts" . | sort | uniq -c | sort -rn
```

**Git History:**
```bash
git log --oneline -20
git log --all --oneline --grep="keyword"
git blame file.ts
```

**Exit:** Codebase context gathered.

### Phase 3: Documentation Research

1. Read existing documentation:
   - README files
   - API docs
   - Architecture docs
   - Comments and docstrings

2. Check for gaps:
   - Missing documentation
   - Outdated docs
   - Inconsistent information

3. Cross-reference:
   - Do docs match code?
   - Are examples correct?

**Exit:** Documentation context gathered.

### Phase 4: External Research (if web tools available)

Use web tools for external research:

**Library/API Research:**
```
web_search(query: "library-name documentation")
web_read(url: "https://docs.library.com")
web_llm_summarize(url: "https://library.com/guide", prompt: "Extract key concepts and usage patterns")
```

**Best Practices:**
```
web_search(query: "best practices for X in TypeScript 2026")
web_search(query: "X vs Y comparison")
```

**Stack Overflow / GitHub:**
```
web_search(query: "site:stackoverflow.com how to X")
web_search(query: "site:github.com X implementation examples")
```

**Exit:** External context gathered.

### Phase 5: Synthesize Findings

Organize research into clear categories:

```markdown
## Research Findings: {Topic}

### Summary
{One-paragraph overview of findings}

### Key Findings
1. {Finding 1}
2. {Finding 2}
3. {Finding 3}

### Detailed Analysis

#### {Category 1}
{Detailed findings with evidence}

#### {Category 2}
{Detailed findings with evidence}

### Codebase Context
- Current implementation: {description}
- Patterns used: {list}
- Gaps identified: {list}

### Recommendations
- {Recommendation 1}
- {Recommendation 2}

### Sources
- {File/code references}
- {External links}
- {Documentation references}

### Open Questions
- {Question that needs further research}
```

### Phase 6: Present & Handoff

Present findings to user:

> "Research complete on: {topic}"

Then suggest next steps based on findings:

**If research was for planning:**
> "Ready to brainstorm solutions?"
```
/unipi:brainstorm {topic}
```

**If research found issues:**
> "Found some issues during research. Consider investigating:"
```
/unipi:debug {issue}
/unipi:scan-issues focus on {area}
```

**If research was for documentation:**
> "Ready to document what we found?"
```
/unipi:document {topic}
```

**If research was exploratory:**
> "Want me to save these findings?"
- Save to `.unipi/docs/generated/YYYY-MM-DD-research-{topic}.md`

---

## Research Types

### Codebase Research
- Find patterns and conventions
- Understand architecture
- Map dependencies
- Identify tech debt

### Documentation Research
- Review existing docs
- Find gaps and inconsistencies
- Extract best practices
- Cross-reference with code

### External Research
- Library evaluation
- API documentation
- Best practices
- Community solutions

### Historical Research
- Git history analysis
- Past decision context
- Evolution of codebase
- Bug pattern analysis

### Comparative Research
- Evaluate alternatives
- Trade-off analysis
- Performance comparison
- Feature comparison

---

## Differences from gather-context

| Aspect | `/unipi:research` | `/unipi:gather-context` |
|--------|-------------------|-------------------------|
| Scope | Broad, any topic | Focused on codebase |
| Bash access | Full read-only bash | Limited commands |
| External web | Uses web tools | Codebase only |
| Output | Detailed findings | Concise summary |
| Handoff | Various options | Always → brainstorm |

---

## Notes

- Read-only with bash — powerful but safe
- Web tools integration when available
- Subagent support for parallel research
- Findings can be saved to docs if requested
- Natural lead-in to brainstorm, debug, or document
