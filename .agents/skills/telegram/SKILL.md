---
name: telegram
description: "Send and read Telegram messages through a configured fleet of bots. Use when the user wants to interact with Telegram via one or more named bots (e.g. 'send a message via the alice bot', 'check what the alerts bot received'). Bots are looked up by name from a secret JSON config file mapping bot name -> bot API token; a default chat-id in the same config is used as the default target for sending and as the default filter for read/listen. Supports sending text and photos, one-shot read of recent inbound messages, and bounded long-polling for new ones. Also includes send_as_user.py to send a message AS your own user account over MTProto (Telethon) — use this when you need a message to look like it came from you so a bot's reply handler treats it as incoming and responds; the Bot API cannot do this."
---

# Telegram Multi-Bot CLI

A minimal stdlib-only Python CLI for sending and reading Telegram messages through one or more configured bots. Lives at `${SKILL_DIR}$/scripts/telegram.py`.

## Choosing the sender — read this first

There are two ways to send, and they are **not** interchangeable. Pick by **who the recipient is** and **whether a reply is expected**:

| If the request means… | Recipient | Use | Why |
|---|---|---|---|
| "send X **to** bot `ohmystocks`", "tell the `ohmystocks` bot …", "ask bot Y …", "ping bot Z", "message my `ohmystocks` bot" | **a bot** (you want it to react / reply) | **`send_as_user.py`** (MTProto, as you) | A bot only reacts to *incoming* messages. A Bot-API message is the bot's own *outgoing* message and never reaches another bot's update handler — so the target bot's program won't reply. Sending as your user account does. |
| "send X **via / through / using** the `alice` bot", "have the `alerts` bot post …", "notify me via bot Z" | **a human / chat** (the bot is the delivery vehicle) | **`telegram.py send`** (Bot API) | The bot is the *sender*, delivering outward to a chat that has already started it. |

The linguistic tell: **"to a bot" → send as you; "via a bot" → send as the bot.** When the target named is itself one of the registry bots and the user expects that bot to do something in response, that is always the `send_as_user.py` path. When in doubt and the goal is clearly "make bot X react," default to `send_as_user.py`. See "Sending as yourself (MTProto)" below for the command.

## Bot Configuration

Tokens and the default `chat_id` come from two sources that are **merged** at every invocation: a JSON file and environment variables (including a `.env` file). Either source alone is sufficient. On a name collision the JSON file wins. Secrets are never committed.

### Source 1 — JSON file

**Default path:** `~/.telegram-bots.json`
**Override:** set the `TELEGRAM_BOTS_CONFIG` env var to a custom path.

Format:

```json
{
  "chat-id": "123456789",
  "bots": {
    "alice":   "123456:ABC-DEF...",
    "alerts":  { "token": "222222:GHI-JKL...", "cwd": "~/projects/alerts/" },
    "support": "333333:MNO-PQR..."
  }
}
```

- **`bots`** (required) — map of bot name to its token. Each value may be a plain token **string**, or an **object** with a `"token"` field plus any extra metadata (e.g. `"cwd"`, which the CLI ignores). A token is obtained from [@BotFather](https://t.me/BotFather) on Telegram (`/newbot`).
- **`chat-id`** (optional) — numeric chat id used as the default for `send` and as the default filter for `read` / `listen`. Pass `--chat` to override per command, or `--all-chats` on `read` / `listen` to disable the filter.

The `chat-id` value must be a numeric string or integer (private chats and groups are positive, channels/supergroups are negative and typically start with `-100`). For private chats the chat id is the same as the other person's user id.

### Source 2 — environment variables / `.env`

The CLI also loads the nearest `.env` file (walking up from the current directory; existing env vars are never overridden) and reads bots from the environment:

| Env var | Becomes |
|---|---|
| `<NAME>_TELEGRAM_BOT_TOKEN` | a bot named `<name>` (lowercased) — e.g. `OHMYSTOCKS_TELEGRAM_BOT_TOKEN` → `--bot ohmystocks` |
| `TELEGRAM_BOT_TOKEN` | a bot named by `TELEGRAM_BOT_NAME`, or `default` if that is unset |
| `TELEGRAM_CHAT_ID` | the default `chat-id` (used only if the JSON file doesn't set one) |

This lets a project keep its bot tokens in the same `.env` it uses for everything else — no separate secret file needed. Run `bots` to confirm what resolved.

If no bots resolve from either source, the script prints a clear error and exits non-zero.

#### Gotcha: a bare `TELEGRAM_BOT_TOKEN` resolves as `default`, not its "real" name

A project `.env` that sets the **bare** `TELEGRAM_BOT_TOKEN=...` exposes that bot under the name **`default`** unless you also set `TELEGRAM_BOT_NAME=<name>`. This bites you when docs (e.g. `AGENTS.md`) refer to the bot by a friendly name like `example-bot` but `--bot example-bot` fails with `Bot 'example-bot' not found. Available: default, ...`. The token may be identical to a named entry in `~/.telegram-bots.json`, yet the env-derived name wins because the home JSON is not always loaded (it depends on how `Path.home()` resolves for the interpreter `uv run` launches — in practice a project's `.env` can end up being the sole source).

**Symptom:** `--bot <friendlyname>` errors with `not found`, even though the token clearly exists.
**Fix:** either add `TELEGRAM_BOT_NAME=<friendlyname>` to the `.env` (so the bare token resolves under that name), or just call `--bot default`.
**Always run `bots` first** to see what actually resolved in the current working directory — trust that over the JSON file or any docs. Note that names exposed via env depend on cwd (the nearest `.env` is loaded by walking up), so the same command can resolve different bots from different directories.

#### Gotcha: `~/.telegram-bots.json` may never load because `Path.home()` is redirected

In some setups (e.g. when a `pi` msg-bridge / intercom is active) the `HOME`/`USERPROFILE` the Python interpreter sees is **not** `C:\Users\<you>`. Here `Path.home()` resolved to `C:\Users\<you>\.pi\msg-bridge-example-bot`, so the script looked for `.telegram-bots.json` there, didn't find it, and silently fell back to **`.env`-only** bots. The real registry at `C:\Users\<you>\.telegram-bots.json` was never read — which is why bots defined only in the JSON (e.g. `example-bot`) showed up as `not found`.

**Symptom:** a bot you can clearly see in `~/.telegram-bots.json` is missing from `bots` output / errors as `not found`.
**Diagnose:** `python -c "from pathlib import Path; print(Path.home())"` — if it's not your normal home, the JSON registry isn't being loaded.
**Fixes (pick one):** add the bot to the project `.env` as `<NAME>_TELEGRAM_BOT_TOKEN=<token>` (copy the token from the JSON registry); or set `TELEGRAM_BOTS_CONFIG=C:\Users\<you>\.telegram-bots.json` so the file is found regardless of `Path.home()`.

#### Scheduling `send_as_user.py` (MTProto) as a recurring task

It **is** possible to schedule the "send as yourself" path — but only because the **interactive first login is a one-time cost**. Once `scripts/.send-as-user.session` exists (and `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` are in `.env`), later runs are fully non-interactive and safe to run from Task Scheduler / cron. If that session file does **not** yet exist, a scheduled run will hang forever waiting for the phone/code prompt — the user must run it once interactively first. Wrap the call in a `.bat` that `cd /d "%~dp0.."`s to the project root first (so `.env` + the session file resolve), and bake the message into the wrapper rather than passing it as a scheduler argument (see the windows_scheduler skill's apostrophe/quoting gotcha).

#### Gotcha: `SSL: CERTIFICATE_VERIFY_FAILED` / "self-signed certificate in chain" on send

Both `telegram.py` (Bot API over stdlib `urllib`) and `send_as_user.py` (Telethon login does HTTPS) can fail with `ssl.SSLCertVerificationError: [SSL: CERTIFICATE_VERIFY_FAILED] ... self-signed certificate in certificate chain`. Diagnose before assuming a network MITM: check the *real* chain with PowerShell (`SslStream` + `X509Chain`) — if that shows a clean public chain (e.g. GoDaddy for `api.telegram.org`) then the network is **not** intercepting; the fault is in Python's CA loading.

The specific trap seen here: `python-certifi-win32` was installed to "fix" certs, but it **histream-as** Python's default cert loading and feeds it a truncated Windows-store set (`ssl.create_default_context().cert_store_stats()` showed only ~32 certs, one self-signed, missing the real root) instead of certifi's ~140+. So it *caused* the failure. Confirm by comparing: `ssl.create_default_context()` stats vs `ssl.create_default_context(cafile=certifi.where())` — if the latter connects and the former doesn't, a store-injecting package is the culprit.

**Fix:** `pip uninstall python-certifi-win32`, then point everything at the clean certifi bundle via the standard env var, which both stdlib and Telethon honor and which survives into `uv run`'s isolated env. Add to the project `.env`:
```
SSL_CERT_FILE=<output of: python -c "import certifi; print(certifi.where())">
```
If a run still errors (env not reaching Telethon's network layer early enough), set `$env:SSL_CERT_FILE` in the shell before invoking as a fallback.

## Picking the Right Bot

The CLI itself does not guess which bot to use. **You (the agent) must map the user's verbal reference to a name in the config file** and pass `--bot <name>`.

| User says | You pass |
|---|---|
| "send a message via the alice bot" | `--bot alice` (no `--chat` needed — config default applies) |
| "post that to my alerts channel" | `--bot alerts --chat -100...` (the channel's `chat_id`) |
| "ask the support bot to forward this" | `--bot support` |
| "list my bots" / "what bots are available?" | `bots` (no `--bot` needed) |

If the user has not set up any bots yet, or you are unsure which name they mean, run `bots` first to show the available names, then ask. If nothing resolves, tell the user to add a `<NAME>_TELEGRAM_BOT_TOKEN` to their `.env` (or create `~/.telegram-bots.json`) with a token from BotFather.

## Usage

- Windows: `python ${SKILL_DIR}$/scripts/telegram.py <cmd> [flags]`
- macOS/Linux: `python3 ${SKILL_DIR}$/scripts/telegram.py <cmd> [flags]`

All commands print a single JSON object to stdout on success and a one-line error message to stderr on failure (exit code 1).

### `bots`

List the names of all configured bots, plus the default `chat-id` if set.

```bash
python telegram.py bots
# -> {
#      "ok": true,
#      "bots": ["alerts", "alice", "support"],
#      "default_chat_id": "123456789"
#    }
```

### `send`

Send a text message, or a photo with optional caption, to a chat. Long texts are auto-chunked on blank-line boundaries. If `--chat` is omitted, the message goes to the `chat-id` from the config.

```bash
python telegram.py send --bot alice --text "hello from the agent"
python telegram.py send --bot alice --chat 999 --text "to a different chat"
python telegram.py send --bot alice --text "see attached" --image ./pic.png
python telegram.py send --bot alice --parse-mode HTML --text "<b>bold</b>"
```

Flags:
- `--bot NAME` (required) — bot name from the config file
- `--chat ID` — target chat_id (string or int); defaults to `chat-id` in the config
- `--text TEXT` — message text, or caption if `--image` is set
- `--image PATH` — local image path to send as a photo (max 10 MB)
- `--parse-mode {MarkdownV2,HTML,Markdown}` — optional Telegram parse mode

If `--text` exceeds Telegram's 4096-char limit, the script splits on `\n\n`, then `\n`, then spaces, and sends each chunk as a separate message. The response reports the count and IDs.

```json
{ "ok": true, "sent": [{ "message_id": 42, "chat_id": 123456789, "date": 1718390000 }], "chunks": 1 }
```

### `read`

One-shot read of recent inbound messages visible to the bot. Uses Telegram's `getUpdates` (so it returns messages the bot has *received* or has pending, not full chat history — see [Limitations](#limitations)). By default filters to the configured `chat-id`; pass `--all-chats` to read across every chat the bot has visibility into.

```bash
python telegram.py read --bot alice --last 20
python telegram.py read --bot alice --chat 123456789 --last 20
python telegram.py read --bot alice --all-chats --last 50
python telegram.py read --bot alice --since 987654321
python telegram.py read --bot alice --last 50 --dry-run
```

Flags:
- `--bot NAME` (required) — bot name from the config file
- `--chat ID` — filter to a specific chat_id; defaults to `chat-id` in the config
- `--all-chats` — disable the chat filter; return messages from any chat
- `--last N` — how many recent updates to pull (1-100, default 10)
- `--since UPDATE_ID` — only return updates with `update_id > this`; **also acknowledges them** so they will not be redelivered next time
- `--dry-run` — pull updates without acknowledging, so they remain available for a later `--since`

Response shape:

```json
{
  "ok": true,
  "count": 2,
  "messages": [
    {
      "update_id": 987654322,
      "message_id": 17,
      "date": 1718390000,
      "chat_id": 123456789,
      "chat_title": "Example Chat",
      "from_id": 555111222,
      "from_name": "Example User",
      "text": "are you around?"
    }
  ]
}
```

### `listen`

Long-poll for new messages for a bounded duration. Each new message is printed as a JSON line as it arrives, then a final summary is printed at the end. Useful for "wait for a reply" workflows. By default filters to the configured `chat-id`; pass `--all-chats` to receive from any chat.

```bash
python telegram.py listen --bot alice --timeout 30
python telegram.py listen --bot alice --all-chats --timeout 30
python telegram.py listen --bot alice --chat 123456789 --timeout 30
```

Flags:
- `--bot NAME` (required) — bot name from the config file
- `--chat ID` — filter to a specific chat_id; defaults to `chat-id` in the config
- `--all-chats` — disable the chat filter; receive messages from any chat
- `--timeout SECONDS` — how long to listen (default 60)

## Sending as yourself (MTProto) — triggering a bot's reply handler

`telegram.py send` sends **as a bot** via the Bot API. Those messages are
*outgoing* for the bot and never arrive as an incoming update, so a bot whose
program replies to user messages will **not** react to them. A bot can never
post a message that looks like it came from you.

To send a message that your bots' update handlers *see* (so their listeners
respond), send it from **your own user account** over MTProto, using
`scripts/send_as_user.py` (Telethon). This is a separate auth model from the
Bot API:

- **Credentials:** `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from
  [my.telegram.org](https://my.telegram.org) → "API development tools". These
  belong to your *user account*, not to any bot. Put them in your `.env` (or
  the environment).
- **First run is interactive:** it prompts for your phone number and the login
  code Telegram sends (plus a 2FA password if you have one). The session is
  then cached in `scripts/.send-as-user.session` (gitignored) and later runs
  need no prompts. Because the first login is interactive, the *user* must run
  it (e.g. via the `! <cmd>` prompt) — a non-interactive agent shell will hang.

```bash
# Resolve the target from the registry (looks up the bot's @username via getMe):
uv run scripts/send_as_user.py --bot ohmystocks --text "hello from me"

# Or address a peer directly (skips the registry):
uv run scripts/send_as_user.py --to @ohmystocks_bot --text "hello from me"
```

Use **`send`** (Bot API) when you want the bot to talk outward to a chat. Use
**`send_as_user.py`** (MTProto) when you want to talk *to* a bot as yourself
and trigger its reply logic.

> **Don't wait for the bot's reply.** When you use `send_as_user.py` to
> trigger another bot, the script's job ends the moment it prints
> `✓ sent to ...`. Do **not** follow up with `listen` / `read` on the
> target bot's getUpdates: the user has a `pi-messenger-bridge` running for
> that bot which already holds the long-poll, and racing it causes offset
> corruption. More importantly, the bot's reply goes to the user in their
> Telegram app — the user will see it and decide what to do next. Just
> acknowledge the successful send and stop. If the user later wants you to
> act on the reply, they will paste it into our chat.

> **Windows encoding note:** `send_as_user.py` reconfigures `sys.stdout`/
> `sys.stderr` to UTF-8 at startup, so the success line (which contains a
> `✓`) prints correctly on default `cp1252` Windows consoles. If you fork the
> script and add new prints, keep that reconfigure in place or you will hit
> `UnicodeEncodeError` again.

## Limitations

- **No full chat history.** Telegram's Bot API only exposes messages the bot has *seen*. To get older messages, you would need a `getUpdates` offset that points before them, or a userbot (MTProto) — out of scope here. If a user asks for "all messages", set the right expectation: this tool reads what the bot has received.
- **No webhooks.** This is a CLI; bots are queried on demand via `getUpdates`. Do not run two listeners against the same bot at the same time — the long-poll offset will race.
- **chat_id is numeric.** You need the target chat's numeric ID. The `chat-id` value in the config must be a pure number (string or int); strings with stray characters will be sent to Telegram and rejected. For private chats, the user can run `python telegram.py read --bot NAME --all-chats --last 1` after sending a message to the bot to discover their own ID. For groups/channels, forward a message to the bot and check the same output, or use a chat-ID-discovery bot.
- **10 MB photo cap.** Larger files need to be sent as `sendDocument` — not implemented in v1; easy to add if needed.
- **No reactions, edits, or media-group sends** in v1. Just plain text and single photos.

## Agent Workflows

**Don't re-send replies for incoming Telegram messages.** When a user message
arrives *into this session* via Telegram (e.g. prefixed like
`[📱 @user via telegram]`), a bridge already relays your normal in-session
response back to Telegram. Do **not** call `telegram.py send` to answer it —
that produces a duplicate message. Just reply normally in the session. Only
use `telegram.py send` when you're *initiating* an outbound message that isn't
a reply to a relayed inbound one (e.g. a proactive notification the user
explicitly asked you to push).

**Don't narrate delivery back in-session.** After sending a Telegram message, do
not add a redundant confirmation line like "Replied via Telegram — message
delivered ✅". The tool result already shows success. Just continue with the
actual work (or stay silent if there's nothing else to say). Report a
`message_id` only if the user specifically needs it.

**Send a message the user asks for:**

1. Identify the bot name from the user's wording (or ask, or run `bots`).
2. The destination chat is normally the config's `chat-id` — you don't need to pass `--chat`. If the user wants a different destination, use `--chat ID`.
3. Call `send`. Report the `message_id` back if useful.

**Check what a bot has received:**

1. Use `read` with `--last N`. By default the result is filtered to the configured `chat-id`; pass `--all-chats` to see across every chat.
2. To check repeatedly, capture the max `update_id` from the previous response and pass it as `--since` next time.

**Wait for a reply:**

1. Use `listen` with a bounded `--timeout` (e.g. 30s).
2. Parse the streaming JSON lines for incoming messages; the final summary line confirms the count and any messages that arrived after the last stream flush.
3. On timeout with no messages, tell the user nothing came in.

**Discover a chat_id:**

1. Have the user send any message to the target bot from the target chat.
2. Run `python telegram.py read --bot NAME --all-chats --last 1` and look at the `chat_id` / `chat_title` in the response.
3. (Optional) Drop that value into the config's `chat-id` field to make it the new default.

## Error Format

Errors go to stderr and exit with code 1:

```
Bot 'alice' not found. Available: alerts, support
Telegram API error (404): Not Found
No Telegram bots configured.
Either create C:\Users\<you>\.telegram-bots.json as JSON { "chat-id": "<id>", "bots": { "<name>": "<token>", ... } },
or set <NAME>_TELEGRAM_BOT_TOKEN (and TELEGRAM_CHAT_ID) in your environment / .env.
No target chat available.
Pass --chat ID, or set 'chat-id' in the config file.
```

Success always prints a single JSON object starting with `"ok": true` to stdout, which is easy to parse.
