# Mise Environment Variables and Secrets

Mise replaces `direnv` for automatic environment variable management. Variables defined in `[env]` in `mise.toml` are loaded when you enter the directory and unloaded (restored) when you leave.

---

## The [env] Section

### Static Values

```toml
[env]
NODE_ENV = "development"
APP_PORT = "8080"
ASPNETCORE_ENVIRONMENT = "Development"
AZURE_TENANT_ID = "00000000-0000-0000-0000-000000000000"
```

### PATH Management

Mise provides special `_.path` to extend PATH without overwriting it:

```toml
[env]
# Prepend directories to PATH (array)
_.path = ["./bin", "./node_modules/.bin", "./scripts"]

# Single directory (string shorthand)
_.path = "./bin"
```

The paths are relative to the `mise.toml` file's directory. Mise prepends them when entering the directory and removes them when leaving.

---

## Loading .env Files

### Plain .env Files

```toml
[env]
# Load a .env file alongside static values
_.file = ".env"

# Load multiple files (merged, later files win on conflict)
_.file = [".env", ".env.local"]
```

### Encrypted .env Files (SOPS)

```toml
[env]
# Decrypt and load on entry
_.file = { path = "secrets.enc.json", decrypt = true }
```

See the SOPS section below for setup.

### File Format Support

Mise `_.file` supports:
- `.env` (KEY=VALUE pairs)
- `.json` (flat key-value object)
- `.yaml` / `.yml`
- `.toml`

---

## Tera Templating

Mise uses [Tera](https://tera.netlify.app) templating for dynamic env values. Templates are evaluated at directory entry.

### Available Variables

| Template Variable | Description |
|-------------------|-------------|
| `{{ env.HOME }}` | Value of a current environment variable |
| `{{ cwd }}` | Current working directory (full path) |
| `{{ cwd \| basename }}` | Last component of cwd |
| `{{ config_root }}` | Directory containing the `mise.toml` file |

### Examples

```toml
[env]
# Derive app name from directory name
APP_NAME = "{{ cwd | basename }}"

# Build a connection string from existing env vars
DB_HOST = "{{ env.DB_HOST | default(value='localhost') }}"
CONNECTION_STRING = "Server={{ env.DB_HOST }};Database={{ env.APP_NAME }};Integrated Security=True"

# Reference an absolute path relative to the project root
ASSETS_DIR = "{{ config_root }}/assets"
```

---

## Secrets with SOPS

[Mozilla SOPS](https://github.com/mozilla/sops) encrypts secrets files at rest. Mise can decrypt them on the fly when loading environment variables, without storing secrets in plaintext.

### Setup

```bash
# 1. Install SOPS
mise use --global sops

# 2. Install age (lightweight encryption key tool)
mise use --global age

# 3. Generate an age key pair
age-keygen -o ~/.config/sops/age/keys.txt
# Note the public key output (starts with age1...)

# 4. Configure SOPS to use your age key (~/.sops.yaml or project .sops.yaml)
cat > .sops.yaml << EOF
creation_rules:
  - path_regex: secrets.enc.*
    age: age1YOURPUBLICKEYHERE
EOF
```

### Encrypting Secrets

```bash
# Create a JSON secrets file
cat > secrets.json << EOF
{
  "DATABASE_URL": "postgres://user:password@host/db",
  "API_KEY": "sk-supersecret"
}
EOF

# Encrypt it with SOPS
sops --encrypt --input-type json --output-type json secrets.json > secrets.enc.json

# Delete the plaintext file
rm secrets.json
```

### Loading SOPS Secrets in mise.toml

```toml
[env]
# Mise decrypts on directory entry, sets vars, re-encrypts on leave
_.file = { path = "secrets.enc.json", decrypt = true }
```

The SOPS private key must be available (via `keys.txt` or a cloud KMS) for decryption to work.

### Checking What's Loaded

```bash
mise env --json | jq 'keys'   # list all env vars mise would set
```

---

## fnox: Remote Secrets

**fnox** (Fort Knox) is a companion CLI tool for fetching secrets from remote providers (AWS Secrets Manager, Azure Key Vault, 1Password, HashiCorp Vault). It addresses a key limitation: mise's fast caching prevents it from making network calls for secrets without breaking prompt speed.

### How fnox Works

fnox acts as a wrapper that fetches remote secrets and injects them before running your command:

```bash
# Fetch secrets from AWS and inject them into npm start
mise exec -- fnox exec -- npm start

# Or integrate with mise tasks:
```

```toml
[tasks.start]
run = "fnox exec -- node server.js"
```

### fnox Configuration

```yaml
# fnox.yaml
providers:
  - type: aws_secrets_manager
    region: eu-west-1
    secrets:
      - id: myapp/production/database
        env:
          DATABASE_URL: .password
  - type: azure_key_vault
    vault_url: https://myvault.vault.azure.net
    secrets:
      - name: api-key
        env: API_KEY
```

### Installation

```bash
mise use --global fnox
```

---

## Environment Scoping

Mise env vars are scoped to the directory and its subdirectories. When you `cd` out, variables are removed.

### Verification

```bash
# See what would be set in current directory
mise env

# Verbose: see which config file sets each variable
mise env --verbose

# JSON output for scripting
mise env --json
```

---

## mise.local.toml for Personal Secrets

For per-developer secrets that shouldn't be committed:

```toml
# mise.local.toml  (add to .gitignore)
[env]
# Personal database override
DATABASE_URL = "postgres://localhost/myapp_mark_dev"

# Load a local .env file not tracked in git
_.file = ".env.mark"
```

Never commit `mise.local.toml`. Add it to `.gitignore`:

```
mise.local.toml
.env.local
.env.mark
```

---

## Common Patterns

### .NET Project

```toml
[env]
ASPNETCORE_ENVIRONMENT = "Development"
ASPNETCORE_URLS = "https://localhost:5001;http://localhost:5000"
_.file = ".env.development"
```

### Node.js Project

```toml
[env]
NODE_ENV = "development"
PORT = "3000"
_.path = ["./node_modules/.bin"]
_.file = ".env.local"
```

### Python Project

```toml
[env]
PYTHONDONTWRITEBYTECODE = "1"
PYTHONUNBUFFERED = "1"
DJANGO_SETTINGS_MODULE = "myapp.settings.local"
_.path = ["./.venv/bin"]
```

### Monorepo Root Config

```toml
# Root mise.toml — shared across all services
[env]
ENVIRONMENT = "development"
LOG_LEVEL = "debug"
_.file = ".env.shared"

# Each service's mise.toml adds service-specific vars
# without overriding the root
```
