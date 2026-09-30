#!/bin/bash
# UNI-11 live confirmation — real pi session on coffee in ~/skill-eval-mock.
# --approve: the mock project is untrusted, headless -p can't show the trust
# prompt, and project .agents/skills (the eval catalog) need trust.
# No --no-skills: the registry judges pi's discovered catalog (skill dirs on).
# Warm-up freezes the set; the uni11-real prompt exercises the later-prompt
# reveal rule. Prints the session file and the raw revealed entry.
set -e
export PATH=$HOME/.local/share/mise/installs/node/lts/bin:$PATH
SID="5e1a1e11-1111-4a11-b111-uni11eval03"
PI="pi --approve --no-extensions -e $HOME/Projects/Personal/archived/unipi/packages/unipi/index.ts"
cd ~/skill-eval-mock
echo "=== turn 1 (warm-up, freezes the catalog) ==="
$PI --session-id "$SID" -n uni11-eval -p "hi, look at src and tell me what it does"
SESS=$(ls -t ~/.pi/agent/sessions/--home-coffee-skill-eval-mock--/*"$SID"*.jsonl | head -1)
echo "=== turn 2 (uni11-real, resume $SESS) ==="
$PI --session "$SESS" -p "$(cat ~/uni11-live/prompt.txt)"
echo "=== session file ==="
echo "$SESS"
echo "=== revealed entry ==="
grep "skills-revealed" "$SESS" || echo "NO skills-revealed entry"
echo "=== judged entry ==="
grep -o '"customType":"unipi:skills-judged".*' "$SESS" | head -c 400 || true
