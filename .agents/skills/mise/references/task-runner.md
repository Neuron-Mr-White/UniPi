# Mise Task Runner

Mise includes a built-in task runner that replaces `Makefile`, `package.json` scripts, and `just`. Tasks are defined in `mise.toml` and run with `mise run <task>`. They automatically inherit the tool versions and environment variables from `mise.toml`.

---

## Defining Tasks

### Inline Tasks

Short tasks defined directly in `mise.toml`:

```toml
[tasks.build]
description = "Build the project"
run = "cargo build --release"

[tasks.test]
description = "Run tests"
run = "cargo test"

[tasks.lint]
description = "Run linter"
run = "cargo clippy"
```

### Multi-line Tasks

```toml
[tasks.setup]
description = "Full project setup"
run = """
npm install
dotnet restore ./src/MyApp.sln
echo "Setup complete"
"""
```

### Task with Arguments

Arguments passed after `--` are available as positional variables:

```bash
mise run greet -- Alice
```

```toml
[tasks.greet]
run = "echo Hello, $1"
```

---

## Task Properties

| Property | Type | Description |
|----------|------|-------------|
| `description` | string | Human-readable summary shown in `mise run --list` |
| `run` | string or array | Shell command(s) to execute |
| `depends` | array | Task names that must complete before this task |
| `env` | table | Extra environment variables for this task only |
| `dir` | string | Working directory (default: project root) |
| `sources` | array | File globs; task is skipped if sources unchanged |
| `outputs` | array | File globs for output artifacts |
| `shell` | string | Override the shell used (e.g., `powershell`, `bash`) |
| `hide` | bool | Hide from `mise run --list` |
| `raw` | bool | Stream output unbuffered (useful for interactive tasks) |

---

## Task Dependencies

Use `depends` to declare task prerequisites. Mise runs independent dependencies in parallel by default.

```toml
[tasks.build]
run = "dotnet build ./src/MyApp.sln"

[tasks.frontend]
run = "npm run build --prefix ./src/Frontend"

[tasks.test]
description = "Run all tests"
depends = ["build", "frontend"]   # runs build and frontend in parallel, then test
run = "dotnet test && npx playwright test"

[tasks.ci]
description = "Full CI pipeline"
depends = ["test", "lint"]
run = "echo CI complete"
```

### Sequential Dependencies

For dependencies that must run in order, use `depends_post` or chain with `&&` inside `run`:

```toml
[tasks.release]
depends = ["test"]           # test runs first
run = "cargo build --release && cargo publish"
```

---

## Running Tasks

```bash
# Run a task
mise run build
mise run test
mise run ci

# List all tasks with descriptions
mise run --list
mise tasks ls      # alias

# Pass arguments to a task
mise run deploy -- --env production --force

# Run multiple tasks sequentially
mise run lint test build

# Run with verbose output
mise run --verbose build

# Dry run (show what would execute without running)
mise run --dry-run build
```

---

## File-based Tasks

Tasks can also be defined as standalone script files in a `mise/tasks/` or `.mise/tasks/` directory. Mise discovers these automatically.

```
project/
├── mise.toml
└── mise/
    └── tasks/
        ├── build        # executable shell script
        ├── test.py      # Python script
        └── deploy.ts    # TypeScript script (requires deno or ts-node)
```

File tasks are made executable and run directly. The description is read from the first comment line of the file:

```bash
#!/usr/bin/env bash
# Builds the production Docker image
set -euo pipefail

docker build -t myapp:latest .
```

Use file tasks when:
- The task logic is complex (many lines)
- The task requires a specific language (Python, TypeScript)
- You want the task to be independently testable

---

## Skipping Unchanged Tasks (Source Tracking)

Mise can skip task execution if source files haven't changed since the last run. Similar to `make` file tracking.

```toml
[tasks.build]
sources = ["src/**/*.rs", "Cargo.toml"]
outputs = ["target/release/myapp"]
run = "cargo build --release"
```

Mise hashes the source files and only runs the task if they've changed.

---

## Environment Variables in Tasks

Tasks inherit all environment variables from `[env]` in `mise.toml`. You can also add task-scoped variables:

```toml
[tasks.test-integration]
env = { TEST_DB_URL = "postgres://localhost/test_db", LOG_LEVEL = "debug" }
run = "pytest tests/integration"
```

---

## Monorepo Task Support

For monorepos, mise supports running tasks across sub-projects. Requires `experimental = true` in settings.

```toml
# root mise.toml
[settings]
experimental = true
```

### Monorepo Task Globs

```bash
# Run 'build' task in a specific app
mise //apps/frontend:build

# Run 'test' task in all packages
mise //packages/*:test

# Run 'lint' everywhere
mise //...:lint
```

### Per-Package Task Definition

Each package has its own `mise.toml` with local task definitions:

```
monorepo/
├── mise.toml       # root config (shared tools, root tasks)
├── apps/
│   └── frontend/
│       └── mise.toml    # frontend-specific tasks
└── packages/
    └── ui/
        └── mise.toml    # UI library tasks
```

---

## Usage: Tab Completion for Task Arguments

Mise bundles the [Usage](https://usage.jdx.dev) library for declaring task argument schemas, enabling shell tab-completion.

```toml
[tasks.deploy]
description = "Deploy to an environment"
usage = '''
  flag "-f --force" help="Force deployment even if health checks fail"
  flag "--dry-run" help="Print what would happen without deploying"
  arg "<env>" choices="staging|production" help="Target environment"
'''
run = """
if [ "$usage_force" = "true" ]; then
  echo "Force deploying to $usage_env"
fi
./scripts/deploy.sh "$usage_env"
"""
```

Arguments are available as `$usage_<name>` variables in the run command. Flags become `$usage_force`, `$usage_dry_run`, etc.

Enable completions in shell:

```bash
# Add to shell profile
eval "$(mise completion zsh)"
# or
eval "$(mise completion bash)"
```

---

## Comparison with Alternatives

| Feature | mise tasks | Makefile | package.json scripts | just |
|---------|-----------|---------|---------------------|------|
| Environment variable sharing | Yes (from mise.toml) | No | No | Partial |
| Dependency graph | Yes | Yes | No | Yes |
| Parallel execution | Yes (automatic) | Manual | No | Manual |
| Cross-platform | Yes | Partial | Yes | Yes |
| Tab completion | Yes (via Usage) | No | No | Yes |
| Language runtimes | Automatic | No | Manual | No |
| Monorepo support | Yes | No | Partial | No |
