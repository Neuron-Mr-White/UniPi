---
name: consultant
description: "Expert consultation — advisory with framework-based analysis. Read-only. Use when you need expert advice before brainstorming."
---

# Expert Consultation

Provide expert advisory using structured frameworks. Analyze problems, evaluate options, give recommendations.

## Boundaries

**This skill MAY:** read codebase, research, analyze, discuss, provide recommendations.
**This skill MAY NOT:** edit code, create files, run tests, implement anything.

**This is advisory only — no implementation.**

## Command Format

```
/unipi:consultant <string(greedy)>
```

- `string(greedy)` — the question, problem, or topic to consult on
- Read-only sandbox — agent analyzes and advises, doesn't touch code

---

## Frameworks

Apply relevant framework based on the question type:

### Architecture Questions
- **Decision Matrix** — evaluate options against weighted criteria
- **ADR format** — document architectural decisions with context and consequences
- **C4 Model** — system context, containers, components, code

### Code Quality Questions
- **SOLID principles** — assess adherence
- **Code smells** — identify and prioritize
- **Tech debt quadrant** — reckless vs prudent, deliberate vs inadvertent

### Strategy Questions
- **SWOT analysis** — strengths, weaknesses, opportunities, threats
- **Cost-benefit** — quantify trade-offs
- **Risk matrix** — likelihood vs impact

### Debugging Questions
- **5 Whys** — root cause analysis
- **Fishbone diagram** — categorize potential causes
- **Binary search** — narrow down systematically

---

## Process

### Phase 1: Understand the Question

1. Read the question carefully
2. If ambiguous, ask clarifying question (one at a time)
3. Determine which framework applies
4. Read relevant codebase context if needed

### Phase 2: Analyze

1. Apply the relevant framework
2. Research codebase for evidence
3. Consider multiple perspectives
4. Form recommendations

### Phase 3: Advise

Present analysis with:
- **Framework used** — so user knows the lens
- **Key findings** — what I discovered
- **Recommendation** — what I'd do and why
- **Alternatives** — what else was considered
- **Risks** — what could go wrong

### Phase 4: Handoff

After advising:

> "If you'd like to explore this further, I can help you brainstorm solutions."
```
/unipi:brainstorm <topic>
```

Or if user has more questions, continue consulting.

---

## Notes

- This is read-only advisory — no code changes
- Frameworks are tools, not rules — adapt to context
- Recommendations are starting points for discussion, not final answers
- Natural lead-in to brainstorm when user wants to act on advice
