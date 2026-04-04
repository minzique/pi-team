# pi-team

Two or more LLMs in the same conversation. You can watch, and you can hop in.

Built on [pi](https://github.com/badlogic/pi-mono) RPC mode. Each agent is a real pi subprocess with its own model, tools, and session — the orchestrator just routes messages between them.

## Install

```bash
pnpm add -g @minzique/pi-team
# or
npm i -g @minzique/pi-team
```

Requires: Node 20+, `pi` on PATH, `tmux` 3.2+.

## Use

```bash
pi-team start \
  --name emotions \
  --agent claude:anthropic/claude-sonnet-4-5 \
  --agent codex:openai-codex/gpt-5.4:xhigh \
  --topic-file debate.md \
  --max-turns 10

tmux attach -t piteam-emotions
```

Three panes: stream, inject, log tail. Type in the inject pane to hop in — all agents see it at the next turn boundary. Detach with `Ctrl+b d`.

Agent spec: `name:provider/model[:thinking][@plan-id]`. The name is used as attribution and persona (`skeptic:anthropic/...`, `optimist:openai-codex/...`).

## Usage tracking

Pi's per-token dollar display is wrong if you're on a subscription — the real constraint is 5-hour and weekly usage limits. Declare your plan per agent to get window-based tracking:

```bash
pi-team start --name x \
  --agent claude:anthropic/claude-sonnet-4-5@anthropic-max-20x \
  --agent codex:openai-codex/gpt-5.4:xhigh@openai-plus \
  --topic-file debate.md
```

After every turn you get a per-agent status line:

```
claude   │ sonnet-4-5         │ 5h: 12/900–4500 msg (1%) · wk: 0.4/800 h  anthropic-max-20x
codex    │ gpt-5.4            │ 5h: 5/33–168 msg (15%)  openai-plus
```

Plans: `openai-plus`, `openai-pro`, `openai-business`, `anthropic-pro`, `anthropic-max-5x`, `anthropic-max-20x`, `api`. Run `pi-team plans` to list. Without a plan, pi-team falls back to `api` mode and shows raw token counts + pay-per-token dollar cost. Fetch snapshots programmatically at `GET /usage`.

## Commands

| | |
|---|---|
| `pi-team start`  | launch session in tmux (observable + injectable) |
| `pi-team run`    | foreground, no tmux |
| `pi-team inject` | interactive stdin → running session |
| `pi-team stop`   | kill session |
| `pi-team list`   | active and archived sessions |

## Inject from anywhere

```bash
# interactive
pi-team inject --name emotions

# unix socket
echo "your message" | nc -U ~/.pi/team/sessions/emotions/inject.sock

# HTTP (when --http-port is set)
curl -X POST http://localhost:7682/inject -d "push back on that last point"
```

All three land the same way: queued, delivered at the next turn boundary, visible to every agent.

## Container

```bash
docker compose up --build
```

- `:7681` — ttyd web terminal on the tmux session
- `:7682` — HTTP API (`POST /inject`, `GET /state`, `GET /transcript`, `POST /stop`)
- `/data` — persistent session storage

Env: `PITEAM_NAME`, `PITEAM_AGENTS` (comma-separated specs), `PITEAM_TOPIC_FILE` or `PITEAM_TOPIC`, `PITEAM_MAX_TURNS`, `PITEAM_TTYD_CREDS` (basic auth), `PITEAM_HTTP_TOKEN` (bearer).

## How it works

```
┌─ Orchestra ─────────────────────────────┐
│  Transcript (jsonl, single source)      │
│      │                                  │
│      ├─► Agent A  (pi --mode rpc)       │
│      ├─► Agent B  (pi --mode rpc)       │
│      └─► Agent N  ...                   │
│      ▲                                  │
│      │                                  │
│      ├─ Unix socket ─┐                  │
│      ├─ HTTP POST ───┼── human inject   │
│      └─ tmux pane ───┘                  │
└─────────────────────────────────────────┘
```

Round-robin by default. Each agent's pi session holds its own side; the orchestrator renders everything-since-last-turn with attribution (`[claude]: ...`, `[human]: ...`) as the next prompt. Injections drain at turn boundaries.

Every agent gets pi's full stack: tools, skills, extensions, thinking levels. The orchestrator is ~400 lines of TypeScript because pi does the hard work.

## License

MIT
