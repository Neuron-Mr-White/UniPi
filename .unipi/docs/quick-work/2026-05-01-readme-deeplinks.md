---
title: "README Package Deeplinks"
type: quick-work
date: 2026-05-01
---

# README Package Deeplinks

## Task
Add clickable deeplinks from the root README's "What You Get" section to each package's individual README file.

## Changes
- `README.md`: Converted all 17 package bold titles (Workflow, Ralph, Memory, Compactor, Subagents, Web API, MCP, Notify, Footer, BTW, Ask User, Milestone, Kanboard, Info Screen, Utility, Updater, Input Shortcuts) from `**Name**` to `**[Name](./packages/name/README.md)**`

## Verification
- Confirmed 18 packages exist in `packages/` directory
- Verified 17 of 19 directories have README.md (autocomplete and unipi umbrella do not)
- Used relative links (`./packages/{name}/README.md`) which work on GitHub when viewing the root README
- Committed: `dbe558f`

## Notes
- `packages/autocomplete/` and `packages/unipi/` have no README.md, so they were not linked (they also aren't listed in the "What You Get" section)
- `packages/core/` has a README but isn't featured in the "What You Get" section — it could be added as a future enhancement
- Relative links were chosen over absolute GitHub URLs because they're shorter, work in both GitHub and local markdown viewers, and don't break if the repo is renamed/moved
