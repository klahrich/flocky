#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["telethon"]
# ///
"""Send a Telegram message AS YOUR USER ACCOUNT (MTProto).

Why this exists, separate from telegram.py:
  The Bot API only lets a bot send messages *as itself*. Such messages are
  outgoing for the bot and never arrive as an incoming update, so a bot whose
  program replies to user messages will NOT react to them. To trigger that
  behaviour you must send the message from your own user account — which is
  what this script does, via Telethon (MTProto).

Credentials (from https://my.telegram.org -> "API development tools"), read
from the environment or the nearest .env (walking up from the cwd):
  TELEGRAM_API_ID    numeric app id      (this is NOT a bot token)
  TELEGRAM_API_HASH  app hash string

Target resolution (choose one):
  --bot NAME   Look NAME up in the telegram registry (~/.telegram-bots.json or
               <NAME>_TELEGRAM_BOT_TOKEN), call getMe to discover the bot's
               @username, and send there. Reuses the same config as telegram.py.
  --to PEER    Send directly to a @username / phone / numeric id (no registry).

First run is interactive: it prompts for your phone number and the login code
Telegram sends (plus your 2FA password if set). The session is then cached in
scripts/.send-as-user.session so later runs need no prompts.

Usage:
  uv run send_as_user.py --bot ohmystocks --text "hello"
  uv run send_as_user.py --to @ohmystocks_bot --text "hello"
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

from telethon import TelegramClient
from telethon.errors import UsernameInvalidError, UsernameNotOccupiedError

SCRIPT_DIR = Path(__file__).resolve().parent
# Telethon appends ".session" to this name.
SESSION_NAME = str(SCRIPT_DIR / ".send-as-user")

# Reuse telegram.py's config loading (.env + registry). It is stdlib-only, so
# importing it inside this telethon-backed uv script is cheap and safe.
sys.path.insert(0, str(SCRIPT_DIR))
import telegram as tg  # noqa: E402


def _force_utf8_stdio() -> None:
    """Reconfigure stdout/stderr to UTF-8.

    Windows consoles default to the active OEM codepage (e.g. cp1252), which
    chokes on non-ASCII characters like the success checkmark below. Python
    3.7+ supports `TextIOWrapper.reconfigure`; fall back to wrapping with a
    UTF-8 stream if it isn't available.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8", errors="replace")
                continue
            except Exception:
                pass
        # Last-resort: detach and re-wrap with UTF-8 (best effort).
        try:
            buf = getattr(stream, "buffer", None)
            if buf is not None:
                import io
                replacement = io.TextIOWrapper(buf, encoding="utf-8", errors="replace")
                if stream is sys.stdout:
                    sys.stdout = replacement
                else:
                    sys.stderr = replacement
        except Exception:
            pass


def get_api_creds() -> tuple[int, str]:
    tg.load_dotenv()
    api_id = os.environ.get("TELEGRAM_API_ID")
    api_hash = os.environ.get("TELEGRAM_API_HASH")
    if not api_id or not api_hash:
        sys.exit(
            "error: TELEGRAM_API_ID and TELEGRAM_API_HASH must be set "
            "(env or .env).\n"
            "       Get them at https://my.telegram.org -> API development tools.\n"
            "       These belong to your user account, not to a bot."
        )
    try:
        return int(api_id), api_hash
    except ValueError:
        sys.exit(f"error: TELEGRAM_API_ID must be numeric, got {api_id!r}")


def resolve_target(args: argparse.Namespace) -> str:
    """Return the peer to send to: an explicit --to, or the bot's @username."""
    if args.to:
        return args.to
    token = tg.resolve_bot(args.bot)  # exits with a clear error if unknown
    me = tg.api_call(token, "getMe")
    username = (me or {}).get("username")
    if not username:
        sys.exit(f"error: bot {args.bot!r} has no username; pass --to explicitly")
    return f"@{username}"


async def send(target: str, message: str, api_id: int, api_hash: str) -> None:
    async with TelegramClient(SESSION_NAME, api_id, api_hash) as client:
        try:
            entity = await client.get_entity(target)
        except (UsernameNotOccupiedError, UsernameInvalidError) as exc:
            sys.exit(f"error: could not resolve {target} ({exc.__class__.__name__})")
        await client.send_message(entity, message)
        print(f"✓ sent to {target} as you: {message!r}")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="send_as_user",
        description="Send a Telegram message as your user account (MTProto).",
    )
    grp = p.add_mutually_exclusive_group(required=True)
    grp.add_argument("--bot", help="Bot name from the telegram registry")
    grp.add_argument("--to", help="Direct target: @username / phone / numeric id")
    p.add_argument("--text", required=True, help="Message text to send")
    return p


def main(argv: list[str] | None = None) -> int:
    _force_utf8_stdio()
    args = build_parser().parse_args(argv)
    api_id, api_hash = get_api_creds()
    target = resolve_target(args)
    asyncio.run(send(target, args.text, api_id, api_hash))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
