---
title: arch_cache_layer_ttl
tags: [architecture, cache, performance, storage]
project: unipi
created: 2026-04-27T00:00:00Z
updated: 2026-04-27T00:00:00Z
type: pattern
---

# Architecture: Cache Layer with Configurable TTL

Implement caching for external API calls with time-based expiration and manual invalidation.

## Pattern

```
~/.unipi/config/{extension}/cache/
└── {sha256_hash}.json    # Cache entries as individual files
```

## Key Design

### Cache Entry Structure
```typescript
interface CacheEntry {
  key: string;        // SHA-256 of provider:identifier
  data: unknown;      // Cached response
  timestamp: number;  // When cached
  ttlMs: number;      // Time-to-live
  provider: string;   // Which provider produced this
  url: string;        // Original URL/identifier
}
```

### Key Generation
```typescript
function generateKey(identifier: string, provider: string): string {
  const content = `${provider}:${identifier}`;
  return crypto.createHash("sha256").update(content).digest("hex");
}
```

### Cache Operations
- `get(identifier, provider)` → Returns data or null if expired/missing
- `set(identifier, provider, data, ttlMs?)` → Stores with TTL
- `clear()` → Manual invalidation, returns count cleared
- `clearExpired()` → Cleanup on startup
- `getStats()` → Entry count, size, expired count

### TTL Configuration
```json
{
  "cache": {
    "enabled": true,
    "ttlMs": 3600000
  }
}
```

## Benefits
- Reduces API calls for repeated requests
- Configurable TTL based on data freshness needs
- Manual clear command for troubleshooting
- File-based (no external dependencies)
- SHA-256 keys prevent collisions

## Use When
- Extension calls external APIs
- Responses are cacheable (not real-time)
- Want to reduce costs/rate limit hits
- Need manual cache invalidation option
