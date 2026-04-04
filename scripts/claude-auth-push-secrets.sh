#!/usr/bin/env bash
# Push the 1-year Claude OAuth access token from ~/.pi/team/auth/anthropic.json
# into the pi-team repo as the `CLAUDE_CODE_OAUTH_TOKEN` GitHub Actions secret.
#
# The token is long-lived (365 days) and scoped to `user:inference`, so no
# refresh logic is needed in CI. The `anthropics/claude-code-action@v1`
# workflow reads it directly from env and passes it through to the bundled
# Claude Code CLI — which handles all the billing headers, cch signing, and
# system-prompt identity injection internally.
#
# Rotate annually with:
#   python3 scripts/claude-auth-login.py        # step 1
#   python3 scripts/claude-auth-login.py --code '...'   # step 2
#   bash    scripts/claude-auth-push-secrets.sh # push

set -euo pipefail

REPO="${PITEAM_REPO:-minzique/pi-team}"
TOKEN_PATH="$HOME/.pi/team/auth/anthropic.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "$TOKEN_PATH" ]; then
  echo "error: no tokens at $TOKEN_PATH" >&2
  echo "run:    python3 $SCRIPT_DIR/claude-auth-login.py" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI not found" >&2
  exit 1
fi

# Require a long-lived token — bail loudly if someone ran this on a short-lived one
LONG_LIVED=$(python3 -c "import json; print(json.load(open('$TOKEN_PATH'))['long_lived'])")
if [ "$LONG_LIVED" != "True" ]; then
  echo "error: stored token is NOT long-lived; refusing to push a short-lived token" >&2
  echo "       run claude-auth-login.py to regenerate with expires_in=31536000" >&2
  exit 1
fi

ACCESS_TOKEN=$(python3 "$SCRIPT_DIR/claude-auth-login.py" --print-access-token)
if [ -z "$ACCESS_TOKEN" ]; then
  echo "error: failed to read access token from $TOKEN_PATH" >&2
  exit 1
fi

EXPIRES_DAYS=$(python3 -c "
import json, time
d = json.load(open('$TOKEN_PATH'))
remaining = (d['expires'] - int(time.time())) // 86400
print(remaining)
")

echo "Pushing long-lived access token to $REPO as CLAUDE_CODE_OAUTH_TOKEN..."
echo "  (expires in ~$EXPIRES_DAYS days)"
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo "$REPO" --body "$ACCESS_TOKEN"
echo "✓ CLAUDE_CODE_OAUTH_TOKEN set on $REPO"
echo
echo "Test it by opening a PR — .github/workflows/claude-review.yml will run."
