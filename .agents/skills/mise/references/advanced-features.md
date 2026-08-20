# Mise Advanced Features

Covers caching architecture, shell hooks, Pitchfork daemon management, team workflows, CI/CD integration, and lockfiles.

---

## Performance and Caching Architecture

Mise is built in Rust with a sub-millisecond shell prompt target. Understanding its cache model helps diagnose unexpected behaviour.

### Cache Mechanics

| Cache Layer | What's Cached | Invalidation |
|-------------|--------------|-------------|
| Remote version lists | Available versions of each tool (e.g. all Node.js versions) | Daily (configurable) |
| Environment resolution | Resolved PATH and env vars for the current directory | File timestamp change on any `mise.toml` or lock file |
| Tool metadata | Plugin metadata and checksums | Per plugin update |

- **Serialization:** msgpack with zstd compression — significantly smaller and faster than JSON.
- **Early exit:** If no `mise.toml` has changed since last entry, mise exits without recalculating the environment. This is why the shell prompt stays fast even in large projects.
- **Why remote secrets aren't built in:** Fetching secrets from AWS/Vault would require a network call on every directory change, breaking the under-10ms prompt requirement. This is why fnox exists as a separate tool.

### Cache Location

```bash
# Default cache dir
~/.cache/mise/

# Override
export MISE_CACHE_DIR=/tmp/mise-cache
```

### Clearing the Cache

```bash
# Clear all caches (rarely needed)
mise cache clear

# Clear only version list cache (if you need latest versions immediately)
mise cache clear --stale
```

---

## Shell Hooks

Mise supports hooks that run scripts at lifecycle events.

### Tool Post-Install Hooks

Run a command after a specific tool is installed:

```toml
[tools]
# Enable corepack after Node.js installs
node = { version = "22", postinstall = "corepack enable" }

# Set up a Python virtualenv after Python installs
python = { version = "3.12", postinstall = "python -m venv .venv" }
```

### Directory Hooks (enter/leave)

Run scripts when entering or leaving a directory:

```toml
[hooks]
enter = "echo 'Entered project directory'"
leave = "echo 'Left project directory; cleaning up...'"
```

More complex hooks using an array:

```toml
[hooks]
enter = [
  "mise doctor --quiet",
  "echo 'Project: {{ cwd | basename }}'"
]
```

### Git Hooks

Generate a Git pre-commit hook that runs a mise task:

```bash
mise generate git-pre-commit --task lint
```

This creates `.git/hooks/pre-commit` that runs `mise run lint` before each commit.

### Available Hook Types

| Hook | Trigger |
|------|---------|
| `enter` | Directory entry |
| `leave` | Directory exit |
| `postinstall` | After a tool installs |
| `preinstall` | Before a tool installs |

---

## Pitchfork: Daemon Management

[Pitchfork](https://github.com/jdx/pitchfork) is a companion tool that automatically manages background processes (databases, dev servers, message queues) per directory.

### Problem it Solves

Without Pitchfork, developers either:
- Manually run `docker-compose up` in a separate terminal tab (and forget to stop it)
- Write complex `mise run start` tasks that don't clean up on exit

### How Pitchfork Works

1. Tracks active shell sessions per project directory
2. When the first shell enters the directory: starts configured daemons
3. When the last shell exits: automatically stops all daemons
4. If you open 3 tabs in the same project, daemons persist until all 3 close

### Configuration

```toml
# mise.toml
[tools]
pitchfork = "latest"

[tasks.start-dev]
# Pitchfork manages this as a daemon
run = "pitchfork start"
```

```toml
# pitchfork.toml
[[daemons]]
name = "postgres"
command = "docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:16"
health_check = { tcp = "localhost:5432", timeout = 30 }

[[daemons]]
name = "redis"
command = "redis-server"
health_check = { tcp = "localhost:6379" }
```

### Status

Pitchfork is **experimental** as of early 2026. It works well but the API may change.

---

## Lockfiles

Mise lockfiles (`mise.lock`) pin exact tool versions including patch numbers. Without a lockfile, `node = "22"` could resolve to `22.11.0` today and `22.12.0` tomorrow.

### Enabling Lockfiles

```toml
# mise.toml
[settings]
experimental = true
lockfile = true
```

### Workflow

```bash
# First install: creates mise.lock
mise install

# mise.lock is generated automatically:
# [node]
# version = "22.11.0"
# backend = "core"
# checksum = "sha256:abc123..."

# Team members: reproduce exact versions
mise install   # uses mise.lock if present
```

### Lockfile Recommendations

| Scenario | Recommendation |
|----------|---------------|
| Application (final artifact) | Commit `mise.lock` |
| Library | Don't commit `mise.lock`; let consumers resolve |
| CI pipeline | Always use `mise.lock` |
| Local dev, solo | Optional |

---

## Team Workflows

### Onboarding a New Developer

```bash
# 1. Clone the repo
git clone https://github.com/myorg/myproject && cd myproject

# 2. Install mise (if not already installed)
curl https://mise.run | sh && eval "$(mise activate zsh)"

# 3. Install all project tools in one command
mise install

# 4. (Optional) Install project tasks completion
eval "$(mise completion zsh)"

# 5. Verify
mise doctor
mise ls
```

### Recommended .gitignore Additions

```gitignore
# Mise personal overrides
mise.local.toml
.env.local
.env.personal

# SOPS plaintext (never commit unencrypted secrets)
secrets.json
.env.secrets
```

### CI/CD Integration

```yaml
# GitHub Actions example
- name: Install mise
  run: curl https://mise.run | sh
  env:
    MISE_INSTALL_PATH: /usr/local/bin/mise

- name: Install project tools
  run: mise install
  # Uses mise.lock if present for reproducible builds

- name: Run CI tasks
  run: mise run ci
```

```yaml
# GitLab CI example
before_script:
  - curl https://mise.run | MISE_INSTALL_PATH=/usr/local/bin sh
  - mise install

test:
  script:
    - mise run test
```

### Monorepo Strategy

For large monorepos with many packages:

```
monorepo/
├── mise.toml           # shared: common tools and env vars for all packages
├── mise.lock           # committed: reproducible versions
├── apps/
│   ├── api/
│   │   └── mise.toml   # API-specific tools only (e.g., dotnet version override)
│   └── frontend/
│       └── mise.toml   # Frontend-specific tools (e.g., node, pnpm)
└── packages/
    └── shared-ui/
        └── mise.toml   # Library tools
```

Root `mise.toml` defines the common baseline. Sub-packages override only what's different.

Enable monorepo task execution at root:

```toml
# mise.toml (root)
[settings]
experimental = true
```

```bash
# Run tests in all packages
mise //...:test

# Run build in a specific app
mise //apps/api:build

# Run lint in all apps
mise //apps/*:lint
```

---

## Settings Reference

Commonly used `[settings]` entries:

```toml
[settings]
# Enable experimental features (lockfiles, monorepo tasks, etc.)
experimental = true

# Enable lockfile
lockfile = true

# Auto-install tools declared in mise.toml on directory entry
# (default: false — prompts instead)
auto_install = true

# Disable legacy file reading (.nvmrc, .tool-versions)
legacy_version_file = false

# Concurrency for parallel tool installations
jobs = 4

# Verbose HTTP requests (for debugging network/download issues)
verbose = false
```

---

## Troubleshooting

| Problem | Diagnosis | Fix |
|---------|-----------|-----|
| Wrong version of a tool active | `mise ls` to check + `mise env` to see PATH | Check config hierarchy with `mise config ls`; ensure project `mise.toml` takes precedence |
| Tool not found after install | `mise doctor` | Shell not activated; add `eval "$(mise activate zsh)"` to shell profile |
| SOPS decryption fails on CI | Check SOPS key availability | Inject age private key or IAM role into CI environment |
| Slow shell prompt | `MISE_VERBOSE=1 mise env` to time resolution | Check for network-calling hooks; clear stale cache with `mise cache clear` |
| asdf shims conflicting | `mise doctor` reports PATH order issue | Remove asdf from shell profile; uninstall fully |
| mise.lock conflict on merge | Two branches installed different patch versions | Run `mise install` after merge to regenerate lock |
