---
status: completed
priority: high
created: 2026-09-20
system: operational-validation
---

# Real Telegram / MTProto smoke test

## Outcome

A human-approved harmless task completes from owner Pi to stream Pi and back through actual MTProto delivery and live Telegram bot bridges.

## Preconditions

- Local ignored environment has `FLOCKY_PROTOCOL_SECRET`, `TELEGRAM_API_ID`, and `TELEGRAM_API_HASH`.
- The MTProto Telethon session has been authenticated interactively.
- Owner and stream bot usernames are known.
- Owner and stream Telegram bridges are running.
- Both fixture repositories are attached and their agents are configured with Telegram routes.

## In scope

- Use isolated private fixture repositories and a read-only Git-status task.
- Send the signed owner task through `send_as_user.py` to the stream bot.
- Verify the stream bot bridge passes the task into Pi.
- Verify the stream returns a signed result through MTProto to the owner bot.
- Validate task ID, HMAC, semantic outcome, and delivery receipts at both endpoints.
- Record privacy-safe evidence only; do not commit secrets, `.env`, Telethon sessions, or bot tokens.

## Verification

- MTProto sender reports successful delivery to the expected bot username.
- Stream inbox records exactly one task ID.
- Owner receives the matching signed result with an accurate status.
- No duplicate messages arise from bridge polling.
- Fixture repositories and credential files remain uncommitted.

## Smoke-test record

- 2026-09-20: `my-project` dispatched task `7f490aa7-7faa-4127-b306-5ae9de023e41` to `website-stream` through Telegram.
- The MTProto owner send receipt succeeded, the stream Pi processed the task, and the structured stream result appeared in both Pi sessions and Telegram.

## Definition of done

- Telegram is validated as a real transport, not only through mocks.
- Any bridge, authentication, addressing, or delivery mismatch is documented as a bug before normal Telegram dispatch is enabled.
