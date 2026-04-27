# Coexist Triggers

How workflow skills integrate with other packages when they're present.

## Overview

Workflow skills dynamically enhance their behavior based on available packages. When a package is installed, related skills automatically leverage its capabilities.

## Trigger Map

| Package Present | Skills Affected | Enhancement |
|-----------------|-----------------|-------------|
| `@unipi/ask-user` | ALL workflow skills | All ask-user tools available |
| `@unipi/subagents` | brainstorm, document, gather-context, review-work, scan-issues, work | Inject subagent prompt templates |
| `@unipi/mcp` | ALL workflow skills | All MCP tools available |
| `@unipi/web-api` | research, gather-context, consultant + subagents | Web tools for research |
| `@unipi/compactor` | ALL workflow skills (main agent) | Compactor tools available |
| `@unipi/ralph` | work, review-work | Encourage ralph loop for 3+ tasks |

---

## Detailed Triggers

### ask-user → All Skills

When `@unipi/ask-user` is present, all workflow skills can use structured user input.

**Injected behavior:**
- Use `ask_user` tool for decision gates
- Present multiple-choice options when natural
- Support multi-select for feature selection
- Use context parameter for additional info

**Example usage in brainstorm:**
```
ask_user({
  question: "Which approach should we take?",
  context: "We've evaluated three options based on complexity and maintainability.",
  options: [
    { label: "Option A", description: "Simple, fast to implement" },
    { label: "Option B", description: "Flexible, more complex" },
    { label: "Option C", description: "Balanced approach" }
  ]
})
```

---

### subagents → Investigation & Work Skills

When `@unipi/subagents` is present, these skills get parallel execution:

| Skill | Subagent Usage |
|-------|----------------|
| `brainstorm` | Parallel research for different approaches |
| `document` | Parallel documentation of different modules |
| `gather-context` | Parallel codebase exploration |
| `review-work` | Parallel task verification |
| `scan-issues` | Parallel scanning by category |
| `work` | Parallel task execution (with file locking) |

**Injected prompt template (concise):**

```
## Subagent Strategy

If subagents available:
1. Decompose task into independent subtasks
2. Spawn explore agents for read-only investigation
3. Spawn work agents for parallel file modifications
4. Collect and synthesize findings

Use spawn_helper({ type: "explore", prompt: "...", description: "..." })
Use spawn_helper({ type: "work", prompt: "...", description: "..." })
```

**Quality prompt guidelines:**
- Be specific about what to find/do
- Include file paths when known
- Specify output format for findings
- Keep prompts concise but precise

---

### mcp → All Skills

When `@unipi/mcp` is present, all MCP server tools are available to all skills.

**Injected behavior:**
- MCP tools named `{serverName}__{toolName}` are accessible
- Use MCP tools for external service integration
- Examples: GitHub operations, database queries, API calls

**Usage pattern:**
```
// If GitHub MCP server is configured
github__search_code({ query: "authentication middleware" })
github__list_pull_requests({ state: "open" })
```

---

### web-api → Research Skills

When `@unipi/web-api` is present, research-type skills get web access:

| Skill | Web Enhancement |
|-------|-----------------|
| `research` | Full web search, read, summarize |
| `gather-context` | External documentation lookup |
| `consultant` | Industry best practices research |
| `subagents` (explore) | Web research in parallel |

**Injected tools:**
- `web_search` — search the web
- `web_read` — read URL content
- `web_llm_summarize` — summarize with LLM

**Usage in research:**
```
web_search(query: "TypeScript 5.0 new features", source: 2)
web_read(url: "https://devblogs.microsoft.com/typescript/announcing-typescript-5-0/")
```

---

### compactor → All Skills (Main Agent)

When `@unipi/compactor` is present, main agent has access to compactor tools:

**Available tools:**
- `ctx_execute` — run code safely
- `ctx_recall` — search session history
- `ctx_index` — index project files
- `ctx_search` — search indexed content

**Usage pattern:**
- Use `ctx_recall` to find earlier context
- Use `ctx_search` for fast codebase search
- Use `ctx_execute` for safe code execution

---

### ralph → Work & Review Skills

When `@unipi/ralph` is present, working and reviewing skills encourage ralph loops for complex tasks.

**Trigger condition:** Task has 3+ subtasks or checklist items.

**Injected behavior in work skill:**
```
## Ralph Loop Recommendation

This task has {N} subtasks. Consider using a ralph loop for better progress tracking:

ralph_start({
  name: "{task-name}",
  taskContent: "# Task\n\n{description}\n\n## Goals\n- {goal1}\n- {goal2}\n\n## Checklist\n- [ ] {item1}\n- [ ] {item2}\n- [ ] {item3}",
  maxIterations: 50,
  itemsPerIteration: 3,
  reflectEvery: 5
})

Benefits:
- Progress tracked across sessions
- Periodic reflection checkpoints
- State persists if interrupted
- Clean completion markers
```

**Injected behavior in review-work:**
```
## Ralph Status Check

If ralph loop was used:
1. Check loop state: .unipi/ralph/{name}.state.json
2. Review checklist completion
3. Note any reflection findings
```

---

## Implementation Notes

### How Triggers Work

1. **Detection:** Skill checks if package is installed
2. **Enhancement:** Injects package-specific behavior
3. **Graceful degradation:** Works without package too

### Prompt Injection Pattern

When injecting prompts into skills:

```markdown
## Subagent Integration

If `@unipi/subagents` extension is installed:
1. Use spawn_helper for parallel work
2. Each agent gets focused, specific prompts
3. Collect results and synthesize

Prompt template:
- Be specific about task
- Include relevant file paths
- Specify expected output format
```

### Quality Guidelines for Injected Prompts

1. **Concise:** Don't bloat the skill with verbose templates
2. **Specific:** Include actual file paths and expected outputs
3. **Actionable:** Agent should know exactly what to do
4. **Flexible:** Allow agent to adapt to context
5. **Example-driven:** Show one good example, not many bad ones

---

## Adding New Coexist Triggers

When adding a new package that integrates with workflow:

1. **Identify affected skills** — which skills benefit?
2. **Determine enhancement** — what does the package enable?
3. **Write concise prompt** — specific, actionable template
4. **Document trigger** — add to this file
5. **Test graceful degradation** — works without package
6. **Store in memory** — save trigger pattern for consistency

---

## Memory Reference

Store coexist-trigger patterns in memory for consistency:
```
memory_store({
  title: "coexist_trigger_pattern",
  content: "When package X is present, skill Y gets Z enhancement...",
  tags: ["workflow", "coexist", "triggers"],
  type: "pattern"
})
```
