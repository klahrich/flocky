---
status: proposed
stage: planned
created: 2026-09-20
updated: 2026-09-20
system: quality
---

# Outcome

The complete owner-to-stream-to-owner lifecycle is verified in automated, isolated tests before real project work depends on it.

## In scope

- Build an isolated fake or mock transport harness for Telegram and Herdr adapters.
- Exercise owner dispatch, stream ingress, SQLite state transitions, final result generation, and owner receipt.
- Cover duplicate inbound task IDs, queued second tasks, outbox failure/retry, stale Herdr route, missing transport route, invalid signature, and malformed outcome contract.
- Assert no secrets appear in persisted receipts, tool results, or generated messages.
- Keep tests independent of a live Telegram login and a user’s active Herdr session.

## Out of scope

- Testing Telegram’s external APIs themselves.
- Replacing one real-world smoke test after automated coverage exists.

## Canonical path

`owner dispatch -> mock transport -> stream input hook -> durable task -> simulated settled answer -> result outbox -> mock transport -> owner input hook`

## Side-effect budget

Allowed:

- Temporary databases, fixture repositories, and mock process records under test temp directories.

Forbidden:

- Sending a real Telegram message.
- Inspecting, creating, moving, or closing real Herdr workspaces/panes.

## Verification

- The suite executes every listed lifecycle scenario deterministically.
- Each test asserts durable state and the actual emitted signed payload.
- The suite runs with `npm test` on a machine without Telegram or Herdr credentials.

## Definition of done

- Core protocol behavior is covered by integration tests, not only parser/storage unit tests.
- Regressions in routing, correlation, and result delivery are caught locally.
