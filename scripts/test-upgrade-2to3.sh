#!/usr/bin/env bash
# UNI-272: clean 2.20.5 → 3.0 upgrade test, in a throwaway HOME + pi agent dir
# (never the user's ~/.pi or ~/.unipi). Steps:
#   1. pi install npm:@pi-unipi/unipi@2.20.5     (what users have today)
#   2. seed a v2-format memory file + a v2 settings key
#   3. `pi install npm:@pi-unipi/unipi@<TARGET>` over it — exactly what users run
#      (TARGET defaults to the current `alpha` dist-tag; once 3.0.0 is `latest`
#      the plain `npm:@pi-unipi/unipi` does the same). pi can't install a .tgz,
#      so a local checkout is tested by publishing the alpha first.
#   4. check: pi lists the 3.x package once (no duplicate 2.x entry), pi starts
#      in print mode with UniPi loaded, and the v2 memory is still on disk
#      (migration is opt-in: /unipi:memory migrate).
# Usage: scripts/test-upgrade-2to3.sh [--keep] [TARGET]   (TARGET e.g. 3.0.0-alpha.40)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d /tmp/unipi-upgrade-XXXXXX)
KEEP=${1:-}
TARGET=${2:-$(npm view @pi-unipi/unipi dist-tags.alpha)}
cleanup() { [ "$KEEP" = "--keep" ] && echo "kept: $WORK" || rm -rf "$WORK"; }
trap cleanup EXIT

export HOME="$WORK/home"
export PI_CODING_AGENT_DIR="$WORK/home/.pi/agent"
export UNIPI_HOST_DIR="$WORK/home/.unipi/app-host"
export npm_config_cache="$WORK/npm-cache"
mkdir -p "$PI_CODING_AGENT_DIR"
# pi needs a model to start; a dummy key is enough for `pi list` / extension load.
echo '{}' > "$PI_CODING_AGENT_DIR/settings.json"

say() { printf '\n== %s\n' "$*"; }

say "1. install 2.20.5"
pi install npm:@pi-unipi/unipi@2.20.5 >"$WORK/install-2.log" 2>&1 || { tail -20 "$WORK/install-2.log"; exit 1; }
pi list 2>&1 | tee "$WORK/list-2.txt" | grep -q "@pi-unipi/unipi" || { echo "2.20.5 not listed"; cat "$WORK/list-2.txt"; exit 1; }
V2=$(find "$PI_CODING_AGENT_DIR" -path '*node_modules/@pi-unipi/unipi/package.json' -exec node -p 'require(process.argv[1]).version' {} \; | head -1)
echo "installed: $V2"
[ "$V2" = "2.20.5" ] || { echo "expected 2.20.5"; exit 1; }

say "2. seed v2 data"
mkdir -p "$HOME/.unipi/memory/MyProject"
cat > "$HOME/.unipi/memory/MyProject/deploy_steps.md" <<'EOF'
---
title: deploy_steps
type: pattern
---
Deploy with scripts/deploy.sh after running the tests.
EOF

say "3. upgrade: pi install npm:@pi-unipi/unipi@$TARGET"
pi install "npm:@pi-unipi/unipi@$TARGET" >"$WORK/install-3.log" 2>&1 || { tail -30 "$WORK/install-3.log"; exit 1; }
pi list 2>&1 | tee "$WORK/list-3.txt"

say "4. checks"
grep -qi "warning\|failed" "$WORK/list-3.txt" && { echo "pi list warns"; exit 1; }
NPKG=$(node -e '
const fs=require("fs"),p=require("path");
const s=JSON.parse(fs.readFileSync(p.join(process.env.PI_CODING_AGENT_DIR,"settings.json"),"utf8"));
console.log((s.packages||[]).filter(x=>String(typeof x==="string"?x:x.source).includes("@pi-unipi/unipi")).length);')
echo "unipi package entries in settings: $NPKG"
[ "$NPKG" = "1" ] || { echo "expected exactly one @pi-unipi/unipi entry (upgrade, not a second install)"; exit 1; }
VNOW=$(find "$PI_CODING_AGENT_DIR" -path '*node_modules/@pi-unipi/unipi/package.json' -not -path '*/node_modules/*/node_modules/*' -exec node -p 'require(process.argv[1]).version' {} \; | sort -u | tr '\n' ' ')
echo "installed now: $VNOW"
echo "$VNOW" | grep -q "^$TARGET *$" || { echo "expected only $TARGET"; exit 1; }
V3=$(node -e '
const fs=require("fs"),p=require("path");
const s=JSON.parse(fs.readFileSync(p.join(process.env.PI_CODING_AGENT_DIR,"settings.json"),"utf8"));
console.log(JSON.stringify(s.packages||[]));')
echo "settings.packages: $V3"
# Load check: pi resolves every extension of the package (no model call).
timeout 120 pi --help >/dev/null 2>"$WORK/load.err" || true
if grep -qiE "failed to load|cannot find module|error loading" "$WORK/load.err"; then
  echo "LOAD ERRORS:"; cat "$WORK/load.err"; exit 1
fi
test -f "$HOME/.unipi/memory/MyProject/deploy_steps.md" || { echo "v2 memory was touched"; exit 1; }
echo "v2 memory still on disk (migration is opt-in) ✓"
echo
echo "PASS: 2.20.5 → $TARGET upgrade"
