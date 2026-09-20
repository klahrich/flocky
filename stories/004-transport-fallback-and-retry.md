---
status: proposed
stage: planned
created: 2026-09-20
updated: 2026-09-20
system: transport
---

# Outcome

Flocky delivers messages through an explicitly configured transport order, retries safely, and never routes work to an unverified replacement destination.

## In scope

- Persist the selected primary transport, delivery attempts, errors, and fallback history per outbox item.
- Attempt the configured primary route first.
- On a retryable primary failure, attempt only a configured fallback route for the same logical recipient.
- Validate a Herdr route before every send; validate Telegram target presence before invoking MTProto.
- Keep undeliverable messages in the outbox with actionable diagnostics.
- Expose delivery state through a command or tool suitable for owner-agent inspection.

## Out of scope

- Automatically discovering a replacement pane after a Herdr route becomes stale.
- Inventing Telegram targets or bypassing MTProto login requirements.
- Unlimited retry loops or background retry daemons.

## Canonical path

`outbox item -> primary route validation -> send attempt -> durable receipt/error -> permitted fallback attempt -> sent or retrying state`

## Side-effect budget

Allowed:

- Send the same idempotent payload through a configured fallback after the primary route fails.
- Update durable outbox delivery metadata.

Forbidden:

- Sending to a newly discovered pane without confirmation.
- Sending through a transport not configured for that recipient.
- Marking delivery complete merely because a command was invoked without a successful receipt.

## Verification

- Simulate a stale Herdr pane and verify Telegram fallback is used only when configured.
- Simulate an MTProto failure and verify the outbox remains retryable.
- Verify no fallback is attempted when none is configured.
- Verify repeated flushes do not duplicate a completed delivery.

## Definition of done

- Delivery state explains which transport was attempted and why it failed or succeeded.
- Stale routes cannot silently misdirect work.
