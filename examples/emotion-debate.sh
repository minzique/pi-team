#!/usr/bin/env bash
# Example: replicate the original Claude vs Codex emotion-concepts debate
# this project was born from. Both agents get the same prompt, round-robin,
# max 10 turns. Observable via tmux.

set -euo pipefail

NAME="${1:-emotions}"
TOPIC_FILE="$(dirname "$0")/emotion-debate-topic.md"

pi-team start \
  --name "$NAME" \
  --agent claude:anthropic/claude-sonnet-4-5 \
  --agent codex:openai-codex/gpt-5.4:xhigh \
  --max-turns 10 \
  --topic-file "$TOPIC_FILE"

echo ""
echo "Attach: tmux attach -t piteam-${NAME}"
echo "Stop:   pi-team stop --name ${NAME}"
