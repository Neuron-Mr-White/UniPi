---
title: arch_settings_split_auth_config
tags: [architecture, settings, security, config]
project: unipi
created: 2026-04-27T00:00:00Z
updated: 2026-04-27T00:00:00Z
type: pattern
---

# Architecture: Split Settings into Auth + Config

When extensions need both sensitive credentials and non-sensitive configuration, split into two files.

## Pattern

```
~/.unipi/config/{extension}/
├── auth.json    # API keys, tokens (gitignored, never commit)
└── config.json  # Provider settings, toggles (safe to commit)
```

## Key Design

### auth.json (Sensitive)
```json
{
  "serpapi": "sk-...",
  "tavily": "tvly-...",
  "perplexity": "pplx-..."
}
```
- Simple key-value: provider ID → API key
- Gitignored by default
- Never log or expose in UI

### config.json (Non-sensitive)
```json
{
  "providers": {
    "serpapi": { "enabled": true },
    "duckduckgo": { "enabled": true }
  },
  "cache": {
    "enabled": true,
    "ttlMs": 3600000
  }
}
```
- Provider enable/disable toggles
- Feature flags and settings
- Safe to commit and share

## Implementation Pattern
```typescript
function getConfigDir(): string {
  return path.join(os.homedir(), ".unipi", "config", extensionName);
}

function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
```

## Benefits
- Clear separation of concerns
- Auth can be gitignored without losing config
- Config can be shared/committed
- Easier security review

## Use When
- Extension uses API keys or tokens
- Some settings are safe to share, others aren't
- Want to support both env vars and stored keys
