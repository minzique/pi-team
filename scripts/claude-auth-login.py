#!/usr/bin/env python3
"""
Non-interactive Claude long-lived OAuth token helper for pi-team.

Generates a 1-year OAuth access token by modifying the standard PKCE flow:
- scope = "user:inference" only (full scope set rejects custom expires_in)
- expires_in = 31536000 in the token exchange POST body
- endpoint = claude.ai/v1/oauth/token

This produces a `sk-ant-oat01-...` token valid for 365 days with no refresh
needed — the same format `claude setup-token` and `/install-github-app`
generate. The `anthropics/claude-code-action@v1` GitHub Action accepts it
directly as `CLAUDE_CODE_OAUTH_TOKEN`.

Research basis: minzique/claude-code-re notes/oauth-long-lived-tokens.md
(RE of Claude Code v2.1.81 modules 4047/4048/4049 — the /install-github-app
command flow, which calls startOAuthFlow({inferenceOnly: true, expiresIn:
31536000})). stdlib-only — no external deps beyond Python 3.10.

Two-step flow (no TTY/browser needed on this machine):

  Step 1 (no args):
    python3 scripts/claude-auth-login.py

    Prints the OAuth URL to visit + writes a throwaway PKCE verifier to
    ~/.pi/team/auth/anthropic.verifier. Fully isolated from pi's own auth.

  Step 2 (after visiting URL, copying the code from the callback page):
    python3 scripts/claude-auth-login.py --code "<paste-code-here>"

    Reads the verifier, exchanges the code for a 1-year token, writes it
    to ~/.pi/team/auth/anthropic.json.

Important: never touch pi's ~/.pi/agent/auth.json — refresh tokens rotate
on use and sharing breaks both processes. Every consumer gets its own flow.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# Inlined OAuth constants. We deliberately do NOT depend on the upstream
# claude-code-oauth Python library because its defaults target the
# short-lived personal flow via console.anthropic.com — we need claude.ai.
CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
TOKEN_URL = "https://claude.ai/v1/oauth/token"
REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback"
SCOPE = "user:inference"
ONE_YEAR_SECONDS = 31_536_000

TEAM_AUTH_DIR = Path.home() / ".pi" / "team" / "auth"
VERIFIER_PATH = TEAM_AUTH_DIR / "anthropic.verifier"
TOKEN_PATH = TEAM_AUTH_DIR / "anthropic.json"

USER_AGENT = "claude-cli/2.1.90 (external, cli)"


def ensure_dir() -> None:
    TEAM_AUTH_DIR.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(TEAM_AUTH_DIR, 0o700)
    except OSError:
        pass


def generate_pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(32)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .rstrip(b"=")
        .decode()
    )
    return verifier, challenge


def build_authorize_url(challenge: str, verifier: str) -> str:
    params = {
        "code": "true",
        "client_id": CLIENT_ID,
        "response_type": "code",
        "redirect_uri": REDIRECT_URI,
        "scope": SCOPE,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": verifier,
    }
    return f"{AUTHORIZE_URL}?{urllib.parse.urlencode(params)}"


def exchange_code(code: str, verifier: str) -> dict:
    # The landing page sometimes returns "<code>#<state>".
    parts = code.split("#")
    auth_code = parts[0]
    state = parts[1] if len(parts) > 1 else verifier

    body = json.dumps(
        {
            "grant_type": "authorization_code",
            "code": auth_code,
            "redirect_uri": REDIRECT_URI,
            "client_id": CLIENT_ID,
            "code_verifier": verifier,
            "state": state,
            "expires_in": ONE_YEAR_SECONDS,
        }
    ).encode()

    req = urllib.request.Request(
        TOKEN_URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body_text = e.read().decode()[:500]
        raise SystemExit(f"token exchange failed: HTTP {e.code}\n{body_text}")


def step1_print_url() -> None:
    ensure_dir()
    verifier, challenge = generate_pkce()
    url = build_authorize_url(challenge, verifier)
    VERIFIER_PATH.write_text(verifier)
    try:
        os.chmod(VERIFIER_PATH, 0o600)
    except OSError:
        pass
    print()
    print("=" * 72)
    print("  Claude 1-year OAuth token for pi-team (scope: user:inference)")
    print("=" * 72)
    print()
    print("1. Open this URL in a browser, log in, authorize:")
    print()
    print(f"   {url}")
    print()
    print("2. Copy the code from the callback page (the entire string,")
    print("   including any # and text after it).")
    print()
    print("3. Run:")
    print()
    print("   python3 scripts/claude-auth-login.py --code '<paste-code-here>'")
    print()
    print(f"Verifier cached at: {VERIFIER_PATH}")
    print()


def step2_exchange(code: str) -> None:
    if not VERIFIER_PATH.exists():
        sys.exit(f"error: no verifier at {VERIFIER_PATH} — run step 1 first")
    verifier = VERIFIER_PATH.read_text().strip()
    tokens = exchange_code(code.strip(), verifier)

    import time

    expires_in = int(tokens.get("expires_in", 0))
    record = {
        "type": "oauth",
        "access": tokens["access_token"],
        # Long-lived tokens do not come with a refresh_token. Keep the field
        # so consumers can detect the "no refresh needed" case.
        "refresh": tokens.get("refresh_token"),
        "expires": int(time.time()) + expires_in,
        "expires_in": expires_in,
        "scope": tokens.get("scope"),
        "token_type": tokens.get("token_type", "Bearer"),
        "organization": tokens.get("organization"),
        "account": tokens.get("account"),
        "issued_at": int(time.time()),
        "source": "pi-team/scripts/claude-auth-login.py",
        "long_lived": expires_in >= 30 * 24 * 3600,
    }
    ensure_dir()
    TOKEN_PATH.write_text(json.dumps(record, indent=2))
    try:
        os.chmod(TOKEN_PATH, 0o600)
    except OSError:
        pass
    try:
        VERIFIER_PATH.unlink()
    except FileNotFoundError:
        pass

    days = expires_in // 86400
    print()
    print(f"✓ Token issued. Stored at: {TOKEN_PATH}")
    print(f"  Scope:      {record['scope']}")
    print(f"  Expires in: {days} days ({expires_in}s)")
    print(f"  Long-lived: {record['long_lived']}")
    if not record["long_lived"]:
        print()
        print("WARNING: server issued a SHORT-LIVED token. Server may be enforcing")
        print("stricter rules than documented. Raw response:")
        print(json.dumps({k: v for k, v in tokens.items() if "token" not in k}, indent=2))
    print()
    print("Next: push to the pi-team repo as a GH Actions secret:")
    print("  bash scripts/claude-auth-push-secrets.sh")
    print()


def print_access_token() -> None:
    if not TOKEN_PATH.exists():
        sys.exit("no tokens — run login first")
    data = json.loads(TOKEN_PATH.read_text())
    print(data["access"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--code", help="Authorization code from step 1's callback page")
    parser.add_argument(
        "--print-access-token",
        action="store_true",
        help="Print stored access token to stdout (used by push-secrets automation)",
    )
    args = parser.parse_args()

    if args.print_access_token:
        print_access_token()
        return
    if args.code:
        step2_exchange(args.code)
        return
    step1_print_url()


if __name__ == "__main__":
    main()
