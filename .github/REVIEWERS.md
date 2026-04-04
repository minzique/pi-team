# External reviewer agents

pi-team's PRs are auto-reviewed by two independent agents from different labs. Neither is part of the team that wrote the code — they're the outside perspective.

## Claude (Sonnet, subscription-billed)

Workflow: `.github/workflows/claude-review.yml` — uses `anthropics/claude-code-action@v1`.

Triggers automatically on PR open, synchronize, reopen, and ready-for-review. Also responds to `@claude` mentions in comments, reviews, and issues.

### One-time setup

```bash
# 1. Generate a long-lived OAuth token from your Claude subscription
claude setup-token
# → copy the token it prints

# 2. Store it as a repo secret
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo minzique/pi-team --body "<paste token>"
```

That's it. The token uses your Claude Max subscription — no API credit burn. Rotate with the same two commands whenever you want.

Fallback: if `CLAUDE_CODE_OAUTH_TOKEN` isn't set, the action falls back to `ANTHROPIC_API_KEY` (API-billed).

## Codex (gpt-5.4, subscription-billed, recommended path)

**Recommended: Codex Cloud GitHub integration.** Uses your ChatGPT subscription, no workflow file, no secrets to manage, official support.

### One-time setup

1. Go to https://chatgpt.com/codex/settings/integrations
2. Connect your GitHub organization (`minzique`)
3. Enable "Code reviews" for the `pi-team` repo
4. Done. Every PR gets a Codex review automatically.

If you want tighter control (custom prompt, different trigger conditions), there's also a backup workflow at `.github/workflows/codex-review.yml` using `openai/codex-action@v1`. It's **disabled by default** (gated on the `PITEAM_CODEX_REVIEW=true` repo variable) and requires an `OPENAI_API_KEY` secret — API-billed, not subscription. Turn it on only if you need the custom prompt and don't mind burning API credits.

## What each reviewer sees

Both reviewers get:
- The full diff
- The merge commit (so they see the integration, not just the delta)
- Permission to fetch history for context

They are prompted to focus on:
- Correctness (edge cases, error paths, race conditions in the orchestrator loop)
- Subprocess / IPC / event-loop lifecycle (critical for pi-team — we spawn pi RPC subprocesses and route JSONL between them)
- Architecture fit (strict TypeScript, no `any`, no `@ts-ignore`, small modules, explicit cleanup)
- Plan-aware usage tracking math (`src/usage/**`) — wrong numbers here could mislead users about their subscription consumption
- Security on any new injection path (Unix socket / HTTP / tmux pane)

They are prompted NOT to pad with generic "add more tests" comments.

## Why two reviewers from two labs

Different models make different mistakes, and agree on fewer things than they disagree on. If both say LGTM, the code is probably fine. If they conflict, that's the interesting case and a human should read both reviews before merging.

If one is silent for any reason (outage, quota, misconfig), the other still runs.
