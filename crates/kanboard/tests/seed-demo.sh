#!/usr/bin/env bash
# Seed a realistic demo board for UI screenshots.
#   UNIPI_KANBOARD_HOME=/tmp/kb-demo crates/kanboard/tests/seed-demo.sh [binary]
set -euo pipefail
KB="$(realpath "${1:-$(dirname "$0")/../target/debug/unipi-kanboard}")"
: "${UNIPI_KANBOARD_HOME:?set UNIPI_KANBOARD_HOME to a scratch dir}"
WS="$(mktemp -d /tmp/kb-demo-ws-XXXX)"
cd "$WS" && git init -q
kb() { "$KB" "$@"; }
id() { "$KB" "$@" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'; }

SLUG=$(kb project add --name "Atlas API" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["slug"])')
P=(--project "$SLUG")

A=$(id add "${P[@]}" "Rate-limit the public search endpoint" --status todo --priority high \
  --body "Token bucket per API key, 60 req/min default. Return **429** with \`Retry-After\`.")
B=$(id add "${P[@]}" "Document the rate-limit headers in the API reference" --status todo --priority low --after "$A" \
  --body "X-RateLimit-Limit / Remaining / Reset, with an example response.")
C=$(id add "${P[@]}" "Migrate session storage from Redis to Postgres" --status todo --priority urgent \
  --body "Redis eviction dropped sessions twice this week. Move to a sessions table with a TTL index.")
D=$(id add "${P[@]}" "Backfill existing sessions during the cutover window" --status todo --priority medium --after "$C" \
  --body "Dual-write for 24h, then read from Postgres only.")
E=$(id add "${P[@]}" "Add OpenTelemetry tracing to the worker pool" --status todo --priority medium \
  --body "Span per job, propagate trace id from the enqueueing request.")
F=$(id add "${P[@]}" "Flaky test: webhook retries exceed the 30s budget" --status todo --priority high \
  --body "Fails ~1 in 12 runs on CI. Likely the exponential backoff jitter.")
G=$(id add "${P[@]}" "Upgrade axum to 0.9 and fix the extractor changes" --priority medium \
  --body "Breaking: \`Path\` extractor order, \`State\` must be last.")
H=$(id add "${P[@]}" "Evaluate pgvector for semantic search" --priority low \
  --body "Benchmark recall@10 against the current BM25 index on 50k docs.")
I=$(id add "${P[@]}" "Dark-mode screenshots for the docs site" --priority none)
J=$(id add "${P[@]}" "Rotate the staging database credentials" --priority high \
  --body "Needs the vault admin token — ask infra.")
K=$(id add "${P[@]}" "Paginate the audit log endpoint" --status todo --priority medium \
  --body "Cursor-based, 100 per page, stable ordering by (created_at, id).")
L=$(id add "${P[@]}" "Remove the deprecated v1 upload route" --priority low)
M=$(id add "${P[@]}" "Set up canary deploys for the API" --status todo --priority medium)

kb edit "${P[@]}" "$A" --labels api,security >/dev/null
kb edit "${P[@]}" "$C" --labels infra,database >/dev/null
kb edit "${P[@]}" "$E" --labels observability >/dev/null
kb edit "${P[@]}" "$F" --labels ci,bug >/dev/null
kb edit "${P[@]}" "$G" --labels deps >/dev/null
kb edit "${P[@]}" "$J" --labels infra,security >/dev/null
kb edit "${P[@]}" "$K" --labels api >/dev/null

# Work the flow: claim-next picks by priority/order, so release whatever it claimed.
claim() { "$KB" claim-next "${P[@]}" --session "$1" --pid "$$" --host coffee --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["task"]["id"])'; }
X=$(claim s-7f2a); kb release "${P[@]}" "$X" --to in_review --comment "Sessions table + TTL index landed; dual-write behind SESSIONS_PG=1. Load test: p99 4ms." >/dev/null
X=$(claim s-81c0); kb release "${P[@]}" "$X" --to in_review --comment "Token bucket in middleware; 429 + Retry-After verified with hey (200 rps)." >/dev/null
kb move "${P[@]}" "$X" done >/dev/null 2>&1 || true
X=$(claim s-93de); kb release "${P[@]}" "$X" --to blocked --comment "The CI runner clock skews by ~8s. Needs infra to enable NTP on runners." >/dev/null
X=$(claim s-a41b); kb release "${P[@]}" "$X" --to in_review --comment "Cursor pagination done; added (created_at,id) index." >/dev/null
kb move "${P[@]}" "$L" cancelled >/dev/null 2>&1 || true
kb note "${P[@]}" "$E" "Prefer the OTLP/HTTP exporter; gRPC is blocked by the proxy." >/dev/null
# One live agent keeps its run block.
X=$(claim s-c55e); kb set-run "${P[@]}" "$X" --mode goal >/dev/null 2>&1 || true

# A second, smaller project so the sidebar lists more than one.
cd "$(mktemp -d /tmp/kb-demo-ws2-XXXX)" && git init -q
S2=$(kb project add --name "Mobile app" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["slug"])')
kb add --project "$S2" "Offline mode for the inbox" --status todo --priority high >/dev/null
kb add --project "$S2" "Push notification opt-in screen" --priority medium >/dev/null
kb add --project "$S2" "Crash on Android 12 when rotating the camera view" --status todo --priority urgent >/dev/null

echo "$SLUG"
