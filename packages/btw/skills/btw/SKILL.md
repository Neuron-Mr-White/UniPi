---
name: btw
description: Helps you use the /unipi:btw side-conversation workflow effectively. Use when you want to think in parallel, ask side questions without interrupting ongoing work, or inject a side thread back into the main agent.
---

# BTW

Use this skill when the user wants to work in parallel with the main agent instead of derailing the current turn.

## When to use BTW

Prefer the BTW workflow when the user wants to:

- ask a side question while the main agent keeps working
- brainstorm or compare options without interrupting the current run
- prepare a plan or summary before handing it back to the main agent
- keep exploratory discussion out of the main transcript/context

## Commands

Use these commands in your guidance to the user:

```text
/unipi:btw <question>
/unipi:btw --save <question>
/unipi:btw-new [question]
/unipi:btw-tangent <question>
/unipi:btw-tangent --save <question>
/unipi:btw-clear
/unipi:btw-inject [instructions]
/unipi:btw-summarize [instructions]
```

## How to guide the user

### For a quick side question

Recommend:

```text
/unipi:btw <question>
```

Use this when the user wants an immediate aside and does not need a visible saved note.

### For a saved one-off note

Recommend:

```text
/unipi:btw --save <question>
```

Use this when the user wants the exchange to appear as a visible BTW note in the session transcript.

### For a fresh side thread

Recommend:

```text
/unipi:btw-new
```

or

```text
/unipi:btw-new <question>
```

Use this when the previous BTW discussion is no longer relevant, but you still want the new side thread to inherit the current main-session context.

### For a contextless tangent thread

Recommend:

```text
/unipi:btw-tangent <question>
```

or

```text
/unipi:btw-tangent --save <question>
```

Use this when the user wants a side conversation that does not include the current main-session context.

### To hand the full thread back to the main agent

Recommend:

```text
/unipi:btw-inject <instructions>
```

Use this when the exact discussion matters and the user wants the main agent to act on it.

### To hand back a condensed version

Recommend:

```text
/unipi:btw-summarize <instructions>
```

Use this when the thread is long and only the distilled outcome should go back into the main agent.

## Recommendation rules

- Prefer `/unipi:btw` over normal chat when the user explicitly wants a side conversation.
- Prefer `/unipi:btw-tangent` when the user wants that side conversation to be contextless.
- Prefer `/unipi:btw-summarize` over `/unipi:btw-inject` for long exploratory threads.
- Prefer `/unipi:btw-inject` when precise wording, detailed tradeoffs, or a full plan matters.
- Suggest `/unipi:btw-new` before starting a totally unrelated side topic when main-session context is still useful.
- Suggest `/unipi:btw-clear` when the widget/thread should be dismissed.

## Response style

When helping the user use BTW:

- give the exact slash command to run
- explain briefly why that command fits
- keep the guidance short and operational

## Examples

### Example: brainstorm while coding continues

```text
/unipi:btw what are the risks of switching this to optimistic updates?
```

### Example: create a clean new thread

```text
/unipi:btw-new sketch a safer migration plan
```

### Example: start a contextless tangent

```text
/unipi:btw-tangent think through this from first principles without using the current chat context
```

### Example: send the result back

```text
/unipi:btw-summarize implement the recommended migration plan
```
