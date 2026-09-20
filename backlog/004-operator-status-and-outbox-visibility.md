---
status: backlog
priority: medium
created: 2026-09-20
system: operations
---

# Operator status and delivery visibility

## Outcome

An owner can inspect Flocky task, route, and delivery state without reading SQLite directly.

## In scope

- Add owner-facing commands or tools for task/outbox visibility.
- Show active, queued, settled, failed, and undelivered task states.
- Show transport attempts, selected primary/fallback transport, timestamps, and safe error summaries.
- Highlight stale/unavailable Herdr routes and missing Telegram targets.
- Keep secrets, full signed payloads, and credential material out of displays.

## Candidate surface

```text
/flocky-status
/flocky-tasks
/flocky-outbox
```

## Verification

- Fixture database state renders correctly for delivered, retrying, failed, and fallback-delivered messages.
- Display output does not expose HMAC secrets, Telegram tokens, or full sensitive task payloads.

## Definition of done

- Operators can diagnose a stuck dispatch or route issue from Pi without SQLite tooling.
