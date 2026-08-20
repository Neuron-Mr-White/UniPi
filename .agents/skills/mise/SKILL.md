---
name: mise
description: Provides expert guidance on mise (mise-en-place) — a polyglot dev tool and environment orchestrator that manages runtimes, environment variables, and project tasks. This skill should be used when users ask about mise configuration (mise.toml), installing or switching tool versions (Node, Python, Go, .NET, etc.), the mise task runner, environment variable management, secrets with SOPS/fnox, backends (ubi, cargo, npm, aqua), Lua plugins, shell hooks, migrating from asdf/nvm/direnv, or debugging with mise doctor.
metadata:
  version: 1.0.0
  tags: [mise, devtools, runtimes, environment, tasks, asdf, direnv, nvm]
---

# Mise Skill

Expert guidance on [mise](https://mise.jdx.dev) — the single tool that replaces asdf, nvm, pyenv, direnv, and make. Covers installation, mise.toml configuration, runtime management, task runner, environment variables, secrets, backends, Lua plugins, and team workflows.

## Quick Reference Table

| Task | Load Resource | Key Concepts |
|------|--------------|--------------|
| Install mise or activate in shell | references/core-concepts.md | curl install, shell activation, mise doctor |
| Configure tools and env vars in mise.toml | references/core-concepts.md | [tools], [env], config hierarchy, mise.local.toml |
| List, install, upgrade, or pin tool versions | references/commands-reference.md | mise use, mise install, mise upgrade, mise prune |
| Understand backends (ubi, cargo, npm, aqua) | references/backends.md | Core, UBI, Cargo, npm, Pipx, Aqua, Lua plugins |
| Define and run project tasks | references/task-runner.md | [tasks], mise run, depends, parallel, monorepo |
| Manage environment variables and secrets | references/environment-secrets.md | _.path, _.file, templating, SOPS, fnox |
| Advanced: caching, hooks, Pitchfork daemons | references/advanced-features.md | msgpack cache, Lua hooks, Pitchfork, Usage completions |
| Migrate from asdf, nvm, or direnv | references/core-concepts.md | .tool-versions, .nvmrc, compatibility |
| Team workflows, CI/CD, lockfiles | references/advanced-features.md | mise.lock, monorepo tasks, CI integration |

## Orchestration Protocol

### Phase 1 — Classify the Task

Identify which category the user's request falls into:

- **Setup** — installing mise, activating in shell, configuring global tools
- **Configuration** — writing or editing mise.toml, pinning versions, managing hierarchy
- **Tool management** — installing, listing, upgrading, or switching runtime versions
- **Backends** — choosing the right backend for a tool (ubi, aqua, cargo, npm)
- **Tasks** — defining and running tasks, task dependencies, monorepo tasks
- **Environment** — setting env vars, PATH modifications, .env file loading
- **Secrets** — SOPS encryption, fnox remote secrets
- **Advanced** — caching internals, Lua plugins, Pitchfork daemons, shell hooks
- **Migration** — moving from asdf, nvm, pyenv, or direnv

### Phase 2 — Load the Right Resource

Load the resource indicated in the Quick Reference Table. For tasks spanning multiple areas (e.g. "set up a new project with tools, tasks, and secrets"), load all relevant files. The files are lean enough to load together.

### Phase 3 — Execute

Apply guidance from the loaded resource. Produce complete, commented mise.toml snippets where configuration is involved. Always suggest `mise doctor` as the first debugging step for any environment issue.

## Common Task Workflows

### Workflow 1: Bootstrap a New Project

1. Load references/core-concepts.md for config hierarchy
2. Create mise.toml in the project root with [tools] for required runtimes
3. Add [env] section for project-specific environment variables
4. Run `mise install` to install all declared tools
5. Commit mise.toml; add mise.local.toml to .gitignore for personal overrides

```toml
[tools]
node = "22"
python = "3.12"

[env]
NODE_ENV = "development"
_.path = ["./node_modules/.bin"]
```

### Workflow 2: Replace nvm / asdf

1. Load references/core-concepts.md
2. Mise auto-reads .nvmrc and .tool-versions — no conversion needed immediately
3. Activate mise in shell profile: `eval "$(mise activate zsh)"`
4. Uninstall nvm/asdf once comfortable; run `mise doctor` to verify
5. Migrate to mise.toml to unlock env vars and tasks

### Workflow 3: Define Project Tasks

1. Load references/task-runner.md
2. Add [tasks.name] blocks to mise.toml
3. Set depends for prerequisite tasks
4. Run: `mise run <task>` or `mise run --list` to see all tasks

### Workflow 4: Manage Secrets with SOPS

1. Load references/environment-secrets.md
2. Install sops: `mise use --global sops`
3. Encrypt secrets file with age key
4. Reference in mise.toml: `_.file = { path = "secrets.enc.json", decrypt = true }`

### Workflow 5: Troubleshoot Environment Issues

1. Run `mise doctor` — surfaces shell integration problems, PATH issues, shim conflicts
2. Run `mise env` — shows exactly which env vars mise will set in the current directory
3. Run `mise ls` — lists active tool versions in the current directory
4. Load references/core-concepts.md for config hierarchy to diagnose overrides

## Resource Summaries

| File | Contents | Lines |
|------|----------|-------|
| references/core-concepts.md | Installation, shell activation, mise.toml format, config hierarchy, migration from asdf/nvm | ~280 |
| references/commands-reference.md | Full command reference: use, install, upgrade, exec, ls, prune, doctor, env | ~240 |
| references/backends.md | Core, UBI, Cargo, npm, Pipx, Aqua backends; Lua plugin architecture; writing custom plugins | ~260 |
| references/task-runner.md | Task definitions, depends, parallel execution, file tasks, monorepo tasks, Usage completions | ~250 |
| references/environment-secrets.md | [env] reference, PATH management, Tera templating, SOPS integration, fnox remote secrets | ~240 |
| references/advanced-features.md | Caching architecture, Lua lifecycle hooks, Pitchfork daemon manager, shell hooks, team CI/CD | ~260 |

## Best Practices

- **Commit mise.toml** — treat it as the project's source of truth for the toolchain; everyone on the team gets the same runtimes
- **Use mise.local.toml for personal overrides** — add it to .gitignore; never commit personal paths or secrets
- **Prefer `mise use` over hand-editing** — `mise use node@22` writes the correct version and installs the tool atomically
- **Global tools = CLI utilities only** — use `mise use --global` for ripgrep, bat, gh; enforce local versions for runtimes to ensure reproducibility
- **Always run `mise doctor` first** — it diagnoses 90% of "tool not found" / "wrong version" issues instantly
- **Use lockfiles for CI strictness** — enable mise.lock (experimental) to pin exact patch versions
- **Don't mix mise + asdf shims** — they conflict on PATH; remove asdf entirely when migrating

## External References

- [mise documentation](https://mise.jdx.dev) — official docs
- [mise GitHub](https://github.com/jdx/mise) — source and releases
- [mise backends list](https://mise.jdx.dev/dev-tools/backends/) — all available backends
- [mise plugins registry](https://github.com/mise-plugins/registry) — community plugins
- [SOPS documentation](https://github.com/mozilla/sops) — secrets encryption
- [Pitchfork](https://github.com/jdx/pitchfork) — daemon manager companion tool
- [fnox](https://github.com/jdx/fnox) — remote secrets companion tool
