#!/usr/bin/env python3
import json
import os
import re
import shlex
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from socket import timeout as SocketTimeout
from typing import Dict, List, Tuple
from urllib.parse import urlparse


@dataclass
class Config:
    host: str = os.getenv("HOST", "127.0.0.1")
    port: int = int(os.getenv("PORT", "8000"))
    tmux_session: str = os.getenv("TMUX_SESSION", "claude-bridge")
    tmux_window: str = os.getenv("TMUX_WINDOW", "claude")
    claude_cmd: str = os.getenv("CLAUDE_CMD", "claude")
    pane_history_lines: int = int(os.getenv("PANE_HISTORY_LINES", "200"))
    poll_interval_sec: float = float(os.getenv("POLL_INTERVAL_SEC", "0.15"))
    idle_timeout_sec: float = float(os.getenv("IDLE_TIMEOUT_SEC", "1.5"))
    start_timeout_sec: float = float(os.getenv("START_TIMEOUT_SEC", "10"))
    hard_timeout_sec: float = float(os.getenv("HARD_TIMEOUT_SEC", "180"))
    prompt_mode: str = os.getenv("PROMPT_MODE", "last_user")
    debug: bool = os.getenv("DEBUG", "0").lower() in ("1", "true", "yes", "on")
    debug_log_body_max: int = int(os.getenv("DEBUG_LOG_BODY_MAX", "4000"))


CFG = Config()
TMUX_LOCK = threading.Lock()
ANSI_RE = re.compile(r"\x1B\[[0-?]*[ -/]*[@-~]")


def debug_log(message: str) -> None:
    if not CFG.debug:
        return
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[debug {ts}] {message}")


def run_cmd(args: List[str]) -> Tuple[int, str, str]:
    proc = subprocess.run(args, capture_output=True, text=True)
    return proc.returncode, proc.stdout, proc.stderr


def tmux_target() -> str:
    return f"{CFG.tmux_session}:{CFG.tmux_window}"


def ensure_tmux_session() -> None:
    rc, _, _ = run_cmd(["tmux", "has-session", "-t", CFG.tmux_session])
    if rc == 0:
        debug_log(f"tmux session exists: {CFG.tmux_session}")
        return

    rc, _, err = run_cmd(
        [
            "tmux",
            "new-session",
            "-d",
            "-s",
            CFG.tmux_session,
            "-n",
            CFG.tmux_window,
            CFG.claude_cmd,
        ]
    )
    if rc != 0:
        raise RuntimeError(f"failed to create tmux session: {err.strip()}")
    debug_log(f"created tmux session: {CFG.tmux_session}")


def capture_pane() -> str:
    rc, out, err = run_cmd(
        [
            "tmux",
            "capture-pane",
            "-p",
            "-S",
            f"-{CFG.pane_history_lines}",
            "-t",
            tmux_target(),
        ]
    )
    if rc != 0:
        raise RuntimeError(f"failed to capture pane: {err.strip()}")
    return out


def send_prompt(prompt: str) -> None:
    debug_log(f"sending prompt to tmux: chars={len(prompt)}")
    # Use tmux buffer+paste for robust multiline input.
    rc, _, err = run_cmd(["tmux", "set-buffer", "--", prompt])
    if rc != 0:
        raise RuntimeError(f"failed to set tmux buffer: {err.strip()}")

    rc, _, err = run_cmd(["tmux", "paste-buffer", "-t", tmux_target()])
    if rc != 0:
        raise RuntimeError(f"failed to paste tmux buffer: {err.strip()}")

    rc, _, err = run_cmd(["tmux", "send-keys", "-t", tmux_target(), "Enter"])
    if rc != 0:
        raise RuntimeError(f"failed to send Enter: {err.strip()}")


def extract_delta(prev: str, cur: str) -> str:
    if cur == prev:
        return ""

    max_prefix = min(len(prev), len(cur))
    prefix_len = 0
    while prefix_len < max_prefix and prev[prefix_len] == cur[prefix_len]:
        prefix_len += 1

    max_suffix = min(len(prev) - prefix_len, len(cur) - prefix_len)
    suffix_len = 0
    while suffix_len < max_suffix and prev[-1 - suffix_len] == cur[-1 - suffix_len]:
        suffix_len += 1

    end = len(cur) - suffix_len if suffix_len > 0 else len(cur)
    if end < prefix_len:
        end = prefix_len
    return cur[prefix_len:end]


def sanitize_text(text: str) -> str:
    if not text:
        return ""
    text = ANSI_RE.sub("", text)
    text = text.replace("\r", "")
    # Keep tab/newline; drop other controls.
    text = "".join(ch for ch in text if ch == "\n" or ch == "\t" or ord(ch) >= 32)
    return text


def append_unique(emitted: str, chunk: str) -> Tuple[str, str]:
    chunk = sanitize_text(chunk)
    if not chunk:
        return "", emitted

    if chunk in emitted[-4000:]:
        return "", emitted

    max_overlap = min(len(emitted), len(chunk), 2000)
    overlap = 0
    for i in range(max_overlap, 0, -1):
        if emitted[-i:] == chunk[:i]:
            overlap = i
            break

    unique = chunk[overlap:]
    if not unique:
        return "", emitted
    return unique, emitted + unique


def normalize_space(text: str) -> str:
    return " ".join((text or "").split()).strip()


def is_prompt_echo(chunk: str, prompt: str) -> bool:
    c = normalize_space(chunk)
    p = normalize_space(prompt)
    if not c or not p:
        return False
    if c == p:
        return True
    if c == f"> {p}":
        return True
    if c == f"[user] {p}":
        return True
    if c.endswith(f"> {p}"):
        return True
    return False


def is_ui_noise_line(stripped: str) -> bool:
    if not stripped:
        return False
    if "? for shortcuts" in stripped:
        return True
    if "Contemplating" in stripped:
        return True
    if "esc to interrupt" in stripped:
        return True
    if stripped.startswith("[Pasted text #"):
        return True
    if all(ch in "─-_" for ch in stripped):
        return True
    return False


def extract_latest_assistant_text(pane: str) -> str:
    text = sanitize_text(pane)
    lines = text.splitlines()
    blocks: List[List[str]] = []
    current: List[str] | None = None

    for raw in lines:
        line = raw.rstrip()
        stripped = line.strip()

        bullet_idx = line.rfind("● ")
        if bullet_idx != -1:
            if current:
                blocks.append(current)
            current = [line[bullet_idx + 2 :].strip()]
            continue

        if is_ui_noise_line(stripped):
            continue

        if line.lstrip().startswith(">"):
            if current:
                blocks.append(current)
                current = None
            continue

        if current is None:
            continue

        if line.startswith("  ") or line.startswith("\t"):
            if stripped:
                current.append(stripped)
            elif current and current[-1] != "":
                current.append("")
            continue

        if stripped == "":
            if current and current[-1] != "":
                current.append("")
            continue

        blocks.append(current)
        current = None

    if current:
        blocks.append(current)

    if not blocks:
        return ""

    last = blocks[-1]
    out: List[str] = []
    prev_blank = False
    for part in last:
        s = part.strip()
        if not s:
            if not prev_blank:
                out.append("")
            prev_blank = True
            continue
        out.append(s)
        prev_blank = False

    return "\n".join(out).strip()


def sse_event(payload: Dict) -> bytes:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")


def build_messages_prompt(messages: List[Dict]) -> str:
    def content_to_text(content) -> str:
        if isinstance(content, list):
            return "\n".join(
                part.get("text", "") if isinstance(part, dict) else str(part)
                for part in content
            )
        return str(content or "")

    # Default behavior: only send the latest user message to Claude TUI.
    if CFG.prompt_mode != "full":
        for msg in reversed(messages):
            if msg.get("role") == "user":
                return content_to_text(msg.get("content", "")).strip()
        # Fallback if no user role exists.
        if messages:
            return content_to_text(messages[-1].get("content", "")).strip()
        return ""

    # Optional full mode for debugging/experimentation.
    lines = []
    for msg in messages:
        role = msg.get("role", "user")
        content = content_to_text(msg.get("content", ""))
        lines.append(f"[{role}] {content}")
    return "\n".join(lines).strip()


def model_list_payload() -> Dict:
    return {
        "object": "list",
        "data": [
            {
                "id": "claude-tmux",
                "object": "model",
                "created": 0,
                "owned_by": "claude_tmux",
            }
        ],
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send_json(self, status: int, payload: Dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def _read_json_body(self) -> Dict:
        content_length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(content_length) if content_length else b"{}"
        if CFG.debug:
            raw_text = raw.decode("utf-8", errors="replace")
            if len(raw_text) > CFG.debug_log_body_max:
                raw_text = raw_text[: CFG.debug_log_body_max] + "...<truncated>"
            debug_log(f"request raw body: {raw_text}")
        try:
            return json.loads(raw)
        except json.JSONDecodeError as e:
            raise ValueError("invalid JSON body") from e

    def _debug_request(self) -> None:
        if not CFG.debug:
            return
        redacted_headers = {}
        for key, value in self.headers.items():
            if key.lower() == "authorization":
                redacted_headers[key] = "<redacted>"
            else:
                redacted_headers[key] = value
        debug_log(f"request {self.command} {self.path} headers={redacted_headers}")

    def do_GET(self):
        self._debug_request()
        path = urlparse(self.path).path
        if path == "/health":
            self._send_json(HTTPStatus.OK, {"ok": True})
            return
        if path == "/v1/models":
            self._send_json(HTTPStatus.OK, model_list_payload())
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self):
        self._debug_request()
        path = urlparse(self.path).path
        if path != "/v1/chat/completions":
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return

        try:
            body = self._read_json_body()
            model = body.get("model", "claude-tmux")
            stream = bool(body.get("stream", False))
            messages = body.get("messages")
            debug_log(
                f"chat request parsed: model={model} stream={stream} "
                f"messages={len(messages) if isinstance(messages, list) else 'invalid'}"
            )
            if not isinstance(messages, list):
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "messages must be a list"})
                return

            prompt = build_messages_prompt(messages)
            if not prompt:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "empty prompt"})
                return
            debug_log(f"built prompt chars={len(prompt)}")

            completion_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
            created = int(time.time())

            with TMUX_LOCK:
                ensure_tmux_session()
                baseline = capture_pane()
                send_prompt(prompt)

                if stream:
                    debug_log("handling stream response")
                    self._handle_streaming_chat(completion_id, created, model, baseline, prompt)
                    return

                text = self._collect_response_text(baseline)
                debug_log(f"non-stream response chars={len(text)}")

            self._send_json(
                HTTPStatus.OK,
                {
                    "id": completion_id,
                    "object": "chat.completion",
                    "created": created,
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": text},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                },
            )
        except TimeoutError as e:
            self._send_json(HTTPStatus.GATEWAY_TIMEOUT, {"error": str(e)})
        except Exception as e:
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(e)})

    def _collect_response_text(self, baseline: str) -> str:
        baseline_reply = extract_latest_assistant_text(baseline)
        prev_reply = baseline_reply
        emitted = ""
        parts: List[str] = []
        started = False
        start_wait_deadline = time.monotonic() + CFG.start_timeout_sec
        hard_deadline = time.monotonic() + CFG.hard_timeout_sec
        last_change = time.monotonic()

        while time.monotonic() < hard_deadline:
            cur = capture_pane()
            cur_reply = extract_latest_assistant_text(cur)
            delta = extract_delta(prev_reply, cur_reply)
            prev_reply = cur_reply
            unique, emitted = append_unique(emitted, delta)
            if unique:
                parts.append(unique)
                started = True
                last_change = time.monotonic()
                debug_log(f"non-stream delta chars={len(unique)}")
            elif started and time.monotonic() - last_change >= CFG.idle_timeout_sec:
                debug_log("non-stream stop: idle timeout")
                break
            elif (not started) and time.monotonic() >= start_wait_deadline:
                # One final baseline diff pass.
                cur2 = capture_pane()
                cur2_reply = extract_latest_assistant_text(cur2)
                fallback = extract_delta(baseline_reply, cur2_reply)
                unique2, emitted = append_unique(emitted, fallback)
                if unique2:
                    parts.append(unique2)
                    debug_log(f"non-stream fallback delta chars={len(unique2)}")
                else:
                    debug_log("non-stream stop: start timeout")
                break

            time.sleep(CFG.poll_interval_sec)

        return "".join(parts).strip()

    def _stream_text(self, completion_id: str, created: int, model: str, text: str) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        try:
            self.wfile.write(
                sse_event(
                    {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model,
                        "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
                    }
                )
            )
            if text:
                self.wfile.write(
                    sse_event(
                        {
                            "id": completion_id,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": model,
                            "choices": [
                                {"index": 0, "delta": {"content": text}, "finish_reason": None}
                            ],
                        }
                    )
                )
            self.wfile.write(
                sse_event(
                    {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model,
                        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                    }
                )
            )
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, SocketTimeout):
            return

    def _handle_streaming_chat(
        self, completion_id: str, created: int, model: str, baseline: str, prompt: str
    ) -> str:
        emitted_parts: List[str] = []
        # Wait for first real content before opening SSE response.
        baseline_reply = extract_latest_assistant_text(baseline)
        prev_reply = baseline_reply
        emitted = ""
        first_chunk = ""
        start_wait_deadline = time.monotonic() + CFG.start_timeout_sec
        while time.monotonic() < start_wait_deadline:
            cur = capture_pane()
            cur_reply = extract_latest_assistant_text(cur)
            delta = extract_delta(prev_reply, cur_reply)
            prev_reply = cur_reply
            unique, emitted = append_unique(emitted, delta)
            if unique.strip():
                if is_prompt_echo(unique, prompt):
                    debug_log("stream skipping prompt echo chunk")
                    continue
                first_chunk = unique
                debug_log(f"stream first chunk chars={len(first_chunk)}")
                break
            time.sleep(CFG.poll_interval_sec)

        if not first_chunk:
            # Final best-effort baseline diff.
            cur2 = capture_pane()
            cur2_reply = extract_latest_assistant_text(cur2)
            fallback = extract_delta(baseline_reply, cur2_reply)
            unique2, emitted = append_unique(emitted, fallback)
            if unique2 and (not is_prompt_echo(unique2, prompt)):
                first_chunk = unique2
                debug_log(f"stream fallback first chunk chars={len(first_chunk)}")
            else:
                debug_log("stream start timeout: no response content detected")
                raise TimeoutError("no response content from claude before start timeout")

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        # Some clients expect an initial role delta before content.
        try:
            self.wfile.write(
                sse_event(
                    {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model,
                        "choices": [
                            {
                                "index": 0,
                                "delta": {"role": "assistant"},
                                "finish_reason": None,
                            }
                        ],
                    }
                )
            )
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, SocketTimeout):
            debug_log("stream aborted: client disconnected before first chunk")
            return "".join(emitted_parts).strip()

        try:
            self.wfile.write(
                sse_event(
                    {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model,
                        "choices": [
                            {
                                "index": 0,
                                "delta": {"content": first_chunk},
                                "finish_reason": None,
                            }
                        ],
                    }
                )
            )
            self.wfile.flush()
            debug_log(f"stream chunk sent: chars={len(first_chunk)}")
            emitted_parts.append(first_chunk)
        except (BrokenPipeError, ConnectionResetError, SocketTimeout):
            debug_log("stream aborted: client disconnected on first content")
            return "".join(emitted_parts).strip()

        started = True
        hard_deadline = time.monotonic() + CFG.hard_timeout_sec
        last_change = time.monotonic()

        while time.monotonic() < hard_deadline:
            cur = capture_pane()
            cur_reply = extract_latest_assistant_text(cur)
            delta = extract_delta(prev_reply, cur_reply)
            prev_reply = cur_reply
            unique, emitted = append_unique(emitted, delta)

            if unique:
                if is_prompt_echo(unique, prompt):
                    debug_log("stream skipping prompt echo chunk")
                    continue
                started = True
                last_change = time.monotonic()
                payload = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"content": unique},
                            "finish_reason": None,
                        }
                    ],
                }
                try:
                    self.wfile.write(sse_event(payload))
                    self.wfile.flush()
                    debug_log(f"stream chunk sent: chars={len(unique)}")
                    emitted_parts.append(unique)
                except (BrokenPipeError, ConnectionResetError, SocketTimeout):
                    debug_log("stream aborted: client disconnected mid-stream")
                    return "".join(emitted_parts).strip()
            elif started and time.monotonic() - last_change >= CFG.idle_timeout_sec:
                debug_log("stream stop: idle timeout")
                break
            elif (not started) and time.monotonic() >= start_wait_deadline:
                debug_log("stream stop: start timeout")
                break

            time.sleep(CFG.poll_interval_sec)

        final_payload = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        }
        try:
            self.wfile.write(sse_event(final_payload))
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            debug_log("stream finished: sent stop + [DONE]")
        except (BrokenPipeError, ConnectionResetError, SocketTimeout):
            debug_log("stream end write failed: client disconnected")
            return "".join(emitted_parts).strip()

        return "".join(emitted_parts).strip()

    def log_message(self, fmt: str, *args):
        print(f"{self.address_string()} - {fmt % args}")


def main() -> None:
    server = ThreadingHTTPServer((CFG.host, CFG.port), Handler)
    print(f"tmux-claude OpenAI bridge listening on http://{CFG.host}:{CFG.port}")
    print(f"tmux target: {tmux_target()} | claude cmd: {shlex.quote(CFG.claude_cmd)}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
