# @pi-unipi/trajectory

Live, localhost-only UniPi trajectory inspector for the current Pi session.

## Usage

```text
/unipi:trajectory             # open or reuse the server
/unipi:trajectory stop        # stop this session's server
/unipi:trajectory off         # alias of stop
/unipi:trajectory toggle      # open when stopped, stop when running
```

The command starts or reuses an in-process server on `127.0.0.1:8176-8186` and opens it in the default browser. The page follows the active session every 500 ms. The server is owned by the current Pi process and is stopped on any Pi session shutdown/reload/resume/new/fork event.

## What it shows

- Turn-aware User, Assistant, Tool, Compaction, and Branch ledger
- Assistant reasoning and final output
- Tool payloads, results, errors, and measured call duration
- Provider, model, stop reason, token usage, cache reads/writes, and cost
- Provider, model, thinking level, request payload/options, tool schemas, response status/headers
- Exact TTFT, decoding/total request timing, and tool execution timing
- Input/Model/Tools overview timeline with drag-to-focus
- Search, turn folding, call folding, and a local record inspector

## Privacy and model behavior

The server binds only to `127.0.0.1`. It reads `SessionManager.getBranch()` and never appends or changes session entries, prompts, provider requests, or model context. It therefore has no prefix-cache effect.

Detailed telemetry is appended to `~/.unipi/trajectory/<session-id>.jsonl` with a private directory/file mode. Authorization, API-key, token, cookie, secret, password, and credential fields and credential-shaped values are recursively redacted before persistence.

Detailed request fields appear when captured by the trajectory telemetry sidecar.

## Lifecycle

Each Pi process owns its own trajectory server. A second Pi process running `/unipi:trajectory` picks the next free localhost port in `8176-8186`; it never attaches to or controls another Pi process's server. When the owning Pi session exits, reloads, resumes another session, starts a new session, or forks, its server is closed.

## Limitations

- Live transport uses 500 ms polling rather than a push stream.
- Very large branches are rendered in one table; browser virtualization can be added if measured sessions require it.
- Tool duration uses exact executor telemetry when captured and session timestamps otherwise.
