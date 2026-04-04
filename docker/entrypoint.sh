#!/usr/bin/env bash
# pi-team container entrypoint.
#
# Reads configuration from env vars and launches a tmux session running the
# orchestrator, plus ttyd for web observation. ttyd runs in the foreground so
# the container stays alive as long as the debate does.
#
# Required env:
#   PITEAM_NAME         session name (e.g. "emotions")
#   PITEAM_AGENTS       comma-separated agent specs: "name:provider/model[:thinking],..."
#   PITEAM_TOPIC        inline topic string, OR
#   PITEAM_TOPIC_FILE   path to a topic file
#
# Optional env:
#   PITEAM_MAX_TURNS    default 20
#   PITEAM_HTTP_PORT    default 7682
#   PITEAM_TTYD_PORT    default 7681
#   PITEAM_SESSIONS_DIR default /data/sessions
#   PITEAM_HTTP_TOKEN   if set, require Bearer token for HTTP inject
#   PITEAM_TTYD_CREDS   user:password for ttyd basic auth (recommended for hosted)
#   PITEAM_TTYD_ARGS    extra args passed to ttyd

set -euo pipefail

: "${PITEAM_NAME:?PITEAM_NAME is required}"
: "${PITEAM_AGENTS:?PITEAM_AGENTS is required}"

MAX_TURNS="${PITEAM_MAX_TURNS:-20}"
HTTP_PORT="${PITEAM_HTTP_PORT:-7682}"
TTYD_PORT="${PITEAM_TTYD_PORT:-7681}"
SESSIONS_DIR="${PITEAM_SESSIONS_DIR:-/data/sessions}"

mkdir -p "$SESSIONS_DIR"

# Resolve topic: prefer file, fallback to inline
TOPIC_ARGS=()
if [[ -n "${PITEAM_TOPIC_FILE:-}" ]]; then
  TOPIC_ARGS=(--topic-file "$PITEAM_TOPIC_FILE")
elif [[ -n "${PITEAM_TOPIC:-}" ]]; then
  TOPIC_ARGS=(--topic "$PITEAM_TOPIC")
else
  echo "error: set PITEAM_TOPIC or PITEAM_TOPIC_FILE" >&2
  exit 2
fi

# Split comma-separated agent specs into repeated --agent args
AGENT_ARGS=()
IFS=',' read -ra SPECS <<< "$PITEAM_AGENTS"
for spec in "${SPECS[@]}"; do
  # Trim whitespace
  spec="${spec#"${spec%%[![:space:]]*}"}"
  spec="${spec%"${spec##*[![:space:]]}"}"
  [[ -z "$spec" ]] && continue
  AGENT_ARGS+=(--agent "$spec")
done

# Start the tmux session in the background
pi-team start \
  --name "$PITEAM_NAME" \
  "${AGENT_ARGS[@]}" \
  "${TOPIC_ARGS[@]}" \
  --max-turns "$MAX_TURNS" \
  --sessions-dir "$SESSIONS_DIR" \
  --http-port "$HTTP_PORT"

# Wait for tmux session to be created (pi-team exits after detaching)
for i in 1 2 3 4 5; do
  if tmux has-session -t "piteam-${PITEAM_NAME}" 2>/dev/null; then
    break
  fi
  sleep 1
done

echo ""
echo "==============================================="
echo "  pi-team session \"${PITEAM_NAME}\" is running"
echo "  web observer:  http://0.0.0.0:${TTYD_PORT}/"
echo "  http inject:   POST http://0.0.0.0:${HTTP_PORT}/inject"
echo "  status:        GET  http://0.0.0.0:${HTTP_PORT}/state"
echo "==============================================="
echo ""

# Launch ttyd in the foreground pointing at the tmux session
TTYD_CMD=(ttyd -p "$TTYD_PORT" -W)
if [[ -n "${PITEAM_TTYD_CREDS:-}" ]]; then
  TTYD_CMD+=(-c "$PITEAM_TTYD_CREDS")
fi
if [[ -n "${PITEAM_TTYD_ARGS:-}" ]]; then
  # shellcheck disable=SC2206
  TTYD_CMD+=($PITEAM_TTYD_ARGS)
fi
TTYD_CMD+=(tmux attach -t "piteam-${PITEAM_NAME}")

exec "${TTYD_CMD[@]}"
