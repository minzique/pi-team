# pi-team

Multi-agent debate/collaboration harness built on top of [pi](https://github.com/badlogic/pi-mono) RPC mode. Spawn N agents, each with its own model, have them talk to each other in a shared transcript, and hop in live with human injections.

Think "pi session, but with two or more LLMs in the room, and you can type in whenever you want."

## What it does

- **Spawns pi agents as RPC subprocesses.** Each agent is a real `pi --mode rpc` instance with its own session file, model, thinking level, and tools. You get pi's full capability stack (web search, code execution, skills, extensions) per agent, for free.
- **Routes messages through a shared transcript.** Round-robin turn-taking by default; each agent sees everything said since its last turn, attributed by name (`[claude]: ...`, `[codex]: ...`, `[human]: ...`).
- **Live observation via tmux.** `pi-team start` creates a 3-pane tmux session: orchestrator stream, inject prompt, log tail. Attach from any terminal, detach, reattach, share.
- **Human injection.** Type into the inject pane, or `curl -X POST /inject` from anywhere. Injections land at the next turn boundary, visible to every agent.
- **Containerized.** `docker compose up` gives you a hosted debate with a web UI (ttyd) and an HTTP inject endpoint. Drop it into ops-agent, webhooks, any tool that speaks HTTP.

## Install

```bash
pnpm install
pnpm build

# Link locally
npm link
# or use directly:
node bin/pi-team.js help
```

Requirements:
- Node 20+
- `pi` on PATH (`npm install -g @mariozechner/pi-coding-agent`)
- `tmux` 3.2+ (for `start` mode)
- API keys for whichever providers you use

## Usage

### Quickstart: two agents debating, observable in tmux

```bash
pi-team start \
  --name emotions \
  --agent claude:anthropic/claude-sonnet-4-5 \
  --agent codex:openai-codex/gpt-5.4:xhigh \
  --max-turns 10 \
  --topic-file ./debate-prompt.md
```

This prints:

```
pi-team session "emotions" started in tmux.

  Watch:   tmux attach -t piteam-emotions
  Inject:  pi-team inject --name emotions
  Stop:    pi-team stop --name emotions
  Log:     /Users/you/.pi/team/sessions/emotions/events.log
  Dir:     /Users/you/.pi/team/sessions/emotions
```

Attach to watch live:

```bash
tmux attach -t piteam-emotions
```

You'll see three panes:
- **Top (big):** orchestrator stream — every agent's tokens stream live, colored by agent name.
- **Bottom-left:** injection prompt. Type a message and press Enter; it gets delivered to both agents at the next turn.
- **Bottom-right:** raw log tail.

Detach with `Ctrl+b d`. Stop the session with `pi-team stop --name emotions`.

### Foreground mode (no tmux)

```bash
pi-team run \
  --name test \
  --agent a:anthropic/claude-haiku-4-5 \
  --agent b:openai-codex/gpt-5.4-mini \
  --topic "Pick a side on X and debate briefly." \
  --max-turns 6
```

Everything streams to stdout. Use `pi-team inject --name test` from another shell to hop in.

### Agent spec format

```
name:provider/model[:thinking]
```

Examples:
- `claude:anthropic/claude-sonnet-4-5`
- `codex:openai-codex/gpt-5.4:xhigh`
- `haiku:anthropic/claude-haiku-4-5`
- `gem:google/gemini-3-pro-preview:high`
- `mini:openai-codex/gpt-5.4-mini`

`name` is arbitrary; it's used as the attribution prefix in the transcript. Use it to give agents personas: `skeptic:anthropic/claude-sonnet-4-5`, `optimist:openai-codex/gpt-5.4:xhigh`.

### Commands

```
pi-team start    --name N --agent SPEC --agent SPEC [--topic T | --topic-file F] [--max-turns N]
pi-team run      (same flags, foreground, no tmux)
pi-team inject   --name N              (interactive stdin → session socket)
pi-team stop     --name N              (kill tmux session)
pi-team list                           (sessions on disk, ● = active)
pi-team help
```

Flags:
- `--max-turns N` — stop after N agent turns (default 20)
- `--turn-delay-ms N` — pause between turns (rate limiting)
- `--sessions-dir <dir>` — override `~/.pi/team/sessions`
- `--http-port N` — enable HTTP inject endpoint on this port (or `PITEAM_HTTP_PORT` env)

### Injection from anywhere

Three equivalent ways to inject a human message into a running session:

1. **Tmux inject pane.** Just type in the bottom-left pane.
2. **`pi-team inject --name N`** from any shell. Interactive readline prompt.
3. **Unix socket directly.** `echo "your message" | nc -U ~/.pi/team/sessions/N/inject.sock`
4. **HTTP (when `--http-port` is set).**
   ```bash
   curl -X POST http://localhost:7682/inject -d "Push back on the steering manifold argument."
   ```

All four deliver the same way: the injection lands in the transcript at the next turn boundary, and every subsequent agent sees it.

## Containerized deployment

For hosting (ops-agent integration, shared team sessions, hosted debates):

```bash
cd pi-team
cp .env.example .env  # add your API keys
echo "your debate topic here" > topics/topic.md

docker compose up --build
```

Then:

- **Watch the debate** at <http://localhost:7681/> (web-based tmux via ttyd)
- **Inject messages** via `curl -X POST http://localhost:7682/inject -d 'your message'`
- **Get state**: `curl http://localhost:7682/state`
- **Fetch transcript**: `curl http://localhost:7682/transcript`

Env vars (see `docker-compose.yml`):

| Var                  | Description                                     |
|----------------------|-------------------------------------------------|
| `PITEAM_NAME`        | Session name                                    |
| `PITEAM_AGENTS`      | Comma-separated agent specs                     |
| `PITEAM_TOPIC_FILE`  | Path to topic file inside container             |
| `PITEAM_TOPIC`       | Or inline topic string                          |
| `PITEAM_MAX_TURNS`   | Max agent turns                                 |
| `PITEAM_TTYD_CREDS`  | `user:password` for ttyd basic auth (hosted)    |
| `PITEAM_HTTP_TOKEN`  | Bearer token required for HTTP inject           |
| `ANTHROPIC_API_KEY`  | (or whichever providers you're using)           |

The container exposes:
- **7681**: ttyd web terminal showing the tmux session
- **7682**: HTTP API for inject/state/transcript/stop
- **Volume `/data`**: persistent session storage

## Architecture

```
┌──────────────────────────────────────────────┐
│              Orchestra                       │
│  ┌────────────┐      ┌───────────────┐       │
│  │ Transcript │◄─────┤ runLoop()     │       │
│  │ (jsonl)    │      │  round-robin  │       │
│  └────────────┘      └───┬───────────┘       │
│                          │                   │
│           ┌──────────────┼──────────────┐    │
│           ▼              ▼              ▼    │
│      ┌────────┐     ┌────────┐     ┌────────┐│
│      │Agent A │     │Agent B │ ... │Agent N ││
│      │pi RPC  │     │pi RPC  │     │pi RPC  ││
│      └────────┘     └────────┘     └────────┘│
│                          ▲                   │
│                          │ events             │
│                    ┌─────┴──────┐             │
│                    │  Observer  │─► stdout    │
│                    │            │─► log file  │
│                    └────────────┘             │
│                                               │
│  InjectServer (Unix socket)                   │
│  HttpInject (optional :7682)                  │
└───────────────────────────────────────────────┘
```

- Each **Agent** is a `pi --mode rpc` subprocess. The orchestrator sends it `prompt` commands and streams back text deltas + tool calls.
- The **Transcript** is the single source of truth. Every message (human, agent, system) gets a monotonic seq and is appended to a JSONL file.
- The **Orchestra** runs a round-robin loop: for each turn, render the messages since that agent's last turn, send as a `prompt`, wait for `agent_end`, append the response to the transcript, repeat.
- **Human injections** are drained into the transcript at turn boundaries, so every subsequent agent naturally sees them as messages from `[human]`.
- **Observer** is a read-only event consumer that renders to stdout/log. Multiple observers can attach.

Each agent has **its own pi session file** (`agent-<name>.session.jsonl`), so every agent has pi's full memory of its side of the conversation, plus all the tools, skills, and extensions it would have in a normal pi session.

## Why build this on pi?

pi's RPC mode gives us:
- A full agent runtime per subprocess (tools, extensions, skills, thinking levels, session persistence)
- A clean JSONL event stream with turn boundaries, tool execution events, and text deltas
- Easy model switching per agent without touching orchestration code
- Session files that are human-readable and replayable

The orchestrator is ~300 lines of TypeScript because pi does the hard work.

## Roadmap

- [ ] Free-for-all mode (all agents respond in parallel per turn)
- [ ] Moderator mode (a third agent decides who speaks next)
- [ ] Resume from existing transcript
- [ ] Export to HTML / Markdown transcript
- [ ] Slack/Discord bridges
- [ ] Streaming HTTP SSE endpoint
- [ ] Pi extension wrapper (`/team` command inside a pi session)

## License

MIT
