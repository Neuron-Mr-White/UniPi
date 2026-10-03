# Docs style guide

UniPi docs use **STE-flavored English**. The rules come from
[ASD-STE100](https://www.asd-ste100.org/) (Simplified Technical English), as
applied by the [asd-ste100 skill](https://github.com/danyuchn/asd-ste100-skill).
Many readers do not speak English as a first language. Some readers are AI
agents. Both readers must get one meaning from each sentence.

## Rules

| Rule | Do | Do not |
|---|---|---|
| Sentence length | Use 20 words or fewer for steps. Use 25 words or fewer for descriptions. | Write long sentences with many clauses. |
| One instruction per sentence | "Open the board. Select a task." | `Open the board and select a task, then …` |
| Active voice | "The compactor writes a summary." | `A summary is written.` |
| Simple tenses | "The release added hints." | `The release has added hints.` |
| No phrasal verbs | "Start the daemon." | `Spin up the daemon.` |
| No semicolons | Write two sentences. | Join two clauses with a `;` mark. |
| Verbs, not nouns | "Compact the session." | `Perform a compaction of the session.` |
| No marketing adjectives | Give the number: "0 LLM calls", "$0 per query". | `seamless`, `robust`, `powerful`, `blazing-fast` |
| One word, one meaning | Use one verb for one action in a file. | Mix `check`, `verify` and `confirm` for one action. |
| Short paragraphs | One topic. Six sentences or fewer. | Paragraphs with many topics. |
| Lists for sequences | Use a numbered list for three or more steps. | Put a sequence in one sentence. |
| Noun clusters | Three nouns or fewer in a row. | `session prefix cache epoch boundary marker` |

Keep hedges. If the code "may" do a thing, the doc says "may". Do not change a
hedge into a fact.

Define each UniPi term the first time a page uses it, or link to the
[glossary](../reference/glossary.md).

## Lint

Run the linter on each page before you commit:

```bash
python3 ste-lint.py docs/your-page.md
```

Get `ste-lint.py` from the
[asd-ste100-skill repository](https://github.com/danyuchn/asd-ste100-skill/tree/main/scripts).
The linter skips code blocks. A page must have 0 hard violations. You can keep an
advisory finding (passive voice, compound tense) when the actor is unknown or
the tense carries meaning.

## Facts

Each command, key, setting and tool name in the docs must exist in the source.
Search the source before you add a name. Do not copy names from old docs.
