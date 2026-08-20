# Mise Backends

Backends are the mechanisms mise uses to fetch and install tools. Choosing the right backend determines where a tool comes from, how it's installed, and how it's updated.

---

## Backend Overview

| Backend | Prefix | Source | Best For |
|---------|--------|--------|----------|
| **Core** | (none) | Built-in Rust implementation | Node, Python, Go, Java, Ruby, Rust |
| **UBI** | `ubi:` | GitHub Releases (binary download) | Any tool with GitHub releases |
| **Cargo** | `cargo:` | crates.io | Rust CLI tools |
| **npm** | `npm:` | npm registry | Node.js CLI tools |
| **Pipx** | `pipx:` | PyPI | Python CLI tools |
| **Aqua** | `aqua:` | Aqua registry | Security-audited CLI tools |
| **Lua plugins** | (custom) | Custom Lua scripts | Custom/private tools |
| **asdf plugins** | `asdf:` | asdf plugin registry | Legacy compatibility |

---

## Core Backends

Core backends are built directly into mise as Rust code. They are the fastest and most reliable option because they don't require external plugin scripts.

### Supported Core Tools

| Tool | mise name | Notes |
|------|-----------|-------|
| Node.js | `node` | Reads `.nvmrc`, supports `lts`, `lts/iron` aliases |
| Python | `python` | Reads `.python-version` |
| Go | `go` | |
| Java | `java` | Supports Temurin, Corretto, Zulu distributions |
| Ruby | `ruby` | |
| Rust | `rust` | Manages toolchains via rustup |
| .NET | `dotnet` | |
| Erlang | `erlang` | |
| Elixir | `elixir` | |
| Deno | `deno` | |
| Bun | `bun` | |

```toml
[tools]
node = "22"
python = "3.12"
go = "1.23"
java = { version = "21", jdk_id = "temurin" }
dotnet = "8.0"
```

---

## UBI (Universal Binary Installer)

UBI downloads pre-compiled binaries from GitHub Releases. Use it for any tool that publishes release artifacts to GitHub.

### Syntax

```toml
[tools]
# Basic: owner/repo (mise infers binary name from repo)
"ubi:cli/cli" = "latest"           # GitHub CLI (gh)
"ubi:BurntSushi/ripgrep" = "latest"  # ripgrep
"ubi:sharkdp/bat" = "latest"       # bat

# With explicit binary name (when it differs from repo name)
"ubi:cli/cli[exe:gh]" = "latest"
```

### Command line

```bash
mise use ubi:BurntSushi/ripgrep
```

### When to use UBI

- The tool publishes GitHub release assets (`.tar.gz`, `.zip`, platform-specific binaries)
- You want to pin to exact GitHub release tags
- The tool isn't in Aqua registry or other backends

---

## Cargo Backend

Installs Rust CLI tools from crates.io using `cargo install`. Requires Rust/Cargo to be available.

```toml
[tools]
"cargo:ripgrep" = "latest"
"cargo:tokei" = "latest"
"cargo:cargo-watch" = "latest"
```

```bash
mise use cargo:cargo-watch
```

**Note:** Cargo installs compile from source, which is slower than binary backends. Prefer UBI or Aqua if a pre-compiled binary is available.

---

## npm Backend

Installs Node.js packages as global CLI tools via npm.

```toml
[tools]
"npm:typescript" = "latest"
"npm:@angular/cli" = "latest"
"npm:azure-functions-core-tools" = "4"
"npm:prettier" = "3"
```

```bash
mise use npm:typescript
```

**Best practice:** For project-local tools, prefer committing them to `package.json` devDependencies. Use the npm backend for tools that need to be available globally across projects.

---

## Pipx Backend

Installs Python applications in isolated virtualenvs via pipx. Requires Python to be available.

```toml
[tools]
"pipx:black" = "latest"
"pipx:ruff" = "latest"
"pipx:poetry" = "latest"
```

```bash
mise use pipx:black
```

---

## Aqua Backend

Aqua is a registry-based CLI tool manager with security focus. It provides a curated list of tools with checksums and signature verification.

```toml
[tools]
"aqua:cli/cli" = "latest"             # GitHub CLI
"aqua:hashicorp/terraform" = "latest"
"aqua:helm/helm" = "latest"
"aqua:kubernetes/kubectl" = "latest"
```

```bash
mise use aqua:hashicorp/terraform
```

**Advantages of Aqua over UBI:**
- Pre-verified checksums and signatures
- Curated registry with consistent naming
- Reproducible installs

Browse the registry: [aquaproj/aqua-registry](https://github.com/aquaproj/aqua-registry)

---

## Choosing the Right Backend

Decision guide for common scenarios:

| Scenario | Recommended Backend |
|----------|-------------------|
| Language runtime (Node, Python, Go, .NET) | Core |
| Rust CLI tool | Aqua if listed, otherwise Cargo |
| Security-critical tool (Terraform, kubectl) | Aqua (verified checksums) |
| GitHub-released binary not in Aqua | UBI |
| Node.js global CLI tool | npm |
| Python application | Pipx |
| Company-internal tool | Lua plugin |
| Legacy asdf plugin exists | asdf (with migration plan to Lua) |

---

## Lua Plugin Architecture

When no built-in or community backend fits, write a custom Lua 5.1 plugin. Plugins are stored in `~/.local/share/mise/plugins/<name>/`.

### Plugin Directory Structure

```
~/.local/share/mise/plugins/my-tool/
└── mise.lua    # Main plugin file
```

### Plugin Lifecycle Hooks

| Hook | Purpose | Required |
|------|---------|----------|
| `Available` | Returns list of installable versions | Yes |
| `PreInstall` | Returns download URL and SHA256 checksum | Yes |
| `EnvKeys` | Sets environment variables and PATH entries | Yes |
| `PostInstall` | Runs after download (chmod, compile, etc.) | No |
| `ParseLegacyFile` | Parses legacy version files (.nvmrc, etc.) | No |

### Example Plugin

```lua
-- mise.lua for a hypothetical "mytool"

local PLUGIN = {}

function PLUGIN:Available(ctx)
  -- Return a list of available version strings
  return { "1.0.0", "1.1.0", "2.0.0" }
end

function PLUGIN:PreInstall(ctx)
  local version = ctx.version
  local os = ctx.os       -- "linux", "macos", "windows"
  local arch = ctx.arch   -- "x64", "arm64"
  return {
    url = "https://example.com/mytool-" .. version .. "-" .. os .. "-" .. arch .. ".tar.gz",
    sha256 = "abc123..."  -- optional but recommended
  }
end

function PLUGIN:EnvKeys(ctx)
  return {
    { key = "MYTOOL_HOME", value = ctx.path },
    { key = "PATH", value = ctx.path .. "/bin" }
  }
end

function PLUGIN:PostInstall(ctx)
  -- Make binaries executable
  os.execute("chmod +x " .. ctx.path .. "/bin/mytool")
end

return PLUGIN
```

### Installing a Custom Plugin

```bash
# From a local path
mise plugins install my-tool ~/.local/share/mise/plugins/my-tool

# From a git repo
mise plugins install my-tool https://github.com/you/mise-tool-plugin.git
```

---

## asdf Plugin Compatibility

Mise can use existing asdf plugins as a compatibility layer:

```toml
[tools]
"asdf:hashicorp/terraform" = "latest"
```

```bash
# Or install asdf plugins directly
mise plugins install terraform https://github.com/asdf-community/asdf-hashicorp.git
mise use terraform@latest
```

**Note:** asdf plugins run as bash scripts via process spawning and are significantly slower than Lua plugins. Migrate to Lua or Core/UBI/Aqua backends when performance matters.
