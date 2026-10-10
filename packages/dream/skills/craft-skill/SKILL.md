---
name: craft-skill
description: Create or refine an agent skill. Use when asked to write or update a skill, turn a lesson into a skill, or when a dream proposes one.
---

1. Search existing skills. If one covers most of the job, refine it instead of adding a new one.
2. Name the skill with words the user actually types. Put what it does and when to use it in the first 200 characters of `description`: the skill router only reads that much.
3. Write steps that each end on a checkable done-condition. Move long reference into sibling files the steps point to.
4. Run `scripts/scaffold <dir>`. Put secret values in `<dir>/.env` and their names in `<dir>/.env.example`; scripts read them from the environment.
5. Done when `scripts/check <dir>` passes.
