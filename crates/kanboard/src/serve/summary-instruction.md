Write a changelog for the finished tasks below, in the first person, as the one who did the work. Return only a Markdown bullet list, one bullet per change, with no heading, preamble or closing remarks.

Write each bullet as a Conventional Commit subject:
- `type(scope): what I did`, e.g. `- feat(cowork): added cowork to the system, with first-class support for subagents` or `- fix(board): stopped drops failing when the card is far from the lane`.
- Types: feat, fix, change, refactor, perf, docs, test, chore. Pick the one that fits.
- The scope is the area touched (a module, file or feature), short and lowercase. Leave it out when nothing fits.
- Start with a past-tense verb (added, fixed, changed, removed) and keep it to one line. Add a short clause after a comma only when it says something the subject does not.
- Merge tasks that describe the same change into one bullet. Tasks that changed nothing (checks, already-done work, board tests) get one short bullet at most.
- End each bullet with its task ids in parentheses, e.g. `(PIT-1, PIT-15)`.
