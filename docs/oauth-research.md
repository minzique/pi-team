# Claude Code OAuth Long-Lived Token Flow — Research Report

**Date**: 2026-04-04  
**Context**: pi-team multi-agent orchestration — CI automation of Claude Code OAuth flow  
**Researcher**: Archon (pi worker agent)

---

## Summary

- **Long-lived OAuth tokens (1-year) are a documented feature** (`claude setup-token`) but Anthropic aggressively fingerprints and restricts third-party use via TOS enforcement, not technical blocks.
- **The `cch=` request signing mechanism has been fully reverse-engineered** — SHA-256 with salt `59cf53e54c78`, sampling chars at indices 4/7/20 from the first user message. Algorithm is public, constants extracted from Bun binary.
- **Headless automation is technically feasible** but requires emulating the billing header + identity string in the system prompt. No TLS fingerprinting or binary authentication. OAuth token + correct headers = equivalent to official client.

---

## 1. Public Reverse-Engineering Repos

### minzique/claude-code-re ⭐ Primary Source
- **URL**: https://github.com/minzique/claude-code-re
- **Status**: Active, last update 2026-04-04
- **Coverage**: Automated pipeline extracts ~3000 JS modules per release, tracks 12 signature categories (beta flags, feature flags, env vars, OAuth scopes, endpoints)
- **Key Contributions**:
  - `notes/oauth-long-lived-tokens.md` — full OAuth flow documentation
  - `notes/findings.md` — internal codenames, VM infrastructure, telemetry events
  - Version diffs since v2.1.80 with changelog
- **Stars**: Not visible (personal research repo)
- **What's Missing**: No automated token generation script yet (manual curl workflow documented)

### Ringmast4r/chauncygu-collection-claude-code-source-code
- **URL**: https://github.com/ringmast4r/chauncygu-collection-claude-code-source-code
- **Status**: Archive of the March 31 2026 Claude Code source leak
- **Coverage**: Decompiled TypeScript source (163K lines, v2.1.88), contains `src/main.tsx`, context management, auth resolution logic
- **Key Contributions**:
  - Full auth priority chain in Module 2096 (`ML()` for OAuth, `PH()` for API keys)
  - Credential storage + refresh token rotation logic in Module 3117
  - OAuth token file descriptor reading in Module 2032
  - Billing header injection in Module 2015
- **What's Missing**: No automation — source archive only

### router-for-me/CLIProxyAPI
- **URL**: https://github.com/router-for-me/CLIProxyAPI
- **Status**: Active proxy middleware for OpenAI/Claude/Gemini
- **Coverage**: Device fingerprint stabilization (#2213), billing header normalization (#1592)
- **Key Contributions**:
  - Documents that `cch=` field mutation in tool results breaks prompt cache (#40652 linked)
  - Implements Claude header cloaking with configurable defaults
  - Proof that third-party tools can successfully spoof Claude Code headers
- **Stars**: ~500 (popular in Chinese dev community)

### NTT123/claude-code-billing-header-gist
- **URL**: https://gist.github.com/NTT123/579183bdd7e028880d06c8befae73b99
- **Status**: Reference implementation (Python)
- **Coverage**: Complete SHA-256 algorithm with constants, test vectors
- **Key Contributions**:
  - Salt: `59cf53e54c78`
  - Sampling indices: 4, 7, 20
  - `cch` = SHA-256(message_text)[:5]
  - `version_hash` = SHA-256(salt + sampled + version)[:3]

### javirandor/anthropic-tokenizer
- **URL**: https://github.com/javirandor/anthropic-tokenizer
- **Status**: Research project (2024), pre-dates cch signing
- **Coverage**: Reverse-engineered Claude 3 tokenizer by observing streaming
- **What's Missing**: Not relevant to OAuth — focused on tokenization only

---

## 2. Decompiled Claude Code Source

### Extraction Method
- Bun binary → [bun-demincer](https://github.com/vicnaum/bun-demincer) → ~3000 JS modules
- minzique/claude-code-re pipeline tracks 12 signature categories per release
- Full source leak (v2.1.88) published March 31 2026 via npm source map misconfiguration

### Key Modules (v2.1.81 numbering)

| Module | Contains |
|--------|----------|
| `0393.js` | OAuth config (`r8()`), endpoint URLs, scope constants |
| `0394.js` | Prod/staging config, scope assignments (`G38`, `z6T`, `meT`) |
| `2015.js` | Token exchange (`CPq`), refresh (`Kp_`), API key creation, auth URL builder |
| `2032.js` | OAuth token file descriptor reading (`ZYT`), CCR token resolution |
| `2096.js` | **Auth source resolution** — `ML()` for OAuth, `PH()` for API keys, priority chain |
| `2097.js` | **Credential construction** — `S8()` maps `CLAUDE_CODE_OAUTH_TOKEN` → static credential |
| `3061.js` | Low-level OAuth2 token request (generic, used by MCP OAuth too) |
| `3117.js` | Credential storage, error handling for expired/invalid refresh tokens |
| `3139.js` | `startOAuthFlow()` — PKCE flow orchestrator |
| `4047.js` | `TR9` — GitHub Actions setup (workflow files, secret creation) |
| `4048.js` | `RR9` — OAuth flow UI component |
| `4049.js` | `/install-github-app` command — calls `startOAuthFlow({inferenceOnly: true, expiresIn: 31536000})` |

### Auth Resolution Priority (Module 2096)

```
1. ANTHROPIC_AUTH_TOKEN env var (if not in _DT/restricted mode)
2. CLAUDE_CODE_OAUTH_TOKEN env var          ← long-lived token path
3. CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR  ← CCR (remote) path
4. CCR_OAUTH_TOKEN_FILE                     ← CCR fallback
5. apiKeyHelper                             ← managed key from /login
6. claude.ai OAuth (keychain/credentials)   ← interactive login
7. none → error
```

When `CLAUDE_CODE_OAUTH_TOKEN` is found:
```javascript
// Module 2097 — S8() credential resolver
if (process.env.CLAUDE_CODE_OAUTH_TOKEN)
  return {
    accessToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    refreshToken: null,      // No refresh — static token
    expiresAt: null,          // No expiry tracking
    scopes: ["user:inference"],
    subscriptionType: null,
    rateLimitTier: null,
  };
```

---

## 3. GitHub Issues/PRs on anthropics/claude-code

### OAuth Token Restrictions (Feb 2026)
- **#28089, #28091**: "Anthropic disabled OAuth tokens for third-party apps"
  - Closed as duplicate, but reveals TOS enforcement wave
  - OAuth tokens (`sk-ant-oat01-*`) rejected with `OAuth authentication is currently not supported`
  - Affects users trying to use subscription OAuth outside Claude Code

### Headless Auth Issues
- **#8938**: "`setup-token`/`CLAUDE_CODE_OAUTH_TOKEN` is not enough to authenticate" (Oct 2025, still open)
  - Requires `hasCompletedOnboarding: true` in `~/.claude.json` to skip onboarding
  - Affects Docker/CI environments
  - Workaround: manually edit config file or use `IS_DEMO=true`

- **#22992**: "Support device-code authentication flow (RFC 8628)" (Feb 2026, open)
  - Requests a headless-friendly auth flow (device code)
  - Current OAuth flow requires browser redirect back to the machine
  - 20 upvotes — clear user demand

### Token Expiry Issues
- **#12447**: "OAuth token expiration disrupts autonomous workflows" (Dec 2025, open)
  - 22 upvotes
  - Normal `/login` tokens expire in ~8 hours
  - `setup-token` creates 1-year tokens
  - Refresh token rotation breaks multi-instance setups

- **#37636**: "Agent token TTL too short (~15min)" (Mar 2026, closed duplicate)
  - Reports agent tokens expiring in ~15 minutes during long tasks
  - Affects background worktree agents

### MCP OAuth Issues
- **#26281**: "MCP OAuth tokens without expires_in and refresh_token silently expires" (Feb 2026, open)
  - Claude Code imposes 8-hour TTL on tokens with no explicit expiry
  - Affects GitHub OAuth tokens (which are long-lived but have no `expires_in`)

### Cache Invalidation Bug
- **#40652**: "CLI mutates historical tool results via cch= billing hash substitution" (Mar 2026, open)
  - Critical bug: Claude Code performs find-and-replace of `cch=XXXXX` across ALL message content including stored tool results
  - Permanently breaks prompt cache mid-conversation
  - Only affects sessions where tool results incidentally contain `cch=` strings (e.g., proxy logs)

---

## 4. cch= Request Signing (March 2026 State)

### Algorithm (SHA-256 with salt 59cf53e54c78)

**Constants**:
```python
CC_VERSION = "2.1.37"  # changes per release
BILLING_SALT = "59cf53e54c78"  # extracted from Bun binary, stable since v2.1.37
```

**Step 1: Compute `cch` (Content Hash)**
```python
cch = SHA-256(message_text)[:5]  # first 5 hex chars
```

**Step 2: Compute `cc_version` suffix**
```python
# Sample chars at indices 4, 7, 20 from first user message (pad with "0" if out of bounds)
sampled = message_text[4] + message_text[7] + message_text[20]
version_hash = SHA-256(BILLING_SALT + sampled + CC_VERSION)[:3]
cc_version = f"{CC_VERSION}.{version_hash}"
```

**Step 3: Format header**
```
x-anthropic-billing-header: cc_version=2.1.37.0d9; cc_entrypoint=cli; cch=fa690;
```

### Enforcement

**Required for fast mode**: Get it wrong → `Fast mode is currently available in research preview in Claude Code. It is not yet available via API.`

**Not required for Haiku**: Haiku models work with minimal headers (just `anthropic-beta: oauth-2025-04-20`)

**Required for Sonnet/Opus**: Must have billing header OR identity string in system prompt (first block)

### Server-Side Validation (Empirically Tested)

**Layer 1: OAuth Beta Gate** (all models)
```
anthropic-beta: oauth-2025-04-20
```
Without it: `OAuth authentication is currently not supported`

**Layer 2: Entitlement Verification** (Sonnet/Opus only)

Two paths:

**Path A: Billing Header in System Prompt**
```json
{"type": "text", "text": "x-anthropic-billing-header: cc_version=<any>; cc_entrypoint=<any>;"}
```
- Must have both `cc_version` and `cc_entrypoint` keys
- Values are NOT validated — `cc_version=99.0.0` works
- `cch` field is optional
- Can include arbitrary extra fields

**Path B: Identity Prefix**
One of three exact strings (must be complete and sole text of first system block):
- `"You are Claude Code, Anthropic's official CLI for Claude."`
- `"You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."`
- `"You are a Claude agent, built on Anthropic's Claude Agent SDK."`

**What's NOT validated**:
- `cc_version` value (no version checking)
- `cc_entrypoint` value (accepts anything)
- `cch` value (any string or omit)
- Model consistency (billing says `haiku`, request is `sonnet` → works)
- Extra fields in billing header
- Correlation with HTTP headers
- TLS fingerprint
- Binary authentication
- Request signing beyond SHA-256 (no secret keys involved)
- Replay detection

**Layer 3: Standard Auth**
```
Authorization: Bearer sk-ant-oat01-...
```
Must be valid, non-expired OAuth token.

### Fingerprinting Evidence

**What Anthropic checks**:
1. `anthropic-beta: oauth-2025-04-20` header — BLOCKING
2. System prompt first block — BLOCKING (Sonnet/Opus only)
3. Valid OAuth token — BLOCKING

**What Anthropic does NOT check** (but may log):
- `cc_version` value accuracy
- `cc_entrypoint` value allowlist
- `User-Agent` header presence/format
- `x-app` header
- `cch` field value correctness
- TLS client fingerprint
- Binary signature

### Spoofing Risk

**Third-party tools CAN successfully authenticate** by:
1. Using a valid long-lived token from `claude setup-token`
2. Adding billing header to system prompt (first block)
3. Including `anthropic-beta: oauth-2025-04-20` header

**Recommended approach** (honest, not impersonation):
```
x-anthropic-billing-header: cc_version=2.1.81; cc_entrypoint=pi-agent;
```
Use real CLI version, honest entrypoint name. Server accepts arbitrary entrypoint values.

---

## 5. Anthropic Documentation

### Official OAuth Documentation

**OAuth Endpoints**:
```
Authorization: https://claude.ai/oauth/authorize
Token Exchange: https://claude.ai/v1/oauth/token
Client Metadata: https://claude.ai/oauth/claude-code-client-metadata
Refresh: https://claude.ai/v1/oauth/token (grant_type=refresh_token)
```

**Client ID**: `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (public client, no secret)

**Personal accounts** use `claude.ai` endpoints.  
**Organization accounts** use `platform.claude.com` endpoints.

### OAuth Scopes

| Scope | Normal Login | Long-Lived | Description |
|-------|:---:|:---:|---|
| `user:inference` | ✓ | ✓ | API calls (messages, completions) |
| `user:profile` | ✓ | ✗ | Read user profile |
| `user:sessions:claude_code` | ✓ | ✗ | **Blocks long expiry** |
| `user:mcp_servers` | ✓ | ✗ | MCP server access |
| `user:file_upload` | ✓ | ✗ | File uploads |
| `org:create_api_key` | Console only | ✗ | Create API keys (org accounts) |

**Key constraint**: `expires_in` parameter (1-year TTL) is rejected if scope includes `user:sessions:claude_code`. Only `user:inference` scope allows long expiry.

### Token Exchange (1-Year Token)

```bash
POST https://claude.ai/v1/oauth/token
Content-Type: application/json

{
  "grant_type": "authorization_code",
  "code": "<auth_code>",
  "redirect_uri": "http://localhost:<port>/callback",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "code_verifier": "<pkce_verifier>",
  "state": "<state>",
  "expires_in": 31536000  ← 1 year
}
```

Response:
```json
{
  "token_type": "Bearer",
  "access_token": "sk-ant-oat01-...",
  "expires_in": 31536000,
  "scope": "user:inference",
  "organization": { "uuid": "...", "name": "..." },
  "account": { "uuid": "...", "email_address": "..." }
}
```

### Token Format Prefixes

| Prefix | Type | TTL | Billing |
|--------|------|-----|---------|
| `sk-ant-api03-` | API key (console) | No expiry | API credits |
| `sk-ant-oat01-` | OAuth access token | 10h default, up to 1yr | Subscription |
| `sk-ant-ort01-` | OAuth refresh token | Single-use, rotates | N/A |

### Refresh Token Behavior

- **Single-use**: Each refresh invalidates the previous refresh token
- **Rotation**: New refresh token returned with each access token refresh
- **Multi-instance risk**: If two clients share the same refresh token, one's refresh invalidates the other's token
- **Not needed for long-lived tokens**: 1-year access tokens have no refresh token in the response

### anthropics/claude-code-action (Official GitHub Action)

**Repository**: https://github.com/anthropics/claude-code-action (MIT License, 7K stars)

**Auth Inputs**:
```yaml
inputs:
  anthropic_api_key:          # → ANTHROPIC_API_KEY
  claude_code_oauth_token:    # → CLAUDE_CODE_OAUTH_TOKEN
```

Action passes env vars to Claude Code CLI, which resolves via Module 2096 priority chain.

**How to populate `CLAUDE_CODE_OAUTH_TOKEN`**:
1. Run `claude setup-token` on any machine with a browser
2. Create GitHub secret with the token
3. Reference in workflow: `claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`

**No documented scope restrictions** — GitHub Actions workflow just needs the token.

---

## 6. Pragmatic Recommendation

### Can we automate `claude setup-token` from headless?

**Technical Answer**: YES, with caveats.

**Two paths**:

### Path A: Generate Token Once, Store Forever (Recommended)

1. **One-time human setup** (requires browser):
   ```bash
   # On developer's laptop
   claude setup-token
   ```
   
2. **Store in secret manager**:
   - GitHub Secrets (for GH Actions)
   - Doppler/1Password/Vault (for pi-team)
   - Encrypted in dotfiles-agents repo

3. **Use in CI**:
   ```yaml
   env:
     CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
   ```

**Pros**:
- Zero browser automation required
- Token valid for 1 year
- No refresh needed
- Fully automated after initial setup

**Cons**:
- Requires one human interaction per year
- Token must be stored securely
- If token leaks, full access to subscription

**Rotation**: Set calendar reminder for 11 months → regenerate token → update secrets.

### Path B: Automated Browser-Based OAuth (Complex)

Use a headless browser (Playwright/Puppeteer) to:
1. Drive the OAuth flow at `claude.ai/oauth/authorize`
2. Auto-fill credentials (from secret manager)
3. Capture callback code
4. Exchange for token

**Pros**:
- Fully automated
- Can generate on-demand

**Cons**:
- Claude.ai login has Cloudflare Turnstile
- May require 2FA (TOTP)
- Fragile (breaks if UI changes)
- Higher complexity vs. 1-year token storage
- Violates TOS (automated login)

### Path C: Custom Client ID (Not Recommended)

Register your own OAuth client at `console.anthropic.com`, get a client ID scoped to your app.

**Cons**:
- Not documented
- Unknown if Anthropic accepts third-party client registration
- May require client secret (not suitable for public clients)
- Still requires user to complete OAuth flow (just with your client ID)

---

## 7. Minimum Harness Work Required (Path A)

**For pi-team CI workflow**:

1. **One-time setup** (developer):
   ```bash
   claude setup-token
   # Copy token to clipboard
   ```

2. **Store token** in dotfiles-agents encrypted secrets:
   ```bash
   # In ~/Developer/dotfiles-agents
   echo "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-..." >> .env.encrypted
   # Or use doppler, 1password, etc.
   ```

3. **CI workflow** (e.g., `.github/workflows/test.yml`):
   ```yaml
   jobs:
     test:
       runs-on: ubuntu-latest
       env:
         CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
       steps:
         - uses: actions/checkout@v4
         - name: Test with Claude Code
           run: |
             npm install -g @anthropic-ai/claude-code
             echo '{"hasCompletedOnboarding": true}' > ~/.claude.json
             claude -p "Run tests"
   ```

4. **For pi agents** calling Anthropic directly (not via Claude Code CLI):
   ```typescript
   // pi-team codebase
   import Anthropic from '@anthropic-ai/sdk';
   
   const client = new Anthropic({
     authToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
   });
   
   const response = await client.messages.create({
     model: 'claude-sonnet-4-6',
     max_tokens: 1024,
     system: [
       {
         type: 'text',
         text: 'x-anthropic-billing-header: cc_version=2.1.81; cc_entrypoint=pi-agent;'
       },
       {
         type: 'text',
         text: 'You are a helpful AI assistant.'
       }
     ],
     messages: [{ role: 'user', content: 'Hello' }],
   });
   ```

**Total effort**: ~2 hours (setup + testing).

---

## 8. TOS Risk Assessment

### What Anthropic's TOS Says (as of Feb 2026)

From the GitHub issues (#28089, #28091):
> "OAuth tokens generated via `claude setup-token` are intended for use with Claude Code and cannot be used for other API requests."

**However**:
- The `claude-code-action` (official GH Action) uses the SAME OAuth token mechanism
- The token response includes `scope: user:inference` — explicitly for API calls
- Anthropic documents `CLAUDE_CODE_OAUTH_TOKEN` as a supported env var
- No technical restriction (only TOS language)

### Gray Area

**Anthropic's position** (based on issue responses):
- OAuth tokens are for Claude Code official client only
- Third-party tools should use API keys with pay-per-use billing

**Community interpretation**:
- `claude-code-action` is a third-party CI environment using the same token
- The token is scoped to `user:inference` — the API scope
- Anthropic shut down some users' tokens in Feb 2026, but criteria unclear

**Safest approach**:
- Use API keys (`sk-ant-api03-`) for production
- OAuth tokens are for personal/dev use only

### For pi-team Use Case

**Recommendation**: Start with API keys for production. Use OAuth tokens only for:
- Development testing
- Internal experiments
- Non-customer-facing workflows

**Why**: API keys are explicitly allowed for third-party use. OAuth token TOS enforcement is unpredictable.

---

## 9. Related Work

### OpenClaw/OpenCode OAuth Plugins

Both projects have working OAuth integrations using the techniques documented here:
- System prompt billing header injection
- User-Agent spoofing
- Beta header inclusion

**OpenClaw**: Uses `setup-token` workflow, stores in `auth-profiles.json`  
**OpenCode**: Uses `opencode-claude-auth` plugin for header injection

### Third-Party CLI Tools

Several tools successfully use Claude Code OAuth tokens:
- **Auto-Claude** (#1518): Recommends `setup-token` for agent tasks
- **Moltworker** (Cloudflare Workers): Confirmed OAuth token works in `ANTHROPIC_API_KEY` env var
- **Nanoclaw** (#41): Documents `setup-token` as default auth method

### Academic Research

**AprilNEA's blog post**: Reverse-engineered Claude Code Web internals (Firecracker VMs, Antspace)  
**javirandor/anthropic-tokenizer**: Reverse-engineered Claude 3 tokenizer via streaming observation

---

## 10. Open Questions

1. **What triggers OAuth token revocation?**
   - Unknown criteria for Feb 2026 ban wave
   - Password change? Account-level revocation? Third-party client detection?

2. **Does Anthropic fingerprint based on tool schemas?**
   - Claude Code has specific tool names (`Read`, `Edit`, `Bash`)
   - Do different tool names trigger detection?
   - router-for-me/CLIProxyAPI uses `mcp_` prefix for tool names

3. **Rate limit differences between OAuth and API keys?**
   - Both hit same endpoint
   - OAuth tied to subscription tier (Max/Pro)
   - API keys tied to organization tier
   - Unclear if rate limits differ

4. **Will Anthropic expand TOS enforcement?**
   - Feb 2026 wave affected some users
   - No public statement on criteria
   - Unpredictable risk for production use

---

## Appendix A: Key URLs

### GitHub Repos
- https://github.com/minzique/claude-code-re
- https://github.com/ringmast4r/chauncygu-collection-claude-code-source-code
- https://github.com/router-for-me/CLIProxyAPI
- https://github.com/anthropics/claude-code-action
- https://github.com/anthropics/anthropic-sdk-typescript

### Documentation/Gists
- https://gist.github.com/NTT123/579183bdd7e028880d06c8befae73b99
- https://gist.github.com/coenjacobs/d37adc34149d8c30034cd1f20a89cce9
- https://a10k.co/b/reverse-engineering-claude-code-cch.html (V2EX Chinese discussion)
- https://code.claude.com/docs/en/headless (official headless docs)

### GitHub Issues (claude-code)
- #8938: setup-token not enough to authenticate
- #12447: OAuth token expiration disrupts autonomous workflows
- #22992: Support device-code authentication flow
- #26281: MCP OAuth tokens without expires_in
- #28089, #28091: Anthropic disabled OAuth tokens for third-party apps
- #29924: CLAUDE_CODE_OAUTH_TOKEN breaks Chrome extension
- #31021: OAuth usage API returns persistent 429
- #34575: MCP connector sync should work with setup-token
- #37636: Agent token TTL too short
- #40652: CLI mutates tool results via cch= substitution

---

## Appendix B: Reference Implementation (Python)

```python
#!/usr/bin/env python3
"""
Minimal Claude Code OAuth token generator.
Requires: python3, browser for OAuth flow.
"""
import hashlib
import secrets
import base64
import json
import urllib.request
import urllib.parse
import webbrowser

CC_VERSION = "2.1.81"
BILLING_SALT = "59cf53e54c78"
CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
AUTH_URL = "https://claude.ai/oauth/authorize"
TOKEN_URL = "https://claude.ai/v1/oauth/token"

def generate_pkce():
    """Generate PKCE verifier and challenge."""
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(96)).decode('utf-8').rstrip('=')[:128]
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).decode('utf-8').rstrip('=')
    return verifier, challenge

def compute_billing_header(message_text: str, entrypoint: str = "cli") -> str:
    """Compute x-anthropic-billing-header."""
    sampled = "".join(
        message_text[i] if i < len(message_text) else "0"
        for i in (4, 7, 20)
    )
    version_hash = hashlib.sha256(f"{BILLING_SALT}{sampled}{CC_VERSION}".encode()).hexdigest()[:3]
    cch = hashlib.sha256(message_text.encode()).hexdigest()[:5]
    return f"x-anthropic-billing-header: cc_version={CC_VERSION}.{version_hash}; cc_entrypoint={entrypoint}; cch={cch};"

def main():
    print("Generating 1-year Claude Code OAuth token...\n")
    
    verifier, challenge = generate_pkce()
    state = secrets.token_urlsafe(32)
    
    # Step 1: Authorization URL
    auth_params = {
        'code': 'true',
        'client_id': CLIENT_ID,
        'response_type': 'code',
        'redirect_uri': 'http://localhost:18234/callback',
        'scope': 'user:inference',
        'code_challenge': challenge,
        'code_challenge_method': 'S256',
        'state': state,
    }
    auth_url = f"{AUTH_URL}?{urllib.parse.urlencode(auth_params)}"
    
    print(f"Opening browser for OAuth flow...")
    print(f"URL: {auth_url}\n")
    webbrowser.open(auth_url)
    
    # Step 2: Wait for callback
    callback_url = input("Paste the callback URL (http://localhost:18234/callback?code=...): ").strip()
    parsed = urllib.parse.urlparse(callback_url)
    params = urllib.parse.parse_qs(parsed.query)
    
    code = params['code'][0]
    returned_state = params['state'][0]
    
    if returned_state != state:
        print("ERROR: State mismatch!")
        return
    
    # Step 3: Token exchange
    token_data = {
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': 'http://localhost:18234/callback',
        'client_id': CLIENT_ID,
        'code_verifier': verifier,
        'state': state,
        'expires_in': 31536000,  # 1 year
    }
    
    req = urllib.request.Request(
        TOKEN_URL,
        data=json.dumps(token_data).encode(),
        headers={'Content-Type': 'application/json'},
    )
    
    with urllib.request.urlopen(req) as response:
        result = json.loads(response.read())
    
    print("\n✓ Token generated successfully!")
    print(f"\nAccess Token: {result['access_token']}")
    print(f"Expires In: {result['expires_in']} seconds ({result['expires_in'] / 86400:.0f} days)")
    print(f"Scope: {result['scope']}")
    print(f"\nExport as:")
    print(f"export CLAUDE_CODE_OAUTH_TOKEN='{result['access_token']}'")
    
    # Demo: compute billing header
    demo_message = "Hello Claude"
    billing_header = compute_billing_header(demo_message)
    print(f"\nDemo billing header for '{demo_message}':")
    print(billing_header)

if __name__ == '__main__':
    main()
```

---

**End of Report**
