---
title: "ntfy setup fails with ByteString error on em dash — Quick Fix"
type: quick-fix
date: 2026-04-29
---

# ntfy setup fails with ByteString error on em dash — Quick Fix

## Bug

When running the ntfy setup TUI (`/unipi:notify-settings` → ntfy setup), the connection
test failed with:

```
✗ Connection test failed
Cannot convert argument to a ByteString because the character at index 3 has a
value of 8212
```

Character 8212 is `—` (em dash, U+2014). The test title used by the setup flow is
`"Pi — Setup Test"`, with the em dash at index 3.

## Root Cause

`packages/notify/platforms/ntfy.ts` sent notifications via HTTP POST to
`<serverUrl>/<topic>`, passing the notification title through the `Title` HTTP
header:

```ts
const headers: Record<string, string> = {
  Title: title,
  Priority: String(...),
};
```

HTTP header values are required by the Fetch/URL specs to be ByteString
(Latin-1, code points 0–255). Node's/undici's `fetch` rejects any character
greater than 255, including common Unicode punctuation such as em dash,
en dash, smart quotes, and emoji. Any event title containing such characters
(the setup test is just one example) would fail before the request was sent.

## Fix

Switched the ntfy transport to ntfy's JSON publishing API (documented at
https://docs.ntfy.sh/publish/#publish-as-json). Instead of encoding the topic,
title, and priority into URL path + headers, we POST a JSON body to the server
root. JSON bodies are UTF-8 safe, so em dashes and any other Unicode pass
through correctly. The `Authorization` header (for tokens) remains the only
header and is always pure ASCII.

The public function signature (`sendNtfyNotification`) is unchanged, so all
three callers (`tui/ntfy-setup.ts`, `commands.ts`, `events.ts`) continue to
work without modification.

### Files Modified

- `packages/notify/platforms/ntfy.ts` — switched from header-based publishing
  (`POST /<topic>` with `Title`/`Priority` headers) to JSON-body publishing
  (`POST /` with `{topic,title,message,priority}` JSON body). Added a comment
  explaining the ByteString constraint.

## Verification

1. Reproduced the original error in a minimal repro:
   ```
   new Request('http://x/t', { headers: { Title: 'Pi — Setup Test' } })
   → Cannot convert argument to a ByteString ... value of 8212
   ```
2. Confirmed the new JSON-body path constructs a valid `Request` with the em
   dash preserved in the UTF-8 body:
   ```
   {"topic":"t","title":"Pi — Setup Test","message":"hi","priority":3}
   ```
3. `npx tsc --noEmit --skipLibCheck` passes with no errors.

## Notes

- This fix also incidentally hardens every other ntfy notification site
  (agent_end, workflow_end, the `/unipi:notify-test` command, etc.) against
  Unicode titles/messages, which previously would have failed the same way for
  any title containing smart quotes, em/en dashes, emoji, or non-Latin scripts.
- ntfy's JSON publishing supports the same features as the header-based API
  (title, priority, optional token auth), so no user-visible behavior changes
  beyond "it actually works now".
- If future features need ntfy-specific headers (e.g. `Tags`, `Click`,
  `Attach`), add them to the JSON body instead of HTTP headers.
