# Mise Core Concepts

## What is Mise?

Mise (mise-en-place) is a single Rust-based binary that replaces a collection of separate tools:

| Replaced Tool | Mise Equivalent |
|---------------|----------------|
| `asdf` | Tool version management |
| `nvm`, `pyenv`, `rbenv` | Language-specific version managers |
| `direnv` | Automatic environment variable loading |
| `make` / `package.json scripts` | Task runner |
| `fnm`, `volta` | Node.js version management |

It activates automatically when you enter a directory containing a `mise.toml` file, setting the correct tool versions and environment variables without any manual steps.

---

## Installation

### Linux / macOS

```bash
# Recommended: installer script
curl https://mise.run | sh

# macOS via Homebrew
brew install mise

# Cargo
cargo install mise
```

### Windows

```powershell
# winget (recommended)
winget install jdx.mise

# Scoop
scoop install mise
```

### Verify installation

```bash
mise --version
mise doctor   # checks shell integration, PATH, shims
```

---

## Shell Activation

Mise must be hooked into your shell to auto-activate when entering directories. Add the appropriate line to your shell profile:

| Shell | Profile File | Activation Command |
|-------|-------------|-------------------|
| zsh | `~/.zshrc` | `eval "$(mise activate zsh)"` |
| bash | `~/.bashrc` or `~/.bash_profile` | `eval "$(mise activate bash)"` |
| fish | `~/.config/fish/config.fish` | `mise activate fish \| source` |
| PowerShell | `$PROFILE` | `mise activate pwsh \| Out-String \| Invoke-Expression` |

After editing your profile, restart your terminal or run `source ~/.zshrc` (etc.).

**Testing activation:**

```bash
cd /tmp && mise ls        # should show no tools
cd /your/project && mise ls  # should show project tools
```

---

## Configuration File: mise.toml

`mise.toml` is the primary configuration file for mise. It supports a hierarchical cascade:

| Location | Scope | Notes |
|----------|-------|-------|
| `/etc/mise/config.toml` | System-wide | Managed by sysadmin |
| `~/.config/mise/config.toml` | Global user | Applies everywhere for this user |
| `~/<parent-dir>/mise.toml` | Parent directory | Inherited by subdirectories |
| `./mise.toml` | Project | Committed to source control |
| `./mise.local.toml` | Personal override | Git-ignored; personal paths and secrets |

**Cascade resolution:** mise merges all applicable configs, with more specific files taking priority. If two files define `node`, the project-level version wins over the global one.

### File Format

```toml
# mise.toml

[tools]
# pin exact versions
node = "22.11.0"
# use a major-version constraint
python = "3.12"
# use a named alias
go = "latest"
# install multiple versions
ruby = ["3.2", "3.3"]
# pin with options
java = { version = "21", jdk_id = "temurin" }

[env]
# static values
ASPNETCORE_ENVIRONMENT = "Development"
APP_PORT = "8080"

# add directory to PATH
_.path = ["./bin", "./node_modules/.bin"]

# load a .env file
_.file = ".env"

# computed from environment
HOME_DIR = "{{ env.HOME }}"
APP_NAME = "{{ cwd | basename }}"

[settings]
# opt-in to experimental features
experimental = true
```

### mise.local.toml

Personal overrides that should never be committed:

```toml
# mise.local.toml  (add this file to .gitignore)
[env]
DATABASE_URL = "postgres://localhost/mydb_dev"
_.file = ".env.local"
```

---

## Legacy File Compatibility

Mise automatically reads legacy configuration files — no manual migration required:

| Legacy File | Handled by | Notes |
|-------------|-----------|-------|
| `.tool-versions` | asdf compatibility plugin | Exact asdf format |
| `.nvmrc` | Node.js backend | `lts/iron`, `v22.0.0`, `22` all valid |
| `.node-version` | Node.js backend | Same as .nvmrc |
| `.python-version` | Python backend | `3.12`, `3.12.5` |
| `.ruby-version` | Ruby backend | `3.2.0` |

To disable legacy file reading:

```toml
# ~/.config/mise/config.toml
[settings]
legacy_version_file = false
```

---

## Migrating from asdf

Mise is a drop-in replacement for asdf. Migration steps:

1. Install mise and activate in shell
2. Existing `.tool-versions` files continue to work without changes
3. Run `mise install` in any project to install the tools declared in `.tool-versions`
4. Gradually migrate projects to `mise.toml` to gain env var and task features
5. Remove asdf from shell profile to avoid PATH conflicts

```bash
# Uninstall asdf (after confirming mise works)
rm -rf ~/.asdf
# Remove asdf lines from ~/.zshrc (or equivalent)
```

**Key differences from asdf:**
- Mise is significantly faster (Rust vs shell)
- `mise.toml` is more expressive than `.tool-versions`
- Mise includes env vars and task runner — asdf does not
- Mise plugins use Lua instead of bash

---

## Migrating from nvm

1. Activate mise in shell profile
2. Mise reads `.nvmrc` automatically
3. Run `mise install` to install the Node version from `.nvmrc`
4. Remove nvm activation from shell profile: delete or comment the `export NVM_DIR` block
5. Optionally remove `~/.nvm` to reclaim disk space

```bash
# After confirming mise manages Node correctly:
rm -rf ~/.nvm
```

---

## Migrating from direnv

Mise's `[env]` section replaces `.envrc` files, but the syntax differs:

| direnv (.envrc) | mise.toml equivalent |
|-----------------|---------------------|
| `export FOO=bar` | `FOO = "bar"` under `[env]` |
| `PATH_add bin` | `_.path = ["./bin"]` under `[env]` |
| `dotenv .env` | `_.file = ".env"` under `[env]` |
| `source_env ../.envrc` | Handled automatically via config hierarchy |

If you need both mise and direnv simultaneously, mise has a `direnv` integration mode. See the official docs.

---

## Global Tools

Global tools are installed via the global config at `~/.config/mise/config.toml`:

```bash
# Install a tool globally
mise use --global node@lts
mise use --global ripgrep cargo:ripgrep

# Or edit ~/.config/mise/config.toml directly:
[tools]
node = "lts"
ripgrep = "latest"
```

**Best practice:** Use global config for CLI utilities (ripgrep, bat, gh, jq); always define runtimes (node, python, dotnet) at the project level for reproducibility.

---

## mise doctor

Run `mise doctor` whenever something seems wrong. It checks:

- Shell integration: is mise properly hooked into the shell?
- Shims: are mise shims on PATH before system versions?
- Config files: are all active mise.toml files valid?
- Tool conflicts: are shadowed tools from asdf/nvm causing conflicts?
- Active tools: dumps the current effective tool versions

```bash
mise doctor
# Example output:
# [WARN] ~/.asdf/shims is earlier in PATH than mise shims
# [OK] mise shim dir: ~/.local/share/mise/shims
# [OK] mise config: /home/user/project/mise.toml
```
