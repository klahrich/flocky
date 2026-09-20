#!/usr/bin/env python3
"""telegram.py — minimal multi-bot Telegram CLI.

Sends and reads messages via the Telegram Bot API (HTTPS, no extra deps).

Bot tokens and the default chat-id are read from two sources, merged:

  1. A JSON config file (default ~/.telegram-bots.json, override with the
     TELEGRAM_BOTS_CONFIG environment variable):

        {
            "chat-id": "123456789",
            "bots": {
                "alice": "123456:ABC-DEF...",
                "bob":   "789012:GHI-JKL..."
            }
        }

  2. Environment variables (also loaded from the nearest .env file, walking
     up from the current directory):

        <NAME>_TELEGRAM_BOT_TOKEN=...   -> bot named "<name>" (lowercased)
        TELEGRAM_BOT_TOKEN=...          -> bot named by TELEGRAM_BOT_NAME,
                                           or "default" if that is unset
        TELEGRAM_CHAT_ID=...            -> default chat-id

     e.g. OHMYSTOCKS_TELEGRAM_BOT_TOKEN=... is reachable as `--bot ohmystocks`.

On a name collision the JSON file wins. Either source alone is sufficient;
the JSON file is optional when the bots come from the environment.

The "chat-id" / TELEGRAM_CHAT_ID value is optional. When set, every command
uses it as the default target for sending and as the default filter for
read/listen; pass --chat to override per command, or --all-chats on
read/listen to disable the filter.

Usage examples:

    python telegram.py bots
    python telegram.py send --bot alice --text "hello"
    python telegram.py send --bot alice --chat 999 --text "to a different chat"
    python telegram.py send --bot alice --text "see attached" --image ./pic.png
    python telegram.py read --bot alice --last 20
    python telegram.py read --bot alice --since 987654321
    python telegram.py read --bot alice --all-chats --last 20
    python telegram.py listen --bot alice --timeout 30
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

# Telegram Bot API
API_BASE = "https://api.telegram.org/bot{token}/{method}"

# Telegram hard limits
TG_MAX_LENGTH = 4096
TG_MAX_PHOTO_BYTES = 10 * 1024 * 1024  # 10 MB
TG_LONG_POLL_TIMEOUT = 30  # max long-poll window per getUpdates call
TG_GET_UPDATES_LIMIT = 100  # max updates per getUpdates call

# Default HTTP timeouts
DEFAULT_HTTP_TIMEOUT = 30
LISTEN_HTTP_TIMEOUT = TG_LONG_POLL_TIMEOUT + 10


# ==================== Config ====================

# Matches <NAME>_TELEGRAM_BOT_TOKEN; the bare TELEGRAM_BOT_TOKEN is handled separately.
_BOT_TOKEN_RE = re.compile(r"^(?P<name>.+)_TELEGRAM_BOT_TOKEN$")


def config_path() -> Path:
    """Resolve the bot config file path. Env var overrides the default."""
    env = os.environ.get("TELEGRAM_BOTS_CONFIG")
    return Path(env).expanduser() if env else Path.home() / ".telegram-bots.json"


def load_dotenv() -> None:
    """Populate os.environ from the nearest .env file, walking up from the cwd.

    First match wins; existing environment variables are never overridden.
    """
    cwd = Path.cwd()
    for directory in (cwd, *cwd.parents):
        env_file = directory / ".env"
        if not env_file.is_file():
            continue
        for raw in env_file.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
        return


def _bots_from_env() -> dict[str, str]:
    """Collect bot tokens from environment variables.

    `<NAME>_TELEGRAM_BOT_TOKEN` -> bot "<name>" (lowercased). The bare
    `TELEGRAM_BOT_TOKEN` -> the name in `TELEGRAM_BOT_NAME`, else "default".
    """
    bots: dict[str, str] = {}
    for key, value in os.environ.items():
        if not value:
            continue
        m = _BOT_TOKEN_RE.match(key)
        if m:
            bots[m.group("name").lower()] = value
    bare = os.environ.get("TELEGRAM_BOT_TOKEN")
    if bare:
        name = (os.environ.get("TELEGRAM_BOT_NAME") or "default").strip().lower() or "default"
        bots[name] = bare
    return bots


def load_config() -> dict[str, Any]:
    """Build the effective config by merging env vars with the JSON file.

    Returns a dict of shape ``{"bots": {name: token}, "chat-id": str | None}``.
    The JSON file is optional when bots come from the environment; on a name
    collision the JSON file wins.
    """
    load_dotenv()

    file_data: dict[str, Any] = {}
    path = config_path()
    explicit_config = os.environ.get("TELEGRAM_BOTS_CONFIG")
    if path.exists():
        try:
            with path.open("r", encoding="utf-8") as f:
                file_data = json.load(f)
        except json.JSONDecodeError as e:
            raise SystemExit(f"Invalid JSON in {path}: {e}")
        if not isinstance(file_data, dict):
            raise SystemExit(
                f"Expected an object at the top level of {path}, got: {type(file_data).__name__}"
            )
    elif explicit_config:
        # User explicitly pointed at a config file that does not exist.
        raise SystemExit(
            f"Telegram bots config not found at {path} (from TELEGRAM_BOTS_CONFIG)."
        )

    file_bots = file_data.get("bots", {})
    if not isinstance(file_bots, dict):
        raise SystemExit(
            f"Config in {path} must have a 'bots' object mapping name -> token"
        )

    # Env first, JSON file overrides on collision. A bot value may be a plain
    # token string or an object with a "token" field (extra keys like "cwd"
    # are metadata and ignored here).
    raw_bots = {**_bots_from_env(), **file_bots}
    bots: dict[str, str] = {}
    for k, v in raw_bots.items():
        token = v.get("token") if isinstance(v, dict) else v
        if not (isinstance(k, str) and isinstance(token, str) and k and token):
            raise SystemExit(
                f"bot {k!r} must have a non-empty token "
                f"(a string, or an object with a 'token' field); got {v!r}"
            )
        bots[k] = token
    if not bots:
        raise SystemExit(
            f"No Telegram bots configured.\n"
            f"Either create {path} as JSON "
            f"{{ \"chat-id\": \"<id>\", \"bots\": {{ \"<name>\": \"<token>\", ... }} }},\n"
            f"or set <NAME>_TELEGRAM_BOT_TOKEN (and TELEGRAM_CHAT_ID) in your environment / .env."
        )

    chat_id = file_data.get("chat-id")
    if chat_id in (None, ""):
        chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    return {"bots": bots, "chat-id": chat_id}


def resolve_bot(name: str) -> str:
    """Look up a bot's token by its config-file name. Exits with a clear error if missing."""
    bots = load_config().get("bots", {})
    if name not in bots:
        available = ", ".join(sorted(bots)) or "(none configured)"
        raise SystemExit(f"Bot '{name}' not found. Available: {available}")
    return bots[name]


def default_chat_id() -> str | None:
    """Return the configured default chat-id (str), or None if not set / empty."""
    val = load_config().get("chat-id")
    if isinstance(val, bool):  # bool is a subclass of int; treat as invalid
        return None
    if isinstance(val, int):
        return str(val)
    if isinstance(val, str) and val.strip():
        return val.strip()
    return None


def resolve_chat_id(explicit: int | str | None) -> str:
    """Pick the chat_id: explicit value wins, else fall back to the config's 'chat-id'."""
    if explicit is not None and explicit != "":
        return str(explicit)
    default = default_chat_id()
    if default is None:
        raise SystemExit(
            "No target chat available.\n"
            "Pass --chat ID, or set 'chat-id' in the config file."
        )
    return default


# ==================== HTTP layer ====================

def api_call(
    token: str,
    method: str,
    params: dict[str, Any] | None = None,
    files: dict[str, str] | None = None,
    timeout: int = DEFAULT_HTTP_TIMEOUT,
) -> Any:
    """Call a Telegram Bot API method. Returns the unwrapped `result` field.

    - JSON body when `files` is None.
    - multipart/form-data when `files` is provided (values are local file paths).
    """
    url = API_BASE.format(token=token, method=method)

    if files:
        body, content_type = _encode_multipart(params or {}, files)
    else:
        body = json.dumps(params or {}).encode("utf-8")
        content_type = "application/json"

    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": content_type},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # Telegram returns JSON error bodies on HTTP errors
        try:
            payload = json.loads(e.read().decode("utf-8"))
        except Exception:
            raise SystemExit(f"HTTP {e.code} from Telegram: {e.reason}")
    except urllib.error.URLError as e:
        raise SystemExit(f"Network error talking to Telegram: {e.reason}")
    except TimeoutError:
        raise SystemExit(f"Telegram request timed out after {timeout}s")

    if not payload.get("ok"):
        code = payload.get("error_code")
        desc = payload.get("description", "unknown error")
        raise SystemExit(f"Telegram API error ({code}): {desc}")
    return payload.get("result")


def _encode_multipart(params: dict[str, Any], files: dict[str, str]) -> tuple[bytes, str]:
    """Build a multipart/form-data body for the Bot API."""
    boundary = f"----telegram-cli-{uuid.uuid4().hex}"
    chunks: list[bytes] = []

    for key, value in params.items():
        if value is None:
            continue
        chunks.append(f"--{boundary}\r\n".encode())
        chunks.append(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode())
        chunks.append(str(value).encode("utf-8"))
        chunks.append(b"\r\n")

    for key, filepath in files.items():
        fp = Path(filepath)
        if not fp.is_file():
            raise SystemExit(f"File not found: {filepath}")
        if fp.stat().st_size > TG_MAX_PHOTO_BYTES:
            raise SystemExit(
                f"{fp} is {fp.stat().st_size} bytes; Telegram photo limit is {TG_MAX_PHOTO_BYTES}."
            )
        mime, _ = mimetypes.guess_type(str(fp))
        mime = mime or "application/octet-stream"
        chunks.append(f"--{boundary}\r\n".encode())
        chunks.append(
            f'Content-Disposition: form-data; name="{key}"; filename="{fp.name}"\r\n'.encode()
        )
        chunks.append(f"Content-Type: {mime}\r\n\r\n".encode())
        chunks.append(fp.read_bytes())
        chunks.append(b"\r\n")

    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


# ==================== Message formatting ====================

def format_message(update: dict) -> dict | None:
    """Normalize an inbound update (message or edited_message) into a compact dict."""
    msg = update.get("message") or update.get("edited_message")
    if not msg:
        return None

    user = msg.get("from") or {}
    chat = msg.get("chat") or {}
    name_parts = [user.get("first_name"), user.get("last_name")]
    from_name = " ".join(p for p in name_parts if p).strip() or user.get("username")

    out: dict[str, Any] = {
        "update_id": update.get("update_id"),
        "message_id": msg.get("message_id"),
        "date": msg.get("date"),
        "chat_id": chat.get("id"),
        "chat_title": chat.get("title") or chat.get("username"),
        "from_id": user.get("id"),
        "from_name": from_name,
        "text": msg.get("text") or msg.get("caption"),
    }

    if msg.get("photo"):
        largest = msg["photo"][-1]
        out["photo"] = {
            "file_id": largest.get("file_id"),
            "width": largest.get("width"),
            "height": largest.get("height"),
        }
    if msg.get("document"):
        doc = msg["document"]
        out["document"] = {
            "file_id": doc.get("file_id"),
            "file_name": doc.get("file_name"),
            "mime_type": doc.get("mime_type"),
        }
    return out


# ==================== Commands ====================

def _chunk_text(text: str, limit: int = TG_MAX_LENGTH) -> list[str]:
    """Split text that exceeds Telegram's message cap on blank lines / newlines / spaces."""
    if len(text) <= limit:
        return [text]
    chunks: list[str] = []
    remaining = text
    while len(remaining) > limit:
        # Try to split on a clean boundary within the limit
        window = remaining[:limit]
        for sep in ("\n\n", "\n", " "):
            idx = window.rfind(sep)
            if idx > limit // 2:  # require the split to use at least half the window
                chunks.append(remaining[:idx].rstrip())
                remaining = remaining[idx:].lstrip()
                break
        else:
            chunks.append(remaining[:limit])
            remaining = remaining[limit:]
    if remaining:
        chunks.append(remaining)
    return chunks


def cmd_send(args: argparse.Namespace) -> int:
    if not args.text and not args.image:
        raise SystemExit("Provide --text and/or --image")

    token = resolve_bot(args.bot)
    chat_id = resolve_chat_id(args.chat)
    chunks = _chunk_text(args.text) if args.text else [""]
    sent: list[dict[str, Any]] = []

    for chunk in chunks:
        if args.image:
            params: dict[str, Any] = {
                "chat_id": chat_id,
                "caption": chunk,
            }
            if args.parse_mode:
                params["parse_mode"] = args.parse_mode
            result = api_call(
                token, "sendPhoto", params=params, files={"photo": args.image}
            )
        else:
            params = {"chat_id": chat_id, "text": chunk, "disable_web_page_preview": True}
            if args.parse_mode:
                params["parse_mode"] = args.parse_mode
            result = api_call(token, "sendMessage", params=params)
        sent.append({
            "message_id": result.get("message_id"),
            "chat_id": result.get("chat", {}).get("id"),
            "date": result.get("date"),
        })

    print(json.dumps({"ok": True, "sent": sent, "chunks": len(sent)}, indent=2))
    return 0


def _fetch_updates(
    token: str, *, limit: int, offset: int | None, timeout: int
) -> list[dict]:
    params: dict[str, Any] = {
        "limit": limit,
        "timeout": timeout,
        "allowed_updates": ["message", "edited_message"],
    }
    if offset is not None:
        params["offset"] = offset
    result = api_call(token, "getUpdates", params=params, timeout=max(timeout + 5, 30))
    return result or []


def _resolve_chat_filter(args: argparse.Namespace) -> int | str | None:
    """Figure out which chat_id to filter updates to.

    Order: explicit --chat > config 'chat-id' > no filter (only when --all-chats).
    """
    if args.chat is not None:
        return args.chat
    if getattr(args, "all_chats", False):
        return None
    default = default_chat_id()
    if default is None:
        return None
    try:
        return int(default)
    except (TypeError, ValueError):
        return default


def cmd_read(args: argparse.Namespace) -> int:
    token = resolve_bot(args.bot)
    limit = max(1, min(args.last, TG_GET_UPDATES_LIMIT))

    updates = _fetch_updates(token, limit=limit, offset=args.since, timeout=0)

    chat_filter = _resolve_chat_filter(args)
    if chat_filter is not None:
        updates = [
            u for u in updates
            if (u.get("message") or u.get("edited_message") or {}).get("chat", {}).get("id") == chat_filter
        ]

    messages = [m for u in updates if (m := format_message(u)) is not None]

    # Acknowledge: advance the offset past everything we just saw so the next
    # call without --since doesn't redeliver the same messages.
    if updates and not args.dry_run:
        new_offset = max(u["update_id"] for u in updates) + 1
        try:
            api_call(token, "getUpdates", params={"offset": new_offset}, timeout=10)
        except SystemExit as e:
            print(f"warning: failed to acknowledge updates: {e}", file=sys.stderr)

    print(json.dumps({"ok": True, "count": len(messages), "messages": messages}, indent=2))
    return 0


def cmd_listen(args: argparse.Namespace) -> int:
    token = resolve_bot(args.bot)
    deadline = time.monotonic() + args.timeout
    offset: int | None = None
    seen: set[int] = set()
    collected: list[dict] = []
    chat_filter = _resolve_chat_filter(args)

    while time.monotonic() < deadline:
        remaining = max(1, int(deadline - time.monotonic()))
        long_poll = min(remaining, TG_LONG_POLL_TIMEOUT)
        try:
            updates = _fetch_updates(
                token, limit=TG_GET_UPDATES_LIMIT, offset=offset, timeout=long_poll
            )
        except SystemExit as e:
            print(f"warning during long-poll: {e}", file=sys.stderr)
            time.sleep(1)
            continue

        for u in updates:
            uid = u.get("update_id")
            if uid is None:
                continue
            seen.add(uid)
            offset = max(offset or 0, uid + 1)

            formatted = format_message(u)
            if not formatted:
                continue
            if chat_filter is not None and formatted["chat_id"] != chat_filter:
                continue
            collected.append(formatted)
            # Stream each message as a JSON line so the caller can tail it.
            print(json.dumps(formatted, flush=True))

    # Final acknowledgement
    if offset is not None:
        try:
            api_call(token, "getUpdates", params={"offset": offset}, timeout=10)
        except SystemExit:
            pass

    print(
        json.dumps({"ok": True, "count": len(collected), "messages": collected}),
        flush=True,
    )
    return 0


def cmd_bots(_args: argparse.Namespace) -> int:
    config = load_config()
    out: dict[str, Any] = {"ok": True, "bots": sorted(config.get("bots", {}).keys())}
    default = config.get("chat-id")
    if default:
        out["default_chat_id"] = default
    print(json.dumps(out, indent=2))
    return 0


# ==================== Entry point ====================

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="telegram",
        description="Minimal multi-bot Telegram CLI (send / read / listen).",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    # bots
    sub.add_parser("bots", help="List configured bot names").set_defaults(func=cmd_bots)

    # send
    s = sub.add_parser("send", help="Send a message (or photo) to a chat")
    s.add_argument("--bot", required=True, help="Bot name from the config file")
    s.add_argument(
        "--chat",
        help="Target chat_id (string or int). Defaults to 'chat-id' in the config.",
    )
    s.add_argument("--text", help="Message text (or photo caption if --image is set)")
    s.add_argument("--image", help="Path to a local image to send as a photo")
    s.add_argument(
        "--parse-mode",
        choices=["MarkdownV2", "HTML", "Markdown"],
        help="Optional Telegram parse mode",
    )
    s.set_defaults(func=cmd_send)

    # read
    r = sub.add_parser("read", help="Read recent inbound messages visible to the bot")
    r.add_argument("--bot", required=True, help="Bot name from the config file")
    r.add_argument(
        "--chat",
        type=int,
        help="Filter to a specific chat_id. Defaults to 'chat-id' in the config; --all-chats disables the filter.",
    )
    r.add_argument(
        "--all-chats",
        action="store_true",
        help="Do not filter by chat; return messages from any chat the bot has visibility into.",
    )
    r.add_argument(
        "--last",
        type=int,
        default=10,
        help="How many recent updates to pull (1-100, default 10)",
    )
    r.add_argument(
        "--since",
        type=int,
        help="Only return updates with update_id > this value; also marks them as read",
    )
    r.add_argument(
        "--dry-run",
        action="store_true",
        help="Do not acknowledge the updates (so they will be redelivered next time)",
    )
    r.set_defaults(func=cmd_read)

    # listen
    l = sub.add_parser("listen", help="Long-poll for new messages for a bounded duration")
    l.add_argument("--bot", required=True, help="Bot name from the config file")
    l.add_argument(
        "--chat",
        type=int,
        help="Filter to a specific chat_id. Defaults to 'chat-id' in the config; --all-chats disables the filter.",
    )
    l.add_argument(
        "--all-chats",
        action="store_true",
        help="Do not filter by chat; receive messages from any chat.",
    )
    l.add_argument(
        "--timeout",
        type=float,
        default=60.0,
        help="Seconds to listen (default 60)",
    )
    l.set_defaults(func=cmd_listen)

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
