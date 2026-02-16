# tmux Claude -> OpenAI-compatible bridge

This wrapper exposes a minimal OpenAI-compatible endpoint and uses a hidden `tmux` session running the `claude` TUI as the backend.

## What it does

- Creates/uses a detached tmux session (default: `claude-bridge:claude`)
- Sends prompts into the pane
- Captures pane output incrementally
- Streams output as OpenAI-style SSE from `/v1/chat/completions`
- Exposes `/v1/models` for client model discovery

## Caveats

- This is terminal automation (screen scraping), not a model API.
- Output parsing is heuristic and may duplicate text on redraw.
- Prompt/response boundaries are inferred by idle timeout.

## Requirements

- `python3`
- `tmux`
- `claude` command available in `PATH`

## Run

```bash
python3 server.py
```

Optional env vars:

- `HOST` (default `127.0.0.1`)
- `PORT` (default `8000`)
- `TMUX_SESSION` (default `claude-bridge`)
- `TMUX_WINDOW` (default `claude`)
- `CLAUDE_CMD` (default `claude`)
- `PANE_HISTORY_LINES` (default `200`)
- `POLL_INTERVAL_SEC` (default `0.15`)
- `IDLE_TIMEOUT_SEC` (default `1.5`)
- `START_TIMEOUT_SEC` (default `10`)
- `HARD_TIMEOUT_SEC` (default `180`)
- `PROMPT_MODE` (default `last_user`; use `full` to send full chat transcript)
- `DEBUG` (default `0`; set `1` to log request/stream details)
- `DEBUG_LOG_BODY_MAX` (default `4000`; max raw-body chars in debug logs)

## API

### Health

```bash
curl http://127.0.0.1:8000/health
```

### Streaming chat completions

```bash
curl -N http://127.0.0.1:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "claude-tmux",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Write a haiku about terminals"}
    ]
  }'
```

## Pointing OpenAI-compatible clients

Configure your client:

- `base_url`: `http://127.0.0.1:8000/v1`
- `api_key`: any non-empty string (currently ignored)
- `model`: any string (default fallback is `claude-tmux`)

If your client requires auth, inject a fake bearer token; this server does not validate it.

### Models

```bash
curl http://127.0.0.1:8000/v1/models
```
