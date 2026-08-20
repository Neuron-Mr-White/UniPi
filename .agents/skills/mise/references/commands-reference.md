# Mise Commands Reference

Complete reference for all commonly-used mise commands.

---

## Tool Installation & Version Management

### mise use

Installs a tool and pins the version in the nearest `mise.toml`. The most common way to add or change a tool.

```bash
# Pin Node.js 22 in the current project's mise.toml
mise use node@22

# Pin multiple tools at once
mise use node@22 python@3.12 go@latest

# Pin globally (writes to ~/.config/mise/config.toml)
mise use --global node@lts

# Pin with a fuzzy version pattern
mise use node@22.x

# Install without modifying config (useful in CI)
mise use --no-config node@22
```

### mise install

Installs all tools defined in `mise.toml` (and any cascading config files) without modifying the config. Ideal for CI pipelines and initial project setup.

```bash
# Install everything declared in mise.toml
mise install

# Install a specific tool without pinning
mise install node@22

# Install all tools including those from parent configs
mise install --all
```

### mise exec (mise x)

Runs a command using a specific tool version without modifying any config.

```bash
# Run a command with a one-off tool version
mise x node@20 -- npm test
mise x python@3.11 -- pytest

# Shorthand
mise x node@20 -- node --version
```

### mise run

Executes tasks defined in `mise.toml`. See also `references/task-runner.md`.

```bash
mise run build
mise run test
mise run --list          # list all available tasks
```

---

## Listing and Inspecting Tools

### mise ls

Lists all active tools and their version status for the current directory.

```bash
mise ls                  # tools in scope for current directory
mise ls --current        # only active (installed and in-use) tools
mise ls --missing        # tools declared but not yet installed
mise ls --outdated       # tools where a newer version is available
```

Example output:
```
Tool       Version   Source             Requested
node       22.11.0   ~/project/mise.toml  22
python     3.12.7    ~/project/mise.toml  3.12
```

### mise outdated

Shows tools that have newer versions available.

```bash
mise outdated            # all tools
mise outdated node       # specific tool
```

### mise current

Prints the current active version of a tool — useful for quick checks.

```bash
mise current             # all tools
mise current node        # specific tool
```

### mise where

Prints the installation path for a tool.

```bash
mise where node          # /home/user/.local/share/mise/installs/node/22.11.0
```

---

## Upgrading and Cleanup

### mise upgrade

Upgrades tools to the latest version matching the pinned constraint.

```bash
mise upgrade             # upgrade all tools
mise upgrade node        # upgrade only node (respects version constraint in mise.toml)
mise upgrade --bump      # upgrade AND rewrite version constraints in mise.toml
```

### mise prune

Removes tool versions that are no longer referenced by any config file.

```bash
mise prune               # removes unused versions (interactive confirmation)
mise prune --dry-run     # preview what would be removed
mise prune node          # prune unused node versions only
```

---

## Environment Inspection

### mise env

Prints the environment variables mise would set for the current directory. Useful for debugging.

```bash
mise env                 # show all env vars as export statements
mise env --json          # JSON output  
mise env NODE_ENV        # show a specific variable
```

### mise doctor

Diagnoses shell integration issues, PATH conflicts, and configuration problems.

```bash
mise doctor              # comprehensive environment health check
```

Common issues reported:
- Shell not activated (missing `eval "$(mise activate zsh)"`)
- asdf or nvm shims appearing before mise shims in PATH
- Missing tool versions
- Invalid `mise.toml` syntax

---

## Configuration Inspection

### mise config

Shows the active configuration hierarchy for the current directory.

```bash
mise config              # list all config files in scope
mise config ls           # same as above
mise config get          # dump merged configuration
```

### mise settings

Reads and writes mise settings.

```bash
mise settings             # show all settings
mise settings get experimental  # read a setting
mise settings set experimental true  # write a setting
```

---

## Plugin Management

### mise plugins

Lists and manages tool backends/plugins.

```bash
mise plugins ls          # list installed plugins
mise plugins ls --all    # list all available plugins (from registry)
mise plugins install <name>  # install a plugin
mise plugins update      # update all plugins
mise plugins uninstall <name>
```

---

## Shim Management

Mise can operate in two modes: **PATH-based** (recommended, via shell activation) and **shim-based** (for environments where you cannot modify PATH).

```bash
mise reshim              # regenerate shims after manual changes
mise shims               # list all shim executables
```

---

## Useful One-liners

```bash
# Check which mise.toml is setting a particular tool
mise ls node --json | jq '.[].source'

# List all versions of a tool available to install
mise ls-remote node

# Install mise in CI without shell interaction
curl https://mise.run | MISE_INSTALL_PATH=/usr/local/bin sh

# Run a task with a specific environment
MISE_ENV=production mise run deploy

# Print what mise.toml would look like after 'use'
mise use --dry-run node@22
```

---

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | General error |
| `2` | Tool not found or not installed |
| `3` | Configuration error |

---

## Environment Variables for Scripting

Mise behaviour can be controlled via environment variables — useful in CI:

| Variable | Effect |
|----------|--------|
| `MISE_DATA_DIR` | Override the data directory (default: `~/.local/share/mise`) |
| `MISE_CONFIG_DIR` | Override the config directory (default: `~/.config/mise`) |
| `MISE_VERBOSE=1` | Enable verbose output |
| `MISE_DEBUG=1` | Enable debug output |
| `MISE_QUIET=1` | Suppress non-error output |
| `MISE_YES=1` | Auto-confirm all prompts |
| `MISE_NOT_FOUND_AUTO_INSTALL=false` | Disable auto-install on missing tool |
