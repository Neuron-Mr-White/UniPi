---
name: summarize
description: |
  Use for every final reply that ends a piece of work (a task, a fix, an
  investigation), and for /unipi:summarize, unless the user asked for full
  detail, raw output, or exact text. Shape: one-sentence answer, numbered
  sections, problems and fixes, not verified, still open, typed questions.
---

# Summarize for the user

Use this skill for the final reply after work (a task, an investigation, a
fix), and when the user runs /unipi:summarize. "The work" below means the
latest piece of work: the user's last request, the tool calls and results
that answered it, and your last reply. Use the rest of the session only as
context to explain it.

When the user runs /unipi:summarize, summarize your last reply again in
this shape. Do not call tools. If text follows this skill, it is the
user's question or focus. Answer it about your last reply. Words like "it"
or "this" refer to what your last reply covered. Use earlier parts of the
session only when the user's text asks about them.

## When not to use it

- The user asked for full detail, raw output, a file, code, or exact text.
  Give them that.
- The reply is short by nature: a one-line answer, a yes or no, a command,
  a question back to the user. Answer in plain sentences.
- The reply is in the middle of the work, not at its end.

Scale the shape to the work. A small task gets the answer sentence and one
or two bullets. Use the full shape only when the work has several findings,
changes, or open items.

The reader is the user. They asked for the work but did not watch it. They
read the summary once, quickly, top to bottom. Each line should tell them
more than the line before. The answer comes first, then the reasons, then
the details, then what is left for them.

You did the work. Write as "I" and call the reader "you".

## Step 1: pick the level

Read the user's own messages in the work before you write. Pick one level.

- Product level (the default). The user talks about features, screens,
  customers, money, speed, or decisions. Describe what people see and why it
  matters. Use at most three code names in total, and only ones the user needs
  to act on (a file to open, a command to run, a setting to change).
- Technical level. The user's messages use code names, file paths, commands,
  or error text, or they ask how something works inside the code. Match them:
  name the functions, files, and settings that carry the answer, and explain
  the mechanism. Still start each point with the effect, then the mechanism.
  Count your code names (anything in backticks, plus file, function, route,
  and setting names). Use six or fewer in total. Describe the rest in words. Never give style values, line
  numbers, or full lists of files or pages. Say "about 15 table pages".

If the user mixes both, use product level for the answer and the findings.
Put technical names only where the user must act.

## Step 2: the shape

```
<Answer: one sentence. No heading above it.>

## 1. <First topic>
**<One-sentence takeaway of this section.>**
<diagram, if one fits>
- **<Label>**: <one or two sentences>
- **<Label>**: <one or two sentences>

## 2. <Next topic>
...

## Problems and fixes        (only if the work hit a real obstacle)
- **<Problem>**: <what blocked the work>. **Fix**: <what I did about it>.

## Not verified
- **<Label>**: <one sentence>

## Still open
- **<Label>**: <one sentence>

## Questions for you
...
```

Read the shape as a report to a manager: what we achieved, how, what got in
the way and how we solved it, what we did not check, what needs approval.

The answer line:
- Exactly one sentence, 25 words or fewer, with no semicolon. It gives the
  answer, the result, or the main finding. Keep caveats out of it. The one
  exception: a caveat that flips the answer ("the fix is not deployed yet").
- It states what is true, never what you did. "I traced each issue and
  wrote a plan" is wrong. "The filter count is right, but the list hides 4
  of the 6 statuses" is right. If nothing changed yet, say that after the
  finding, in the same sentence.
- No label such as "Status:" or "Summary:". Do not restate the request.

Topic sections:
- Use two to four sections, numbered. A heading names its content in two to
  six words: "1. Why wake got slow", "2. What I changed".
- Put the most important section first. Build from the answer: what is true
  now, then why, then what changed.
- Every section starts with one bold sentence: the takeaway of that section.
  The user can read only the bold sentences and still get the whole story.
- Details follow as bullets. Each bullet starts with a bold label of one to
  four words, a colon, then one or two sentences.
- A section has four bullets or fewer, and the whole summary has 14 bullets
  or fewer. If you have more, group them or keep the ones that matter to the
  user. A bullet that only lists items ("chat, posts, captions, comments")
  can usually merge into the bullet above it.

## Step 3: plain words

Jargon hides in plain text too, not only in backticks. Before you send, find
every word a manager outside this project would not know: internal system
names ("warm assignment", "supernode", "lane"), infrastructure names, and
abbreviations.

- Product level: replace each one with what it does ("the spare pod kept
  ready for the user"). If it appears three times or more, explain it once
  in eight words or fewer and keep it.
- Technical level: keep it, but explain it once in eight words or fewer the
  first time it appears, unless the user used it first.
- Write a number with a unit the reader knows: "35 seconds", not "35s p50".

## Step 4: break the text

- No paragraph longer than three sentences or about 50 words. Break every
  longer block into bullets.
- Put the important word first in each sentence. Write "**8 of 12** checks
  failed", not "Of the twelve checks that I ran, eight failed".
- Bold only these: the section takeaway, the bullet labels, and at most one
  key number or name inside a bullet.
- Use a short paragraph only for one connected line of reasoning, three
  sentences at most.

## Step 5: add a diagram when it fits

Add a mermaid diagram when the work has one of these:
- a flow of three or more steps,
- a chain of three or more causes,
- three or more parts that send things to each other.

Do not draw a diagram for a plain list.

Diagram rules:
- Use `flowchart TD` or `sequenceDiagram`. Never use `flowchart LR`: wide
  diagrams break in a terminal.
- The diagram shows the subject of its own section, nothing else.
- Use 7 nodes or fewer. If you need more, split the diagram into two, each
  with its own one-line caption.
- Labels are one to four plain words. Node ids are single letters: A, B, C.
  Put labels in square brackets. Do not put parentheses, quotes, or colons
  inside a label. Edge labels are one to three words: `A -->|fails| B`.
- Use the same names in the diagram and in the text.
- Put the diagram right after the bold takeaway of its section.
- Use two diagrams at most, and one when the summary is product level.

## Step 6: problems and fixes

Add this section only when the work hit a real obstacle: something failed,
blocked progress, or forced a change of plan. Leave it out for normal work.

- One bullet per obstacle, three or fewer. Format:
  **<Problem in 2 to 4 words>**: what went wrong, in one sentence.
  **Fix**: what I did about it, in one sentence.
- If the obstacle is not solved, write **Fix**: none yet, and put the open
  work under "Still open".
- Do not repeat an obstacle that a topic section already explains.

## Step 7: not verified, then still open

Write two short sections. Leave out a section when it is empty. Never write
a bullet that says there is nothing to report.

- "Not verified": what the user should trust less. Numbers that came from
  docs or estimates, tests that did not run, causes that are not confirmed.
- "Still open": work that is not done yet, and risks.

Use bullets with bold labels, three or fewer in each section. Include only
items that bear on what the user asked.

## Step 8: questions for you

Ask only when the work is blocked on a user decision or on information that
only the user has. If nothing is blocked, leave out this section.

Ask two questions or fewer. Ask a third only when the work is blocked on it. Label each question with its type:

```
**Q1 (pick one)**: Which tier should I cut first?
- a) Diff rendering, about 1,800 lines **(recommended: largest cut, no runtime risk)**
- b) Memory fallback, about 800 lines
- c) Compactor display code, about 900 lines

**Q2 (pick any)**: Which tables should get translations in this pass?
- a) Onboarding review
- b) Users
- c) Orders

**Q3 (your answer)**: Which three slow users should I check?
```

- Use "pick one" for a single choice, "pick any" when several can apply, and
  "your answer" when the user must type something: a name, a number, a
  preference, or access.
- Take the question and the options from the work. Never invent a question
  the work did not raise. A question about a step you only propose is an
  offer, so leave it out.
- Give two or three options. Merge or drop the weakest.
- Mark an option **(recommended: reason)** only when the work gives a reason.
  Mark one at most. You can mark a risky option **(not recommended: reason)**.
- A thing the user must do (not a choice) is one line: **To do**: Set the
  search key on the server.
- A step that waits for the user's permission is one line:
  **Needs approval**: Deploy the fix to production.
- Do not offer more work ("Do you want me to...", "I can also...").

## Sentences

- One idea per sentence, 20 words or fewer when you can. Active voice.
- Simple verbs. No semicolons. One name for one thing, every time.
- Keep the confidence of the work with one short word inline: "likely",
  "about", "estimated". Put every longer caveat at the end (see Step 5):
  where a number came from, what was not tested, what was not confirmed.
  Never write a section or a bullet about what was measured versus claimed.
- Copy cause and effect only as the work states it. Never add a fact, number,
  cause, or opinion that is not in the work. This applies to diagram arrows
  too: draw an arrow between two things only when the work says one leads to
  the other.
- Keep the certainty of the work in both directions. If the work states a
  fact plainly, do not soften it to "likely". If the work guesses, do not
  harden it.
- Copy numbers exactly: "$26.60", not "about $27".
- Put a baseline next to a number when the work has one that measures the
  same thing: "3.2 s (was 11 s)".

## Cut

- Each fact or caveat appears once.
- Three examples at most in any list inside a sentence.
- No framing phrases ("The bigger finding is", "In short", "Overall").
- No "not X but Y", no "X rather than Y", and no "X, not Y" ("mid-June, not months ago", "from a
  test, not production"). State the positive claim. If the user believed
  the wrong thing, say the right thing once.
- No em dashes. No emoji. No opener, no closer, no offer of more help.
- No inflated words: robust, seamless, comprehensive, crucial, leverage,
  pivotal, significant, enhance, streamline.

## Length

- Product level: 120 to 240 words, not counting diagrams.
- Technical level or very large work: 300 words at most.
- If the draft is longer, cut the least important bullets first. Do not cut
  the answer, the bold takeaways, or the questions.

## Example

The work: the user said "people keep getting logged out, fix it". The agent
found a setting in seconds that the code read as minutes, fixed it, tested on
staging, and found a second, unrelated bug.

```
Logins now last 24 hours again, after I fixed a setting that ended every session after 24 minutes.

## 1. Why people were logged out
**The session timer used the wrong unit since the 3 May release.**
- **Cause**: the setting was written in minutes but read as seconds.
- **Effect**: every session ended after **24 minutes** (should be 24 hours).

## 2. What I changed
**I fixed the unit and tested the fix on staging.**
- **Fix**: the setting now states its unit, and the code reads it the same way.
- **Test**: a staging login stayed active for 3 hours with no logout.

## Problems and fixes
- **Bug did not show locally**: my machine kept old sessions alive. **Fix**: I tested on staging with a fresh login.

## Not verified
- **Long sessions**: the staging test ran 3 hours, so a full 24-hour session is untested.

## Still open
- **Production**: the fix is not deployed yet.
- **Second bug**: the "remember me" box does nothing. It is a separate problem.

## Questions for you
**Q1 (pick one)**: When should I deploy?
- a) Now **(recommended: users are logged out every 24 minutes)**
- b) With Friday's release
```

## Check before you send

- Is the answer one sentence, with no label and no restated request?
- Does every section start with a bold takeaway?
- Is any paragraph longer than three sentences? Break it.
- Did you match the user's level?
- If there is a flow of three or more steps, is there a diagram?
- Is each question labeled with its type, with a recommendation only where
  the work gives a reason?
- Does any fact, caveat, or number appear twice? Delete the second one.
- Is there a caveat longer than one word in the answer, a takeaway, or a
  bullet? Move it to the end.
- Is the word count inside the limit for the level?
- Would a manager outside this project understand every word? Replace or
  explain the rest.
- Does every diagram arrow match a cause or step the work states?
